/**
 * Archivage des sessions Hearthstone (phase 0).
 *
 *   npm run archive
 *   npm run archive -- --dry-run
 *   npm run archive -- --keep 50
 *   npm run archive -- --source "F:\\SteamLibrary\\Hearthstone\\Logs" --dest D:\\archive
 *
 * Les chemins par defaut sont ceux de l'installation de l'utilisateur ; ils
 * peuvent aussi venir des variables d'environnement BG_TRACKER_LOGS et
 * BG_TRACKER_ARCHIVE, pratiques pour le planificateur de taches Windows.
 *
 * Voir docs/ARCHIVAGE.md.
 */
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  archiveLogs,
  ensureRatingsFile,
  sessionLabel,
  type ArchiveOptions,
} from '../src/archive/archive-logs.js';
import { logsFolderPath } from '../src/reader/hearthstone-path.js';

const DEFAULT_DEST = 'data/archive';
/**
 * Nombre de parties conservees dans l'archive.
 *
 * Environ un mois de jeu, pour 1 Go compresse. Les logs bruts ne servent pas
 * qu'a l'import : la base garde les resumes, les tours et les plateaux, mais
 * pas chaque achat, vente ou repositionnement, dont la phase 5 aura besoin.
 * Elaguer trop tot couterait donc des donnees d'entrainement.
 */
const DEFAULT_KEEP = 200;
const RATINGS = 'data/ratings.csv';

export function parseArchiveArgs(argv: readonly string[]): ArchiveOptions {
  const options: ArchiveOptions = {
    // BG_TRACKER_LOGS, sinon le registre, sinon l'emplacement par defaut.
    source: logsFolderPath(),
    dest: process.env['BG_TRACKER_ARCHIVE'] ?? DEFAULT_DEST,
    keep: DEFAULT_KEEP,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`Valeur manquante apres ${arg}`);
      i += 1;
      return next;
    };

    switch (arg) {
      case '--source':
        options.source = value();
        break;
      case '--dest':
        options.dest = value();
        break;
      case '--keep': {
        const keep = Number(value());
        if (!Number.isInteger(keep) || keep < 1) {
          throw new Error('--keep attend un entier positif');
        }
        options.keep = keep;
        break;
      }
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        throw new Error(`Option inconnue : ${arg}`);
    }
  }

  return options;
}

function mo(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} Mo`;
}

async function main(): Promise<void> {
  const options = parseArchiveArgs(process.argv.slice(2));

  console.log(`Source  : ${options.source}`);
  console.log(`Archive : ${resolve(options.dest)}`);
  console.log(`Retenue : ${options.keep} dernieres parties`);
  if (options.dryRun) console.log('(simulation : rien ne sera ecrit)');
  console.log();

  const result = await archiveLogs(options);

  let copiedSource = 0;
  let copiedArchive = 0;
  let copiedCount = 0;

  for (const file of result.files) {
    if (file.skipped) {
      console.log(`  = ${sessionLabel(file.session)}  ${file.file}  deja archive`);
      continue;
    }
    copiedCount += 1;
    copiedSource += file.sourceSize;
    copiedArchive += file.archivedSize;
    const ratio =
      file.archivedSize > 0 ? ` (${(file.sourceSize / file.archivedSize).toFixed(0)}x)` : '';
    console.log(
      `  + ${sessionLabel(file.session)}  ${file.file}  ${mo(file.sourceSize)} -> ${mo(file.archivedSize)}${ratio}  ${file.games} partie(s)`,
    );
  }

  for (const key of result.discarded) {
    console.log(`  × ${key}  copie perimee retiree (le jeu a renomme le fichier)`);
  }

  for (const session of result.pruned) {
    const verbe = options.dryRun ? 'serait supprimee' : 'supprimee';
    console.log(`  - ${sessionLabel(session)}  ${verbe} de l'archive (hors retenue)`);
  }

  console.log();
  if (copiedCount > 0) {
    console.log(
      `${copiedCount} fichier(s) archive(s) : ${mo(copiedSource)} -> ${mo(copiedArchive)}`,
    );
  } else {
    console.log('Rien de nouveau a archiver.');
  }
  console.log(`${result.gamesKept} partie(s) conservee(s) dans l'archive.`);

  if (!options.dryRun && (await ensureRatingsFile(RATINGS))) {
    console.log(`${RATINGS} cree : y noter la cote a la main (datetime,rating).`);
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
