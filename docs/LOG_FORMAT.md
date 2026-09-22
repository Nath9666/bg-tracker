# Format de Power.log (mode Champs de bataille)

Ce document rassemble ce qui a été **vérifié sur un vrai log** (build `251952`, client en français). Tout ce qui n'est pas vérifié est marqué *(à vérifier)*. Compléter ce fichier à chaque découverte.

## Activation des logs

Fichier `%LocalAppData%\Blizzard\Hearthstone\log.config`, déjà configuré chez l'utilisateur. La section indispensable :

```ini
[Power]
LogLevel=1
FilePrinting=True
ConsolePrinting=False
ScreenPrinting=False
Verbose=True
```

## Emplacement et rotation des fichiers

- Les logs sont dans `<dossier d'installation Hearthstone>\Logs\`, avec **un sous-dossier par session de jeu**, nommé `Hearthstone_AAAA_MM_JJ_HH_MM_SS` (vérifié : `Hearthstone_2026_09_22_00_28_13`). C'est la seule source de la **date** des lignes, qui ne portent que l'heure.
- Installation de référence chez l'utilisateur : `F:\SteamLibrary\Hearthstone`, donc les sessions sont dans `F:\SteamLibrary\Hearthstone\Logs\`.
- Un dossier de session contient une quinzaine de fichiers (`Hearthstone.log`, `LoadingScreen.log`, `Achievements.log`…). Seuls `Power.log` et `Power_old.log` nous intéressent.
- Dans une session terminée, on trouve un `Power_old.log` en plus de `Power.log`. Hearthstone renomme l'ancien fichier et en recommence un nouveau. Dans le fichier de référence, `Power_old.log` commence directement par `CREATE_GAME`, donc la rotation s'est faite au début d'une partie *(déclencheur exact à vérifier ; probablement un seuil de taille)*.
- **Un dossier de session ne contient jamais les deux fichiers à la fois.** Relevé sur les 6 sessions
  présentes : chacune a soit `Power.log`, soit `Power_old.log`. Le renommage a été **observé en direct** :
  le `Power.log` de `Hearthstone_2026_09_22_00_28_13`, lu à 177 Mo pendant que l'utilisateur jouait, est
  devenu `Power_old.log` à 226 Mo à la fermeture du jeu, sans qu'un nouveau `Power.log` soit créé. La
  règle « lire `Power_old.log` puis `Power.log` » reste la bonne, mais en pratique il n'y en a qu'un.
- ⚠️ **Un fichier contient plusieurs parties.** La rotation n'a pas lieu à chaque partie. Mesuré sur la session `Hearthstone_2026_09_22_00_28_13` : un seul `Power.log` de **177 Mo** (1 305 659 lignes) contenant **6 `CREATE_GAME` pour 5 `STATE=COMPLETE`** (la 6ᵉ partie était en cours), toutes en `GT_BATTLEGROUNDS`, et **aucun `Power_old.log`**. La rotation n'est donc pas un simple seuil à 150 Mo *(déclencheur toujours à déterminer)*. Le découpage se fait sur les `CREATE_GAME` / `STATE=COMPLETE`, jamais sur les fichiers. Le fichier de référence `sample-game-1` est un cas particulier : il ne contient qu'une seule partie.
- Une session peut donc se terminer sur une partie **incomplète** (`CREATE_GAME` sans `STATE=COMPLETE`), si le joueur est encore en partie ou si le jeu a été fermé brutalement.
- **Règle :** pour une session, lire `Power_old.log` puis `Power.log`, dans cet ordre, comme un seul flux continu.
- Taille : environ **40 Mo et 300 000 lignes pour une partie de 25 minutes**. Lecture en flux obligatoire.
- ⚠️ **Hearthstone supprime les anciennes sessions.** Constaté : le dossier `Hearthstone_2026_09_19_02_47_25`, d'où vient le log de référence, a disparu du dossier `Logs\` en quelques jours. C'est toute la raison d'être de la phase 0 : sans archivage, les parties sont perdues.
- Fins de ligne Windows (`\r\n`). Encodage UTF-8 (noms avec accents, cyrilliques, apostrophes typographiques `’`).

## Format d'une ligne

```
D 02:48:30.3211164 GameState.DebugPrintPower() - TAG_CHANGE Entity=AkiLif#2498 tag=RESOURCES value=3 
```

- `D` : niveau de log. `E` existe aussi pour les erreurs du client (19 lignes dans le fichier de référence, toutes hors `GameState.*`).
- `02:48:30.3211164` : heure locale **sans date**. La date vient du nom du dossier de session. Gérer le passage de minuit (si l'heure diminue, on passe au jour suivant).
- `GameState.DebugPrintPower()` : la source. Voir ci-dessous.
- ⚠️ Toutes les sources ne suivent pas la forme `Classe.Methode()` : certaines portent un suffixe entre crochets, comme `PowerSpellController [taskListId=1766].InitPowerSpell()`. Une expression régulière naïve sur `\w+\.\w+\(\)` les rate. Sans conséquence pour nous, puisqu'on ne garde que `GameState.`.
- **Aucune ligne ne s'étale sur plusieurs lignes** : chaque ligne physique porte son propre préfixe, y compris les tags indentés et les options d'un choix. Le découpage par saut de ligne est donc sans piège.
- L'**indentation** après ` - ` indique l'imbrication (un `TAG_CHANGE` à l'intérieur d'un `BLOCK_START`, ou les tags listés sous un `FULL_ENTITY`).
- Beaucoup de lignes se terminent par un espace avant `\r`. Toujours faire un `trim`.

## Sources de lignes

| Source | Utilité |
|---|---|
| `GameState.DebugPrintPower()` | **Source principale.** Tous les événements de la partie. |
| `GameState.DebugPrintGame()` | Métadonnées : `BuildNumber`, `GameType`, `FormatType`, `ScenarioID`, `PlayerID=…, PlayerName=…` |
| `GameState.DebugPrintEntityChoices()` | Un choix proposé au joueur (héros, découverte, triple, bibelot) avec la liste des options |
| `GameState.SendChoices()` / `GameState.DebugPrintEntitiesChosen()` | L'option choisie |
| `GameState.DebugPrintPowerList()` | Marqueur `Count=N` annonçant un lot de N lignes `DebugPrintPower` qui suivent. Sans intérêt pour le parseur. |
| `GameState.DebugPrintOptions()` | Les actions disponibles à un instant donné (fin de tour, pouvoir héroïque, achat…). Très utile pour la phase IA. |
| `GameState.SendOption()` | L'action effectivement jouée (`selectedOption`, `selectedTarget`, `selectedPosition`) |
| `PowerTaskList.DebugPrintPower()` | **Doublon** des événements `GameState`, rejoués pour l'animation. À ignorer. ⚠️ Piège de comptage : un `grep` qui ne filtre pas sur la source compte **deux fois** chaque événement. |
| `PowerProcessor.*`, `PowerTaskList.DebugDump()` | Interne. À ignorer. |

## Types d'événements (dans `GameState.DebugPrintPower()`)

Fréquences observées sur une partie : `TAG_CHANGE` ~63 000, `BLOCK_START` ~3 300, `FULL_ENTITY` ~2 450, `SHOW_ENTITY` ~1 200, `HIDE_ENTITY` ~1 100, `META_DATA` ~1 000, `SUB_SPELL_START` ~380, `CHANGE_ENTITY` 2.

- `CREATE_GAME` : début de partie. Suivi de `GameEntity EntityID=…` puis d'une entité `Player EntityID=… PlayerID=… GameAccountId=[hi=… lo=…]` par joueur, chacun avec ses tags indentés.
- `FULL_ENTITY - Creating ID=37 CardID=TB_BaconShop_HERO_PH` : création d'une entité, suivie de ses tags indentés (`tag=… value=…`). `CardID` peut être vide si la carte est cachée.
- `SHOW_ENTITY - Updating Entity=247 CardID=…` : révèle ou met à jour la carte d'une entité, suivi de tags.
- `HIDE_ENTITY - Entity=[…] tag=ZONE value=…` : cache une entité.
- `CHANGE_ENTITY` : transforme une entité en une autre carte.
- `TAG_CHANGE Entity=<réf> tag=<nom> value=<valeur>` : modifie un tag.
- `BLOCK_START BlockType=… Entity=…` / `BLOCK_END` : regroupent des événements (TRIGGER, PLAY, ATTACK, POWER…).

### ⚠️ Les identifiants de joueur changent à chaque partie

`PlayerID=7` / `PlayerID=15` ne sont **pas** des constantes. Relevé sur les 6 parties de la session
`Hearthstone_2026_09_22_00_28_13` :

| `Player EntityID` | `PlayerID` | `GameAccountId` |
|---|---|---|
| 2 | 1 | réel |
| 3 | 9 | `hi=0 lo=0` |
| 8 | 3 | réel |
| 9 | 11 | `hi=0 lo=0` |
| 14 | 5 | réel |
| 15 | 13 | `hi=0 lo=0` |
| 20 | 7 | réel |
| 21 | 15 | `hi=0 lo=0` |
| 23 | 8 | réel |
| 24 | 16 | `hi=0 lo=0` |

La régularité observée : le joueur fictif porte `PlayerID` + 8 et `EntityID` + 1 par rapport à l'utilisateur.
**Ne jamais coder en dur 7 et 15.** Le seul critère fiable reste le `GameAccountId` non nul.

### Formes de référence à une entité (`Entity=`)

Trois formes coexistent, le parseur doit gérer les trois :

1. Un nombre : `Entity=19`
2. Un nom de joueur ou `GameEntity` : `Entity=AkiLif#2498`, `Entity=GameEntity`, `Entity=Bob le barman`
3. Un bloc détaillé : `Entity=[entityName=Maître-éclaireur Tavish id=89 zone=PLAY zonePos=0 cardId=BG22_HERO_000_SKIN_A player=7]` → utiliser `id`.

