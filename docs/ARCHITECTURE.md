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

### Simulateur de combat (phase 4)

`src/sim/` estime le prochain combat.

- `sim-cards.ts` charge la base de cartes de **Firestone**, distincte de celle de `src/cards/`
  (HearthstoneJSON, qui ne sert qu'à afficher des noms). Le simulateur y lit les effets propres à
  chaque carte — râles d'agonie, cris de guerre, invocations — que **rien dans les logs ne
  déclare**. 42 Mo, mis en cache dans `data/cards/firestone-cards.json` par `npm run sim-cards`.
- `combat.ts` traduit un plateau vers le format du moteur et lance la simulation. **1000
  simulations** par défaut : mesuré à 98 ms, et à un point près du résultat à 5000.
- `combat-odds.ts` estime le **combat en cours**, et fournit `oddsSignature`, qui évite de
  relancer 1000 simulations à chaque lot de lignes.

### Quand l'estimation est calculée

Au **début du combat**, pas pendant le recrutement. C'est le seul instant où les deux plateaux sont
connus exactement : avant, le plateau adverse n'existe pas ; après, il se vide.

`LiveTracker` publie donc `currentCombat`, les **deux** plateaux figés à la première balise
`ATTACKING`. Il **survit à la fin du combat** et n'est effacé qu'au début du suivant : un combat
dure une dizaine de secondes, trop court pour être lu, donc l'estimation reste affichée pendant le
recrutement qui suit. Le plateau adverse l'était déjà ; celui du joueur ne l'était pas, et `state.board`
continue de suivre le plateau en train de se battre — il est donc déjà entamé quelques
millisecondes plus tard. Les deux étant figés, la signature ne bouge qu'au combat suivant : une
seule série de simulations par combat.

Le compromis est assumé : l'estimation arrive quand il est **trop tard pour changer d'avis**. En
échange, elle est juste. Une estimation faite pendant le recrutement reposerait sur le plateau de
l'adversaire au dernier affrontement, vieux de plusieurs tours, pendant lesquels il a acheté, vendu
et amélioré.

### Cinq fenêtres

L'overlay en ouvre quatre pendant les parties, toutes transparentes et traversantes aux clics, plus
la saisie de cote en fin de partie :

| Mode | Position | Rôle | Composant |
|---|---|---|---|
| `left` | haut gauche, 320 px | combats passés et à venir | `Overlay.tsx` |
| `right` | haut droite, 300 px | jauges et rythme de paliers | `Side.tsx` |
| `combat` | **haut centre**, 460 px | estimation du combat | `Combat.tsx` |
| `bonus` | **bas centre**, 720 px | bonus cumulés | `Bonuses.tsx` |
| `rating` | bas droite | seule fenêtre où l'on peut cliquer | `RatingPrompt.tsx` |

Quatre fenêtres plutôt qu'un panneau unique parce que chaque coin de l'écran sert à autre chose
pendant une partie : les combats se consultent avant d'acheter, le rythme quand on hésite à monter
de palier, l'estimation au centre pendant qu'on regarde le combat. Tout au même endroit obligerait
à chercher.

Chacune reste **entièrement transparente** tant qu'elle n'a rien à dire : la bande de bonus
n'existe visuellement qu'à partir du premier bonus actif.

Toutes partagent `app/overlay/index.html`, le mode arrivant en paramètre d'URL, et `commun.tsx`
pour l'abonnement à l'état et les listes de serviteurs.

### Bonus cumulés

`src/extract/player-bonuses.ts` lit les tags portés par l'**entité joueur** : gemmes de sang, or du
tour suivant, actualisations offertes, râles d'agonie doublés (voir `docs/LOG_FORMAT.md`). Ils sont
relus sur tout changement de tag du joueur, et non dans `#refreshHero` qui ne surveille que le
héros. Un bonus à zéro n'est pas affiché.

### Limites restantes

| Limite | Conséquence |
|---|---|
| Les **pouvoirs héroïques** ne sont pas extraits des logs | un héros dont le pouvoir agit en combat est sous-estimé |
| Les **PV adverses** ne sont connus que s'il a déjà été affronté | le létal infligé est sous-estimé, jamais surestimé |

Sans le cache de cartes, l'estimation est simplement absente : le reste de l'overlay fonctionne.

### Lecture mémoire (cote)

⚠️ `src/memory/` **sort de la règle « uniquement les fichiers de log »**. Il existe pour une seule
raison : la cote (MMR) n'apparaît dans **aucun** des dix fichiers qu'une session écrit (vérifié,
voir `docs/LOG_FORMAT.md`). Voir `CLAUDE.md` pour la décision et ses limites — lecture seule,
cantonné à ce dossier, doit échouer proprement.

- `process-memory.ts` — primitives Win32 via **koffi** (FFI à binaires précompilés, aucune
  compilation native). `findProcessIdByName`, `listModules`, `readMemory`/`readPointer`/
  `readCString`. Une lecture invalide rend `null`, elle ne lève pas : suivre un pointeur atterrit
  couramment sur une adresse non mappée, ce n'est pas une anomalie.
- `pe-exports.ts` — table d'exports d'un module PE, lue à distance (format standard, testé contre
  `kernel32.dll`). Sert à localiser une fonction Mono par son nom sans l'exécuter : on n'a que
  `PROCESS_VM_READ`, jamais le droit d'appeler du code dans le processus visé.
- `mono-runtime.ts` — marche dans le runtime Mono jusqu'aux assemblies chargées. Deux motifs de
  prologue x64 à reconnaître :
  - un **accesseur trivial** `mov rax, [rcx+X]; ret` donne un décalage de champ directement ;
    **redécouvert à chaque lancement**, jamais figé, donc résistant à un patch qui déplace le
    champ tant que l'export survit ;
  - une **globale** `mov rax, [rip+X]; ret` (`mono_get_root_domain`) donne l'adresse d'une
    variable, pas sa valeur.

  Le seul décalage codé en dur, `MonoDomain.domain_assemblies` (`0xa0`), n'a pas d'accesseur
  exporté : dérivé par désassemblage de `mono_domain_assembly_foreach` (le commentaire au-dessus
  de `listAssemblies` détaille le prologue), et **vérifié à chaque appel** en cherchant `mscorlib`
  dans le résultat. Son absence lève `MonoLayoutError` plutôt que de rendre une liste tronquée sans
  le dire — c'est le point qui casse en premier à un patch.

  Vérifié en direct sur le jeu : domaine racine résolu, 119 assemblies énumérées, `mscorlib` et
  `Assembly-CSharp` — où vit le code du jeu — retrouvées par leur nom.
- `mono-classes.ts` — classes, champs et statiques d'une image. Toute la disposition (`MonoLayout`)
  est **recalculée au lancement** : décalages lus dans les accesseurs exportés, table des classes
  repérée par sa signature de `MonoInternalHashTable`, `runtime_info` repéré parce que sa vtable
  pointe en retour vers la classe. Seuls `MonoClass.fields` (0x98) et la forme de `MonoClassField`
  sont codés en dur, et vérifiés à chaque lecture par le champ `parent`.
- `rating-reader.ts` — la cote. Chemin : `ServiceManager.s_runtimeServices` →
  `m_services` → le `ServiceInfo` dont le service est `NetCache` → `m_netCache` →
  `NetCacheBaconRatingInfo` → `Rating` / `DuosRating`. **Chaque champ est retrouvé par son
  nom**, jamais par un décalage : seules les dispositions des conteneurs du runtime (tableau,
  entrée de dictionnaire) sont figées. Préparation ~30 ms, lecture ~20 ms.

  Vérifié le 24/09/2026 contre la dernière ligne de `ratings.csv` (5079, identique), puis sur une
  partie réelle : 5079 lu 17 secondes avant la fin, 5000 après une 6ᵉ place.

**Branchement dans l'overlay.** La cote est lue au début de chaque partie. À la fin, l'overlay la
relit toutes les deux secondes jusqu'à ce que le serveur envoie la nouvelle valeur (trois minutes
au plus), puis **ajoute une ligne datée** à `ratings.csv`. La partie n'est pas encore en base à ce
moment-là, mais `matchRatings` rattache une cote à la partie la plus proche dans le temps : le
prochain `npm run sync` fait le lien. L'overlay lance ensuite **`npm run sync`** lui-même, dans un processus à part (l'import écrit en
base de façon synchrone et gèlerait l'overlay), un seul à la fois. La fenêtre de saisie ne s'ouvre
qu'**après** ce sync, et seulement si la cote manque encore : avant, la partie qui vient de finir
n'est pas en base et la fenêtre visait la précédente.

