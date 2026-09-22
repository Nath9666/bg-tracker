/**
 * Migrations du schema SQLite.
 *
 * Chaque entree du tableau est une version. `PRAGMA user_version` retient ou en
 * est la base : on applique les migrations manquantes, dans l'ordre, dans une
 * transaction. Une migration deja publiee ne se modifie jamais, on en ajoute
 * une nouvelle.
 *
 * Le schema de reference est decrit dans docs/ARCHITECTURE.md.
 */

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    name: 'games, hero_offers, tier_ups, picks',
    sql: `
      CREATE TABLE games (
        -- Clef stable : GAME_SEED + jour de debut. Reimporter le meme log
        -- retombe sur la meme ligne au lieu d'en creer une seconde.
        id            TEXT PRIMARY KEY,
        started_at    TEXT NOT NULL,          -- ISO 8601, heure locale
        ended_at      TEXT,                   -- NULL si la partie n'est pas allee au bout
        complete      INTEGER NOT NULL,       -- 0/1
        build_number  INTEGER,
        game_type     TEXT,                   -- 'GT_BATTLEGROUNDS'
        -- 'solo' | 'duo' | NULL. Aucun indice fiable trouve dans les logs pour
        -- distinguer les deux modes : laisse a NULL tant qu'une partie Duo
        -- n'aura pas permis de trancher (voir docs/LOG_FORMAT.md).
        mode          TEXT,
        player_name   TEXT,
        game_seed     TEXT,
        hero_card_id  TEXT,                   -- cardId du heros joue, skin compris
        hero_base_id  TEXT,                   -- heros normalise, sans suffixe _SKIN_x
        final_place   INTEGER,
        final_turn    INTEGER,                -- tour de jeu, pas le compteur TURN brut
        rating_after  INTEGER,                -- saisi par l'utilisateur, phase 4
        source_folder TEXT,
        imported_at   TEXT NOT NULL
      );

      CREATE TABLE hero_offers (
        game_id  TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        card_id  TEXT NOT NULL,
        position INTEGER NOT NULL,            -- ordre de presentation au mulligan
        chosen   INTEGER NOT NULL,            -- 0/1
        PRIMARY KEY (game_id, card_id)
      );

      CREATE TABLE tier_ups (
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        tier    INTEGER NOT NULL,
        turn    INTEGER NOT NULL,
        PRIMARY KEY (game_id, tier)
      );

      CREATE TABLE picks (
        game_id     TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        choice_id   INTEGER NOT NULL,         -- id du choix dans le log
        turn        INTEGER,
        source_card TEXT,                     -- ex. TB_BaconShop_Triples_01
        kind        TEXT NOT NULL,            -- 'hero' | 'triple' | 'trinket' | 'discover' | 'other'
        option_card TEXT NOT NULL,
        position    INTEGER NOT NULL,         -- ordre de presentation des options
        chosen      INTEGER NOT NULL,         -- 0/1
        PRIMARY KEY (game_id, choice_id, option_card)
      );

      CREATE INDEX idx_games_started_at ON games(started_at);
      CREATE INDEX idx_games_hero_base  ON games(hero_base_id);
      CREATE INDEX idx_picks_option     ON picks(option_card);
    `,
  },
  {
    name: 'cards (base HearthstoneJSON)',
    sql: `
      CREATE TABLE cards (
        card_id      TEXT PRIMARY KEY,
        dbf_id       INTEGER,
        name         TEXT NOT NULL,        -- frFR
        name_en      TEXT NOT NULL,
        type         TEXT,                 -- MINION | HERO | BATTLEGROUND_TRINKET | ...
        tech_level   INTEGER,              -- palier de taverne, NULL hors serviteur CdB
        races        TEXT,                 -- types du serviteur, separes par des virgules
        card_class   TEXT,
        is_bg_hero   INTEGER NOT NULL,
        is_bg_pool   INTEGER NOT NULL,
        refreshed_at TEXT NOT NULL
      );

      -- BACON_SKIN_PARENT_ID donne un dbfId : c'est par la qu'on remonte d'un
      -- skin de heros au heros de base.
      CREATE INDEX idx_cards_dbf_id ON cards(dbf_id);
    `,
  },
  {
    name: 'turns, boards',
    sql: `
      CREATE TABLE turns (
        game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        turn          INTEGER NOT NULL,
        tavern_tier   INTEGER,
        -- Or total disponible ce tour-la, bonus compris : le log peut
        -- l'augmenter en cours de tour.
        gold          INTEGER,
        health        INTEGER,               -- PV restants apres le combat, armure comprise
        opponent_hero TEXT,                  -- cardId du heros affronte
        combat_result TEXT,                  -- 'win' | 'loss' | 'tie'
        damage_taken  INTEGER,
        PRIMARY KEY (game_id, turn)
      );

      CREATE TABLE boards (
        game_id  TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        turn     INTEGER NOT NULL,
        position INTEGER NOT NULL,           -- ZONE_POSITION, de 1 a 7
        card_id  TEXT NOT NULL,
        atk      INTEGER,
        health   INTEGER,
        golden   INTEGER NOT NULL,           -- 0/1, lu sur le tag PREMIUM
        PRIMARY KEY (game_id, turn, position)
      );

      CREATE INDEX idx_turns_opponent ON turns(opponent_hero);
      CREATE INDEX idx_boards_card    ON boards(card_id);
    `,
  },
  {
    name: 'cards.skin_parent_dbf_id',
    sql: `
      -- HearthstoneJSON donne le heros de base d'un skin par son dbfId.
      -- Indispensable : retirer le suffixe _SKIN_x du cardId donne un resultat
      -- faux pour certains heros (TB_BaconShop_HERO_201_SKIN_D -> BG20_HERO_201).
      ALTER TABLE cards ADD COLUMN skin_parent_dbf_id INTEGER;
      CREATE INDEX idx_cards_skin_parent ON cards(skin_parent_dbf_id);
    `,
  },
];
