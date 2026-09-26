/**
 * CLI : `npm run import -- <dossier> [--db <fichier>] [--force]`
 *
 * Lit un dossier de session ou un dossier d'archive, en extrait les parties de
 * Champs de bataille et les ecrit en base. L'operation est idempotente :
 * relancer la meme commande ne cree pas de doublon.
 *
 * Une session dont les fichiers n'ont pas bouge depuis le dernier import est
 * sautee. `--force` la relit quand meme.
 */
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findSessions } from './parse.js';
import { DEFAULT_DB_PATH, openDatabase, schemaVersion } from '../db/database.js';
import { importSessions } from '../db/import-sessions.js';

export interface ImportCliOptions {
  folder: string;
  db: string;
  /** Relire toutes les sessions, meme inchangees. */
  force: boolean;
}

export function parseImportArgs(argv: readonly string[]): ImportCliOptions {
  const positional: string[] = [];
  let db = DEFAULT_DB_PATH;
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--force') {
      force = true;
    } else if (arg === '--db') {
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
    throw new Error('Usage : npm run import -- <dossier> [--db <fichier>] [--force]');
  }
  if (positional.length > 1) {
    throw new Error('Un seul dossier peut etre importe a la fois.');
  }

  return { folder, db, force };
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

  const result = await importSessions(db, sessions, { force: options.force });

  for (const session of result.sessions) {
    if (session.skipped) {
      console.log(`  ${session.folder}  inchangée, sautée`);
    } else {
      console.log(
        `  ${session.folder}  ${session.games} partie(s) : ${session.inserted} nouvelle(s), ${session.updated} mise(s) à jour`,
      );
    }
  }

  const total = db.prepare('SELECT COUNT(*) AS n FROM games').get() as { n: number };
  console.log();
  const sautees = result.skipped > 0 ? `, ${result.skipped} session(s) inchangée(s)` : '';
  console.log(
    `${result.inserted} nouvelle(s), ${result.updated} mise(s) à jour${sautees}. ${total.n} partie(s) en base.`,
  );
  db.close();
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
