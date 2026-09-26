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

| Réglage   | Valeur                                          | Variable d'environnement |
| --------- | ----------------------------------------------- | ------------------------ |
| Source    | `F:\SteamLibrary\Hearthstone\Logs`              | `BG_TRACKER_LOGS`        |
| Archive   | `data/archive` (dans le projet, ignoré par Git) | `BG_TRACKER_ARCHIVE`     |
| Rétention | 200 parties                                     | — (option `--keep`)      |

## Rétention : ce qu'élaguer coûte vraiment

La base contient désormais les parties, leurs tours, leurs plateaux et leurs choix. Élaguer un log
archivé ne fait donc **plus perdre une partie**.

Mais la base ne garde pas **tout** : chaque achat, chaque vente, chaque repositionnement de serviteur
n'existe que dans le log brut, et la phase 5 en aura besoin pour entraîner l'IA. Un log élagué est
une donnée d'entraînement perdue.

D'où la valeur par défaut de **200 parties**, environ un mois de jeu pour 1 Go compressé. Pour tout
garder :

```bash
npm run archive -- --keep 100000
```

⚠️ **Une session élaguée n'est jamais rearchivée**, même si ses logs sont encore dans le dossier de
Hearthstone : le manifeste retient son nom pour ne pas la relire à chaque passage. Lancer
`npm run archive -- --dry-run` **avant** de baisser la rétention permet de voir ce qui partirait.

En cas de besoin, les logs encore présents dans le dossier du jeu restent importables directement,
sans passer par l'archive :

```bash
npm run import -- "F:\SteamLibrary\Hearthstone\Logs"
```

## Lancement automatique (planificateur de tâches Windows)

**En place sur cette machine** : tâche `BG Tracker - archivage`, qui lance **`npm run sync`**,
déclenchée **à l'ouverture de session** (après 2 minutes) et **une fois par jour à 4 h**. Créée
**sans élévation**, elle tourne sous le compte de l'utilisateur.

### Pourquoi cette cadence, et pas toutes les 30 minutes

La seule chose qui fait perdre des données, c'est que Hearthstone **supprime un dossier de session
avant qu'il soit archivé**. Observé une fois : trois jours. Rien d'autre n'est urgent — les logs ne
s'écrasent pas entre eux, chaque lancement du jeu crée son propre dossier horodaté, et un fichier
déjà archivé n'est relu que s'il a grossi.

L'échéance se compte donc en **jours**. Un passage quotidien garde un facteur 3 de marge ; toutes
les 30 minutes, ce serait 48 passages par jour pour tenir un délai de 72 heures.

Le déclencheur d'ouverture de session sert au cas où la machine reste allumée sans jamais atteindre
4 h. `-StartWhenAvailable` rattrape les passages manqués pendant que le PC était éteint.

Le coût d'un passage fréquent n'est pas nul non plus : **0,9 s à vide**, mais une dizaine de
secondes **pendant qu'on joue**, le temps de relire et recompresser la session en cours. Autant ne
pas s'y exposer en pleine partie.

### `archive` ou `sync` ?

Les deux sont planifiables. Ça n'a pas toujours été vrai : `sync` mettait **13,9 s** et réécrivait
`data/ratings.csv` à chaque passage. Deux corrections l'ont rendu utilisable en tâche de fond.

| Commande          | À vide | Pendant qu'on joue | Effet de bord                                              |
| ----------------- | ------ | ------------------ | ---------------------------------------------------------- |
| `npm run archive` | 0,9 s  | ~10 s              | aucun                                                      |
| `npm run sync`    | ~1 s   | 2,8 s              | réécrit `ratings.csv` **seulement** si une partie s'ajoute |

Ce qui a changé :

- **L'import est incrémental.** Une session dont les fichiers n'ont pas bougé depuis le dernier
  import est sautée (table `imported_sessions`, voir `docs/ARCHITECTURE.md`). Seule la session en
  cours est relue, puisqu'elle grossit.
- **`ratings.csv` n'est réécrit que si son contenu change.** Le fichier est fait pour rester ouvert
  dans un éditeur : une tâche qui le touche toutes les heures écraserait une saisie en cours.

Reste que la **cote elle-même ne s'automatise pas** : elle n'apparaît nulle part dans les logs. Tout
ce que `sync` peut faire, c'est préparer la ligne vide plus tôt.

Le tableau de bord lit la base en WAL, donc il peut rester ouvert pendant qu'une tâche planifiée
écrit.

**En pratique** : planifier `sync` donne une base et un tableau de bord toujours à jour sans y
penser. Planifier `archive` seul suffit si on préfère ne rien voir bouger entre deux sessions et
lancer `npm run sync` à la main.

### Créer la tâche

En PowerShell, sans élévation :

```powershell
$projet = "C:\Users\Nathan\Documents\Projet\bg-tracker\bg-tracker"
$moi = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument '-WindowStyle Hidden -NonInteractive -NoProfile -Command "npm run sync"' `
  -WorkingDirectory $projet

# -AtLogOn sans -User vaut « tous les utilisateurs » et exige l'élévation.
$logon = New-ScheduledTaskTrigger -AtLogOn -User $moi
$logon.Delay = "PT2M"
$quotidien = New-ScheduledTaskTrigger -Daily -At 4am

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName "BG Tracker - archivage" -Action $action `
  -Trigger $logon, $quotidien -Settings $settings
```

