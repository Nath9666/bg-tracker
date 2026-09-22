/**
 * CLI : `npm run parse -- <dossier> [--json]`
 *
 * Le dossier peut etre une session unique (`Hearthstone_AAAA_MM_JJ_HH_MM_SS`,
 * contenant Power_old.log / Power.log) ou un dossier d'archive contenant
 * plusieurs sessions.
 *
 * Etape 1 : seule la validation des arguments est en place. Le parcours reel
 * arrive a l'etape 7, une fois le SessionReader et l'extracteur ecrits.
 */
import { stat } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export interface ParseCliOptions {
  folder: string;
  json: boolean;
}

/** Lit les arguments de la ligne de commande. Fonction pure, testable. */
export function parseCliArgs(argv: readonly string[]): ParseCliOptions {
  const positional: string[] = [];
  let json = false;

  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Option inconnue : ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const folder = positional[0];
  if (folder === undefined) {
    throw new Error('Usage : npm run parse -- <dossier> [--json]');
  }
  if (positional.length > 1) {
    throw new Error('Un seul dossier peut etre analyse a la fois.');
  }

  return { folder, json };
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  const stats = await stat(options.folder).catch(() => null);
  if (stats === null || !stats.isDirectory()) {
    throw new Error(`Dossier introuvable : ${options.folder}`);
  }

  console.error('Le parseur n\u2019est pas encore implemente (phase 1, etape 3 et suivantes).');
  process.exitCode = 1;
}

// Ne s'execute que lorsque le fichier est lance directement, pas a l'import.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
