# Phase 1 — Parseur hors ligne

## Objectif

Une commande `npm run parse -- <dossier>` qui lit un dossier de session (ou un dossier contenant plusieurs sessions) et affiche, pour chaque partie de Champs de bataille, un résumé exact.

Lire d'abord `docs/LOG_FORMAT.md` et `docs/ARCHITECTURE.md`.

## Étapes

Faire les étapes dans l'ordre. Chaque étape se termine par des tests verts et un commit.

### 1. Initialisation
- `package.json`, TypeScript `strict`, ESM, Vitest, ESLint.
- Scripts `build`, `test`, `parse`.
- `.gitignore` : `node_modules/`, `dist/`, `fixtures/**/*.log` (les gros logs ne sont pas versionnés), `data/`.
- Mettre à jour la section « Commandes » de `CLAUDE.md`.

### 2. Extrait de test léger
Les logs complets ne sont pas dans Git. Écrire `scripts/make-fixture.ts` qui produit `tests/fixtures/sample-game-1.min.log` à partir de `fixtures/sample-game-1/Power_old.log` en ne gardant que les lignes `GameState.*`. Si l'extrait reste trop gros (au-delà de quelques Mo), le compresser en `.gz` et le lire tel quel dans les tests. Cet extrait **est** versionné.

### 3. SessionReader
- Lit `Power_old.log` puis `Power.log` s'ils existent, ligne par ligne (`readline` sur un flux).
- Supprime `\r`, fait un `trimEnd`.
- Tests : ordre de lecture, dossier avec un seul des deux fichiers, fichier vide.

### 4. LineParser
- Fonction pure, sans état. Une ligne → un événement typé ou `null`.
- Gère les trois formes de `Entity=` (voir `LOG_FORMAT.md`).
- Tests unitaires avec des lignes réelles copiées depuis le log, une par type d'événement.

### 5. GameStateMachine
- Applique les événements au modèle d'entités.
- Détecte le début (`CREATE_GAME`) et la fin (`STATE=COMPLETE`) des parties.
- Identifie le joueur local (`GameAccountId` non nul) et son héros (`HERO_ENTITY`).
- Tests : après lecture de l'extrait, l'entité 89 a `cardId=BG22_HERO_000_SKIN_A`.

### 6. GameExtractor → GameSummary

```ts
interface GameSummary {
  startedAt: string;          // ISO
  endedAt: string | null;
  buildNumber: number;
  gameType: string;           // 'GT_BATTLEGROUNDS'
  playerName: string;
  heroOffered: string[];      // cardIds
  heroChosen: string;         // cardId
  finalPlace: number | null;
  finalTurn: number | null;   // tour de jeu = (TURN + 1) / 2
  tierUps: { tier: number; turn: number }[];
  picks: { choiceId: number; sourceCardId: string; options: string[]; chosen: string }[];
  opponents: string[];        // cardIds des héros adverses
  gameSeed: string | null;
}
```

Ignorer les parties dont `gameType` n'est pas `GT_BATTLEGROUNDS`.

### 7. CLI
`npm run parse -- <dossier>` : parcourt le dossier (session unique ou dossier d'archive) et affiche un résumé lisible par partie. Option `--json` pour sortir les `GameSummary` en JSON.

## Test de référence

Fichier : `fixtures/sample-game-1/Power_old.log`. Valeurs vérifiées à la main :

| Champ | Valeur attendue |
|---|---|
| Nombre de parties | 1 |
| `buildNumber` | 251952 |
| `gameType` | GT_BATTLEGROUNDS |
| `gameSeed` | 817997359 |
| `playerName` | AkiLif#2498 (PlayerID=7) |
| Début | 02:48:30 |
| Fin (`STATE=COMPLETE`) | 03:13:48 |
| `heroOffered` | BG22_HERO_002, TB_BaconShop_HERO_34, BG22_HERO_000_SKIN_A, BG36_HERO_101 |
| `heroChosen` | BG22_HERO_000_SKIN_A (entité 89) |
| `finalPlace` | 3 |
| `finalTurn` | 13 (compteur TURN = 26) |
| `tierUps` | T2 au tour 2, T3 au tour 5, T4 au tour 7, T5 au tour 10 |
| Nombre de choix `GENERAL` | 9 (ids 2 à 10) |
| Choix id=2 | source TB_BaconShop_Triples_01 → BG36_760 |
| Choix id=3 | source BG30_Trinket_1st, options BG30_MagicItem_703, BG30_MagicItem_547, BG36_MagicItem_811, BG36_MagicItem_202 → BG30_MagicItem_547 |
| Choix id=7 | source BG30_Trinket_2nd → BG30_MagicItem_406 |
| Choix id=10 | source TB_BaconShop_Triples_01 → BG35_883 |
| `opponents` | BG22_HERO_201_SKIN_C, BG30_HERO_304, BG34_HERO_001, TB_BaconShop_HERO_16, TB_BaconShop_HERO_58_SKIN_E, TB_BaconShop_HERO_70, TB_BaconShop_HERO_93 |

Pour les tier-ups, le tour est calculé à partir du dernier `TURN` vu avant le changement de `PLAYER_TECH_LEVEL` sur l'entité 89 : TURN 3 → tour 2, TURN 9 → tour 5, TURN 13 → tour 7, TURN 19 → tour 10.

## Critères de fin

- [ ] `npm test` vert, dont le test de référence ci-dessus
- [ ] `npm run parse -- fixtures/sample-game-1` affiche le bon résumé
- [ ] Temps de traitement du fichier de 40 Mo raisonnable (quelques secondes)
- [ ] `LOG_FORMAT.md` complété avec tout ce qui a été découvert
- [ ] Cases de la phase 1 cochées dans `ROADMAP.md`
