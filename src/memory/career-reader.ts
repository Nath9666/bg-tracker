/**
 * Statistiques de carriere et dernieres troupes, lues dans la memoire du jeu.
 *
 * Elles vivent dans `BaconStatsPageDataModel`, le modele de l'ecran de
 * statistiques des Champs de bataille. Aucune variable globale n'y mene : on
 * retrouve l'objet en cherchant son pointeur de table virtuelle dans le tas
 * (`findPointerOccurrences`), puis on ne garde que l'instance coherente.
 *
 * Trouve et verifie le 26/09/2026 contre les chiffres affiches par le jeu :
 * 1188 tops 4, 188 victoires, 145 916 serviteurs tues, 5 512 triples,
 * 9 106 ameliorations, 1 449 joueurs elimines, 124 303 degats en un tour,
 * 29 805/58 794, 3 204 502 s (890 h), serie de 14 -- tous identiques. La
 * premiere des cinq troupes recoupe le plateau final tire des logs pour la
 * meme partie.
 *
 * Tout est retrouve **par nom de champ**. L'instance n'existe qu'une fois
 * l'ecran de statistiques ouvert au moins une fois dans la session du jeu :
 * avant, la lecture rend `null`.
 */
import { findAssembly, getRootDomain, listAssemblies, MonoLayoutError } from './mono-runtime.js';
import {
  classOf,
  className,
  findClass,
  listFields,
  resolveLayout,
  type MonoLayout,
} from './mono-classes.js';
import {
  closeProcess,
  findModule,
  findPointerOccurrences,
  findProcessIdByName,
  openProcess,
  readInt32,
  readMemory,
  readPointer,
  type ProcessHandle,
} from './process-memory.js';

/** `MonoArray` : les elements commencent apres l'en-tete et la longueur. */
const ARRAY_DATA = 0x20n;
/** `MonoString` : longueur (int32) puis caracteres UTF-16. */
const STRING_LENGTH = 0x10n;
const STRING_CHARS = 0x14n;
/** `MonoClass.parent`, confirme par `mono_class_get_parent`. */
const CLASS_PARENT = 0x30n;
const RUNTIME_INFO_FIRST_VTABLE = 0x08n;

/** Champ du jeu -> clef enregistree (voir src/career/career.ts). */
const COMPTEURS: Record<string, string> = {
  m_Top4Finishes: 'top4',
  m_FirstPlaceFinishes: 'wins',
  m_MinionsDestroyed: 'minionsKilled',
  m_TriplesCreated: 'triples',
  m_TavernUpgrades: 'tavernUpgrades',
  m_PlayersEliminated: 'playersEliminated',
  m_DamageInOneTurn: 'maxMinionDamage',
  m_BiggestMinionAttack: 'strongestMinionAtk',
  m_BiggestMinionHealth: 'strongestMinionHealth',
  m_SecondsPlayed: 'secondsPlayed',
  m_LongestWinStreak: 'bestStreak',
};

export interface WarbandMinion {
  cardId: string;
  atk: number;
  health: number;
  /** Lu sur l'identifiant (`_G`, `TB_BaconUps_`) : `m_Premium` reste a 0 dans ce modele. */
  golden: boolean;
}

export interface PastWarband {
  heroCardId: string | null;
  heroName: string | null;
  place: number;
  minions: WarbandMinion[];
}

export interface CareerReading {
  stats: Record<string, number>;
  /** Les dernieres troupes, de la plus recente a la plus ancienne. */
  warbands: PastWarband[];
}

/** Champs d'instance d'une classe et de ses parents, par nom. Mis en cache. */
function offsets(
  target: ProcessHandle,
  layout: MonoLayout,
  cache: Map<bigint, Map<string, bigint>>,
  cls: bigint,
) {
  let table = cache.get(cls);
  if (table === undefined) {
    table = new Map();
    for (
      let c = cls, n = 0;
      c !== 0n && n < 20;
      c = readPointer(target, c + CLASS_PARENT), n += 1
    ) {
      for (const f of listFields(target, c, layout)) {
        if (!f.isStatic && !table.has(f.name)) table.set(f.name, BigInt(f.offset));
      }
    }
    cache.set(cls, table);
  }
  return table;
}

