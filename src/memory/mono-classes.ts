/**
 * Classes, champs et champs statiques d'une image Mono, lus a distance.
 *
 * Meme principe que `mono-runtime.ts` : chaque decalage est **redecouvert au
 * lancement** quand un export ou une signature le permet, et verifie a
 * l'usage quand il est code en dur. Ce qui a ete derive, et comment, est
 * documente a cote de chaque constante.
 *
 * Verifie en direct le 24/09/2026 : 14 095 classes lues dans
 * `Assembly-CSharp` (exactement le nombre d'entrees annonce par la table),
 * 33 723 sur l'ensemble des assemblies.
 */
import { findExport } from './pe-exports.js';
import { fieldOffsetFromAccessor, MonoLayoutError } from './mono-runtime.js';
import { readCString, readMemory, readPointer } from './process-memory.js';
import type { ModuleInfo, ProcessHandle } from './process-memory.js';

/**
 * Decalages de la disposition Mono en cours, calcules une fois par processus.
 */
export interface MonoLayout {
  className: bigint;
  classNamespace: bigint;
  /** `MonoClass.fields` : tableau de `MonoClassField`. */
  classFields: bigint;
  /** `MonoClass.next_class_cache` : chainage dans la table de l'image. */
  classNextInCache: bigint;
  /** `MonoClass.runtime_info` : tables virtuelles par domaine. */
  classRuntimeInfo: bigint;
  /** `MonoClass.vtable_size`, qui situe les statiques dans la vtable. */
  classVtableSize: bigint;
  /** `MonoImage.class_cache` : table de hachage de toutes les classes. */
  imageClassCache: bigint;
  fieldName: bigint;
  /** Octet de drapeaux de `MonoVTable`, et le bit « a des statiques ». */
  vtableFlags: bigint;
  vtableHasStaticsBit: number;
  /** Debut du tableau de methodes de `MonoVTable`, apres lequel vivent les statiques. */
  vtableSlots: bigint;
}

/**
 * `MonoClassField` : `{ MonoType *type; char *name; MonoClass *parent; int offset; }`,
 * aligne sur 0x20. Le nom est redecouvert (`mono_field_get_name`) ; `parent`
 * sert de garde-fou (voir `listFields`), et `offset` est confirme par le
 * prologue de `mono_field_get_offset` (`8b 43 18` : `mov eax, [rbx+0x18]`).
 */
const FIELD_SIZE = 0x20n;
const FIELD_TYPE = 0x00n;
const FIELD_PARENT = 0x10n;
const FIELD_OFFSET = 0x18n;

/** `MonoType.attrs` (uint16) juste apres le pointeur `data`. */
const TYPE_ATTRS = 0x08n;
/** `FIELD_ATTRIBUTE_STATIC`, norme ECMA-335. */
const FIELD_ATTRIBUTE_STATIC = 0x10;

/**
 * `MonoClass.fields`, lu dans `mono_class_get_fields` a 0x6d :
 * `48 8b 83 98 00 00 00` (`mov rax, [rbx+0x98]`). La fonction est trop
 * longue pour un motif fixe ; la valeur est donc codee en dur et verifiee a
 * chaque lecture par le champ `parent` de chaque `MonoClassField`.
 */
const CLASS_FIELDS = 0x98n;

/** `MonoClassRuntimeInfo.domain_vtables[0]`, apres `guint16 max_domain` aligne. */
const RUNTIME_INFO_FIRST_VTABLE = 0x08n;

/** Filet contre une liste chainee mal lue qui boucle sur elle-meme. */
const MAX_CHAIN = 500;
const MAX_FIELDS = 1000;

/**
 * Decode `mono_vtable_get_static_field_data` :
 *
 * ```
 * f6 41 30 04          test byte [rcx+0x30], 4    ; drapeau « a des statiques »
 * 75 03 33 c0 c3       jnz / xor eax, eax / ret
 * 48 8b 01             mov  rax, [rcx]            ; vtable->klass
 * 48 63 40 5c          movsxd rax, [rax+0x5c]     ; klass->vtable_size
 * 48 8b 44 c1 48       mov  rax, [rcx+rax*8+0x48] ; vtable->vtable[vtable_size]
 * ```
 */
function decodeStaticDataAccessor(
  target: ProcessHandle,
  mono: ModuleInfo,
): Pick<MonoLayout, 'vtableFlags' | 'vtableHasStaticsBit' | 'classVtableSize' | 'vtableSlots'> {
  const address = findExport(target, mono, 'mono_vtable_get_static_field_data');
  if (address === null)
    throw new MonoLayoutError('Export absent : mono_vtable_get_static_field_data');

  const b = readMemory(target, address, 22);
  const attendu =
    b !== null &&
    b[0] === 0xf6 &&
    b[1] === 0x41 &&
    b[4] === 0x75 &&
    b[6] === 0x33 &&
    b[8] === 0xc3 &&
    b[9] === 0x48 &&
    b[10] === 0x8b &&
    b[11] === 0x01 &&
    b[12] === 0x48 &&
    b[13] === 0x63 &&
    b[14] === 0x40 &&
    b[16] === 0x48 &&
    b[17] === 0x8b &&
    b[18] === 0x44 &&
    b[19] === 0xc1;
  if (!attendu) {
    throw new MonoLayoutError(
      `mono_vtable_get_static_field_data : prologue inattendu (${b?.toString('hex') ?? '?'})`,
    );
  }

  return {
    vtableFlags: BigInt(b[2]!),
    vtableHasStaticsBit: b[3]!,
    classVtableSize: BigInt(b[15]!),
    vtableSlots: BigInt(b[20]!),
  };
}

