# CLAUDE.md — BG Tracker

Ce fichier est lu en premier par Claude Code. Il décrit le projet, les règles de travail et où trouver le reste de la documentation.

## Le projet

Un tracker Hearthstone inspiré de Hearthstone Deck Tracker, **dédié au mode Champs de bataille (Battlegrounds)**. Il lit les logs du jeu (`Power.log`), reconstruit chaque partie, stocke les données dans SQLite et les affiche dans un tableau de bord, puis dans un overlay en jeu.

Objectif à long terme (phase 5, pas maintenant) : entraîner une IA qui imite la façon de jouer de l'utilisateur. Les données doivent donc être extraites **finement dès le départ** (chaque décision, avec les options proposées et celle choisie).

## Documentation à lire

| Fichier | Contenu | Quand le lire |
|---|---|---|
| `docs/ROADMAP.md` | Les phases du projet, avec critères de fin | Toujours, pour savoir où on en est |
| `docs/LOG_FORMAT.md` | Format de `Power.log`, tags utiles, pièges connus | Avant de toucher au parseur |
| `docs/ARCHITECTURE.md` | Modules, flux de données, schéma SQLite | Avant de créer un module ou une table |
| `docs/phases/phase-1-parser.md` | Spécification de la phase 1, terminée | Pour comprendre le parseur |
| `docs/ARCHIVAGE.md` | Archivage des logs, rétention, tâche planifiée | Pour toucher à `scripts/archive-logs` |
| `ml/README.md` | Jeu de données d'entraînement, chargement pandas | Avant de toucher à la phase 5 |

**Phase en cours : Phase 5 — IA d'imitation, étape de collecte.**
Les phases 0 à 4 sont terminées. La phase 5 exige *plusieurs centaines de parties* ; en attendant,
les **points de décision** sont collectés à chaque import (table `decisions`) car ils n'existent
que dans les logs bruts, qui sont élagués au-delà de 200 parties.

`better-sqlite3` 13 embarque des binaires précompilés compatibles avec Node **et** Electron
(vérifié le 25/09/2026 : ABI 127 et 149) : aucune recompilation n'est nécessaire. Seulement si
Electron se plaint d'un `NODE_MODULE_VERSION` : `npx @electron/rebuild -f -w better-sqlite3`.

Le dossier des logs est trouvé seul (`src/reader/hearthstone-path.ts`) : `BG_TRACKER_LOGS`, sinon
le registre où Battle.net inscrit l'installation, sinon l'emplacement par défaut. `npm run doctor`
vérifie une installation.

## Stack

- **Node.js 20+ / TypeScript** en mode `strict`, modules ESM.
- **Vitest** pour les tests.
- **better-sqlite3** pour le stockage (à partir de la phase 2).
- **Electron** pour l'application et l'overlay (phases 3 et 4), avec **React**, **Vite** et **Recharts**.
- **Python** (pandas, PyTorch) pour la phase IA uniquement, qui lit la base SQLite.
- Données de cartes : **HearthstoneJSON** (base de cartes en JSON, locale `frFR` et `enUS`).

## Commandes

```bash
npm install
npm run build        # compilation TypeScript vers dist/
npm run typecheck    # vérification des types sans émission
npm test             # tests Vitest (une passe)
npm run test:watch   # tests en continu
npm run lint         # ESLint
npm run doctor       # vérifie l'installation (logs, log.config, cartes, base)
npm run parse -- <dossier_de_logs>            # résumé des parties trouvées
npm run --silent parse -- <dossier> --json    # les GameSummary en JSON (--silent : sans la bannière npm)
npm run import -- <dossier>                   # importe les parties en base SQLite
npm run import -- <dossier> --force           # relit les sessions inchangées
npm run cards        # télécharge la base de cartes HearthstoneJSON (frFR + enUS)
npm run sim-cards    # base de cartes du simulateur de combat (42 Mo, mise en cache)
npm run ratings      # complète data/ratings.csv et rattache les cotes saisies
npm run stats        # analyses : places, héros, paliers, types (--from --to --hero)
npm run export       # jeu de données JSON Lines pour Python (--top4)
npm run app          # l'application, tableau de bord ouvert (compile puis lance)
npm run overlay      # l'application, overlay seul, icône près de l'horloge
npm run dist         # installateur Windows dans release/ (electron-builder)
npm run sync         # archive + importe + rattache les cotes, en une commande
npm run archive      # archive les sessions Hearthstone (phase 0)
npm run archive -- --dry-run                  # simulation, sans rien écrire
npm run make-fixture # régénère tests/fixtures/sample-game-1.min.log
```

Les scripts TypeScript sont exécutés avec `tsx` (pas de compilation préalable nécessaire).

## Règles de travail

