# BG Tracker

Un tracker pour le mode **Champs de bataille** de Hearthstone, inspiré de Hearthstone Deck Tracker.

Il lit les logs du jeu, reconstruit chaque partie, garde tout dans une base locale, et l'affiche de
deux façons :

- **un tableau de bord** pour analyser ses parties : cote dans le temps, places, héros, paliers,
  types de serviteurs ;
- **un overlay** transparent par-dessus le jeu : adversaires et combats, estimation du combat en
  cours, rythme de montée de taverne, bonus cumulés, aide au choix du héros, et la cote entre deux
  parties.

Tout reste sur la machine. Rien n'est envoyé nulle part, et rien n'est jamais envoyé au jeu.

---

## Installer avec l'installateur (le plus simple)

1. Lancer **`BG Tracker Setup 0.1.0.exe`** (produit par `npm run dist`, dans `release/`).
   Windows affiche « Windows a protégé votre ordinateur » : l'installateur n'est pas signé.
   Cliquer sur **Informations complémentaires**, puis **Exécuter quand même**.
2. Activer les logs du jeu : voir l'[étape 4](#4-activer-les-logs-du-jeu) plus bas. C'est la seule
   étape manuelle, et elle est indispensable.
3. Au premier lancement, l'application propose de **reprendre un historique** : choisir le dossier
   `data` d'une installation précédente pour y retrouver ses parties, ses cotes et l'archive des
   logs. Il est copié, jamais déplacé.

C'est tout : pas de Node.js, pas de terminal. Les bases de cartes se téléchargent seules au premier
lancement.

L'application vit **près de l'horloge** (icône BG dorée) :

| Action | Effet |
|---|---|
| clic sur l'icône | ouvre le tableau de bord |
| clic droit → *Afficher l'overlay* | masque ou montre l'overlay, sans arrêter le suivi |
| clic droit → *Synchroniser maintenant* | archive et importe tout de suite |
| clic droit → *Lancer au démarrage de Windows* | l'application démarre avec Windows |
| clic droit → *Ouvrir le dossier des données* | `%AppData%\BG Tracker` |
| clic droit → *Quitter BG Tracker* | ferme tout |

Fermer le tableau de bord ne quitte pas l'application : l'overlay continue de suivre les parties.
À chaque lancement, elle synchronise les parties jouées pendant qu'elle était fermée.

**Où sont les données** : dans `%AppData%\BG Tracker\data`. Avec l'option *Lancer au démarrage de
Windows*, la tâche planifiée de [`docs/ARCHIVAGE.md`](docs/ARCHIVAGE.md) devient inutile — et elle
alimente l'ancien dossier `data/` du projet, pas celui de l'application.

---

## Installer depuis le code source

Pour développer, ou sans installateur.

### 1. Prérequis