Pour la forme 2, construire une table nom → id de l'entité joueur à partir de `DebugPrintGame` (`PlayerID=…, PlayerName=…`) et des entités `Player` de `CREATE_GAME`. Attention : les noms peuvent contenir des espaces (`Entity=Bob le barman`, 150 lignes) et des caractères non latins.

✅ **Un nom inconnu désigne toujours le joueur fictif.** Le log de référence référence **10 noms** en forme 2
(`GameEntity`, `Bob le barman`, `AkiLif#2498`, `LazyTurtle`, `ShadowStorm`, `MarshallMN`, `MrSomething`,
`SporeGasm`, `CHLAMYDIAE`, `БойцоваяЖаба`) alors qu'il ne définit que **2 entités `Player`**
(2 lignes `tag=CARDTYPE value=PLAYER`, pas une de plus).

L'explication est dans cette ligne :

```
TAG_CHANGE Entity=LazyTurtle tag=HERO_ENTITY value=80
```

80 est l'entité de **Bob le barman**. Autrement dit `LazyTurtle` et `Bob le barman` sont **la même entité** :
celle du joueur fictif, que le log **renomme d'après le héros qu'elle contrôle**. Pendant le recrutement elle
s'appelle « Bob le barman », pendant un combat elle prend le pseudo de l'adversaire affronté. Les occurrences
des pseudos se succèdent d'ailleurs par blocs disjoints, un bloc par combat.

