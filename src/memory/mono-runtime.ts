/**
 * Marche dans le runtime Mono d'un processus, pour en retrouver les
 * assemblies. C'est la premiere etape vers la classe et le champ qui portent
 * la cote (MMR) : voir `CLAUDE.md` pour pourquoi ce module existe.
 *
 * On ne peut pas **executer** de code dans le processus vise (on n'a que
 * `PROCESS_VM_READ`) : chaque fonction Mono exportee sert donc a se reperer
 * dans la structure, jamais a etre appelee. Deux motifs reviennent :
 *
 * - un accesseur trivial `mov rax, [rcx+X]; ret` donne directement le
 *   decalage d'un champ (`X`) sans avoir a le deviner ;
 * - une fonction qui renvoie une variable globale fait
 *   `mov rax, [rip+X]; ret` : `X` donne l'adresse de la variable, pas sa
 *   valeur (il faut encore la lire).
 *
 * Quand un tel accesseur existe, on **redecouvre le decalage a chaque
 * lancement** plutot que de le figer dans le code : si un patch deplace le
 * champ, l'export officiel bouge avec, et le code suit sans modification.
 * Le seul decalage code en dur ici (`domain_assemblies`) n'a pas d'accesseur
 * expose ; il est derive par desassemblage (voir le commentaire dessus) et
 * **verifie au moment de l'usage** en cherchant `mscorlib` dans le resultat.
 */
import { findExport } from './pe-exports.js';
import { readCString, readMemory, readPointer } from './process-memory.js';
import type { ModuleInfo, ProcessHandle } from './process-memory.js';

/**
 * Le runtime n'a pas la forme attendue : export absent, prologue qui ne
 * correspond a aucun motif connu, ou verification de coherence echouee.
 * Signale un patch qui a change le runtime, jamais une simple absence de
 * donnee (qui rend `null`, elle).
 */
export class MonoLayoutError extends Error {}

/**
 * Decode `mov rax, [rip+disp32]; ret` (48 8b 05 XX XX XX XX c3).
 *
 * Rend l'**adresse de la variable globale**, pas sa valeur : a l'appelant de
 * la lire avec `readPointer`. C'est le motif de `mono_get_root_domain`, qui
 * ne fait que renvoyer `mono_root_domain`.
 */
export function resolveRipRelativeGlobal(target: ProcessHandle, functionAddress: bigint): bigint {
  const bytes = readMemory(target, functionAddress, 7);
  if (bytes === null) throw new MonoLayoutError('Prologue illisible');

  if (bytes[0] !== 0x48 || bytes[1] !== 0x8b || bytes[2] !== 0x05) {
    throw new MonoLayoutError(
      `Prologue inattendu (${bytes.toString('hex')}) : le runtime a peut-être changé`,
    );
  }

  const displacement = bytes.readInt32LE(3);
  return functionAddress + 7n + BigInt(displacement);
}

/**
 * Decode un accesseur trivial et rend le decalage de champ qu'il expose.
 *
 * Deux formes, selon que le decalage tient sur un octet ou non :
 * `mov rax, [rcx+disp8]; ret` (48 8b 41 XX c3) ou
 * `mov rax, [rcx+disp32]; ret` (48 8b 81 XX XX XX XX c3).
 */
export function fieldOffsetFromAccessor(
  target: ProcessHandle,
  module: ModuleInfo,
  exportName: string,
): number {
  const address = findExport(target, module, exportName);
  if (address === null) throw new MonoLayoutError(`Export absent : ${exportName}`);

  const bytes = readMemory(target, address, 8);
  if (bytes === null) throw new MonoLayoutError(`${exportName} : prologue illisible`);

  if (bytes[0] === 0x48 && bytes[1] === 0x8b && bytes[2] === 0x41 && bytes[4] === 0xc3) {
    return bytes[3]!;
  }
  if (bytes[0] === 0x48 && bytes[1] === 0x8b && bytes[2] === 0x81 && bytes[7] === 0xc3) {
    return bytes.readInt32LE(3);
  }

  throw new MonoLayoutError(
    `${exportName} : prologue inattendu (${bytes.toString('hex')}), le runtime a peut-être changé`,
  );
}

