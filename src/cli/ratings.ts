/**
 * CLI : `npm run ratings [--db <fichier>] [--file <fichier>]`
 *
 * Fait les deux sens en un passage :
 *  - complete `data/ratings.csv` avec une ligne par partie connue, la plus
 *    ancienne d'abord, sans toucher aux cotes deja saisies ;
 *  - rattache les cotes saisies aux parties, la plus proche dans le temps.
 *
 * A relancer apres chaque session : les nouvelles parties apparaissent dans le
 * fichier, il n'y a plus qu'a ecrire la cote en face.
 */
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DB_PATH, openDatabase, type Db } from '../db/database.js';
import {
  DEFAULT_RATINGS_PATH,
  matchRatings,
  parseRatings,
  writeRatingsTemplate,
  type RatedGame,
} from '../ratings/ratings.js';

export interface RatingsCliOptions {
  db: string;
  file: string;
}

export function parseRatingsArgs(argv: readonly string[]): RatingsCliOptions {
  const options: RatingsCliOptions = { db: DEFAULT_DB_PATH, file: DEFAULT_RATINGS_PATH };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--db' || arg === '--file') {
      if (next === undefined) throw new Error(`Valeur manquante apres ${arg}`);
      if (arg === '--db') options.db = next;
      else options.file = next;
      i += 1;
    } else {
      throw new Error(`Option inconnue : ${arg}`);
    }
  }

  return options;
}

/** Parties de la base, dans l'ordre chronologique. */
export function listGames(db: Db): RatedGame[] {
  const rows = db
    .prepare(
      `SELECT g.id,
              COALESCE(g.ended_at, g.started_at) AS datetime,
              g.final_place,
              g.complete,
              COALESCE(c.name, g.hero_card_id) AS hero
       FROM games g
       LEFT JOIN cards c ON c.card_id = g.hero_card_id
       ORDER BY datetime`,
    )
    .all() as { id: string; datetime: string; final_place: number | null; complete: number; hero: string }[];

  return rows.map((row) => ({
    id: row.id,
    datetime: row.datetime,
    label: `${row.hero} ${row.final_place ?? '?'}e${row.complete === 1 ? '' : ' (inachevée)'}`,
  }));
}

async function main(): Promise<void> {
  const options = parseRatingsArgs(process.argv.slice(2));
  const db = openDatabase(options.db);
  const games = listGames(db);

  if (games.length === 0) {
    throw new Error('Aucune partie en base : lancer `npm run import` d’abord.');
  }

  const template = await writeRatingsTemplate(options.file, games);
  console.log(`${resolve(options.file)}`);
  console.log(`  ${games.length} partie(s), ${template.added} sans cote, ${template.kept} déjà saisie(s)`);

  const ratings = parseRatings(await readFile(options.file, 'utf8'));
  const matches = matchRatings(games, ratings);

  const update = db.prepare('UPDATE games SET rating_after = ? WHERE id = ?');
  db.transaction(() => {
    for (const match of matches) update.run(match.rating, match.gameId);
  })();

  console.log();
  if (matches.length === 0) {
    console.log('Aucune cote saisie pour l’instant : compléter la colonne `rating` du fichier.');
  } else {
    console.log(`${matches.length} cote(s) rattachée(s) :`);
    for (const game of games) {
      const match = matches.find((m) => m.gameId === game.id);
      if (match === undefined) continue;
      const gap = match.gapMinutes === 0 ? '' : ` (${match.gapMinutes} min d’écart)`;
      console.log(`  ${game.datetime.slice(0, 16).replace('T', ' ')}  ${match.rating}  ${game.label}${gap}`);
    }
  }

  db.close();
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
