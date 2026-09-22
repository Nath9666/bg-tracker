/**
 * Ouverture de la base SQLite et application des migrations.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

/** Emplacement par defaut de la base. `data/` est ignore par Git. */
export const DEFAULT_DB_PATH = 'data/bg-tracker.db';

/**
 * Ouvre la base et la met a niveau.
 *
 * `:memory:` est accepte, ce dont les tests se servent.
 */
export function openDatabase(path: string = DEFAULT_DB_PATH): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  // Les cles etrangeres ne sont pas actives par defaut dans SQLite : sans ca,
  // ON DELETE CASCADE ne ferait rien.
  db.pragma('foreign_keys = ON');
  // WAL : la base reste lisible pendant qu'un import ecrit.
  if (path !== ':memory:') db.pragma('journal_mode = WAL');

  migrate(db);
  return db;
}

/** Applique les migrations manquantes. Renvoie le nombre appliquees. */
export function migrate(db: Db): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  const pending = MIGRATIONS.slice(current);
  if (pending.length === 0) return 0;

  db.transaction(() => {
    for (const migration of pending) db.exec(migration.sql);
    // `user_version` n'accepte pas de parametre lie : la valeur vient d'un
    // tableau du code, jamais d'une entree exterieure.
    db.pragma(`user_version = ${MIGRATIONS.length}`);
  })();

  return pending.length;
}

/** Version du schema actuellement en base. */
export function schemaVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}
