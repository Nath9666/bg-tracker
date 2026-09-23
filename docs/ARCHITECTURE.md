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
│   ├── main/                 # processus principal + preload
│   └── renderer/             # interface React
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

### Suivi en direct (phase 4)
`src/reader/live-reader.ts` relit périodiquement ce que le jeu ajoute à `Power.log`, à partir d'un
offset en **octets** — jamais le fichier entier, qui dépasse couramment 200 Mo. Il encaisse les trois
événements qui changent la source : l'ajout de lignes, le renommage en `Power_old.log` à la fin d'une
session, et l'apparition d'un nouveau dossier quand le joueur relance le jeu.

Une ligne encore incomplète n'est pas rendue : elle attend son saut de ligne, sans quoi on lirait une
ligne tronquée en cours d'écriture.

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

### Base de cartes
`src/cards/` télécharge HearthstoneJSON (`frFR` et `enUS`), en construit un index réduit dans
`data/cards/index.json` et l'écrit dans la table `cards`. Les logs ne contiennent que des `cardId` :
c'est la seule source des noms, du palier de taverne et des types de serviteur. À rafraîchir après
chaque extension avec `npm run cards`.

Le `SessionReader`, le `LineParser` et le `GameStateMachine` n'en dépendent pas : sans index, la CLI
affiche les `cardId` bruts et continue de fonctionner.

### Overlay (phase 4)
Ce qu'il affiche reste dans la limite « papier-crayon » : uniquement des informations que le joueur a
**déjà eues sous les yeux**. Pas de simulation de combat — décision prise le 23/09/2026, voir
`CLAUDE.md`.

Trois garde-fous d'honnêteté dans l'affichage :

- le plateau d'un adversaire est daté du tour où il a été vu, et la comparaison de force n'est
  **tranchée que si ce plateau a moins de trois tours** ; au-delà on affiche son âge sans conclure,
  comparer un plateau vieux de sept tours au sien ne voulant rien dire ;
- le **rythme de paliers** confronte la montée de la partie en cours à celle des tops 4 du joueur,
  lue dans la base. Il n'est affiché qu'à partir de **trois parties de référence** pour ce palier ;
- ce rythme est montré **sans vert ni rouge**. Sur l'historique réel, T4 arrive plus tôt dans les
  tops 4 (6,4 contre 7,1) mais T5 et T6 plus **tard** (10,1 contre 9,7). « Plus tôt = mieux » est
  donc faux : l'overlay montre l'écart, il ne le juge pas.

`app/main/overlay-main.ts` suit `Power.log`, alimente le `LiveTracker` et pousse l'état par IPC vers
deux fenêtres :

- **l'overlay** : transparente, `alwaysOnTop`, `setIgnoreMouseEvents(true)` — les clics la traversent,
  elle ne gêne jamais le jeu. Comme on ne peut donc pas y faire défiler, tout doit tenir à l'écran :
  les plateaux ne sont montrés que pour les deux derniers adversaires affrontés ;
- **la saisie de cote** : fenêtre normale, ouverte à la fin d'une partie, la seule où l'on tape.

Au démarrage, la session est relue **depuis le début** pour rattraper une partie déjà commencée ;
sans cela, lancer l'overlay en cours de partie laisserait l'écran vide jusqu'à la suivante.

Les deux interfaces React partagent une compilation Vite à deux entrées (`app/renderer`, `app/overlay`).

### Application Electron
`app/main/` ouvre la base et répond par IPC ; `app/renderer/` est l'interface React (Vite, Recharts).
Le rendu n'a **ni Node ni accès à SQLite** : `contextIsolation` est activé, `nodeIntegration`
désactivé, et le preload n'expose qu'une seule fonction, `dashboard(filtres)`.

Le processus principal appelle les mêmes fonctions de `src/stats` que `npm run stats` : une seule
source pour les deux surfaces.

`npm run app` compile (esbuild pour le principal et le preload, Vite pour le rendu) puis lance.

### Export vers Python (phase 5)
`src/export/` aplatit `decisions` et `decision_cards` en un fichier JSON Lines, une décision par
ligne, chacune portant **l'issue de sa partie**. Ce format plutôt que du CSV parce qu'une décision
porte trois listes de longueur variable. Voir `ml/README.md`.

### Statistiques
`src/stats/` ne fait que lire la base et rendre des objets simples : vue d'ensemble, chronologie avec
moyenne glissante, table des héros, répartition des places, courbe de montée de taverne et type
dominant du plateau final. Tout accepte les mêmes filtres (période, héros, mode, parties inachevées).

Aucune dépendance à une interface : `npm run stats` les affiche dans le terminal, l'application
Electron s'en servira telle quelle.