/** Adresse du `MonoDomain*` racine, celui qui porte les assemblies chargees. */
export function getRootDomain(target: ProcessHandle, mono: ModuleInfo): bigint {
  const fn = findExport(target, mono, 'mono_get_root_domain');
  if (fn === null) throw new MonoLayoutError('Export absent : mono_get_root_domain');

  const globalVar = resolveRipRelativeGlobal(target, fn);
  const domain = readPointer(target, globalVar);
  if (domain === 0n) {
    throw new MonoLayoutError('Domaine racine nul : le jeu est peut-être encore en démarrage');
  }

  return domain;
}

export interface MonoAssemblyRef {
  /** Pointeur `MonoAssembly*`, pour continuer la marche vers ses classes. */
  assembly: bigint;
  /** Pointeur `MonoImage*` (`assembly->image`). */
  image: bigint;
  name: string;
}

/**
 * Decalage de `MonoDomain.domain_assemblies` (`GSList*`).
 *
 * Aucun export ne le donne directement (contrairement a `image` ou `name`
 * plus bas) : derive une fois par desassemblage de
 * `mono_domain_assembly_foreach`, sur le build Hearthstone du 24/09/2026:
 *
 * ```
 * 48 8d b9 a0 01 00 00   lea  rdi, [rcx+0x1a0]     ; &domain->assemblies_lock
 * 48 8b d9                mov  rbx, rcx             ; rbx = domain
 * ...                                                  (acquisition du verrou)
 * 48 8b 9b a0 00 00 00   mov  rbx, [rbx+0xa0]      ; rbx = domain->domain_assemblies
 * 48 85 db                test rbx, rbx
 * 74 17                   jz   (liste vide)
 * 48 8b 0b                mov  rcx, [rbx]           ; GSList.data (offset 0)
 * ...
 * 48 8b 5b 08              mov  rbx, [rbx+8]         ; GSList.next (offset 8)
 * ```
 *
 * Le motif `{data@0, next@8}` est celui de `GSList` (GLib), stable par
 * construction. Seul `0xa0` est propre a Mono et peut se deplacer a un patch :
 * `listAssemblies` le verifie a chaque appel en cherchant `mscorlib`.
 */
const DOMAIN_ASSEMBLIES_OFFSET = 0xa0;
const GSLIST_DATA_OFFSET = 0n;
const GSLIST_NEXT_OFFSET = 8n;

/** Largement au-dessus des ~120 assemblies d'une session Hearthstone : sert de filet contre une liste mal lue qui boucle sur elle-même. */
const MAX_ASSEMBLIES = 500;

/**
 * Toutes les assemblies chargees dans le domaine.
 *
 * Leve `MonoLayoutError` si `mscorlib` n'apparait pas dans le resultat : la
 * seule explication plausible est que `DOMAIN_ASSEMBLIES_OFFSET` a change
 * avec un patch, et il vaut mieux le dire tout de suite que de rendre une
 * liste tronquee ou du bruit sans le signaler.
 */
export function listAssemblies(
  target: ProcessHandle,
  mono: ModuleInfo,
  domain: bigint,
): MonoAssemblyRef[] {
  const imageOffset = BigInt(fieldOffsetFromAccessor(target, mono, 'mono_assembly_get_image'));
  const nameOffset = BigInt(fieldOffsetFromAccessor(target, mono, 'mono_image_get_name'));

  const result: MonoAssemblyRef[] = [];
  let node = readPointer(target, domain + BigInt(DOMAIN_ASSEMBLIES_OFFSET));

  for (let i = 0; node !== 0n && i < MAX_ASSEMBLIES; i += 1) {
    const assembly = readPointer(target, node + GSLIST_DATA_OFFSET);
    const image = readPointer(target, assembly + imageOffset);
    const namePtr = readPointer(target, image + nameOffset);
    const name = readCString(target, namePtr, 128);

    if (assembly !== 0n && name !== null) result.push({ assembly, image, name });
    node = readPointer(target, node + GSLIST_NEXT_OFFSET);
  }

  if (!result.some((a) => a.name === 'mscorlib')) {
    throw new MonoLayoutError(
      'mscorlib absent du résultat : le décalage domain_assemblies (0xa0) a sans doute ' +
        'changé avec un patch. Le redériver (voir le commentaire au-dessus de listAssemblies).',
    );
  }

  return result;
}

/** Une assembly par son nom exact, ex. `Assembly-CSharp`. */
export function findAssembly(
  assemblies: readonly MonoAssemblyRef[],
  name: string,
): MonoAssemblyRef | null {
  return assemblies.find((a) => a.name === name) ?? null;
}
