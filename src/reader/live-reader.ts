/**
 * Suivi de `Power.log` en direct.
 *
 * Le jeu ecrit en continu dans le fichier de la session en cours. On relit
 * periodiquement ce qui a ete ajoute depuis la derniere lecture, sans jamais
 * recharger le fichier : il depasse couramment 200 Mo.
 *
 * Trois evenements changent la source sous nos pieds, et il faut les trois :
 *
 * - le jeu **ajoute** des lignes : on lit a partir de l'offset precedent ;
 * - le jeu **renomme** `Power.log` en `Power_old.log` a la fin d'une session,
 *   et le fichier suivi disparait ;
 * - le joueur **relance** le jeu, qui cree un nouveau dossier de session.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_LOG_FILES } from './session-reader.js';

/** Nom d'un dossier de session : `Hearthstone_AAAA_MM_JJ_HH_MM_SS`. */
const SESSION_FOLDER = /^Hearthstone_\d{4}(_\d{2}){5}$/;

export interface LiveReaderOptions {
  /** Dossier `Logs` de Hearthstone. */
  logsFolder: string;
  /** Intervalle entre deux relectures, en millisecondes. */
  pollMs?: number;
  /**
   * Repartir du debut du fichier a la premiere lecture.
   *
   * Faux par defaut : on se place a la fin, car les parties deja jouees ont
   * ete importees par ailleurs et les rejouer n'apporterait rien.
   */
  fromStart?: boolean;
}

/** Ce que le suivi rapporte a chaque passage. */
export interface LiveBatch {
  /** Dossier de session d'ou viennent ces lignes. */
  session: string;
  /** Vrai quand ce lot ouvre une session differente de la precedente. */
  newSession: boolean;
  lines: string[];
}

/** Sessions du dossier de logs, de la plus ancienne a la plus recente. */
export async function listSessionFolders(logsFolder: string): Promise<string[]> {
  const entries = await readdir(logsFolder, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];

  return entries
    .filter((entry) => entry.isDirectory() && SESSION_FOLDER.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Fichier de log actif d'une session.
 *
 * `Power.log` tant que la session tourne, `Power_old.log` une fois le jeu
 * ferme. `null` si la session n'a encore aucun des deux.
 */
export async function activeLogFile(sessionFolder: string): Promise<string | null> {
  for (const name of SESSION_LOG_FILES) {
    if (name.endsWith('.gz')) continue;
    const path = join(sessionFolder, name);
    const stats = await stat(path).catch(() => null);
    if (stats?.isFile() === true) return path;
  }
  return null;
}

/**
 * Lit ce qui a ete ajoute a un fichier depuis un offset.
 *
 * Renvoie les lignes completes et le nouvel offset. Une ligne partielle en fin
 * de lecture n'est pas rendue : elle le sera au passage suivant, une fois le
 * jeu allé au bout de sa ligne.
 */
export async function readFrom(
  path: string,
  offset: number,
): Promise<{ lines: string[]; offset: number }> {
  const stats = await stat(path).catch(() => null);
  if (stats === null) return { lines: [], offset };

  // Le fichier a retreci : il a ete remplace, on repart du debut.
  const start = stats.size < offset ? 0 : offset;
  if (stats.size === start) return { lines: [], offset: start };

  const handle = await open(path, 'r');
  try {
    const length = stats.size - start;
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, start);

    const text = buffer.toString('utf8');
    const lastBreak = text.lastIndexOf('\n');
    // Aucune ligne complete : on attend le prochain passage.
    if (lastBreak === -1) return { lines: [], offset: start };

    const complete = text.slice(0, lastBreak);
    return {
      lines: complete.split('\n').map((line) => line.trimEnd()),
      // +1 pour le saut de ligne lui-meme : l'offset se pose juste apres, donc
      // toujours au debut d'une ligne.
      offset: start + Buffer.byteLength(complete, 'utf8') + 1,
    };
  } finally {
    await handle.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Suit la session la plus recente et rend les lignes au fil de l'eau.
 *
 * La boucle s'arrete quand le signal est declenche.
 */
export async function* followLogs(
  options: LiveReaderOptions,
  signal?: AbortSignal,
): AsyncGenerator<LiveBatch> {
  const pollMs = options.pollMs ?? 1000;
  let session: string | null = null;
  let path: string | null = null;
  let offset = 0;

  while (signal?.aborted !== true) {
    const sessions = await listSessionFolders(options.logsFolder);
    const newest = sessions.at(-1) ?? null;

    if (newest !== null && newest !== session) {
      // Nouvelle session : le joueur a relance le jeu.
      session = newest;
      path = await activeLogFile(join(options.logsFolder, newest));
      offset = 0;

      if (path !== null && options.fromStart !== true) {
        // On se place a la fin : le passe a deja ete importe hors ligne.
        offset = (await stat(path).catch(() => null))?.size ?? 0;
      }
      if (path !== null) yield { session: newest, newSession: true, lines: [] };
    }

    if (session !== null && path === null) {
      // La session existe mais son fichier n'est pas encore la.
      path = await activeLogFile(join(options.logsFolder, session));
      if (path !== null && options.fromStart !== true) offset = 0;
    }

    if (path !== null) {
      const exists = await stat(path).then(() => true).catch(() => false);
      if (!exists) {
        // `Power.log` a ete renomme en `Power_old.log` : on reprend la suite
        // au meme offset, le contenu etant le meme fichier.
        path = session === null ? null : await activeLogFile(join(options.logsFolder, session));
      }
    }

    if (path !== null && session !== null) {
      const batch = await readFrom(path, offset);
      offset = batch.offset;
      if (batch.lines.length > 0) yield { session, newSession: false, lines: batch.lines };
    }

    await sleep(pollMs);
  }
}
