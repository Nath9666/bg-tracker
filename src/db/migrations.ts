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
  {
    name: 'decisions',
    sql: `
      -- Chaque action du joueur, avec le contexte ou elle a ete prise.
      -- Ces lignes n'existent que dans les logs bruts : elles ne sont pas
      -- reconstituables depuis le resume d'une partie, et les logs sont
      -- elagues. C'est la matiere premiere de la phase 5.
      CREATE TABLE decisions (
        game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        sequence       INTEGER NOT NULL,    -- rang dans la partie
        turn           INTEGER,
        -- 'buy' | 'buySpell' | 'sell' | 'reroll' | 'freeze' | 'tierUp'
        -- | 'heroPower' | 'play' | 'endTurn' | 'other'
        action         TEXT NOT NULL,
        card_id        TEXT,                -- carte support : bouton, sort, pouvoir
        target_card_id TEXT,                -- serviteur achete, vendu ou vise
        position       INTEGER,             -- emplacement de pose
        gold           INTEGER,
        tavern_tier    INTEGER,
        health         INTEGER,
        PRIMARY KEY (game_id, sequence)
      );

      CREATE INDEX idx_decisions_action ON decisions(action);
      CREATE INDEX idx_decisions_target ON decisions(target_card_id);
    `,
  },
  {
    name: 'decision_cards',
    sql: `
      -- Ce que le joueur avait sous les yeux a chaque decision : son plateau,
      -- sa main, et la boutique de Bob. La boutique est l'essentiel : sans
      -- elle on sait ce qu'il a pris, pas ce qu'il a ecarte.
      CREATE TABLE decision_cards (
        game_id  TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        zone     TEXT NOT NULL,          -- 'board' | 'hand' | 'shop'
        position INTEGER NOT NULL,
        card_id  TEXT NOT NULL,
        atk      INTEGER,
        health   INTEGER,
        golden   INTEGER NOT NULL,
        PRIMARY KEY (game_id, sequence, zone, position),
        FOREIGN KEY (game_id, sequence) REFERENCES decisions(game_id, sequence) ON DELETE CASCADE
      );

      CREATE INDEX idx_decision_cards_card ON decision_cards(card_id, zone);
    `,
  },
  {
    name: 'imported_sessions',
    sql: `
      -- Empreinte des sessions deja importees : nom, taille et date de
      -- modification de leurs fichiers de log. Une session inchangee est
      -- sautee, ce qui rend l'import proportionnel aux nouvelles parties et
      -- non a la taille de l'archive.
      --
      -- La version du schema fait partie de l'empreinte, donc une migration
      -- invalide tout et force une relecture complete.
      CREATE TABLE imported_sessions (
        folder      TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );
    `,
  },
  {
    name: 'career_snapshots',
    sql: `
      -- Statistiques de carriere des Champs de bataille, lues dans la memoire
      -- du jeu (aucun log ne les porte, voir docs/LOG_FORMAT.md). Un releve
      -- date par lecture qui change quelque chose : on suit ainsi leur
      -- evolution, pas seulement leur derniere valeur.
      --
      -- Clef/valeur plutot qu'une colonne par compteur : un compteur decouvert
      -- plus tard en memoire y entre sans nouvelle migration.
      CREATE TABLE career_snapshots (
        taken_at TEXT NOT NULL,          -- ISO 8601, heure locale
        stat     TEXT NOT NULL,          -- ex. 'top4', 'minionsKilled'
        value    INTEGER NOT NULL,
        PRIMARY KEY (taken_at, stat)
      );

      CREATE INDEX idx_career_stat ON career_snapshots(stat, taken_at);
    `,
  },
];
