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
  { key: 'hoursPlayed', label: 'Heures de jeu' },
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

  const inserer = db.prepare('INSERT OR REPLACE INTO career_snapshots (taken_at, stat, value) VALUES (?, ?, ?)');
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
export function careerView(
  db: Db,
  since: string,
): { takenAt: string; lines: CareerLine[] } | null {
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
