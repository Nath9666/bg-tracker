/**
 * Statistiques de carriere des Champs de bataille.
 *
 * Tenues par le serveur et affichees par le jeu dans son ecran de
 * statistiques : elles couvrent toute la carriere, bien au-dela des parties
 * vues par le tracker. Aucun log ne les porte ; elles viennent de la memoire
 * du jeu (src/memory/). Ce module ne sait que les ranger et les relire.
 */
import type { Db } from '../db/database.js';

/**
 * Les compteurs connus, dans l'ordre d'affichage du jeu. D'autres peuvent
 * etre enregistres : la table est en clef/valeur.
 */
export const CAREER_STATS = [
  { key: 'top4', label: 'Tops 4' },
  { key: 'wins', label: '1res places' },
  { key: 'minionsKilled', label: 'Serviteurs tués' },
  { key: 'triples', label: 'Triples créés' },
  { key: 'tavernUpgrades', label: 'Améliorations de taverne' },
  { key: 'playersEliminated', label: 'Joueurs éliminés' },
  { key: 'maxMinionDamage', label: 'Dégâts max d’un serviteur' },
  { key: 'strongestMinionAtk', label: 'Plus puissant serviteur (attaque)' },
  { key: 'strongestMinionHealth', label: 'Plus puissant serviteur (vie)' },
  // En secondes, comme le jeu : en heures, les progressions perdraient leur precision.
  { key: 'secondsPlayed', label: 'Heures de jeu' },
  { key: 'bestStreak', label: 'Meilleure série' },
] as const;

export type CareerStats = Record<string, number>;

/** Dernier releve enregistre, ou `null` s'il n'y en a aucun. */
export function latestSnapshot(db: Db): { takenAt: string; stats: CareerStats } | null {
  const derniere = db.prepare('SELECT MAX(taken_at) AS takenAt FROM career_snapshots').get() as {
    takenAt: string | null;
  };
  if (derniere.takenAt === null) return null;
  return { takenAt: derniere.takenAt, stats: snapshotAt(db, derniere.takenAt) };
}

function snapshotAt(db: Db, takenAt: string): CareerStats {
  const rows = db
    .prepare('SELECT stat, value FROM career_snapshots WHERE taken_at = ?')
    .all(takenAt) as { stat: string; value: number }[];
  return Object.fromEntries(rows.map((r) => [r.stat, r.value]));
}

/**
 * Enregistre un releve, sauf s'il est identique au precedent.
 *
 * Le jeu relit ces chiffres chaque fois que l'ecran s'ouvre ; sans ce filtre,
 * la table se remplirait de copies. Rend vrai si quelque chose a ete ecrit.
 */
export function saveSnapshot(db: Db, takenAt: string, stats: CareerStats): boolean {
  const entrees = Object.entries(stats).filter(([, v]) => Number.isFinite(v));
  if (entrees.length === 0) return false;

  const precedent = latestSnapshot(db)?.stats ?? {};
  const identique =
    entrees.length === Object.keys(precedent).length &&
    entrees.every(([k, v]) => precedent[k] === v);
  if (identique) return false;

  const inserer = db.prepare(
    'INSERT OR REPLACE INTO career_snapshots (taken_at, stat, value) VALUES (?, ?, ?)',
  );
  db.transaction(() => {
    for (const [stat, value] of entrees) inserer.run(takenAt, stat, Math.round(value));
  })();
  return true;
}

export interface CareerLine {
  key: string;
  label: string;
  value: number;
  /** Progression depuis le premier releve de la periode, `null` sans reference. */
  delta: number | null;
}

/**
 * Derniers chiffres, avec leur progression depuis `since` (le premier releve
 * posterieur ou egal a cette date).
 */