/** Decode `lea rax, [rcx+disp32]; ret` (48 8d 81 XX XX XX XX c3). */
function leaOffset(target: ProcessHandle, fn: bigint): bigint | null {
  const b = readMemory(target, fn, 8);
  if (b === null || b[0] !== 0x48 || b[1] !== 0x8d || b[2] !== 0x81 || b[7] !== 0xc3) return null;
  return BigInt(b.readInt32LE(3));
}

/** Etendue du module, pour reconnaitre un pointeur vers son code. */
function moduleRange(target: ProcessHandle, mono: ModuleInfo): [bigint, bigint] {
  const dos = readMemory(target, mono.base, 0x40);
  if (dos === null) throw new MonoLayoutError('En-tête du module Mono illisible');
  const pe = mono.base + BigInt(dos.readUInt32LE(0x3c));
  // SizeOfImage : offset 56 de l'optional header PE32+, lui-meme a pe+24.
  const size = readMemory(target, pe + 24n + 56n, 4)?.readUInt32LE(0) ?? 0;
  return [mono.base, mono.base + BigInt(size)];
}

/**
 * Situe `MonoImage.class_cache` par sa signature de `MonoInternalHashTable` :
 *
 * `{ hash_func; key_extract; next_value; int size; int num_entries; table; }`
 *
 * Les trois premiers pointent dans le code de Mono, `next_value` est un
 * `lea rax, [rcx+X]; ret` qui donne au passage le decalage du chainage dans
 * `MonoClass`. Trouve a 0x4d0 le 24/09/2026, avec 6 247 cases pour 14 095
 * classes dans `Assembly-CSharp`.
 */
function locateClassCache(
  target: ProcessHandle,
  mono: ModuleInfo,
  image: bigint,
): { imageClassCache: bigint; classNextInCache: bigint } {
  const [debut, fin] = moduleRange(target, mono);
  const dansMono = (p: bigint): boolean => p >= debut && p < fin;
  const brut = readMemory(target, image, 0x800);
  if (brut === null) throw new MonoLayoutError('MonoImage illisible');

  for (let off = 0; off + 40 <= brut.length; off += 8) {
    const fonctions = [0, 8, 16].map((d) => brut.readBigUInt64LE(off + d));
    if (!fonctions.every(dansMono)) continue;

    const size = brut.readInt32LE(off + 24);
    const entrees = brut.readInt32LE(off + 28);
    if (size <= 0 || entrees <= 0 || brut.readBigUInt64LE(off + 32) < 0x10000n) continue;

    const suivant = leaOffset(target, fonctions[2]!);
    if (suivant !== null) return { imageClassCache: BigInt(off), classNextInCache: suivant };
  }

  throw new MonoLayoutError('Table de classes introuvable dans MonoImage');
}

/**
 * Situe `MonoClass.runtime_info` : le seul pointeur `p` de la classe tel que
 * `p->domain_vtables[0]->klass` revienne a la classe, sans etre la classe
 * elle-meme (sinon `element_class`, qui pointe sur soi, passerait aussi).
 * Trouve a 0xd0 le 24/09/2026.
 */
function locateRuntimeInfo(target: ProcessHandle, cls: bigint): bigint | null {
  const brut = readMemory(target, cls, 0x140);
  if (brut === null) return null;

  for (let off = 0; off < brut.length; off += 8) {
    const p = brut.readBigUInt64LE(off);
    if (p < 0x10000n) continue;
    const vtable = readPointer(target, p + RUNTIME_INFO_FIRST_VTABLE);
    if (vtable !== 0n && vtable !== cls && readPointer(target, vtable) === cls) return BigInt(off);
  }
  return null;
}

/**
 * Calcule toute la disposition d'une traite.
 *
 * `probeClass` doit avoir ses statiques initialisees, pour que
 * `runtime_info` soit reperable : n'importe quelle classe deja utilisee par
 * le jeu convient, `Assembly-CSharp` en regorge.
 */
