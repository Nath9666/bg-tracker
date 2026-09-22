/**
 * SessionReader : un dossier de session Hearthstone -> un flux de lignes.
 *
 * Un dossier de session (`Hearthstone_AAAA_MM_JJ_HH_MM_SS`) contient
 * `Power.log`, et `Power_old.log` si le jeu a fait tourner ses fichiers en
 * cours de session. Les deux forment un seul flux continu, l'ancien d'abord.
 *
 * La lecture est strictement en flux : un Power.log peut depasser 150 Mo
 * (voir docs/LOG_FORMAT.md), il n'est jamais charge en memoire.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

/**
 * Les fichiers d'une session, dans leur ordre de lecture.
 *
 * La variante `.gz` est celle produite par l'archivage (phase 0) : une session
 * archivee se lit exactement comme un dossier de logs d'origine.
 */
export const SESSION_LOG_FILES = [
  'Power_old.log',
  'Power_old.log.gz',
  'Power.log',
  'Power.log.gz',
] as const;

/** `Hearthstone_2026_09_22_00_28_13` */
const SESSION_FOLDER_NAME = /^Hearthstone_(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})$/;

export interface Session {
  /** Chemin du dossier de session. */
  folder: string;
  /**
   * Date et heure de lancement du jeu, lues dans le nom du dossier.
   * `null` si le dossier ne suit pas la convention de nommage.
   *
   * C'est la seule source de la date : les lignes de log ne portent que l'heure.
   */
  startedAt: Date | null;
  /** Chemins des fichiers de log presents, dans l'ordre de lecture. */
  files: string[];
}

/**
 * Lit la date de lancement dans le nom d'un dossier de session.
 * Renvoie `null` si le nom ne correspond pas, ou si la date est impossible.
 */
export function parseSessionFolderName(name: string): Date | null {
  const match = SESSION_FOLDER_NAME.exec(name);
  if (match === null) return null;

  const [year, month, day, hours, minutes, seconds] = match.slice(1).map(Number) as [
    number, number, number, number, number, number,
  ];

  // Heure locale : c'est l'horloge du joueur qui date les logs.
  const date = new Date(year, month - 1, day, hours, minutes, seconds);

  // `new Date(2026, 12, 32)` ne leve pas d'erreur, il deborde sur le mois
  // suivant. On verifie donc que la date relue est bien celle demandee.
  const roundTrips =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hours &&
    date.getMinutes() === minutes &&
    date.getSeconds() === seconds;

  return roundTrips ? date : null;
}

/** Decrit un dossier de session : sa date, et les fichiers de log qu'il contient. */
export async function openSession(folder: string): Promise<Session> {
  const stats = await stat(folder).catch(() => null);
  if (stats === null || !stats.isDirectory()) {
    throw new Error(`Dossier de session introuvable : ${folder}`);
  }

  const files: string[] = [];
  for (const name of SESSION_LOG_FILES) {
    const path = join(folder, name);
    const fileStats = await stat(path).catch(() => null);
    if (fileStats?.isFile() === true) files.push(path);
  }

  return {
    folder,
    startedAt: parseSessionFolderName(basename(folder)),
    files,
  };
}

/**
 * Date a retenir pour une session, avec replis successifs.
 *
 * Le nom du dossier est la source normale. Un dossier qui ne suit pas la
 * convention (une copie manuelle, un extrait de test) n'en a pas : on se rabat
 * alors sur la date de modification du premier fichier de log, qui tombe le
 * bon jour, puis sur la date du jour si le dossier est vide.
 */
export async function resolveSessionDate(session: Session): Promise<Date> {
  if (session.startedAt !== null) return session.startedAt;

  const first = session.files[0];
  if (first !== undefined) {
    const stats = await stat(first).catch(() => null);
    if (stats !== null) {
      // La date de modification est celle de la *fin* de la session. On n'en
      // garde que le jour, a minuit : prendre l'heure telle quelle ferait
      // croire a un passage de minuit des la premiere ligne, qui lui est
      // anterieure. Une session a cheval sur minuit sera donc mal datee par ce
      // repli : le nom du dossier reste la seule source vraiment fiable.
      return new Date(stats.mtime.getFullYear(), stats.mtime.getMonth(), stats.mtime.getDate());
    }
  }

  return new Date();
}

/**
 * Lit un fichier de log ligne par ligne.
 *
 * `readline` decoupe sur `\n` et retire le `\r` final (fins de ligne Windows).
 * Le `trimEnd` supprime en plus l'espace que le jeu laisse souvent avant le
 * saut de ligne. L'indentation en debut de ligne, elle, est significative et
 * doit etre conservee.
 */
export async function* readLogFile(path: string): AsyncGenerator<string> {
  // Un fichier archive est compresse : on le decompresse au fil de l'eau,
  // sans jamais le materialiser sur disque.
  const input = path.endsWith('.gz')
    ? createReadStream(path).pipe(createGunzip()).setEncoding('utf8')
    : createReadStream(path, { encoding: 'utf8' });

  const lines = createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    yield line.trimEnd();
  }
}

/**
 * Lit toutes les lignes d'une session : `Power_old.log` puis `Power.log`.
 *
 * Un dossier sans aucun des deux fichiers ne produit aucune ligne, sans erreur :
 * un dossier d'archive peut contenir des sessions ou le joueur n'a rien lance.
 */
export async function* readSessionLines(folder: string): AsyncGenerator<string> {
  const session = await openSession(folder);
  for (const path of session.files) {
    yield* readLogFile(path);
  }
}
