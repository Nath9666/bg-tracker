/**
 * CLI : `npm run import -- <dossier> [--db <fichier>]`
 *
 * Lit un dossier de session ou un dossier d'archive, en extrait les parties de
 * Champs de bataille et les ecrit en base. L'operation est idempotente :
 * relancer la meme commande ne cree pas de doublon.
 */
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findSessions } from './parse.js';
import { DEFAULT_DB_PATH, openDatabase, schemaVersion } from '../db/database.js';
import { importGames } from '../db/import.js';
import { extractGames } from '../extract/game-extractor.js';
import { openSession, readSessionLines, resolveSessionDate } from '../reader/session-reader.js';
import type { GameSummary } from '../types.js';

export interface ImportCliOptions {
  folder: string;
  db: string;
}

export function parseImportArgs(argv: readonly string[]): ImportCliOptions {
  const positional: string[] = [];
  let db = DEFAULT_DB_PATH;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--db') {
      const next = argv[i + 1];
      if (next === undefined) throw new Error('Valeur manquante apres --db');
      db = next;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`Option inconnue : ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const folder = positional[0];
  if (folder === undefined) {
    throw new Error('Usage : npm run import -- <dossier> [--db <fichier>]');
  }
  if (positional.length > 1) {
    throw new Error('Un seul dossier peut etre importe a la fois.');
  }

  return { folder, db };
}

async function main(): Promise<void> {
  const options = parseImportArgs(process.argv.slice(2));
  const sessions = await findSessions(options.folder);

  if (sessions.length === 0) {
    throw new Error(`Aucun Power.log trouvé dans ${options.folder}.`);
  }

  const db = openDatabase(options.db);
  console.log(`Base    : ${resolve(options.db)} (schéma v${schemaVersion(db)})`);
  console.log(`Source  : ${options.folder}`);
  console.log();

  let inserted = 0;
  let updated = 0;

  for (const session of sessions) {
    const sessionDate = await resolveSessionDate(await openSession(session));
    const summaries: GameSummary[] = [];
    for await (const summary of extractGames(readSessionLines(session), { sessionDate })) {
      summaries.push(summary);
    }

    const result = importGames(db, summaries, session);
    inserted += result.inserted;
    updated += result.updated;
    console.log(
      `  ${session}  ${summaries.length} partie(s) : ${result.inserted} nouvelle(s), ${result.updated} mise(s) à jour`,
    );
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM games').get() as { n: number };
  console.log();
  console.log(`${inserted} nouvelle(s), ${updated} mise(s) à jour. ${total.n} partie(s) en base.`);
  db.close();
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
