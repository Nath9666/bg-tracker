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

**Phase en cours : Phase 3 — Tableau de bord d'analyse.**
Les phases 0 (archivage), 1 (parseur hors ligne) et 2 (base de données) sont terminées.

⚠️ `better-sqlite3` est un module natif. Après un `npm install`, si l'application Electron se plaint
d'un `NODE_MODULE_VERSION`, le recompiler : `npx @electron/rebuild -f -w better-sqlite3`.

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
npm run parse -- <dossier_de_logs>            # résumé des parties trouvées
npm run --silent parse -- <dossier> --json    # les GameSummary en JSON (--silent : sans la bannière npm)
npm run import -- <dossier>                   # importe les parties en base SQLite
npm run cards        # télécharge la base de cartes HearthstoneJSON (frFR + enUS)
npm run ratings      # complète data/ratings.csv et rattache les cotes saisies
npm run stats        # analyses : places, héros, paliers, types (--from --to --hero)
npm run app          # tableau de bord Electron (compile puis lance)
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

- Le tracker lit **uniquement les fichiers de log**. Pas de lecture de la mémoire du processus Hearthstone, pas d'interception réseau.
- Rien ne doit **envoyer d'actions au jeu** (clics simulés, automatisation). L'IA de la phase 5 reste un outil d'analyse et de conseil, jamais un bot.
- La cote (MMR) **n'est pas dans les logs** : elle est saisie par l'utilisateur dans `data/ratings.csv`, pré-rempli par `npm run ratings` avec une ligne par partie.

## Données de test

- `fixtures/` contient des logs réels de l'utilisateur. Les gros fichiers sont exclus de Git (voir `.gitignore`), seuls des extraits réduits sont versionnés.
- Fichier de référence : `fixtures/sample-game-1/Power_old.log` — une partie Solo complète dont les valeurs attendues sont listées dans `docs/phases/phase-1-parser.md`.
