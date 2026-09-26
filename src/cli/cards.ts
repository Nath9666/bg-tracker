/**
 * CLI : `npm run cards [--db <fichier>] [--index <fichier>]`
 *
 * Telecharge la base de cartes HearthstoneJSON (frFR et enUS), en construit un
 * index reduit dans `data/cards/`, et l'ecrit en base.
 *
 * A relancer apres chaque extension de Hearthstone, sinon les cartes recentes
 * restent affichees sous leur `cardId`.
 */
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_INDEX_PATH, buildIndex, fetchCards, saveIndex } from '../cards/card-database.js';
import { importCards } from '../cards/import-cards.js';
import { DEFAULT_DB_PATH, openDatabase } from '../db/database.js';

export interface CardsCliOptions {
  db: string;
  index: string;
}

export function parseCardsArgs(argv: readonly string[]): CardsCliOptions {
  const options: CardsCliOptions = { db: DEFAULT_DB_PATH, index: DEFAULT_INDEX_PATH };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '--db' || arg === '--index') {
      if (next === undefined) throw new Error(`Valeur manquante apres ${arg}`);
      if (arg === '--db') options.db = next;
      else options.index = next;
      i += 1;
    } else {
      throw new Error(`Option inconnue : ${arg}`);
    }
  }

  return options;
}

/** Telecharge la base de cartes et l'ecrit en base. Exporte pour l'application. */
export async function runCards(argv: readonly string[] = []): Promise<void> {
  const options = parseCardsArgs(argv);

  console.log('Téléchargement de HearthstoneJSON (frFR, enUS)…');
  const [french, english] = await Promise.all([fetchCards('frFR'), fetchCards('enUS')]);

  const cards = buildIndex(french, english);
  await saveIndex(options.index, cards);
  console.log(`${cards.length} cartes → ${resolve(options.index)}`);

  const db = openDatabase(options.db);
  importCards(db, cards);

  const stats = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(is_bg_hero) AS heroes,
              SUM(CASE WHEN tech_level IS NOT NULL THEN 1 ELSE 0 END) AS minions
       FROM cards`,
    )
    .get() as { total: number; heroes: number; minions: number };

  console.log(
    `${stats.total} en base, dont ${stats.heroes} héros de Champs de bataille et ${stats.minions} cartes avec un palier.`,
  );
  db.close();
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void runCards(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