1. **Petites étapes.** Une fonctionnalité à la fois, testée, avant de passer à la suivante. Ne pas anticiper les phases suivantes au-delà de ce que la spécification demande.
2. **Tests d'abord pour le parseur.** Chaque comportement du parseur est couvert par un test sur un extrait de log réel.
3. **Identifier les cartes par `cardId`, jamais par `entityName`.** Les noms sont localisés (le client de l'utilisateur est en français) et changent selon les skins.
4. **Lecture en flux.** Un `Power.log` peut dépasser 40 Mo pour une seule partie. Ne jamais charger un fichier entier en mémoire.
5. **Pas d'invention sur le format de log.** Si un comportement n'est pas documenté dans `docs/LOG_FORMAT.md`, le vérifier dans un vrai fichier de log (avec `grep`) avant de coder, puis compléter `LOG_FORMAT.md`.
6. **Mettre à jour la doc.** Quand une tâche de `ROADMAP.md` est finie, cocher la case. Quand on découvre quelque chose sur le format de log, l'ajouter à `LOG_FORMAT.md`.
7. **Langue.** Code, noms de variables et messages de commit en anglais. Documentation et commentaires explicatifs en français.

## Limites à respecter (conditions d'utilisation Blizzard)

- Pas d'**interception réseau**, jamais.
- **Lecture mémoire : autorisée pour trois données absentes des logs.** Décidé le 24/09/2026 et
  élargi le 26/09/2026, chaque fois après avoir vérifié qu'aucun fichier de log ne les porte (voir
  `docs/LOG_FORMAT.md`). Hearthstone Deck Tracker ne fait pas autrement : il lit la mémoire du
  processus via HearthMirror.
  - la **cote** (MMR), Solo et Duo ;
  - les **types de serviteurs de la partie**, affichés par le jeu lui-même au choix du héros :
    ce n'est donc pas une information cachée au joueur ;
  - les **statistiques de carrière et les dernières troupes de guerre**, celles de l'écran de
    statistiques du jeu : les propres chiffres du joueur, sans effet sur une partie. Jamais lues
    pendant une partie (balayage d'environ 2 Go du tas).
  Toute nouvelle donnée lue en mémoire doit d'abord être cherchée dans les logs, puis ajoutée à
  cette liste.
  - **En lecture seule.** Rien n'est jamais écrit dans le processus du jeu.
  - Limité à ce que les logs ne donnent pas. Tout le reste continue de passer par `Power.log` :
    une donnée lisible dans un log ne doit pas être lue en mémoire.
  - `src/memory/` uniquement. Le reste du code ne connait pas cette source.
  - ⚠️ **Fragile par nature** : la disposition des classes change à chaque patch. Ce module doit
    échouer proprement et ne jamais empêcher le tracker de fonctionner sans lui.
- Rien ne doit **envoyer d'actions au jeu** (clics simulés, automatisation). L'IA de la phase 5 reste un outil d'analyse et de conseil, jamais un bot.
- **Simulateur de combat : activé.** Décidé le 23/09/2026, après avoir d'abord tranché l'inverse le
  même jour. Le bandeau de l'overlay estime victoire / nul / défaite, létal dans les deux sens et
  dégâts moyens, via `@firestone-hs/simulate-bgs-battle`.
  - Ce n'est **pas** Blizzard qui l'interdit : HDT et Firestone en embarquent un depuis des années.
    Ce sont **certains tournois**. Si l'utilisateur en joue, l'overlay doit être fermé.
  - Il ne reçoit **que ce que le joueur a déjà vu** : son plateau, et celui du prochain adversaire
    tel qu'il était au dernier affrontement. Aucune donnée cachée n'entre dans l'estimation.
  - L'estimation se fait **au début du combat**, sur le vrai plateau d'en face, jamais pendant le
    recrutement sur le souvenir d'un affrontement précédent. Elle arrive donc trop tard pour
    changer d'avis, mais elle est juste.
- **Critère de Blizzard**, vérifié en septembre 2026 : est acceptable « tout ce qu'on peut déjà faire avec un papier et un crayon » (Ben Brode), en lecture passive. L'overlay n'affiche donc que ce que le joueur a **déjà vu** : plateaux adverses des combats passés, tiers, historique. Le simulateur rejoue ce combat à partir de ces mêmes informations : il n'ajoute rien d'invisible, mais il sort du papier-crayon.
- La cote (MMR) **n'est pas dans les logs**. Elle est **lue dans la mémoire du jeu** par l'overlay en
  fin de partie (`src/memory/rating-reader.ts`) et ajoutée à `data/ratings.csv`. La saisie à la
  main reste possible, et sert de secours si la lecture échoue.

## Données de test

- `fixtures/` contient des logs réels de l'utilisateur. Les gros fichiers sont exclus de Git (voir `.gitignore`), seuls des extraits réduits sont versionnés.
- Fichier de référence : `fixtures/sample-game-1/Power_old.log` — une partie Solo complète dont les valeurs attendues sont listées dans `docs/phases/phase-1-parser.md`.