**Règle de résolution**, appliquée par le `GameStateMachine` et vérifiée sur 7 parties (0 nom non résolu) :

1. `GameEntity` → l'entité de jeu ;
2. un nom égal à un `PlayerName` de `DebugPrintGame` → l'entité `Player` correspondante ;
3. **tout autre nom** → l'entité du joueur fictif.

Conséquence utile pour la phase 2 : le nom courant du joueur fictif **donne l'adversaire du combat en cours**,
et son tag `HERO_ENTITY` donne l'entité du héros adverse.

⚠️ **Le bloc de la forme 3 ne se parse pas avec une paire de crochets.** `entityName` peut contenir des
crochets : `UNKNOWN ENTITY [cardType=INVALID]` (1 313 lignes), `TagTransferPlayerEnchant [DNT]` (220),
`Update Damage Cap [DNT]` (91), `Undead Bonus Attack Player Enchant [DNT]` (77). Chercher le premier `]`
coupe au mauvais endroit. Il faut s'accrocher à la suite de champs fixes, qui ne varie jamais :
` id=<n> zone=<z> zonePos=<n> cardId=<c> player=<n>]`. `entityName` et `cardId` peuvent aussi être **vides**
(`cardId=` dans 1 443 lignes).

Tags : certains ont un nom (`ZONE`, `ATK`), d'autres seulement un numéro (`tag=1068`). Garder les deux sous forme de chaîne.

