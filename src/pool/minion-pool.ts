/**
 * Pool de serviteurs des Champs de bataille.
 *
 * Ce qui **peut** sortir de la taverne, palier par palier. C'est une liste de
 * paliers : n'importe qui peut la consulter hors du jeu, elle ne revele rien
 * de la partie en cours.
 *
 * Les types actifs du lobby, eux, ne sont **declares nulle part** dans les
 * logs (verifie : `BACON_SUBSET_*` est porte par chaque carte et enumere ses
 * sous-ensembles, pas ceux de la partie). Ils se deduisent de ce que le joueur
 * a deja vu passer dans la taverne et sur les plateaux adverses, ce qui reste
 * dans la regle de l'overlay.
 */
import type { Db } from '../db/database.js';

/** Serviteurs d'un palier, pour les types retenus. */
export interface TierPool {
  tier: number;
  /** Nombre de serviteurs differents a ce palier. */
  total: number;
  /** Repartition par type, du plus fourni au moins fourni. */
  byRace: { race: string; count: number }[];
}

interface PoolRow {
  cardId: string;
  name: string;
  techLevel: number;
  races: string;
}

export interface PoolMinion {
  cardId: string;
  name: string;
  techLevel: number;
  /** Vide pour un serviteur sans type. `ALL` pour ceux de tous les types. */
  races: string[];
}

/** Sert d'etiquette aux serviteurs sans type, qui sont toujours dans le pool. */
export const SANS_TYPE = 'aucun';

/** Tous les serviteurs du pool, lus une fois puis gardes en memoire. */
export function loadPool(db: Db): PoolMinion[] {
  const rows = db
    .prepare(
      `SELECT card_id AS cardId, name, tech_level AS techLevel, COALESCE(races, '') AS races
       FROM cards
       WHERE is_bg_pool = 1 AND tech_level IS NOT NULL
       ORDER BY tech_level, name`,
    )
    .all() as PoolRow[];

  return rows.map((row) => ({
    cardId: row.cardId,
    name: row.name,
    techLevel: row.techLevel,
    races: row.races === '' ? [] : row.races.split(','),
  }));
}

/**
 * Vrai si un serviteur peut apparaitre dans une partie ou ces types sont actifs.
 *
 * Un serviteur sans type est toujours la, quels que soient les types tires.
 * `ALL` compte comme tous les types a la fois.
 */
export function inLobby(minion: PoolMinion, races: ReadonlySet<string>): boolean {
  if (minion.races.length === 0) return true;
  if (minion.races.includes('ALL')) return true;
  return minion.races.some((race) => races.has(race));
}

/**
 * Repartition du pool par palier, pour les types donnes.
 *
 * Sans type connu, on ne filtre pas : tout le pool est annonce, ce qui est la
 * verite tant qu'on n'a rien vu.
 */
export function poolByTier(
  pool: readonly PoolMinion[],
  races: ReadonlySet<string>,
): TierPool[] {
  const paliers = new Map<number, Map<string, number>>();

  for (const minion of pool) {
    if (races.size > 0 && !inLobby(minion, races)) continue;

    const parType = paliers.get(minion.techLevel) ?? new Map<string, number>();
    const types = minion.races.length === 0 ? [SANS_TYPE] : minion.races;
    for (const race of types) parType.set(race, (parType.get(race) ?? 0) + 1);
    paliers.set(minion.techLevel, parType);
  }

  return [...paliers.entries()]
    .map(([tier, parType]) => ({
      tier,
      // Un serviteur a deux types ne doit compter qu'une fois dans le total.
      total: pool.filter(
        (minion) =>
          minion.techLevel === tier && (races.size === 0 || inLobby(minion, races)),
      ).length,
      byRace: [...parType.entries()]
        .map(([race, count]) => ({ race, count }))
        .sort((a, b) => b.count - a.count || a.race.localeCompare(b.race)),
    }))
    .sort((a, b) => a.tier - b.tier);
}

/**
 * Types du lobby, deduits des serviteurs deja vus.
 *
 * `ALL` et l'absence de type ne disent rien du lobby : ces serviteurs sont la
 * dans toutes les parties, ils sont donc ignores.
 */
export function racesSeen(
  seenCardIds: readonly string[],
  pool: readonly PoolMinion[],
): Set<string> {
  const parCardId = new Map(pool.map((minion) => [minion.cardId, minion]));
  const races = new Set<string>();

  for (const cardId of seenCardIds) {
    for (const race of parCardId.get(cardId)?.races ?? []) {
      if (race !== 'ALL') races.add(race);
    }
  }

  return races;
}
