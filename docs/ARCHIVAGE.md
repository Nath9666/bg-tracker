# Archivage des logs (phase 0)

## Pourquoi

Hearthstone **supprime ses anciens dossiers de session** au bout de quelques jours. C'est vérifié, pas
supposé : le dossier `Hearthstone_2026_09_19_02_47_25`, d'où vient le log de référence du projet, a
disparu du dossier `Logs\` en trois jours.

Chaque partie perdue est une donnée d'entraînement perdue pour la phase 5. L'archivage tourne donc
**avant** le reste du pipeline, et sans lui rien d'autre n'a d'importance.

Deuxième raison, découverte en mesurant : le disque `F:` où le jeu est installé n'a que **1,5 Go
libres sur 466**, alors que les logs y grossissent d'environ **177 Mo par jour**. L'archive ne doit
surtout pas y être écrite.

## Ce que fait le script

1. Parcourt les dossiers `Hearthstone_AAAA_MM_JJ_HH_MM_SS` du dossier `Logs\` de Hearthstone.
2. Copie les `Power.log` et `Power_old.log` vers le dossier d'archive, **compressés en gzip**
   (environ **20x plus petits** : 559 Mo de logs tiennent dans 28 Mo). Les autres fichiers de log
   (`Hearthstone.log`, `LoadingScreen.log`…) sont ignorés : ils ne servent pas au tracker.
3. Compte les parties de chaque fichier au passage (nombre de `CREATE_GAME`, source `GameState`
   uniquement — les doublons `PowerTaskList` ne comptent pas).
4. Applique la rétention : seules les sessions les plus récentes couvrant les **N dernières parties**
   sont conservées.
5. Crée `data/ratings.csv` s'il manque.

Le script **ne touche jamais aux fichiers d'origine**. Il ne fait que lire le dossier de Hearthstone.

Un `manifest.json` à la racine de l'archive retient ce qui a déjà été traité, pour que les passages
suivants ne refassent pas le travail :

- un fichier déjà archivé et inchangé est sauté ;
- un fichier qui a **grossi** depuis (session encore en cours) est réarchivé ;
- une session déjà écartée par la rétention n'est **jamais relue**, sans quoi une tâche planifiée
  relirait des centaines de Mo à chaque passage juste pour les resupprimer.

## Utilisation

```bash
npm run archive                  # archive puis applique la rétention
npm run archive -- --dry-run     # dit ce qui serait fait, sans rien écrire
npm run archive -- --keep 50     # conserve les 50 dernières parties
npm run archive -- --source "F:\SteamLibrary\Hearthstone\Logs" --dest D:\archive
```

La simulation lit quand même les fichiers, car c'est le seul moyen de compter les parties, donc
d'annoncer ce que la rétention supprimerait. **À lancer avant tout changement de rétention.**

### Réglages par défaut

| Réglage | Valeur | Variable d'environnement |
|---|---|---|
| Source | `F:\SteamLibrary\Hearthstone\Logs` | `BG_TRACKER_LOGS` |
| Archive | `data/archive` (dans le projet, ignoré par Git) | `BG_TRACKER_ARCHIVE` |
| Rétention | 10 parties | — (option `--keep`) |

## ⚠️ Rétention et perte de données

**Tant que la phase 2 n'existe pas, ce que la rétention supprime est perdu définitivement.** Aucune
base de données ne relit encore les parties archivées.

À raison de 6 parties par session, une rétention à 10 parties laisse environ **deux jours de marge**.
Si la phase 2 prend plus longtemps, des parties seront perdues. Pour supprimer ce risque, il suffit de
relever la rétention le temps que la base arrive :

```bash
npm run archive -- --keep 500
```

Une fois la phase 2 en place, l'ordre correct sera : importer en base, **puis** élaguer.

## Lancement automatique (planificateur de tâches Windows)

`scripts\archive-logs.cmd` se place dans le dossier du projet tout seul : il peut être lancé depuis
n'importe où.

### En une commande

Dans un terminal **en administrateur** :

```
schtasks /Create /TN "BG Tracker - archivage" /SC MINUTE /MO 30 /F ^
  /TR "\"C:\Users\Nathan\Documents\Projet\bg-tracker\bg-tracker\scripts\archive-logs.cmd\""
```

Toutes les 30 minutes : la session en cours est réarchivée au fur et à mesure que tu joues, et une
session terminée n'est plus touchée. Un passage sans rien à faire prend environ **1 seconde** ;
réarchiver une grosse session en cours prend une dizaine de secondes.

Pour vérifier, lancer à la main ou supprimer :

```
schtasks /Run    /TN "BG Tracker - archivage"
schtasks /Query  /TN "BG Tracker - archivage"
schtasks /Delete /TN "BG Tracker - archivage" /F
```

### Par l'interface

1. Ouvrir **Planificateur de tâches** → *Créer une tâche*.
2. Onglet **Général** : nom `BG Tracker - archivage`, cocher *Exécuter même si l'utilisateur n'est pas
   connecté* si tu veux qu'elle tourne en session fermée.
3. Onglet **Déclencheurs** : *Nouveau* → *À l'ouverture de session*, puis cocher *Répéter la tâche
   toutes les* **30 minutes**, *pendant* **indéfiniment**.
4. Onglet **Actions** : *Démarrer un programme*, programme
   `C:\Users\Nathan\Documents\Projet\bg-tracker\bg-tracker\scripts\archive-logs.cmd`.
5. Onglet **Conditions** : décocher *N'exécuter que si l'ordinateur est sur secteur* sur un portable.

## Relire l'archive

Une session archivée se lit **exactement comme un dossier de logs d'origine** : le `SessionReader`
décompresse les `.gz` au fil de l'eau, sans fichier temporaire.

```bash
npm run parse -- data/archive/Hearthstone_2026_09_22_00_28_13
```

## La cote (MMR)

Elle n'apparaît nulle part dans les logs. `data/ratings.csv` est là pour la noter à la main en
attendant la phase 4 :

```csv
datetime,rating
2026-09-22T02:56,8412
```

La phase 2 rattachera chaque cote à la partie la plus proche dans le temps.
