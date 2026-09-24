/**
 * Lecture de la cote des Champs de bataille dans la memoire du jeu.
 *
 * Le chemin, retrouve dans le jeu le 24/09/2026 et verifie contre la
 * derniere ligne de `data/ratings.csv` (5079, identique) :
 *
 * ```
 * ServiceManager.s_runtimeServices        statique, Blizzard.T5.ServiceLocator
 *   .m_services                           Dictionary<Type, ServiceInfo>
 *     ServiceInfo.<Service>k__BackingField   -> l'instance de NetCache
 *       .m_netCache                       Map<Type, object> (dictionnaire Mono ancien)
 *         NetCacheBaconRatingInfo
 *           .<Rating>k__BackingField      cote Solo
 *           .<DuosRating>k__BackingField  cote Duo
 * ```
 *
 * **Chaque champ est retrouve par son nom**, jamais par un decalage fige :
 * si Blizzard reordonne une classe, le chemin tient. Seules les dispositions
 * des conteneurs du runtime (tableau, entree de dictionnaire) sont codees en
 * dur, parce qu'elles ne dependent pas du jeu.
 *
 * Tout echec rend `null` : ce module ne doit jamais empecher le tracker de
 * fonctionner (voir CLAUDE.md).
 */
import { Race } from '@firestone-hs/reference-data';
import { findAssembly, getRootDomain, listAssemblies, MonoLayoutError } from './mono-runtime.js';
import {
  classOf,
  className,
  findClass,
  listFields,
  resolveLayout,
  staticData,
  type MonoLayout,
} from './mono-classes.js';
import {
  closeProcess,
  findModule,
  findProcessIdByName,
  openProcess,
  ProcessNotFound,
  readInt32,
  readPointer,
  type ModuleInfo,
  type ProcessHandle,
} from './process-memory.js';

/** `MonoArray` : vtable, synchronisation, bornes, longueur, puis les elements. */
const ARRAY_DATA = 0x20n;
/**
 * Entree de `Dictionary<K,V>` (corefx) pour une clef et une valeur de type
 * reference : `{ int hashCode; int next; K key; V value; }`, 24 octets.
 */
const DICT_ENTRY_SIZE = 24n;
const DICT_ENTRY_VALUE = 16n;
/** Garde-fou : un conteneur mal lu ne doit pas faire lire des millions d'entrees. */
const MAX_ITEMS = 10_000;

export interface BattlegroundsRating {
  solo: number;
  duos: number;
}

/** Le jeu n'est pas lance, ou la cote n'est pas encore arrivee du serveur. */
export class RatingUnavailable extends Error {}

/** Contexte reutilisable : resoudre la disposition coute quelques centaines de ms. */
export interface RatingReader {
  read(): BattlegroundsRating;
  /**
   * Types de serviteurs tires pour la partie en cours, au format de la base de
   * cartes (`MURLOC`, `MECHANICAL`...). `null` hors partie : `GameState`
   * n'existe que pendant une partie.
   */
  lobbyRaces(): string[] | null;
  close(): void;
}

/** Champ d'instance par son nom, en remontant les classes parentes. */
function fieldOffset(target: ProcessHandle, cls: bigint, layout: MonoLayout, name: string): bigint {
  // MonoClass.parent : 0x30 (`mono_class_get_parent`, `mov rax, [rcx+0x30]`).
  for (let c = cls, n = 0; c !== 0n && n < 20; c = readPointer(target, c + 0x30n), n += 1) {
    const champ = listFields(target, c, layout).find((f) => f.name === name && !f.isStatic);
    if (champ !== undefined) return BigInt(champ.offset);
  }
  throw new MonoLayoutError(`Champ ${name} introuvable sur ${className(target, cls, layout)}`);
}

function readField(target: ProcessHandle, obj: bigint, layout: MonoLayout, name: string): bigint {
  return readPointer(target, obj + fieldOffset(target, classOf(target, obj), layout, name));
}

function typeName(target: ProcessHandle, obj: bigint, layout: MonoLayout): string | null {
  return obj === 0n ? null : className(target, classOf(target, obj), layout);
}

