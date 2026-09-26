/**
 * CLI : `npm run stats [--from AAAA-MM-JJ] [--to ...] [--hero <cardId>] [--db ...]`
 *
 * Affiche les analyses de la phase 3 dans le terminal, en attendant
 * l'application Electron. Les memes fonctions alimenteront les deux.
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DB_PATH, openDatabase } from '../db/database.js';
import {
  finalBoardRaces,
  heroStats,
  overview,
  placeDistribution,
  playedHeroes,
  tierCurve,
  timeline,
  type StatsFilters,
} from '../stats/stats.js';

export interface StatsCliOptions extends StatsFilters {
  db: string;
}

export function parseStatsArgs(argv: readonly string[]): StatsCliOptions {
  const options: StatsCliOptions = { db: DEFAULT_DB_PATH };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];

    if (arg === '--incomplete') {
      options.includeIncomplete = true;
      continue;
    }
    if (!['--db', '--from', '--to', '--hero', '--mode'].includes(arg)) {
      throw new Error(`Option inconnue : ${arg}`);
    }
    if (next === undefined) throw new Error(`Valeur manquante apres ${arg}`);
    i += 1;

    if (arg === '--db') options.db = next;
    if (arg === '--from') options.from = next;
    if (arg === '--to') options.to = next;
    if (arg === '--hero') options.heroBaseId = next;
    if (arg === '--mode') options.mode = next;
  }

  return options;
}

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)} %`;
}

function num(value: number | null, digits = 2): string {
  return value === null ? '—' : value.toFixed(digits);
}

/** Petite barre horizontale, pour lire une repartition d'un coup d'oeil. */
function bar(share: number, width = 24): string {
  const filled = Math.round(share * width);
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

function main(): void {
  const { db: path, ...filters } = parseStatsArgs(process.argv.slice(2));
  const db = openDatabase(path);

  const summary = overview(db, filters);
  if (summary.games === 0) {
    console.log('Aucune partie ne correspond aux filtres.');
    db.close();
    return;
  }

  console.log('═══ Vue d’ensemble ═══');
  console.log(
    `  ${summary.games} parties, du ${summary.firstGame?.slice(0, 10)} au ${summary.lastGame?.slice(0, 10)}`,
  );
  console.log(`  Place moyenne  ${num(summary.averagePlace)}`);
  console.log(`  Top 4          ${pct(summary.top4Rate)}`);
  console.log(`  Victoires      ${summary.wins}`);
  console.log(`  Dernière cote  ${summary.latestRating ?? '—'}`);

  console.log('\n═══ Répartition des places ═══');
  for (const row of placeDistribution(db, filters)) {
    console.log(
      `  ${row.place}e  ${bar(row.share)} ${String(row.games).padStart(2)}  ${pct(row.share).padStart(5)}`,
    );
  }

  console.log('\n═══ Héros ═══');
  console.log('  héros                          joué  proposé  sélection  place moy.  top 4');
  const heroRows = heroStats(db, filters);
  // Les héros proposés mais jamais pris encombrent la liste : on les résume.
  const neverPicked = heroRows.filter((row) => row.played === 0);

  for (const row of heroRows.filter((row) => row.played > 0)) {
    console.log(
      `  ${row.heroName.slice(0, 30).padEnd(30)} ${String(row.played).padStart(4)}` +
        ` ${String(row.offered).padStart(8)} ${pct(row.pickRate).padStart(10)}` +
        ` ${num(row.averagePlace).padStart(11)} ${pct(row.top4Rate).padStart(6)}`,
    );
  }

  if (neverPicked.length > 0) {
    const offers = neverPicked.reduce((total, row) => total + row.offered, 0);
    console.log(`  … et ${neverPicked.length} héros proposés ${offers} fois, jamais choisis.`);
  }

  console.log('\n═══ Montée de taverne : top 4 contre le reste ═══');
  console.log('  palier   top 4    reste   écart');
  for (const row of tierCurve(db, filters)) {
    const gap =
      row.top4Turn !== null && row.otherTurn !== null ? row.top4Turn - row.otherTurn : null;
    const sign = gap === null ? '' : gap < 0 ? ' (plus tôt)' : ' (plus tard)';
    console.log(
      `  T${row.tier}     ${num(row.top4Turn, 1).padStart(6)}   ${num(row.otherTurn, 1).padStart(6)}` +
        `  ${gap === null ? '—' : (gap > 0 ? '+' : '') + gap.toFixed(1)}${sign}`,
    );
  }

  console.log('\n═══ Type dominant du plateau final ═══');
  for (const row of finalBoardRaces(db, filters)) {
    console.log(
      `  ${row.race.toLowerCase().padEnd(14)} ${String(row.games).padStart(3)} parties` +
        `  place moy. ${num(row.averagePlace)}  top 4 ${pct(row.top4Rate)}`,
    );
  }

  const points = timeline(db, filters);
  console.log('\n═══ Chronologie ═══');
  console.log('  date              héros                     place  cote   moy. glissante');
  for (const point of points) {
    console.log(
      `  ${point.startedAt.slice(0, 16).replace('T', ' ')}  ${point.heroName.slice(0, 24).padEnd(24)}` +
        `  ${String(point.place ?? '—').padStart(5)}  ${String(point.rating ?? '—').padStart(4)}` +
        `   ${num(point.rollingPlace).padStart(5)}`,
    );
  }

  const heroes = playedHeroes(db);
  console.log(
    `\n${heroes.length} héros différents joués. Filtrer avec --hero <cardId>, --from, --to.`,
  );
  db.close();
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
