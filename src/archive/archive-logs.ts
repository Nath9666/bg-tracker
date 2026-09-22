/**
 * Archivage des sessions de logs (phase 0).
 *
 * Hearthstone supprime ses anciens dossiers de session au bout de quelques
 * jours : sans copie, les parties sont perdues. Ce module copie les `Power.log`
 * de chaque session vers un dossier d'archive, compresses (environ 20x plus
 * petits), et n'y garde que les N dernieres parties.
 *
 * Il ne touche jamais aux fichiers d'origine.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { createGzip } from 'node:zlib';

/** Nom d'un dossier de session : `Hearthstone_AAAA_MM_JJ_HH_MM_SS`. */
const SESSION_FOLDER = /^Hearthstone_\d{4}(_\d{2}){5}$/;

/** Les seuls fichiers qui nous interessent : ils pesent 99 % des octets. */
const POWER_FILES = ['Power.log', 'Power_old.log'] as const;

/** Debut d'une partie, compte au passage pour appliquer la retention. */
const CREATE_GAME = /^[A-Z] [\d:.]+ GameState\.DebugPrintPower\(\) - CREATE_GAME/;

/** Fiche d'un fichier archive, pour ne pas refaire le travail inutilement. */
export interface ManifestEntry {
  /** Taille du fichier source au moment de l'archivage. */
  sourceSize: number;
  /** Date de modification du fichier source, en ISO. */
  sourceModifiedAt: string;
  archivedAt: string;
  /** Nombre de `CREATE_GAME` trouves dans le fichier. */
  games: number;
}

/** Index de l'archive, range dans `manifest.json` a sa racine. */
export interface Manifest {
  /** Fiche par fichier archive, clef `<session>/<fichier>`. */
  files: Record<string, ManifestEntry>;
  /**
   * Sessions deja ecartees par la retention.
   *
   * On garde leur nom pour ne pas les rearchiver a chaque passage : sans cela,
   * une tache planifiee relirait et recompresserait des centaines de Mo
   * d'anciennes sessions juste pour les resupprimer.
   */
  pruned: string[];
}

function emptyManifest(): Manifest {
  return { files: {}, pruned: [] };
}

export interface ArchiveOptions {
  /** Dossier `Logs` de Hearthstone. */
  source: string;
  /** Dossier d'archive. */
  dest: string;
  /** Nombre de parties a conserver. Les sessions plus anciennes sont supprimees. */
  keep: number;
  /** N'ecrit rien, se contente de dire ce qui serait fait. */
  dryRun: boolean;
}

export interface ArchivedFile {
  session: string;
  file: string;
  games: number;
  sourceSize: number;
  archivedSize: number;
  /** Vrai quand le fichier avait deja ete archive et n'a pas bougé. */
  skipped: boolean;
}

export interface ArchiveResult {
  files: ArchivedFile[];
  /** Sessions supprimees par la retention. */
  pruned: string[];
  /** Parties conservees dans l'archive apres passage. */
  gamesKept: number;
}

const MANIFEST = 'manifest.json';

/** Compte les `CREATE_GAME` qui traversent le flux, sans rien retenir. */
function createGameCounter(counter: { games: number }): Transform {
  let pending = '';

  return new Transform({
    decodeStrings: false,
    transform(chunk: Buffer, _encoding, callback) {
      const text = pending + chunk.toString('utf8');
      let start = 0;

      for (;;) {
        const newline = text.indexOf('\n', start);
        if (newline === -1) break;
        if (CREATE_GAME.test(text.slice(start, newline))) counter.games += 1;
        start = newline + 1;
      }

      pending = text.slice(start);
      callback(null, chunk);
    },
    flush(callback) {
      if (CREATE_GAME.test(pending)) counter.games += 1;
      callback();
    },
  });
}

async function readManifest(dest: string): Promise<Manifest> {
  const raw = await readFile(join(dest, MANIFEST), 'utf8').catch(() => null);
  if (raw === null) return emptyManifest();

  try {
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    return {
      files: parsed.files ?? {},
      pruned: parsed.pruned ?? [],
    };
  } catch {
    // Un manifeste illisible ne doit pas bloquer l'archivage : on repart de zero.
    return emptyManifest();
  }
}