| Il faut | Pourquoi |
|---|---|
| **Windows** 10 ou 11 | le jeu, la lecture de la cote et la tâche planifiée sont propres à Windows |
| **Node.js 20 ou plus** — [nodejs.org](https://nodejs.org), version LTS | fait tourner tout le projet |
| **Hearthstone**, installé par Battle.net | évidemment |

Rien d'autre : pas de compilateur, pas de Python (sauf pour la future partie IA, voir plus bas).

### 2. Récupérer le projet

Copier le dossier du projet sur le nouvel ordinateur, **sans** `node_modules/` ni `dist/` (ils se
recréent). Pour garder son historique de parties, copier aussi le dossier **`data/`** : il contient
la base, l'archive des logs et les cotes, et n'est pas versionné par Git.

Ou, si le projet est sur un dépôt Git :

```bash
git clone <adresse-du-depot> bg-tracker
cd bg-tracker
```

### 3. Installer les dépendances

Dans un terminal ouvert dans le dossier du projet :

```bash
npm install
```

### 4. Activer les logs du jeu

Sans cette étape, Hearthstone n'écrit pas les informations dont le tracker a besoin.

Ouvrir (ou créer) le fichier `%LocalAppData%\Blizzard\Hearthstone\log.config` — coller ce chemin
dans la barre d'adresse de l'explorateur — et y ajouter :

```ini
[Power]
LogLevel=1
FilePrinting=True
ConsolePrinting=False
ScreenPrinting=False
Verbose=True
```

Puis **relancer Hearthstone** s'il était ouvert : le fichier n'est lu qu'au démarrage du jeu.

### 5. Télécharger les bases de cartes

```bash
npm run cards        # noms, paliers et types des cartes, en français
npm run sim-cards    # cartes du simulateur de combat (42 Mo)
```

À refaire après chaque nouvelle extension de Hearthstone.

### 6. Vérifier

```bash
npm run doctor
```

Chaque point est vérifié, et chaque point manquant vient avec la commande qui le corrige :

```
✓ Node.js 20 ou plus — version 22.23.1
✓ Dossier des logs de Hearthstone — F:\SteamLibrary\Hearthstone\Logs (registre Windows)
✓ Logs du jeu activés (log.config) — [Power] avec FilePrinting et Verbose
✓ Base de cartes (noms, paliers, types) — data/cards/index.json
✓ Cartes du simulateur de combat — data/cards/firestone-cards.json
✓ Base de données — data/bg-tracker.db
✓ Windows — win32

Prêt.
```

Le dossier du jeu est **trouvé tout seul** dans le registre Windows, où Battle.net l'inscrit, même
installé ailleurs que par défaut. Pour forcer un autre dossier, définir la variable d'environnement
`BG_TRACKER_LOGS` (voir [Configuration](#configuration)).

Sur un ordinateur neuf, « Base de données : pas encore créée » est normal : elle se crée à la
première partie.

### 7. Archivage automatique (recommandé)

Hearthstone **supprime ses anciens logs au bout de quelques jours**. Une tâche planifiée Windows les
met à l'abri régulièrement. La commande exacte, et le pourquoi de chaque réglage, sont dans
[`docs/ARCHIVAGE.md`](docs/ARCHIVAGE.md#créer-la-tâche) — **remplacer le chemin du projet** par celui
du nouvel ordinateur.

---

## Utilisation au quotidien

### Avant de jouer

Avec l'installateur : rien, si l'application démarre avec Windows ; sinon, lancer *BG Tracker*
depuis le menu Démarrer. Depuis le code source :

```bash
npm run overlay
```

Et c'est tout. L'overlay suit la partie en direct, et **à la fin de chaque partie** il lit la cote,
importe la partie en base et met à jour le tableau de bord, sans rien demander. Il peut se lancer en
cours de partie : il rattrape ce qui s'est déjà passé.

Les fenêtres laissent passer les clics : elles ne gênent jamais le jeu.

| Où | Quoi |
|---|---|
| haut gauche | prochain adversaire, combats passés, adversaires affrontés — **entre deux parties** : la cote et sa courbe |
| haut centre | estimation du combat en cours : victoire, nul, défaite, létal, dégâts moyens |
| haut droite | place, PV, palier, or, cote ; ce que la taverne peut encore proposer ; rythme de paliers — **au choix du héros** : tes statistiques avec chacun |
| bas centre | bonus cumulés : gemmes de sang, or du tour suivant, râles d'agonie doublés |

### Pour analyser ses parties

Un clic sur l'icône près de l'horloge, ou depuis le code source :

```bash
npm run app
```

`npm run app` et `npm run overlay` lancent la même application ; le premier ouvre en plus le tableau
de bord. Le tableau de bord se relit en revenant sur sa fenêtre, ou avec le bouton *Rafraîchir*. La cote se
corrige en cliquant dessus.

### Si l'overlay n'était pas lancé

```bash
npm run sync
```

Archive, importe et rattache les cotes en une commande. La tâche planifiée le fait aussi, à
l'ouverture de session et chaque nuit.

---

## Toutes les commandes

| Commande | Rôle |
|---|---|
| `npm run overlay` | overlay en jeu — la seule à lancer au quotidien |
| `npm run app` | tableau de bord |
| `npm run sync` | archive + import + cotes, en une fois |
| `npm run doctor` | vérifie l'installation |
| `npm run dist` | construit l'installateur `release/BG Tracker Setup <version>.exe` |
| `npm run cards` / `npm run sim-cards` | télécharge les bases de cartes |
| `npm run stats` | statistiques en ligne de commande (`--from --to --hero`) |
| `npm run ratings` | complète `data/ratings.csv` et rattache les cotes saisies à la main |
| `npm run archive` | archive seule (`-- --dry-run` pour simuler) |
| `npm run import -- <dossier>` | importe un dossier de logs (`--force` pour tout relire) |
| `npm run parse -- <dossier>` | résumé des parties d'un dossier, sans rien écrire |
| `npm run export` | jeu de données pour Python (`--top4`) |
| `npm test` · `npm run lint` · `npm run typecheck` | vérifications de développement |

---

## Configuration

Tout fonctionne sans configuration. Trois variables d'environnement permettent de changer les
emplacements :

| Variable | Par défaut |
|---|---|
| `BG_TRACKER_LOGS` | trouvé dans le registre, sinon `C:\Program Files (x86)\Hearthstone\Logs` |
| `BG_TRACKER_ARCHIVE` | `data/archive` |
| `BG_TRACKER_DB` | `data/bg-tracker.db` |
| `BG_TRACKER_HOME` | dossier contenant `data/` : `%AppData%\BG Tracker` pour l'application installée, le dossier du projet sinon |

Pour la définir durablement (y compris pour la tâche planifiée) :

```powershell
setx BG_TRACKER_LOGS "D:\Jeux\Hearthstone\Logs"
```

---

## Où sont les données

Tout est dans `data/`, **à sauvegarder** et **à copier** pour changer d'ordinateur :

| Fichier | Contenu |
|---|---|
| `bg-tracker.db` | la base SQLite : parties, tours, plateaux, choix, cotes |
| `archive/` | les logs bruts compressés, 200 dernières parties |
| `ratings.csv` | les cotes, une ligne par partie, modifiable à la main |
| `cards/` | les bases de cartes (se retéléchargent) |

La base se **reconstruit** entièrement depuis l'archive (`npm run import -- data/archive --force`).
L'archive, elle, ne se reconstruit pas : Hearthstone a effacé les originaux.

---

## Dépannage

**« Dossier des logs introuvable »** — Hearthstone n'a jamais été lancé sur cette machine, ou il est
installé dans un dossier que le registre ne connaît pas. Lancer le jeu une fois, sinon définir
`BG_TRACKER_LOGS`.

**L'overlay reste vide en partie** — les logs ne sont pas activés : refaire l'étape 4 **puis
relancer Hearthstone**. `npm run doctor` le détecte.

**La cote ne s'affiche pas** — elle est lue dans la mémoire du jeu, ce qui peut casser après une mise
à jour de Hearthstone. Le reste de l'overlay continue de fonctionner, et la cote peut toujours se
saisir à la main dans le tableau de bord ou dans `data/ratings.csv`.

**L'application refuse de démarrer avec une erreur `NODE_MODULE_VERSION`** — rare avec les versions
actuelles, qui embarquent des binaires compatibles. Si ça arrive :

```bash
npx @electron/rebuild -f -w better-sqlite3
```

**Pas d'estimation de combat** — lancer `npm run sim-cards`.

---

## Limites volontaires

Le projet s'en tient à ce que tolère Blizzard, et le documente dans [`CLAUDE.md`](CLAUDE.md) :

- **aucune action n'est envoyée au jeu** : pas de clic simulé, pas d'automatisation ;
- **aucune interception réseau** ;
- la mémoire du jeu n'est lue, en lecture seule, que pour **deux** données absentes des logs : la
  cote, et les types de serviteurs de la partie (que le jeu affiche lui-même au choix du héros) ;
- l'overlay n'affiche que ce que le joueur a **déjà vu**.

⚠️ **L'estimation de combat est interdite dans certains tournois.** Fermer l'overlay si vous en
jouez un.

---

## Pour aller plus loin

| Document | Contenu |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | règles du projet, limites, commandes |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | les phases et où on en est |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | modules, flux de données, schéma de la base |
| [`docs/LOG_FORMAT.md`](docs/LOG_FORMAT.md) | le format de `Power.log` et ses pièges |
| [`docs/ARCHIVAGE.md`](docs/ARCHIVAGE.md) | archivage, rétention, tâche planifiée |
| [`ml/README.md`](ml/README.md) | le jeu de données pour la future IA (Python) |

**Stack** : Node.js et TypeScript, SQLite (`better-sqlite3`), Electron, React, Vite et Recharts ;
moteur de simulation de Firestone ; lecture mémoire par `koffi`. Tests avec Vitest.
