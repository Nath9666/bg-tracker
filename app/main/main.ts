/**
 * Processus principal Electron.
 *
 * Il ouvre la base en lecture et repond aux demandes du rendu par IPC. Toutes
 * les analyses viennent de `src/stats`, les memes que `npm run stats` : le
 * rendu ne touche jamais a SQLite, il ne recoit que des objets simples.
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import {
  DEFAULT_RATINGS_PATH,
  listGames,
  writeRatingsTemplate,
} from '../../src/ratings/ratings.js';
import { DEFAULT_DB_PATH, openDatabase, type Db } from '../../src/db/database.js';
import {
  finalBoardRaces,
  heroStats,
  overview,
  placeDistribution,
  playedHeroes,
  tierCurve,
  timeline,
  type StatsFilters,
} from '../../src/stats/stats.js';

/** Tout ce dont le tableau de bord a besoin pour un jeu de filtres. */
export interface Dashboard {
  overview: ReturnType<typeof overview>;
  timeline: ReturnType<typeof timeline>;
  heroes: ReturnType<typeof heroStats>;
  places: ReturnType<typeof placeDistribution>;
  tiers: ReturnType<typeof tierCurve>;
  races: ReturnType<typeof finalBoardRaces>;
  /** Liste pour le filtre par heros. */
  playedHeroes: ReturnType<typeof playedHeroes>;
}

let db: Db | null = null;

function database(): Db {
  db ??= openDatabase(process.env['BG_TRACKER_DB'] ?? DEFAULT_DB_PATH);
  return db;
}

function buildDashboard(filters: StatsFilters): Dashboard {
  const handle = database();
  return {
    overview: overview(handle, filters),
    timeline: timeline(handle, filters),
    heroes: heroStats(handle, filters),
    places: placeDistribution(handle, filters),
    tiers: tierCurve(handle, filters),
    races: finalBoardRaces(handle, filters),
    playedHeroes: playedHeroes(handle),
  };
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    title: 'BG Tracker',
    backgroundColor: '#14121c',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // Le rendu n'a aucun acces a Node : il passe par le pont du preload.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.removeMenu();
  void window.loadFile(join(__dirname, 'renderer', 'index.html'));
}

ipcMain.handle('dashboard', (_event, filters: StatsFilters) => buildDashboard(filters ?? {}));

/**
 * Enregistre la cote d'une partie.
 *
 * La base fait foi. `data/ratings.csv` est reecrit dans la foulee pour qu'il
 * reste le reflet de ce qui est enregistre : sans cela, le fichier et la base
 * divergeraient des la premiere saisie faite ici.
 */
ipcMain.handle('setRating', async (_event, gameId: string, rating: number | null) => {
  const handle = database();
  handle.prepare('UPDATE games SET rating_after = ? WHERE id = ?').run(rating, gameId);
  await writeRatingsTemplate(DEFAULT_RATINGS_PATH, listGames(handle));
});

void app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  db?.close();
  db = null;
  if (process.platform !== 'darwin') app.quit();
});