**Types de la partie.** `lobbyRaces()` lit `GameState.m_availableRacesInBattlegroundsExcludingAmalgam`
(`null` hors partie, `GameState` n'existant que pendant une partie). Lus une fois par partie, ils
remplacent la déduction du panneau Taverne et servent au choix du héros.

**Choix du héros.** `LiveTracker.heroOffers` suit le choix `MULLIGAN` comme l'extracteur hors ligne
(vérifié sur l'extrait de référence : mêmes héros). Pendant ce choix, le panneau de droite remplace
ses jauges par une fiche par héros (`heroPickCard`) : parties jouées, place moyenne, top 4, taux de
sélection, et le type du plateau final qui a mené le plus loin **parmi ceux de la partie**.

**Entre deux parties.** Le panneau de gauche remplace « en attente d'une partie » par un écran de
cote (`Repos.tsx`, calculé par `restingView`) : la cote actuelle en grand, l'écart de la dernière
partie, la courbe des 40 dernières cotes et le bilan du jour. La cote lue dans le jeu y fait foi :
elle peut être en avance sur la base, la partie qui vient de finir n'entrant qu'au sync suivant.
Le bandeau de combat, lui, disparaît dès la fin de la partie.

**Solo ou Duo.** Les logs ne distinguent pas les deux modes. La mémoire, si : seule la cote du mode
joué bouge (`detectRatingChange`). La ligne ajoutée le note (`lue en jeu (Solo)`).

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
