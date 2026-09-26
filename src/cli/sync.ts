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
import { DEFAULT_DB_PATH, openDatabase } from '../db/database.js';
import { importSessions } from '../db/import-sessions.js';
import {
  DEFAULT_RATINGS_PATH,
  listGames,
  matchRatings,
  parseRatings,
  writeRatingsTemplate,
} from '../ratings/ratings.js';

/**
 * Archive, importe et rattache les cotes. Exporte pour que l'application le
 * lance sans `npm` (voir app/main/worker.ts).
 */
export async function runSync(argv: readonly string[] = []): Promise<void> {
  const archive = parseArchiveArgs(argv);

  console.log('1/3  Archivage');
  const archived = await archiveLogs(archive);
  const copied = archived.files.filter((file) => !file.skipped);
  console.log(
    `     ${copied.length} fichier(s) archivé(s), ${archived.gamesKept} partie(s) dans l’archive` +
      (archived.pruned.length > 0 ? `, ${archived.pruned.length} session(s) élaguée(s)` : ''),
  );
  for (const key of archived.discarded) {
    console.log(`     × ${key} : copie périmée retirée (le jeu a renommé le fichier)`);
  }

  console.log('\n2/3  Import en base');
  const db = openDatabase(DEFAULT_DB_PATH);
  const result = await importSessions(db, await findSessions(archive.dest));

  const total = db.prepare('SELECT COUNT(*) AS n FROM games').get() as { n: number };
  const sautees = result.skipped > 0 ? `, ${result.skipped} session(s) inchangée(s)` : '';
  console.log(
    `     ${result.inserted} nouvelle(s), ${result.updated} mise(s) à jour${sautees}, ${total.n} partie(s) en base`,
  );

  console.log('\n3/3  Cotes');
  const games = listGames(db);
  const template = await writeRatingsTemplate(DEFAULT_RATINGS_PATH, games);
  const matches = matchRatings(games, parseRatings(await readFile(DEFAULT_RATINGS_PATH, 'utf8')));

  const update = db.prepare('UPDATE games SET rating_after = ? WHERE id = ?');
  db.transaction(() => {
    for (const match of matches) update.run(match.rating, match.gameId);
  })();

  console.log(
    `     ${matches.length} cote(s) rattachée(s), ${template.added} partie(s) sans cote` +
      (template.written ? '' : ', fichier inchangé'),
  );
  if (template.added > 0) {
    console.log(`\nÀ compléter : ${DEFAULT_RATINGS_PATH}`);
  }

  db.close();
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void runSync(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