/** Valeurs d'un `Dictionary<K,V>` corefx : `_entries`, `_count`. */
function dictionaryValues(target: ProcessHandle, dict: bigint, layout: MonoLayout): bigint[] {
  const entries = readField(target, dict, layout, '_entries');
  const cls = classOf(target, dict);
  const count = readInt32(target, dict + fieldOffset(target, cls, layout, '_count')) ?? 0;

  const valeurs: bigint[] = [];
  for (let i = 0n; i < BigInt(Math.min(count, MAX_ITEMS)); i += 1n) {
    const valeur = readPointer(target, entries + ARRAY_DATA + i * DICT_ENTRY_SIZE + DICT_ENTRY_VALUE);
    if (valeur !== 0n) valeurs.push(valeur);
  }
  return valeurs;
}

/** Valeurs de l'ancien dictionnaire Mono (`Map\`2` chez Blizzard) : `valueSlots`, `touchedSlots`. */
function mapValues(target: ProcessHandle, map: bigint, layout: MonoLayout): bigint[] {
  const slots = readField(target, map, layout, 'valueSlots');
  const cls = classOf(target, map);
  const touched = readInt32(target, map + fieldOffset(target, cls, layout, 'touchedSlots')) ?? 0;

  const valeurs: bigint[] = [];
  for (let i = 0n; i < BigInt(Math.min(touched, MAX_ITEMS)); i += 1n) {
    const valeur = readPointer(target, slots + ARRAY_DATA + i * 8n);
    if (valeur !== 0n) valeurs.push(valeur);
  }
  return valeurs;
}

interface Context {
  target: ProcessHandle;
  mono: ModuleInfo;
  layout: MonoLayout;
  /** `Assembly-CSharp`, pour y retrouver `GameState`. */
  csharpImage: bigint;
  /** Classe `GameState`, cherchee au premier besoin : parcourir 14 000 classes coute. */
  gameState?: bigint | undefined;
  /** Classe `ServiceManager`, dont la statique `s_runtimeServices` est la racine. */
  serviceManager: bigint;
  runtimeServicesOffset: bigint;
}

function prepare(pid: number): Context {
  const target = openProcess(pid);
  try {
    const mono = findModule(target, /^mono.*\.dll$/i);
    if (mono === null) throw new MonoLayoutError('Module Mono absent du processus');

    const assemblies = listAssemblies(target, mono, getRootDomain(target, mono));
    const csharp = findAssembly(assemblies, 'Assembly-CSharp');
    const locator = findAssembly(assemblies, 'Blizzard.T5.ServiceLocator');
    if (csharp === null || locator === null) {
      throw new MonoLayoutError('Assemblies du jeu absentes : le jeu démarre peut-être encore');
    }

    const layout = resolveLayout(target, mono, csharp.image);
    const serviceManager = findClass(target, locator.image, layout, 'ServiceManager');
    if (serviceManager === null) throw new MonoLayoutError('Classe ServiceManager introuvable');

    const statique = listFields(target, serviceManager, layout).find(
      (f) => f.isStatic && f.name === 's_runtimeServices',
    );
    if (statique === undefined) throw new MonoLayoutError('ServiceManager.s_runtimeServices introuvable');

    return {
      target,
      mono,
      layout,
      csharpImage: csharp.image,
      serviceManager,
      runtimeServicesOffset: BigInt(statique.offset),
    };
  } catch (erreur) {
    closeProcess(target);
    throw erreur;
  }
}

function readRating(ctx: Context): BattlegroundsRating {
  const { target, layout } = ctx;

  const statiques = staticData(target, ctx.serviceManager, layout);
  if (statiques === 0n) throw new RatingUnavailable('Services pas encore initialisés');

  const locator = readPointer(target, statiques + ctx.runtimeServicesOffset);
  if (locator === 0n) throw new RatingUnavailable('Services pas encore initialisés');

  const netCache = dictionaryValues(target, readField(target, locator, layout, 'm_services'), layout)
    .map((info) => readField(target, info, layout, '<Service>k__BackingField'))
    .find((service) => typeName(target, service, layout) === 'NetCache');
  if (netCache === undefined) throw new RatingUnavailable('NetCache pas encore enregistré');

  const info = mapValues(target, readField(target, netCache, layout, 'm_netCache'), layout).find(
    (objet) => typeName(target, objet, layout) === 'NetCacheBaconRatingInfo',
  );
  if (info === undefined) throw new RatingUnavailable('Cote pas encore reçue du serveur');

  const cls = classOf(target, info);
  const solo = readInt32(target, info + fieldOffset(target, cls, layout, '<Rating>k__BackingField'));
  const duos = readInt32(target, info + fieldOffset(target, cls, layout, '<DuosRating>k__BackingField'));
  if (solo === null || duos === null) throw new RatingUnavailable('Cote illisible');

  return { solo, duos };
}

