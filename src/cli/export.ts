/**
 * CLI : `npm run export [--top4] [--out <fichier>] [--db <fichier>]`
 *
 * Ecrit le jeu de donnees d'entrainement au format JSON Lines, lisible
 * directement par pandas. Voir `ml/README.md`.
 */
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DB_PATH, openDatabase } from '../db/database.js';
import { DEFAULT_EXPORT_PATH, buildDataset, writeDataset } from '../export/dataset.js';

export interface ExportCliOptions {
  db: string;
  out: string;
  top4Only: boolean;
}

export function parseExportArgs(argv: readonly string[]): ExportCliOptions {
  const options: ExportCliOptions = {
    db: DEFAULT_DB_PATH,
    out: DEFAULT_EXPORT_PATH,
    top4Only: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--top4') {
      options.top4Only = true;
      continue;
    }
    const next = argv[i + 1];
    if (arg !== '--db' && arg !== '--out') throw new Error(`Option inconnue : ${arg}`);
    if (next === undefined) throw new Error(`Valeur manquante apres ${arg}`);
    if (arg === '--db') options.db = next;
    else options.out = next;
    i += 1;
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseExportArgs(process.argv.slice(2));
  const db = openDatabase(options.db);

  const decisions = buildDataset(db, { top4Only: options.top4Only });
  const lignes = await writeDataset(options.out, decisions);

  const parties = new Set(decisions.map((d) => d.gameId)).size;
  const top4 = decisions.filter((d) => d.top4).length;

  console.log(`${resolve(options.out)}`);
  console.log(`  ${lignes} décisions, ${parties} partie(s)`);
  console.log(`  dont ${top4} venant de parties de top 4`);
  if (!options.top4Only) {
    console.log('\n  --top4 n’exporte que les parties réussies : un modèle entraîné dessus');
    console.log('  apprend les bonnes parties plutôt que les habitudes, erreurs comprises.');
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
