/**
 * CLI : `npm run sync`
 *
 * Enchaine les trois etapes qu'il faut sinon penser a lancer dans l'ordre :
 * archiver les logs, importer les parties, puis completer et relire les cotes.
 *
 * C'est la commande a lancer apres une session de jeu. Les etapes restent
 * disponibles separement (`npm run archive`, `import`, `ratings`).
 */
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { archiveLogs } from '../archive/archive-logs.js';
import { parseArchiveArgs } from '../../scripts/archive-logs.js';
import { findSessions } from './parse.js';
import { listGames } from './ratings.js';
import { DEFAULT_DB_PATH, openDatabase } from '../db/database.js';
import { importGames } from '../db/import.js';
import { extractGames } from '../extract/game-extractor.js';
import { openSession, readSessionLines, resolveSessionDate } from '../reader/session-reader.js';
import {
  DEFAULT_RATINGS_PATH,
  matchRatings,
  parseRatings,
  writeRatingsTemplate,
} from '../ratings/ratings.js';
import type { GameSummary } from '../types.js';

async function main(): Promise<void> {
  const archive = parseArchiveArgs(process.argv.slice(2));

  console.log('1/3  Archivage');
  const archived = await archiveLogs(archive);
  const copied = archived.files.filter((file) => !file.skipped);
  console.log(
    `     ${copied.length} fichier(s) archivé(s), ${archived.gamesKept} partie(s) dans l’archive` +
      (archived.pruned.length > 0 ? `, ${archived.pruned.length} session(s) élaguée(s)` : ''),
  );

  console.log('\n2/3  Import en base');
  const db = openDatabase(DEFAULT_DB_PATH);
  let inserted = 0;
  let updated = 0;

  for (const session of await findSessions(archive.dest)) {
    const sessionDate = await resolveSessionDate(await openSession(session));
    const summaries: GameSummary[] = [];
    for await (const summary of extractGames(readSessionLines(session), { sessionDate })) {
      summaries.push(summary);
    }
    const result = importGames(db, summaries, session);
    inserted += result.inserted;
    updated += result.updated;
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM games').get() as { n: number };
  console.log(`     ${inserted} nouvelle(s), ${updated} mise(s) à jour, ${total.n} partie(s) en base`);

  console.log('\n3/3  Cotes');
  const games = listGames(db);
  const template = await writeRatingsTemplate(DEFAULT_RATINGS_PATH, games);
  const matches = matchRatings(games, parseRatings(await readFile(DEFAULT_RATINGS_PATH, 'utf8')));

  const update = db.prepare('UPDATE games SET rating_after = ? WHERE id = ?');
  db.transaction(() => {
    for (const match of matches) update.run(match.rating, match.gameId);
  })();

  console.log(`     ${matches.length} cote(s) rattachée(s), ${template.added} partie(s) sans cote`);
  if (template.added > 0) {
    console.log(`\nÀ compléter : ${DEFAULT_RATINGS_PATH}`);
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