## Pièges de parsing vérifiés

Relevés en passant le LineParser sur 846 830 lignes `GameState.*` (le log de référence, plus une session
de 6 parties). Toutes ces formes sont couvertes par `tests/line-parser.test.ts`.

- **`TAG_CHANGE` peut porter un suffixe après la valeur.** 15 lignes se terminent par ` DEF CHANGE`
  (ex. `TAG_CHANGE Entity=2542 tag=1475 value=3 DEF CHANGE`). Capturer `value=(.*)$` avale le suffixe.
- **`BLOCK_START` : `Target=` n'est pas toujours un nombre.** Sur les actions ciblées (achat, pose, pouvoir
  héroïque) c'est un bloc d'entité complet :
  `Target=[entityName=Liche inoffensive id=330 zone=PLAY zonePos=2 cardId=BG28_300 player=15]`.
  `Target=0` signifie « pas de cible ». Ces lignes sont précieuses pour la phase 5 : elles disent ce que
  le joueur a acheté ou posé.
- **`BLOCK_START` : `TriggerKeyword=` est optionnel**, absent sur environ 260 lignes du log de référence.
- **`EffectCardId` contient des crochets et un accent grave** : `System.Collections.Generic.Listˈ1[System.String]`.
- **`Info[i]`, `Source` et `Targets[i]` écrivent ` = ` avec des espaces**, contrairement à tout le reste du
  log qui écrit `clé=valeur`. Ces lignes-là sont des sous-lignes de `META_DATA` et `SUB_SPELL_START`.
- **L'indentation n'est pas toujours un multiple de 4.** Les sous-lignes `Source` et `Targets[i]` utilisent
  22, 26, 30 ou 34 espaces.
- **`TaskList=` peut être vide** sur un `ChoiceType=MULLIGAN` (2 fois sur 6 parties).
- **`DebugPrintOptions` a trois sortes de sous-lignes** : `option i`, `target i`, et `subOption i`, cette
  dernière quand une carte propose plusieurs effets (ex. `Bon appétit` / `À table`).
- **`GameState.OnEntityChoices()`** existe : `id=1 playerId=7 queued`. Une seule ligne sur 6 parties,
  redondante avec le `DebugPrintEntityChoices` qui suit.

Méthodes `GameState.*` vues sur une session de 6 parties :

| Méthode | Lignes |
|---|---|
| `DebugPrintPower()` | 601 951 |
| `DebugPrintOptions()` | 97 673 |
| `DebugPrintPowerList()` | 3 835 |
| `SendOption()` | 936 |
| `DebugPrintEntityChoices()` | 323 |
| `SendChoices()` | 122 |
| `DebugPrintEntitiesChosen()` | 122 |
| `DebugPrintGame()` | 36 |
| `OnEntityChoices()` | 1 |

## Faits propres aux Champs de bataille

### Métadonnées

