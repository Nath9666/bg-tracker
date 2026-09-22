/**
 * Produit l'extrait de log versionne utilise par les tests.
 *
 *   npm run make-fixture
 *   npm run make-fixture -- <source.log> <destination.log.gz>
 *
 * Le Power_old.log de reference fait 40 Mo pour 298 697 lignes : trop gros pour
 * Git. On ne garde que les lignes dont la source est `GameState.*` (les seules
 * qui nous interessent, voir docs/LOG_FORMAT.md), ce qui descend a 19 Mo, puis
 * on compresse en gzip : environ 850 Ko, versionnables.
 *
 * L'extrait reste fidele au log d'origine, octet pour octet : memes lignes,
 * memes fins de ligne CRLF. Les tests lisent donc de vraies lignes de jeu.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createGzip } from 'node:zlib';

const DEFAULT_SOURCE = 'fixtures/sample-game-1/Power_old.log';
const DEFAULT_TARGET = 'tests/fixtures/sample-game-1.min.log.gz';

/** Prefixe d'une ligne dont la source est `GameState.<methode>()`. */
const GAME_STATE_LINE = /^[A-Z] \d{2}:\d{2}:\d{2}\.\d+ GameState\./;

export interface FilterStats {
  linesRead: number;
  linesKept: number;
}

/**
 * Transforme un flux de texte en ne laissant passer que les lignes `GameState.*`.
 *
 * Le decoupage se fait a la main plutot qu'avec `readline` pour conserver les
 * fins de ligne d'origine. La derniere ligne partielle d'un morceau est gardee
 * en tampon jusqu'au morceau suivant.
 */
export function createGameStateFilter(stats: FilterStats): Transform {
  let pending = '';

  const keepLines = (text: string): string => {
    let output = '';
    let start = 0;

    for (;;) {
      const newline = text.indexOf('\n', start);
      if (newline === -1) break;

      const line = text.slice(start, newline + 1);
      stats.linesRead += 1;
      if (GAME_STATE_LINE.test(line)) {
        stats.linesKept += 1;
        output += line;
      }
      start = newline + 1;
    }

    pending = text.slice(start);
    return output;
  };

  return new Transform({
    decodeStrings: false,
    transform(chunk: string, _encoding, callback) {
      const kept = keepLines(pending + chunk);
      // Ne rien pousser plutot qu'une chaine vide quand le morceau est entierement filtre.
      callback(null, kept.length > 0 ? kept : undefined);
    },
    flush(callback) {
      // Un fichier tronque peut se terminer sans fin de ligne.
      if (pending.length > 0) {
        stats.linesRead += 1;
        if (GAME_STATE_LINE.test(pending)) {
          stats.linesKept += 1;
          callback(null, pending);
          return;
        }
      }
      callback();
    },
  });
}

async function main(): Promise<void> {
  const [source = DEFAULT_SOURCE, target = DEFAULT_TARGET] = process.argv.slice(2);

  const stats: FilterStats = { linesRead: 0, linesKept: 0 };
  const filter = createGameStateFilter(stats);

  await mkdir(dirname(target), { recursive: true });
  await pipeline(
    createReadStream(source, { encoding: 'utf8' }),
    filter,
    createGzip({ level: 9 }),
    createWriteStream(target),
  );

  console.log(`${source} -> ${target}`);
  console.log(`  ${stats.linesRead} lignes lues, ${stats.linesKept} conservees (GameState.*)`);
}

// Ne s'execute que lorsque le fichier est lance directement : les tests importent
// createGameStateFilter sans declencher la generation de l'extrait.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
