/**
 * BG Tracker : l'application, en un seul programme.
 *
 * L'overlay demarre seul ; une icone pres de l'horloge ouvre le tableau de
 * bord, masque l'overlay, synchronise ou quitte. Fermer le tableau de bord ne
 * quitte pas : l'overlay continue de suivre les parties.
 *
 * **Ou vivent les donnees.** Installee, l'application range tout dans
 * `%AppData%\BG Tracker\data` : elle n'a plus le dossier du projet a cote
 * d'elle. En developpement (`npm run app`, `npm run overlay`), elle garde le
 * `data/` du projet, partage avec les commandes `npm`. `BG_TRACKER_HOME`
 * force un autre dossier dans les deux cas.
 *
 * Les chemins de donnees du projet sont tous relatifs (`data/...`) : il suffit
 * donc de se placer dans le bon dossier avant la premiere lecture.
 */
import { app, dialog, Menu, nativeImage, shell, Tray } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_DB_PATH } from '../../src/db/database.js';
import { DEFAULT_INDEX_PATH } from '../../src/cards/card-database.js';
import { SIM_CARDS_PATH } from '../../src/sim/sim-cards.js';
import { closeDatabase } from './database.js';
import { openDashboard } from './main.js';
import {
  isInGame,
  reloadSimCards,
  setOverlayVisible,
  startOverlay,
  stopOverlay,
  syncNow,
} from './overlay-main.js';
import { runTask } from './tasks.js';

app.setName('BG Tracker');
// Windows regroupe notifications et raccourcis par cet identifiant.
app.setAppUserModelId('fr.bgtracker.app');

/** Dossier racine des donnees : celui qui contient `data/`. */
function dossierRacine(): string {
  const force = process.env['BG_TRACKER_HOME'];
  if (force !== undefined && force.length > 0) return resolve(force);
  if (app.isPackaged) return join(app.getPath('appData'), 'BG Tracker');
  return process.cwd();
}

const racine = dossierRacine();
mkdirSync(racine, { recursive: true });
process.chdir(racine);

let tray: Tray | null = null;

/** Frequence du releve de carriere hors partie. */
const RELEVE_CARRIERE_MS = 10 * 60_000;
let overlayVisible = true;

/**
 * Premier lancement : proposer de reprendre un historique existant.
 *
 * Le dossier `data/` du projet contient la base, les cotes, et surtout
 * l'archive des logs, que Hearthstone a effaces depuis : c'est la seule copie.
 */
async function premierLancement(): Promise<void> {
  if (existsSync(DEFAULT_DB_PATH) || existsSync(join('data', 'archive'))) return;

  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Bienvenue dans BG Tracker',
    message: 'Reprendre un historique existant ?',
    detail:
      'Si tu utilisais déjà BG Tracker, choisis son dossier « data » : la base, les cotes et ' +
      'l’archive des logs seront copiées ici. Sinon, l’historique commencera à ta prochaine partie.',
    buttons: ['Choisir un dossier data…', 'Partir de zéro'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Dossier « data » de BG Tracker',
    properties: ['openDirectory'],
  });
  const source = filePaths[0];
  if (canceled || source === undefined) return;

  const valide = existsSync(join(source, 'bg-tracker.db')) || existsSync(join(source, 'archive'));
  if (!valide) {
    await dialog.showMessageBox({
      type: 'warning',
      title: 'Dossier non reconnu',
      message: 'Ce dossier ne contient ni « bg-tracker.db » ni « archive ».',
      detail: 'Rien n’a été copié. L’historique commencera à ta prochaine partie.',
    });
    return;
  }

  // Copie, jamais deplacement : l'original reste intact.
  await cp(source, 'data', { recursive: true });
}

/**
 * Bases de cartes manquantes : on les telecharge en fond. L'overlay tourne
 * sans elles en attendant, avec des noms bruts et sans estimation de combat.
 */
async function cartesManquantes(): Promise<void> {
  if (!existsSync(DEFAULT_INDEX_PATH)) await runTask('cards');
  if (!existsSync(SIM_CARDS_PATH) && (await runTask('sim-cards'))) reloadSimCards();
}

function icone(): Electron.NativeImage {
  return nativeImage.createFromPath(join(__dirname, 'assets', 'tray.png'));
}

function menu(): Menu {
  const connexion = app.getLoginItemSettings();
  return Menu.buildFromTemplate([
    { label: 'Ouvrir le tableau de bord', click: openDashboard },
    { type: 'separator' },
    {
      label: 'Afficher l’overlay',
      type: 'checkbox',
      checked: overlayVisible,
      click: (item) => {
        overlayVisible = item.checked;
        setOverlayVisible(overlayVisible);
      },
    },
    {
      label: 'Synchroniser maintenant',
      click: () => {
        void syncNow().then(() => runTask('career'));
      },
    },
    {
      label: 'Lancer au démarrage de Windows',
      type: 'checkbox',
      checked: connexion.openAtLogin,
      // En developpement, l'executable est Electron lui-meme : l'inscrire au
      // demarrage lancerait une fenetre vide.
      enabled: app.isPackaged,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: 'Ouvrir le dossier des données', click: () => void shell.openPath(racine) },
    { type: 'separator' },
    { label: 'Quitter BG Tracker', click: () => app.quit() },
  ]);
}

function creerTray(): void {
  tray = new Tray(icone());
  tray.setToolTip('BG Tracker');
  // Un clic simple ouvre le tableau de bord ; le clic droit, le menu,
  // reconstruit a chaque fois pour refleter l'etat courant.
  tray.on('click', openDashboard);
  tray.on('right-click', () => tray?.popUpContextMenu(menu()));
}

// Une seule instance : relancer l'application ramene le tableau de bord.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', openDashboard);

  void app.whenReady().then(async () => {
    await premierLancement();
    creerTray();
    startOverlay();
    if (process.argv.includes('--dashboard')) openDashboard();

    await cartesManquantes();
    // Rattrape les parties jouees sans l'application ouverte.
    await syncNow();
    await runTask('career');

    // Statistiques de carriere : l'ecran du jeu peut s'ouvrir a tout moment.
    // Jamais pendant une partie : le balayage lit ~2 Go de memoire du jeu.
    setInterval(() => {
      if (!isInGame()) void runTask('career');
    }, RELEVE_CARRIERE_MS);
  });

  // Fermer le tableau de bord ne quitte pas : l'overlay et l'icone restent.
  app.on('window-all-closed', () => undefined);

  app.on('before-quit', () => {
    stopOverlay();
    closeDatabase();
    tray?.destroy();
    tray = null;
  });
}