/**
 * `TAG_RACE` (numero) vers le nom employe par la base de cartes.
 *
 * Les logs ecrivent les types en toutes lettres (`CARDRACE value=QUILBOAR`) :
 * ils ne donnent pas la correspondance. On la prend dans l'enumeration `Race`
 * de la bibliotheque de reference de Firestone, maintenue a chaque patch. Un
 * seul nom differe de HearthstoneJSON : `MECH` y est `MECHANICAL`.
 */
export function raceName(value: number): string | null {
  const nom = (Race as unknown as Record<number, string | undefined>)[value];
  if (nom === undefined) return null;
  return nom === 'MECH' ? 'MECHANICAL' : nom;
}

/**
 * `GameState.s_instance.m_availableRacesInBattlegroundsExcludingAmalgam`, une
 * `List<TAG_RACE>`. Trouve le 24/09/2026 en parcourant les champs
 * d'`Assembly-CSharp` ; aucun log ne porte cette liste (verifie).
 */
function readLobbyRaces(ctx: Context): string[] | null {
  const { target, layout } = ctx;

  ctx.gameState ??= findClass(target, ctx.csharpImage, layout, 'GameState') ?? undefined;
  const gameState = ctx.gameState;
  if (gameState === undefined) throw new MonoLayoutError('Classe GameState introuvable');

  const statique = listFields(target, gameState, layout).find(
    (f) => f.isStatic && f.name === 's_instance',
  );
  if (statique === undefined) throw new MonoLayoutError('GameState.s_instance introuvable');

  const statiques = staticData(target, gameState, layout);
  if (statiques === 0n) return null;

  const instance = readPointer(target, statiques + BigInt(statique.offset));
  if (instance === 0n) return null;

  const liste = readField(target, instance, layout, 'm_availableRacesInBattlegroundsExcludingAmalgam');
  if (liste === 0n) return null;

  const items = readField(target, liste, layout, '_items');
  const taille = readInt32(target, liste + fieldOffset(target, classOf(target, liste), layout, '_size')) ?? 0;

  const noms: string[] = [];
  for (let i = 0n; i < BigInt(Math.min(taille, 32)); i += 1n) {
    const valeur = readInt32(target, items + ARRAY_DATA + i * 4n);
    const nom = valeur === null ? null : raceName(valeur);
    if (nom !== null) noms.push(nom);
  }
  return noms;
}

/**
 * Ouvre le jeu et prepare la lecture.
 *
 * Leve `ProcessNotFound` si le jeu n'est pas lance. La preparation (resoudre
 * la disposition, trouver les classes) est faite une fois ; `read()` ne fait
 * ensuite que suivre le chemin, ce qui permet de relire souvent.
 */
export function openRatingReader(): RatingReader {
  const pid = findProcessIdByName('Hearthstone.exe');
  if (pid === null) throw new ProcessNotFound('Hearthstone n’est pas lancé');

  const ctx = prepare(pid);
  return {
    read: () => readRating(ctx),
    lobbyRaces: () => readLobbyRaces(ctx),
    close: () => closeProcess(ctx.target),
  };
}

/**
 * Lecture ponctuelle, sans jamais lever : `null` si la cote n'est pas
 * lisible, pour quelque raison que ce soit.
 */
export function tryReadRating(): BattlegroundsRating | null {
  let lecteur: RatingReader | null = null;
  try {
    lecteur = openRatingReader();
    return lecteur.read();
  } catch {
    return null;
  } finally {
    lecteur?.close();
  }
}