function lecteur(target: ProcessHandle, layout: MonoLayout) {
  const cache = new Map<bigint, Map<string, bigint>>();
  const decalage = (obj: bigint, nom: string): bigint => {
    const off = offsets(target, layout, cache, classOf(target, obj)).get(nom);
    if (off === undefined) {
      throw new MonoLayoutError(
        `Champ ${nom} introuvable sur ${className(target, classOf(target, obj), layout)}`,
      );
    }
    return off;
  };
  const pointeur = (obj: bigint, nom: string): bigint =>
    readPointer(target, obj + decalage(obj, nom));
  const entier = (obj: bigint, nom: string): number | null =>
    readInt32(target, obj + decalage(obj, nom));
  const chaine = (obj: bigint): string | null => {
    if (obj === 0n) return null;
    const n = readInt32(target, obj + STRING_LENGTH);
    if (n === null || n < 0 || n > 1000) return null;
    return readMemory(target, obj + STRING_CHARS, n * 2)?.toString('utf16le') ?? null;
  };
  /** Elements d'un `DataModelList<T>`, via sa `List<T>` interne. */
  const liste = (obj: bigint): bigint[] => {
    if (obj === 0n) return [];
    const interne = pointeur(obj, 'm_list');
    const items = pointeur(interne, '_items');
    const taille = entier(interne, '_size') ?? 0;
    const out: bigint[] = [];
    for (let i = 0n; i < BigInt(Math.min(Math.max(taille, 0), 64)); i += 1n) {
      const e = readPointer(target, items + ARRAY_DATA + i * 8n);
      if (e !== 0n) out.push(e);
    }
    return out;
  };
  return { pointeur, entier, chaine, liste };
}

function lireTroupe(l: ReturnType<typeof lecteur>, partie: bigint): PastWarband {
  const heros = l.pointeur(partie, 'm_Hero');
  return {
    heroCardId: heros === 0n ? null : l.chaine(l.pointeur(heros, 'm_CardId')),
    heroName: l.chaine(l.pointeur(partie, 'm_HeroName')),
    place: l.entier(partie, 'm_Place') ?? 0,
    minions: l.liste(l.pointeur(partie, 'm_Minions')).map((carte) => {
      const cardId = l.chaine(l.pointeur(carte, 'm_CardId')) ?? '';
      return {
        cardId,
        atk: l.entier(carte, 'm_Attack') ?? 0,
        health: l.entier(carte, 'm_Health') ?? 0,
        golden: /_G$/.test(cardId) || cardId.startsWith('TB_BaconUps_'),
      };
    }),
  };
}

/** Des compteurs de carriere plausibles : positifs, et un top 4 au moins egal aux victoires. */
function coherent(stats: Record<string, number>): boolean {
  const valeurs = Object.values(stats);
  if (valeurs.length !== Object.keys(COMPTEURS).length) return false;
  if (valeurs.some((v) => v < 0)) return false;
  return (stats['top4'] ?? 0) >= (stats['wins'] ?? 0) && (stats['secondsPlayed'] ?? 0) > 0;
}

/**
 * Lit les statistiques de carriere. `null` si le jeu n'est pas lance, ou si
 * l'ecran de statistiques n'a pas encore ete ouvert dans cette session.
 */
export function readCareer(): CareerReading | null {
  const pid = findProcessIdByName('Hearthstone.exe');
  if (pid === null) return null;

  const target = openProcess(pid);
  try {
    const mono = findModule(target, /^mono.*\.dll$/i);
    if (mono === null) return null;
    const csharp = findAssembly(
      listAssemblies(target, mono, getRootDomain(target, mono)),
      'Assembly-CSharp',
    );
    if (csharp === null) return null;

    const layout = resolveLayout(target, mono, csharp.image);
    const cls = findClass(target, csharp.image, layout, 'BaconStatsPageDataModel');
    if (cls === null) throw new MonoLayoutError('Classe BaconStatsPageDataModel introuvable');

    // Classe jamais utilisee dans la session : pas de vtable, donc pas d'instance.
    const runtimeInfo = readPointer(target, cls + layout.classRuntimeInfo);
    const vtable =
      runtimeInfo === 0n ? 0n : readPointer(target, runtimeInfo + RUNTIME_INFO_FIRST_VTABLE);
    if (vtable === 0n) return null;

    const l = lecteur(target, layout);
    const candidats: CareerReading[] = [];

    for (const objet of findPointerOccurrences(target, vtable)) {
      try {
        const stats: Record<string, number> = {};
        for (const [champ, clef] of Object.entries(COMPTEURS)) {
          const v = l.entier(objet, champ);
          if (v !== null) stats[clef] = v;
        }
        if (!coherent(stats)) continue;

        // Une vraie instance a une liste de parties passees bien formee.
        const passees = l.pointeur(objet, 'm_PastGames');
        if (
          passees === 0n ||
          className(target, classOf(target, passees), layout) !== 'DataModelList`1'
        )
          continue;

        candidats.push({ stats, warbands: l.liste(passees).map((p) => lireTroupe(l, p)) });
      } catch {
        // Memoire liberee qui porte encore l'ancienne vtable : on l'ignore.
      }
    }

    // Plusieurs copies coherentes : les compteurs ne font que croitre, la
    // plus grande est la plus recente.
    candidats.sort(
      (a, b) =>
        (b.stats['secondsPlayed'] ?? 0) - (a.stats['secondsPlayed'] ?? 0) ||
        (b.stats['top4'] ?? 0) - (a.stats['top4'] ?? 0),
    );
    return candidats[0] ?? null;
  } finally {
    closeProcess(target);
  }
}