Pièges rencontrés, un essai raté chacun :

- **`-AtLogOn` sans `-User`** vaut « à l'ouverture de session de n'importe qui », ce qui demande
  l'élévation : `Register-ScheduledTask` répond « Accès refusé ». Restreindre au compte courant
  suffit et évite l'élévation.
- **`-Force` ne remplace pas une tâche existante** sans élévation, même la sienne : même « Accès
  refusé ». Il faut `Unregister-ScheduledTask` puis recréer.
- `-WindowStyle Hidden` évite qu'une console clignote à chaque passage, y compris en pleine partie.
  C'est la raison de passer par `powershell.exe` plutôt que par `scripts\archive-logs.cmd`, qui
  reste utilisable pour un lancement manuel.
- **Ne pas passer par un script `.vbs`**, même si c'est la recette classique pour masquer une
  fenêtre : les antivirus bloquent l'exécution des scripts VBS, à juste titre. Essayé ici, refusé
  avec « Accès refusé » alors que Windows Script Host n'était pas désactivé par stratégie.
- Sur un déclencheur répété, **pas de `-RepetitionDuration`** : `[TimeSpan]::MaxValue` est refusé
  (`Duration:P99999999DT23H59M59S` hors limites). L'intervalle seul donne une répétition sans fin.
- `-MultipleInstances IgnoreNew` : si un passage traîne sur une grosse session en cours, le suivant
  est sauté au lieu de lire les mêmes fichiers en double.

### Vérifier, lancer à la main, supprimer

```powershell
Get-ScheduledTaskInfo    -TaskName "BG Tracker - archivage"   # dernière exécution, code de retour
Start-ScheduledTask      -TaskName "BG Tracker - archivage"
Unregister-ScheduledTask -TaskName "BG Tracker - archivage" -Confirm:$false
```

Un **code de retour `0`** signifie que le passage s'est bien terminé (`267011` veut simplement dire
« jamais encore exécutée »). Autre vérification utile : la date de modification de
`data/archive/manifest.json`, qui bouge à chaque passage. La base, elle, est en **WAL** : c'est
`data/bg-tracker.db-wal` qui bouge, pas `data/bg-tracker.db`.

### Par l'interface

1. Ouvrir **Planificateur de tâches** → _Créer une tâche_.
2. Onglet **Général** : nom `BG Tracker - archivage`. _Exécuter avec les autorisations maximales_
   n'est **pas** nécessaire.
3. Onglet **Déclencheurs** : un déclencheur _À l'ouverture de session_ limité à ton compte, et un
   déclencheur _Quotidien_ à 4 h.
4. Onglet **Actions** : programme `powershell.exe`, arguments
   `-WindowStyle Hidden -NonInteractive -NoProfile -Command "npm run sync"`, _Commencer dans_ le
   dossier du projet.
5. Onglet **Conditions** : décocher _N'exécuter que si l'ordinateur est sur secteur_ sur un portable.
6. Onglet **Paramètres** : cocher _Exécuter la tâche dès que possible si un démarrage planifié est
   manqué_, pour rattraper les jours où le PC était éteint à 4 h.

## Après une session de jeu

**L'overlay s'en charge à la fin de chaque partie**, et la tâche planifiée rattrape le reste (parties jouées sans overlay). Pour ne pas attendre le prochain passage, une seule commande
enchaîne les trois étapes, dans l'ordre :

```bash
npm run sync
```

Archivage, import en base, puis mise à jour et relecture de `data/ratings.csv`. La seule chose qui
reste manuelle est la **saisie de la cote** : elle n'est dans aucun log. Les étapes restent
disponibles séparément (`npm run archive`, `npm run import`, `npm run ratings`), mais les oublier dans
le bon ordre est la source d'erreur la plus courante : une cote saisie sans `npm run ratings` reste
dans le fichier sans jamais arriver en base.

Le tableau de bord relit la base **en revenant sur sa fenêtre**, et un bouton _Rafraîchir_ est là pour
le forcer : pas besoin de le relancer après un `npm run sync`.

## Relire l'archive

Une session archivée se lit **exactement comme un dossier de logs d'origine** : le `SessionReader`
décompresse les `.gz` au fil de l'eau, sans fichier temporaire.

```bash
npm run parse -- data/archive/Hearthstone_2026_09_22_00_28_13
```

## La cote (MMR)

Elle n'apparaît nulle part dans les logs : elle se note à la main dans `data/ratings.csv`. Le fichier
est **pré-rempli** par `npm run ratings`, une ligne par partie, la plus ancienne d'abord :

```csv
datetime,rating,partie
2026-09-22T02:56:47.033+02:00,8412,"Cénarius, seigneur de la forêt 1e"
```

Il n'y a que la colonne `rating` à compléter. La même commande rattache ensuite chaque cote à la
partie la plus proche dans le temps, et ajoute les parties jouées depuis, sans toucher à ce qui est
déjà saisi. La troisième colonne n'est qu'un repère lisible : elle est réécrite à chaque passage.
