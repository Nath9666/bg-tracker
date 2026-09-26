/**
 * La base, partagee par le tableau de bord et l'overlay : une seule connexion
 * pour toute l'application. Ouverte au premier besoin, apres que le dossier
 * des donnees a ete choisi (voir app-main.ts).
 */
import { DEFAULT_DB_PATH, openDatabase, type Db } from '../../src/db/database.js';

let db: Db | null = null;

export function database(): Db {
  db ??= openDatabase(process.env['BG_TRACKER_DB'] ?? DEFAULT_DB_PATH);
  return db;
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}
