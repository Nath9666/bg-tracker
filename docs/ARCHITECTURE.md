# Architecture

## Flux de données

```
Logs Hearthstone ──► archive (phase 0)
                        │
                        ▼
  SessionReader ──► LineParser ──► GameStateMachine ──► GameExtractor ──► SQLite
  (flux de lignes)   (événements     (modèle d'entités,   (résumé, tours,     │
                      typés)          découpage parties)   plateaux, choix)   │
                                                                              ▼
                                         Tableau de bord / Overlay (Electron) ◄┘
                                         Jeu de données IA (Python)          ◄┘
```

Le même `GameStateMachine` sert en hors ligne (phase 1) et en direct (phase 4). Seule la source de lignes change : lecture de fichiers archivés, ou suivi du `Power.log` en cours.

## Arborescence cible

```
bg-tracker/
├── CLAUDE.md
├── docs/
├── fixtures/                 # logs réels (gros fichiers hors Git)
│   └── sample-game-1/
├── scripts/                  # archive-logs, utilitaires
├── src/
│   ├── archive/              # archivage des sessions (phase 0)
│   ├── reader/               # SessionReader : fichiers → lignes (flux)
│   ├── parser/               # LineParser : ligne → événement typé
│   ├── state/                # Entity, GameStateMachine
│   ├── extract/              # GameExtractor : état → objets métier
│   ├── cards/                # base de cartes HearthstoneJSON (cache local)
│   ├── db/                   # schéma, migrations, import (phase 2)
│   ├── cli/                  # commandes npm run …
│   └── types.ts
├── app/                      # Electron (phases 3-4)
├── ml/                       # Python (phase 5)
└── tests/
```

## Modules

### Archivage (phase 0)
`src/archive/` copie les `Power.log` de chaque session vers un dossier d'archive, compressés en gzip,
et n'y garde que les N dernières parties. Un `manifest.json` évite de refaire le travail à chaque
passage. Voir `docs/ARCHIVAGE.md`.

### SessionReader
Entrée : un dossier de session, d'origine ou archivé. Sortie : un itérateur asynchrone de lignes (`AsyncIterable<string>`), `Power_old.log` d'abord puis `Power.log`. Les variantes `.gz` produites par l'archivage sont décompressées au fil de l'eau, sans fichier temporaire. Fournit aussi la date de la session (tirée du nom de dossier) pour dater les lignes.

### LineParser
Fonction pure : `parseLine(line: string): LogEvent | null`. Ne garde que les sources `GameState.*`. Renvoie des événements typés (union discriminée) :

- `CreateGame`, `GameEntityDef`, `PlayerDef`
- `FullEntity`, `ShowEntity`, `HideEntity`, `ChangeEntity`
- `TagDef` (tag indenté sous une création), `TagChange`
- `BlockStart`, `BlockEnd`
- `GameMeta` (`DebugPrintGame` : BuildNumber, GameType, PlayerID/PlayerName…)
- `ChoicesOffered`, `ChoiceOption`, `ChoiceMade`
- `OptionsAvailable`, `OptionSent` (utile surtout en phase 5)

Chaque événement porte `timestamp` (horodatage complet) et `indent`.

### GameStateMachine
Maintient l'état d'une partie en cours :

- `entities: Map<number, Entity>` avec `Entity = { id, cardId, tags: Map<string, string> }`
- la table nom de joueur → id d'entité
- l'id du joueur local, l'id de son héros

Émet des événements métier quand une partie commence ou se termine, et à chaque changement significatif (nouveau tour, changement de tier, choix, place). L'extracteur s'abonne à ces événements.

### GameExtractor
Transforme l'état et les événements métier en objets `GameSummary`, `TurnRecord`, `BoardSnapshot`, `PickRecord`.

## Schéma SQLite (phase 2)

```sql
CREATE TABLE games (
  id              TEXT PRIMARY KEY,   -- stable : GAME_SEED + date de début
  started_at      TEXT NOT NULL,      -- ISO 8601
  ended_at        TEXT,
  build_number    INTEGER,
  mode            TEXT,               -- 'solo' | 'duo'
  hero_card_id    TEXT,               -- cardId du héros choisi
  hero_base_id    TEXT,               -- héros normalisé (sans skin)
  final_place     INTEGER,
  final_turn      INTEGER,            -- tour de jeu, pas le compteur TURN brut
  rating_after    INTEGER,            -- saisi par l'utilisateur
  source_folder   TEXT
);

CREATE TABLE hero_offers (
  game_id   TEXT REFERENCES games(id),
  card_id   TEXT NOT NULL,
  chosen    INTEGER NOT NULL          -- 0/1
);

CREATE TABLE turns (
  game_id        TEXT REFERENCES games(id),
  turn           INTEGER NOT NULL,
  tavern_tier    INTEGER,
  gold           INTEGER,
  health         INTEGER,             -- PV restants (armure incluse si possible)
  opponent_hero  TEXT,                -- cardId du héros affronté
  combat_result  TEXT,                -- 'win' | 'loss' | 'tie'
  damage_taken   INTEGER,
  PRIMARY KEY (game_id, turn)
);

CREATE TABLE boards (
  game_id    TEXT REFERENCES games(id),
  turn       INTEGER NOT NULL,
  position   INTEGER NOT NULL,
  card_id    TEXT NOT NULL,
  atk        INTEGER,
  health     INTEGER,
  golden     INTEGER NOT NULL,
  PRIMARY KEY (game_id, turn, position)
);

CREATE TABLE picks (
  game_id     TEXT REFERENCES games(id),
  choice_id   INTEGER NOT NULL,       -- id du choix dans le log
  turn        INTEGER,
  source_card TEXT,                   -- ex. TB_BaconShop_Triples_01
  kind        TEXT,                   -- 'hero' | 'triple' | 'trinket' | 'discover' | 'other'
  option_card TEXT NOT NULL,
  chosen      INTEGER NOT NULL,
  PRIMARY KEY (game_id, choice_id, option_card)
);
```

Ce schéma est un point de départ : l'ajuster si l'extraction révèle d'autres besoins, et documenter chaque changement ici.