export function careerView(db: Db, since: string): { takenAt: string; lines: CareerLine[] } | null {
  const dernier = latestSnapshot(db);
  if (dernier === null) return null;

  const reference = db
    .prepare('SELECT MIN(taken_at) AS takenAt FROM career_snapshots WHERE taken_at >= ?')
    .get(since) as { takenAt: string | null };
  const avant =
    reference.takenAt === null || reference.takenAt === dernier.takenAt
      ? null
      : snapshotAt(db, reference.takenAt);

  const connues = new Set<string>(CAREER_STATS.map((s) => s.key));
  const lignes: CareerLine[] = [
    ...CAREER_STATS.filter((s) => dernier.stats[s.key] !== undefined).map((s) => ({
      key: s.key,
      label: s.label,
      value: dernier.stats[s.key]!,
      delta: avant?.[s.key] === undefined ? null : dernier.stats[s.key]! - avant[s.key]!,
    })),
    // Un compteur inconnu reste affiche, sous son nom brut.
    ...Object.entries(dernier.stats)
      .filter(([k]) => !connues.has(k))
      .map(([key, value]) => ({
        key,
        label: key,
        value,
        delta: avant?.[key] === undefined ? null : value - avant[key]!,
      })),
  ];

  return { takenAt: dernier.takenAt, lines: lignes };
}

export interface StoredWarbandMinion {
  cardId: string;
  atk: number;
  health: number;
  golden: boolean;
}

export interface StoredWarband {
  heroCardId: string | null;
  heroName: string | null;
  place: number;
  minions: StoredWarbandMinion[];
}

/** Identite d'une troupe : la meme partie donne toujours la meme signature. */
export function warbandSignature(w: StoredWarband): string {
  const serviteurs = w.minions.map((m) => `${m.cardId}:${m.atk}/${m.health}`).join(',');
  return `${w.heroCardId ?? w.heroName ?? '?'}|${w.place}|${serviteurs}`;
}

/**
 * Enregistre les troupes jamais vues. `warbands` va de la plus recente a la
 * plus ancienne, comme dans le jeu. Rend le nombre de troupes nouvelles.
 */
export function saveWarbands(db: Db, takenAt: string, warbands: readonly StoredWarband[]): number {
  const inserer = db.prepare(
    `INSERT OR IGNORE INTO warbands (signature, first_seen, rank, hero_card_id, hero_name, place, minions)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let nouvelles = 0;
  db.transaction(() => {
    warbands.forEach((w, rang) => {
      const r = inserer.run(
        warbandSignature(w),
        takenAt,
        rang,
        w.heroCardId,
        w.heroName,
        w.place,
        JSON.stringify(w.minions),
      );
      nouvelles += r.changes;
    });
  })();
  return nouvelles;
}

export interface WarbandView extends StoredWarband {
  firstSeen: string;
  minions: Array<StoredWarbandMinion & { name: string; races: string[]; techLevel: number | null }>;
}

/**
 * Les troupes enregistrees, de la plus recente a la plus ancienne : par date
 * de premiere lecture, puis par rang dans ce releve.
 */
export function recentWarbands(db: Db, limit = 5): WarbandView[] {
  const rows = db
    .prepare(
      `SELECT first_seen AS firstSeen, hero_card_id AS heroCardId, hero_name AS heroName, place, minions
       FROM warbands ORDER BY first_seen DESC, rank ASC LIMIT ?`,
    )
    .all(limit) as {
    firstSeen: string;
    heroCardId: string | null;
    heroName: string | null;
    place: number;
    minions: string;
  }[];

  const carte = db.prepare(
    'SELECT name, races, tech_level AS techLevel FROM cards WHERE card_id = ?',
  );
  return rows.map((row) => ({
    firstSeen: row.firstSeen,
    heroCardId: row.heroCardId,
    heroName: row.heroName,
    place: row.place,
    minions: (JSON.parse(row.minions) as StoredWarbandMinion[]).map((m) => {
      const info = carte.get(m.cardId) as
        { name: string; races: string | null; techLevel: number | null } | undefined;
      return {
        ...m,
        name: info?.name ?? m.cardId,
        races: info?.races ? info.races.split(',') : [],
        techLevel: info?.techLevel ?? null,
      };
    }),
  }));
}