export function resolveLayout(target: ProcessHandle, mono: ModuleInfo, image: bigint): MonoLayout {
  const cache = locateClassCache(target, mono, image);
  const partiel = {
    className: BigInt(fieldOffsetFromAccessor(target, mono, 'mono_class_get_name')),
    classNamespace: BigInt(fieldOffsetFromAccessor(target, mono, 'mono_class_get_namespace')),
    fieldName: BigInt(fieldOffsetFromAccessor(target, mono, 'mono_field_get_name')),
    classFields: CLASS_FIELDS,
    ...cache,
    ...decodeStaticDataAccessor(target, mono),
  };

  // runtime_info : on essaie les classes jusqu'a en trouver une initialisee.
  for (const cls of iterateClasses(target, image, partiel)) {
    const off = locateRuntimeInfo(target, cls);
    if (off !== null) return { ...partiel, classRuntimeInfo: off };
  }

  throw new MonoLayoutError('MonoClass.runtime_info introuvable');
}

/** Toutes les classes d'une image. */
export function* iterateClasses(
  target: ProcessHandle,
  image: bigint,
  layout: Pick<MonoLayout, 'imageClassCache' | 'classNextInCache'>,
): Generator<bigint> {
  const cache = image + layout.imageClassCache;
  const size = readMemory(target, cache + 24n, 4)?.readInt32LE(0) ?? 0;
  if (size <= 0 || size > 1_000_000) return;

  const cases = readMemory(target, readPointer(target, cache + 32n), size * 8);
  if (cases === null) return;

  for (let i = 0; i < size; i += 1) {
    let cls = cases.readBigUInt64LE(i * 8);
    for (let n = 0; cls !== 0n && n < MAX_CHAIN; n += 1) {
      yield cls;
      cls = readPointer(target, cls + layout.classNextInCache);
    }
  }
}

export function className(target: ProcessHandle, cls: bigint, layout: MonoLayout): string | null {
  return readCString(target, readPointer(target, cls + layout.className), 256);
}

/** Classe par son nom simple, sans espace de noms. Premier trouve. */
export function findClass(
  target: ProcessHandle,
  image: bigint,
  layout: MonoLayout,
  name: string,
): bigint | null {
  for (const cls of iterateClasses(target, image, layout)) {
    if (className(target, cls, layout) === name) return cls;
  }
  return null;
}

export interface MonoField {
  name: string;
  /** Decalage dans l'instance, ou dans le bloc des statiques si `isStatic`. */
  offset: number;
  isStatic: boolean;
}

/**
 * Champs declares par la classe (pas ceux herites).
 *
 * S'arrete des qu'un `MonoClassField` ne designe plus la classe comme parent :
 * c'est la fin du tableau, et c'est aussi ce qui detecterait un
 * `CLASS_FIELDS` perime apres un patch.
 */
export function listFields(target: ProcessHandle, cls: bigint, layout: MonoLayout): MonoField[] {
  const tableau = readPointer(target, cls + layout.classFields);
  if (tableau === 0n) return [];

  const champs: MonoField[] = [];
  for (let i = 0n; i < BigInt(MAX_FIELDS); i += 1n) {
    const champ = tableau + i * FIELD_SIZE;
    if (readPointer(target, champ + FIELD_PARENT) !== cls) break;

    const attrs = readMemory(target, readPointer(target, champ + FIELD_TYPE) + TYPE_ATTRS, 2);
    champs.push({
      name: readCString(target, readPointer(target, champ + layout.fieldName), 256) ?? '?',
      offset: readMemory(target, champ + FIELD_OFFSET, 4)?.readInt32LE(0) ?? 0,
      isStatic: ((attrs?.readUInt16LE(0) ?? 0) & FIELD_ATTRIBUTE_STATIC) !== 0,
    });
  }
  return champs;
}

export function findField(
  target: ProcessHandle,
  cls: bigint,
  layout: MonoLayout,
  name: string,
): MonoField | null {
  return listFields(target, cls, layout).find((f) => f.name === name) ?? null;
}

/**
 * Bloc des statiques de la classe dans le domaine racine.
 *
 * `0n` tant que la classe n'a pas ete initialisee par le jeu : ses statiques
 * n'existent pas encore, ce n'est pas une erreur.
 */
export function staticData(target: ProcessHandle, cls: bigint, layout: MonoLayout): bigint {
  const runtimeInfo = readPointer(target, cls + layout.classRuntimeInfo);
  if (runtimeInfo === 0n) return 0n;

  const vtable = readPointer(target, runtimeInfo + RUNTIME_INFO_FIRST_VTABLE);
  if (vtable === 0n) return 0n;

  const drapeaux = readMemory(target, vtable + layout.vtableFlags, 1)?.[0] ?? 0;
  if ((drapeaux & layout.vtableHasStaticsBit) === 0) return 0n;

  const taille = readMemory(target, cls + layout.classVtableSize, 4)?.readInt32LE(0) ?? 0;
  return readPointer(target, vtable + layout.vtableSlots + BigInt(taille) * 8n);
}

/** Classe d'un objet gere : `object->vtable->klass`. */
export function classOf(target: ProcessHandle, object: bigint): bigint {
  return readPointer(target, readPointer(target, object));
}
