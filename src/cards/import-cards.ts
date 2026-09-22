/**
 * Ecriture de la base de cartes en SQLite.
 *
 * Les cartes sont remplacees en bloc a chaque rafraichissement : HearthstoneJSON
 * est la seule source, il n'y a rien a preserver cote base.
 */
import type { Db } from '../db/database.js';
import type { CardInfo } from './card-database.js';

export function importCards(db: Db, cards: readonly CardInfo[]): number {
  const insert = db.prepare(`
    INSERT INTO cards (
      card_id, dbf_id, name, name_en, type, tech_level, races, card_class,
      is_bg_hero, is_bg_pool, refreshed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(card_id) DO UPDATE SET
      dbf_id = excluded.dbf_id, name = excluded.name, name_en = excluded.name_en,
      type = excluded.type, tech_level = excluded.tech_level, races = excluded.races,
      card_class = excluded.card_class, is_bg_hero = excluded.is_bg_hero,
      is_bg_pool = excluded.is_bg_pool, refreshed_at = excluded.refreshed_at
  `);

  const refreshedAt = new Date().toISOString();

  db.transaction(() => {
    for (const card of cards) {
      insert.run(
        card.cardId,
        card.dbfId,
        card.name,
        card.nameEn,
        card.type,
        card.techLevel,
        card.races.join(','),
        card.cardClass,
        card.isBgHero ? 1 : 0,
        card.isBgPoolMinion ? 1 : 0,
        refreshedAt,
      );
    }
  })();

  return cards.length;
}