`src/db/hero-base.ts` normalise un héros vers son héros de base. Import et statistiques passent par
**le même** résolveur, sans quoi un héros à skin apparaîtrait joué mais jamais proposé.

### Cote (MMR)
`src/ratings/` tient `data/ratings.csv` à jour : une ligne par partie, la plus ancienne d'abord, avec
la date de fin déjà remplie et la cote à compléter. `npm run ratings` fait les deux sens en un passage,
ajoute les parties nouvelles sans toucher aux cotes déjà saisies, puis rattache chaque cote à la partie
la plus proche dans le temps (90 minutes de tolérance, une cote par partie).

Le fichier porte une troisième colonne, `partie`, qui n'est qu'un repère lisible : elle est réécrite à
chaque passage et jamais relue.

### GameExtractor
Transforme l'état et les événements métier en objets `GameSummary`, `TurnRecord`, `BoardSnapshot`, `PickRecord`.

Il **suit le flux d'événements en parallèle du `GameStateMachine`** plutôt que de lire l'état final :
le tour d'une montée de palier, ou les options d'une découverte, n'existent qu'à l'instant où la ligne
passe. `LogClock` date les lignes, qui ne portent que l'heure, à partir de la date du dossier de
session, en gérant le passage de minuit.

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

### Écarts au schéma initial (phase 2)

Le schéma réellement créé par `src/db/migrations.ts` s'en écarte sur les points suivants.

**`games`**, colonnes ajoutées :

| Colonne | Pourquoi |
|---|---|
| `complete` | Une session peut se terminer sur une partie inachevée. Sans ce drapeau, une partie en cours serait prise pour une partie terminée à la place courante. |
| `game_type` | Permet de vérifier le filtrage après coup, et de repérer un mode inattendu. |
| `player_name` | Présent dans le `GameSummary`, utile pour distinguer les comptes. |
| `game_seed` | Composant de la clef, gardé en clair pour pouvoir le retrouver. |
| `imported_at` | Savoir quand une ligne a été écrite. |

`mode` reste **toujours `NULL`** : aucun indice fiable ne distingue Solo de Duo dans les logs
(voir `docs/LOG_FORMAT.md`). La colonne existe, elle attend une partie Duo pour être remplie.

**`hero_offers`** et **`picks`** gagnent une colonne `position`, l'ordre de présentation des options.
La phase 5 en aura besoin : la position d'une carte influence le choix.

**Table ajoutée : `decision_cards`** (`game_id`, `sequence`, `zone`, `position`, `card_id`, `atk`,
`health`, `golden`). Ce que le joueur avait sous les yeux : son plateau, sa main, et **la boutique de
Bob**. Cette dernière est l'essentiel — sans elle on sait ce qu'il a pris, pas ce qu'il a écarté.
Environ 10 cartes par décision, soit 1 800 lignes par partie.

**Table ajoutée : `decisions`** (`game_id`, `sequence`, `turn`, `action`, `card_id`, `target_card_id`,
`position`, `gold`, `tavern_tier`, `health`). Une ligne par action du joueur, ~156 par partie. C'est
la seule donnée du projet qui **n'est pas reconstituable** depuis un résumé de partie : elle n'existe
que dans les logs bruts, qui sont élagués. La collecter tôt conditionne la phase 5.

**Table ajoutée : `imported_sessions`** (`folder`, `fingerprint`, `imported_at`). L'empreinte d'une
session déjà importée : nom, taille et date de modification de ses fichiers de log, précédés de la
version du schéma. Sans elle, `npm run import` relisait **toute l'archive** à chaque passage.
Une session encore en cours grossit, donc son empreinte change, donc elle est relue — ce qui est
bien le comportement voulu. La version du schéma en fait partie pour qu'une migration invalide tout
et force une relecture complète : sans ça, une colonne ajoutée resterait vide sur les anciennes
parties. `npm run import -- --force` ignore les empreintes.

**Table ajoutée : `cards`** (`card_id`, `dbf_id`, `name`, `name_en`, `type`, `tech_level`, `races`,
`card_class`, `is_bg_hero`, `is_bg_pool`, `refreshed_at`), remplie depuis HearthstoneJSON. L'index sur
`dbf_id` sert à remonter d'un skin de héros au héros de base via `BACON_SKIN_PARENT_ID`.

**Table ajoutée : `tier_ups`** (`game_id`, `tier`, `turn`). Le schéma initial rangeait le palier dans
`turns`, mais `turns` demande aussi l'or, les PV et l'adversaire, qui ne sont pas encore extraits.
`tier_ups` enregistre la montée de taverne, qui l'est, et sert directement la courbe demandée en
phase 3.
