# Feuille de route

Chaque phase produit un résultat utilisable. Ne pas commencer une phase tant que les critères de fin de la précédente ne sont pas remplis.

## Phase 0 — Collecte des données ✓

But : ne perdre aucune partie. Hearthstone ne conserve pas indéfiniment ses dossiers de logs, et chaque partie est une future donnée d'entraînement.

- [x] Script `scripts/archive-logs` qui copie chaque dossier `Hearthstone_*` du dossier `Logs\` de Hearthstone vers un dossier d'archive (chemins configurables), sans écraser ce qui existe déjà — compressé en gzip (20x), avec rétention des N dernières parties
- [x] Documentation pour le lancer automatiquement (planificateur de tâches Windows) — voir `docs/ARCHIVAGE.md`
- [x] Fichier `data/ratings.csv` (`datetime,rating`) pour noter la cote à la main en attendant la phase 4 — créé par le script

**Critère de fin :** les sessions sont archivées automatiquement. ✅ Le script et sa documentation sont en
place ; il reste à créer la tâche planifiée sur la machine (commande donnée dans `docs/ARCHIVAGE.md`).

## Phase 1 — Parseur hors ligne ✓

Spécification détaillée : `docs/phases/phase-1-parser.md`.

- [x] Initialisation du projet (TypeScript strict, ESM, Vitest, scripts npm)
- [x] Lecteur de session : lit `Power_old.log` puis `Power.log`, en flux
- [x] Parseur de lignes `GameState` → événements typés
- [x] Modèle d'entités (application des `CREATE_GAME`, `FULL_ENTITY`, `SHOW_ENTITY`, `TAG_CHANGE`…)
- [x] Découpage en parties (le filtrage Champs de bataille se fait à l'extraction)
- [x] Extraction du résumé de partie
- [x] CLI `npm run parse -- <dossier>`
- [x] Test de référence sur `fixtures/sample-game-1` qui passe

**Critère de fin :** la CLI affiche un résumé correct pour chaque partie d'un dossier d'archive.

## Phase 2 — Extraction détaillée et base de données ✓

- [x] Schéma SQLite (voir `docs/ARCHITECTURE.md`) et migrations
- [x] Table `games` et `hero_offers`
- [x] Table `turns` (tier, or, PV, résultat du combat, adversaire)
- [x] Table `boards` (plateau au début de chaque combat)
- [x] Table `picks` (découvertes, triples, bibelots : options proposées + choix), plus `tier_ups`
- [x] Import idempotent : réimporter un dossier ne crée pas de doublons (clé = `GAME_SEED` + jour de début)
- [x] Import de `data/ratings.csv` et rattachement de la cote à la partie la plus proche dans le temps (`npm run ratings`)
- [x] Mapping `cardId` → nom, tier, type via HearthstoneJSON, mis en cache localement (`npm run cards`)

**Critère de fin :** toutes les parties archivées sont en base, sans doublon.

## Phase 3 — Tableau de bord d'analyse ✓

- [x] Application Electron (front React, Vite, Recharts) — `npm run app`
- [x] Évolution de la cote et de la place moyenne dans le temps
- [x] Place moyenne par héros, taux de sélection quand il est proposé
- [x] Répartition des places finales, taux de top 4
- [x] Courbe moyenne de montée de taverne, parties gagnantes vs perdantes
- [x] Type dominant du plateau final vs résultat
- [x] Filtres : période, mode (Solo/Duo), héros

**Critère de fin :** l'utilisateur peut analyser ses parties sans ouvrir la base. ✅

## Phase 4 — Mode en direct et overlay ← EN COURS

- [x] Suivi de `Power.log` en temps réel, avec gestion de la rotation vers `Power_old.log`
- [ ] Réutilisation du même modèle d'entités qu'en phase 1, alimenté en continu
- [ ] Fenêtre overlay transparente, toujours au premier plan, qui laisse passer les clics
- [ ] Affichage : derniers plateaux des adversaires, tier de chacun, historique des combats
- [ ] Fenêtre de saisie de la cote en fin de partie
- [x] Vérifier la politique actuelle de Blizzard sur les outils tiers avant de figer ce qui est affiché
      — critère officiel : « tout ce qu'on peut faire au papier-crayon » (Ben Brode), lecture passive
      uniquement. Les plateaux adverses déjà vus, les tiers et l'historique des combats sont dans ce
      cadre. ⚠️ Un **simulateur de combat** en sort et est interdit par certains tournois.

**Critère de fin :** une partie jouée avec le tracker ouvert est suivie en direct et enregistrée.

## Phase 5 — IA d'imitation (plus tard)

Prérequis : plusieurs centaines de parties en base.

- [ ] Reconstruction des points de décision : état complet (tour, or, tier, PV, main, plateau, boutique de Bob, types du lobby) + action prise (achat, vente, pose, relance, montée, gel, repositionnement, choix de découverte)
- [ ] Export du jeu de données depuis SQLite vers Python
- [ ] Modèle de référence naïf (statistiques simples) comme score plancher
- [ ] Modèles supervisés (behavior cloning), dans l'ordre : choix du héros, découvertes, bibelots, puis décisions de boutique
- [ ] Évaluation : accord top 1 / top 3 avec les vrais choix, sur des parties jamais vues
- [ ] Piste : intégrer un simulateur de combat open source (celui de Firestone) pour évaluer les plateaux

**Limite :** l'IA conseille, elle ne joue jamais à la place de l'utilisateur.