- `GameType=GT_BATTLEGROUNDS` identifie une partie Champs de bataille. `FormatType=FT_WILD` et `ScenarioID=3459` observés en Solo.
- Mode Solo vs Duo : *(à vérifier)*. Le tag `BACON_DUOS_PUNISH_LEAVERS` est présent sur `GameEntity` même dans une partie qui semble Solo, il ne suffit donc pas. Chercher d'autres indices (`ScenarioID`, nombre de joueurs, tags `BACON_DUO*` sur les joueurs).
- `GAME_SEED` sur `GameEntity` : candidat pour identifier une partie de façon stable.

### Joueurs

- Deux entités `Player` seulement dans le log. Celle de l'utilisateur a un `GameAccountId` non nul (`PlayerID=7` dans l'exemple). L'autre (`GameAccountId=[hi=0 lo=0]`, `PlayerID=15`) porte Bob et les **copies des héros adverses**.
- Les héros adverses apparaissent donc comme des entités avec `player=15` (ou parfois `player=7` en zone `SETASIDE`, voir le piège plus bas).

### Choix du héros

- C'est un `DebugPrintEntityChoices` avec `ChoiceType=MULLIGAN`. Les options sont les `Entities[i]`, le choix est dans `SendChoices` (`m_chosenEntities[0]`).
- Ensuite, `TAG_CHANGE Entity=<joueur> tag=HERO_ENTITY value=<id>` donne l'id de l'entité héros du joueur (`89` dans l'exemple). **Toutes les stats du joueur se lisent sur cette entité héros.**
- Les skins changent le `cardId` (`BG22_HERO_000_SKIN_A`). Pour regrouper par héros, normaliser vers le héros de base.
  ✅ **`BACON_SKIN_PARENT_ID` sur l'entité héros donne un `dbfId`**, pas un `cardId` : `77987` pour
  `BG22_HERO_000_SKIN_A`, et HearthstoneJSON confirme que `BG22_HERO_000` (Tavish Foudrepique) porte
  bien ce `dbfId`. C'est la source correcte, mais elle **exige la base de cartes**.
  ⚠️ Retirer le suffixe `_SKIN_x` marche presque toujours, mais pas toujours : sur les **653 héros à
  skin** de HearthstoneJSON, **16 donnent un `cardId` qui n'existe pas** une fois le suffixe retiré
  (Sylvanas, Vol'jin, Saurcroc, Noirépine, E.T.C.). Le regroupement reste cohérent, mais l'identifiant
  obtenu n'est pas une vraie carte. Le tracker préfère donc le `dbfId` et ne retombe sur le retrait du
  suffixe qu'en dernier recours.

### Tours

- `TAG_CHANGE Entity=GameEntity tag=TURN value=N` : le compteur avance à **chaque phase** (recrutement, puis combat).
- Tour de jeu du joueur = `⌊(TURN + 1) / 2⌋`. Vérifié : `TURN=3` → tour 2, `TURN=9` → tour 5,
  `TURN=13` → tour 7, `TURN=19` → tour 10, `TURN=26` → tour 13. La partie entière est nécessaire :
  `(26+1)/2` vaut 13,5, c'est bien la partie entière qui donne le 13 attendu.

### Tier de taverne

- Tag `PLAYER_TECH_LEVEL` sur **l'entité héros du joueur** (id obtenu via `HERO_ENTITY`).
- ⚠️ **Piège :** d'autres entités avec `player=7` reçoivent aussi `PLAYER_TECH_LEVEL` : `TagTransferPlayerEnchant` (copie retardée du tier), et des copies de héros adverses en zone `SETASIDE` avec `value=0` à chaque combat. Toujours filtrer sur l'id du héros du joueur.
- Ne pas confondre avec `TECH_LEVEL`, qui est le tier d'un serviteur.

### Classement et fin de partie

- `PLAYER_LEADERBOARD_PLACE` sur l'entité héros : place actuelle, mise à jour en continu.
- Élimination : `TAG_CHANGE Entity=<joueur> tag=PLAYSTATE value=LOST` (précédé de `LOSING`). **Place finale = dernière valeur de `PLAYER_LEADERBOARD_PLACE` sur le héros du joueur à ce moment.**
- Victoire (1re place) : sur une partie gagnée observée (session du 22/09, dernière partie), `PLAYER_LEADERBOARD_PLACE` vaut bien **1** sur le héros du joueur. Le `PLAYSTATE` associé reste *(à confirmer)*, mais la place suffit : c'est la même lecture que pour une défaite.
- Fin de partie : `TAG_CHANGE Entity=GameEntity tag=STATE value=COMPLETE`. Des lignes peuvent encore suivre, à ignorer jusqu'au prochain `CREATE_GAME`. Mesuré sur le fichier de référence : **2 lignes traînent 48 secondes après** le `COMPLETE` de 03:13:48, un `DebugPrintPowerList() - Count=1` et un `TAG_CHANGE tag=PLAYER_TRIPLES` sur une copie de héros adverse en `SETASIDE`. Le fichier ne se termine donc pas sur le `COMPLETE`.
- Dégâts reçus : tag `DAMAGE` sur le héros (valeur cumulée).

### Ressources

- Or : `TAG_CHANGE Entity=<joueur> tag=RESOURCES` (or total du tour) et `RESOURCES_USED` (or dépensé). Or restant = `RESOURCES - RESOURCES_USED`.

### Choix en cours de partie

- `DebugPrintEntityChoices` avec `ChoiceType=GENERAL`. La source du choix indique son type :
  - `Source=[… cardId=TB_BaconShop_Triples_01 …]` : récompense de triple (découverte d'un serviteur).
  - `Source=[… cardId=BG30_Trinket_1st …]` : bibelot inférieur. Options en `BG30_MagicItem_*` / `BG36_MagicItem_*`.
  - Autres sources à cataloguer au fil des parties.

### Identifier les héros adverses

Le lobby compte 8 joueurs : l'utilisateur et **7 adversaires**. Leurs héros ne se trouvent ni par le
contrôleur, ni par le `cardId`.

- **Filtrer sur `CONTROLLER` = joueur fictif ne marche pas.** Ça ramène 9 `cardId` : les 7 adversaires,
  plus **Bob** (`TB_BaconShopBob`) et le héros de remplacement (`TB_BaconShop_HERO_PH`).
- **Et les copies de combat portent `CONTROLLER` = joueur.** Chaque héros adverse existe en plusieurs
  entités (jusqu'à 7 pour une seule carte), certaines contrôlées par l'utilisateur.

✅ **Le bon critère est `PLAYER_LEADERBOARD_PLACE`** : seuls les héros des vrais joueurs du lobby
portent une place au classement. Ni Bob, ni le remplacement, ni les copies ne l'ont.

```
heros adverses = entites  CARDTYPE=HERO
                 et ayant un tag PLAYER_LEADERBOARD_PLACE
                 et dont le cardId n'est pas celui du heros du joueur
```

Vérifié sur 11 parties : **exactement 7 adversaires à chaque fois**, sans aucune liste noire de
`cardId`.

### Serviteurs et plateau

- Serviteur : entité avec `CARDTYPE=MINION`, `CONTROLLER`, `ZONE` (`HAND`, `PLAY`, `SETASIDE`, `GRAVEYARD`, `REMOVEDFROMGAME`), `ZONE_POSITION`, `ATK`, `HEALTH`, `TECH_LEVEL`, `CARDRACE`.
- Doré : suffixe `_G` dans le `cardId` (`BG36_511_G`), avec `BACON_TRIPLED_BASE_MINION_ID` *(à vérifier)*.
- Pendant les combats, le jeu crée des **copies** des serviteurs (`COPIED_FROM_ENTITY_ID`). Le plateau « réel » du joueur est celui de la phase de recrutement ; utiliser `BACON_IN_COMBAT_PHASE` pour distinguer les phases *(à vérifier)*.
- Boutique de Bob : les serviteurs proposés sont des entités contrôlées par l'autre joueur (`player=15`) en zone `PLAY` pendant le recrutement *(à vérifier)*. Un achat correspond à un changement de `CONTROLLER` vers le joueur.
- Tags `BACON_SUBSET_*` (`UNDEAD`, `BEAST`, `MURLOC`…) : liés au pool de serviteurs, mais **ne suffisent pas** à déterminer les types présents dans le lobby *(à vérifier)*.

## Ce qui n'est PAS dans les logs

- **La cote (MMR)** : aucun tag de rating trouvé. Saisie manuelle.
- Les types de serviteurs du lobby ne sont pas donnés directement *(à confirmer)*.

## Mesures sur le fichier de référence

`fixtures/sample-game-1/Power_old.log`, une partie Solo complète de 25 minutes :

| Mesure | Valeur |
|---|---|
| Taille | 40 372 216 octets (40 Mo) |
| Lignes | 298 697, **toutes** terminées par `
` (298 697 `
` pour 298 697 `
`) |
| Lignes `GameState.*` | 141 637 (47 %), soit 19 090 124 octets |
| Idem, compressé en gzip -9 | 857 564 octets |

Répartition des lignes `GameState.*` :

| Source | Lignes |
|---|---|
| `DebugPrintPower()` | 125 359 |
| `DebugPrintOptions()` | 15 394 |
| `DebugPrintPowerList()` | 651 |
| `SendOption()` | 134 |
| `DebugPrintEntityChoices()` | 53 |
| `SendChoices()` | 20 |
| `DebugPrintEntitiesChosen()` | 20 |
| `DebugPrintGame()` | 6 |

Le bloc `DebugPrintGame()` complet, en tête de partie :

```
GameState.DebugPrintGame() - BuildNumber=251952
GameState.DebugPrintGame() - GameType=GT_BATTLEGROUNDS
GameState.DebugPrintGame() - FormatType=FT_WILD
GameState.DebugPrintGame() - ScenarioID=3459
GameState.DebugPrintGame() - PlayerID=7, PlayerName=AkiLif#2498
GameState.DebugPrintGame() - PlayerID=15, PlayerName=МиниНиндзя
```

À noter : le joueur `PlayerID=15`, celui qui porte Bob et les copies des héros adverses, a un **vrai nom de joueur**
(ici en cyrillique), pas un nom technique. Il ne se distingue que par son `GameAccountId=[hi=0 lo=0]`.

## Performances de lecture

Mesuré avec le `SessionReader` (`readline` sur un flux, ligne par ligne) :

| Fichier | Lignes | Temps | Heap |
|---|---|---|---|
| `sample-game-1/Power_old.log` (40 Mo) | 298 697 | 0,22 s | 17 Mo |
| `Hearthstone_2026_09_22_00_28_13/Power.log` (177 Mo) | 1 305 659 | 0,83 s | 19 Mo |

Lecture **et** parsage des lignes en événements typés :

| Fichier | Lignes | Événements | Temps |
|---|---|---|---|
| `sample-game-1/Power_old.log` | 298 697 | 137 186 | 0,31 s |
| Session de 6 parties (200 Mo) | 1 496 091 | 695 997 | 1,48 s |

La mémoire ne grimpe pas avec la taille du fichier : la lecture est bien en flux. Lire un `Power.log`
pendant que le jeu écrit dedans ne pose aucun problème.

## Extrait versionné pour les tests

`tests/fixtures/sample-game-1.min.log.gz` est produit par `npm run make-fixture` à partir du log de référence :
on ne garde que les lignes `GameState.*`, on compresse en gzip. Le contenu décompressé est **identique octet pour
octet** à `grep '^[A-Z] [0-9:.]* GameState\.' Power_old.log`, fins de ligne CRLF comprises.

## Valeurs de référence (fixtures/sample-game-1)

Voir `docs/phases/phase-1-parser.md`, section « Test de référence ».
