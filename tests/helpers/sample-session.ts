/**
 * Reconstitue un dossier de session a partir de l'extrait versionne.
 *
 * `tests/fixtures/sample-game-1.min.log.gz` est compresse pour tenir dans Git.
 * Les modules de production ne connaissent pas gzip : on decompresse donc
 * l'extrait dans un dossier temporaire, nomme comme le vrai dossier de session
 * d'origine, et on fait travailler le SessionReader dessus.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const FIXTURE = new URL('../fixtures/sample-game-1.min.log.gz', import.meta.url);

/** Nom du vrai dossier de session dont provient l'extrait. */
export const SAMPLE_SESSION_FOLDER_NAME = 'Hearthstone_2026_09_19_02_47_25';

/** Nombre de lignes de l'extrait, voir docs/LOG_FORMAT.md. */
export const SAMPLE_SESSION_LINE_COUNT = 141_637;

let cached: Promise<string> | null = null;

/**
 * Chemin d'un dossier de session temporaire contenant l'extrait sous le nom
 * `Power_old.log`. Le dossier n'est cree qu'une fois par fichier de test.
 */
export function sampleSessionFolder(): Promise<string> {
  cached ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), 'bg-tracker-'));
    const folder = join(root, SAMPLE_SESSION_FOLDER_NAME);
    await mkdir(folder);
    await writeFile(join(folder, 'Power_old.log'), gunzipSync(await readFile(FIXTURE)));
    return folder;
  })();
  return cached;
}
