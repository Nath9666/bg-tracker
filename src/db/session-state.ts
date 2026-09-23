/**
 * Memoire des sessions deja importees.
 *
 * Sans elle, `npm run import` relit l'archive entiere a chaque passage : a
 * 200 parties conservees, c'est plusieurs Go de gzip pour retrouver, la
 * plupart du temps, exactement ce qui est deja en base.
 *
 * Le principe reprend celui du manifeste d'archivage : une empreinte par
 * session, faite du nom, de la taille et de la date de modification de ses
 * fichiers de log. Une session encore en cours grossit, donc son empreinte
 * change, donc elle est relue — ce qui est bien le comportement voulu.
 */
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { schemaVersion, type Db } from './database.js';
import { openSession } from '../reader/session-reader.js';

/**
 * Empreinte d'une session.
 *
 * La version du schema en fait partie : une migration change ce qu'on extrait
 * du log, donc toutes les sessions doivent etre relues. C'est le seul moyen
 * d'eviter qu'une colonne ajoutee reste vide sur les anciennes parties.
 */
export async function sessionFingerprint(db: Db, folder: string): Promise<string> {
  const session = await openSession(folder);
  const parts: string[] = [`v${schemaVersion(db)}`];

  for (const file of session.files) {
    const stats = await stat(file).catch(() => null);
    if (stats === null) continue;
    parts.push(`${basename(file)}:${stats.size}:${Math.round(stats.mtimeMs)}`);
  }

  return parts.join('|');
}

/** Vrai si la session a deja ete importee dans cet etat exact. */
export function isSessionImported(db: Db, folder: string, fingerprint: string): boolean {
  const row = db
    .prepare('SELECT fingerprint FROM imported_sessions WHERE folder = ?')
    .get(folder) as { fingerprint: string } | undefined;
  return row?.fingerprint === fingerprint;
}

/** Retient qu'une session a ete importee dans cet etat. */
export function markSessionImported(db: Db, folder: string, fingerprint: string): void {
  db.prepare(
    `INSERT INTO imported_sessions (folder, fingerprint, imported_at)
     VALUES (?, ?, ?)
     ON CONFLICT(folder) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       imported_at = excluded.imported_at`,
  ).run(folder, fingerprint, new Date().toISOString());
}

/** Oublie toutes les empreintes : le prochain import relira tout. */
export function forgetImportedSessions(db: Db): void {
  db.prepare('DELETE FROM imported_sessions').run();
}