/** Sessions presentes dans un dossier, de la plus ancienne a la plus recente. */
export async function listSessions(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => null);
  if (entries === null) return [];

  return entries
    .filter((entry) => entry.isDirectory() && SESSION_FOLDER.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Archive les sessions, puis applique la retention.
 *
 * Un fichier deja archive et inchange est saute. Un fichier qui a grossi depuis
 * (la session etait encore en cours) est rearchive.
 */
export async function archiveLogs(options: ArchiveOptions): Promise<ArchiveResult> {
  const { source, dest, keep, dryRun } = options;

  const sessions = await listSessions(source);
  if (sessions.length === 0) {
    throw new Error(`Aucune session Hearthstone_* dans ${source}`);
  }

  if (!dryRun) await mkdir(dest, { recursive: true });
  const manifest = await readManifest(dest);
  const files: ArchivedFile[] = [];

  const pruned = new Set(manifest.pruned);

  for (const session of sessions) {
    // Deja ecartee par la retention : inutile de la relire.
    if (pruned.has(session)) continue;

    for (const file of POWER_FILES) {
      const sourcePath = join(source, session, file);
      const stats = await stat(sourcePath).catch(() => null);
      if (stats?.isFile() !== true) continue;

      const key = `${session}/${file}`;
      const known = manifest.files[key];
      const unchanged =
        known !== undefined &&
        known.sourceSize === stats.size &&
        known.sourceModifiedAt === stats.mtime.toISOString();

      if (unchanged) {
        files.push({
          session,
          file,
          games: known.games,
          sourceSize: stats.size,
          archivedSize: 0,
          skipped: true,
        });
        continue;
      }

      // Meme en simulation on lit le fichier : c'est le seul moyen de dire
      // combien de parties il contient, donc ce que la retention supprimerait.
      const counter = { games: 0 };
      const targetDir = join(dest, session);
      const targetPath = join(targetDir, `${file}.gz`);

      if (!dryRun) await mkdir(targetDir, { recursive: true });
      await pipeline(
        createReadStream(sourcePath),
        createGameCounter(counter),
        createGzip({ level: 6 }),
        dryRun ? new Writable({ write: (_c, _e, done) => done() }) : createWriteStream(targetPath),
      );

      if (dryRun) {
        files.push({
          session,
          file,
          games: counter.games,
          sourceSize: stats.size,
          archivedSize: 0,
          skipped: false,
        });
        manifest.files[key] = {
          sourceSize: stats.size,
          sourceModifiedAt: stats.mtime.toISOString(),
          archivedAt: new Date().toISOString(),
          games: counter.games,
        };
        continue;
      }

      const archived = await stat(targetPath);
      manifest.files[key] = {
        sourceSize: stats.size,
        sourceModifiedAt: stats.mtime.toISOString(),
        archivedAt: new Date().toISOString(),
        games: counter.games,
      };

      files.push({
        session,
        file,
        games: counter.games,
        sourceSize: stats.size,
        archivedSize: archived.size,
        skipped: false,
      });
    }
  }

  const pruning = await pruneArchive(dest, manifest, keep, dryRun);

  if (!dryRun) {
    await writeFile(join(dest, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  return { files, pruned: pruning.pruned, gamesKept: pruning.gamesKept };
}

/**
 * Ne garde que les sessions les plus recentes couvrant `keep` parties.
 *
 * On remonte de la plus recente a la plus ancienne en cumulant les parties ;
 * une fois le compte atteint, tout ce qui est plus ancien part. La session qui
 * contient la `keep`-ieme partie est conservee entiere.
 */
export async function pruneArchive(
  dest: string,
  manifest: Manifest,
  keep: number,
  dryRun = false,
): Promise<{ pruned: string[]; gamesKept: number }> {
  const gamesPerSession = new Map<string, number>();
  for (const [key, entry] of Object.entries(manifest.files)) {
    const session = key.split('/')[0]!;
    gamesPerSession.set(session, (gamesPerSession.get(session) ?? 0) + entry.games);
  }

  const newestFirst = [...gamesPerSession.keys()].sort().reverse();
  const pruned: string[] = [];
  let gamesKept = 0;
  let reached = false;

  for (const session of newestFirst) {
    if (reached) {
      pruned.push(session);
      continue;
    }
    gamesKept += gamesPerSession.get(session) ?? 0;
    if (gamesKept >= keep) reached = true;
  }

  if (!dryRun) {
    for (const session of pruned) {
      await rm(join(dest, session), { recursive: true, force: true });
      for (const key of Object.keys(manifest.files)) {
        if (key.startsWith(`${session}/`)) delete manifest.files[key];
      }
      if (!manifest.pruned.includes(session)) manifest.pruned.push(session);
    }
    manifest.pruned.sort();
  }

  return { pruned, gamesKept };
}

/** Cree `data/ratings.csv` s'il n'existe pas : la cote n'est pas dans les logs. */
export async function ensureRatingsFile(path: string): Promise<boolean> {
  const exists = await stat(path).then(() => true).catch(() => false);
  if (exists) return false;

  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'datetime,rating\n', 'utf8');
  return true;
}

/** Nom lisible d'une session, pour l'affichage. */
export function sessionLabel(session: string): string {
  const parts = basename(session).split('_').slice(1);
  if (parts.length !== 6) return session;
  const [y, mo, d, h, mi] = parts;
  return `${d}/${mo}/${y} ${h}:${mi}`;
}
