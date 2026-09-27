/**
 * Tableau de bord : sa fenetre et ses reponses IPC.
 *
 * Il repond aux demandes du rendu par IPC. Toutes les analyses viennent de
 * `src/stats`, les memes que `npm run stats` : le rendu ne touche jamais a
 * SQLite, il ne recoit que des objets simples.
 *
 * Plus de cycle de vie propre : c'est `app-main.ts` qui lance l'application et
 * ouvre cette fenetre a la demande.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import {
  DEFAULT_RATINGS_PATH,
  listGames,
  writeRatingsTemplate,
} from '../../src/ratings/ratings.js';
import { database } from './database.js';
import { careerView, recentWarbands } from '../../src/career/career.js';
import { toLocalIso } from '../../src/extract/log-clock.js';
import {
  finalBoardRaces,
  finalBoards,
  heroRaceShares,
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
  /** Repartition des types dominants de chaque heros, par heros de base. */
  heroRaces: ReturnType<typeof heroRaceShares>;
  /** Plateau final de chaque partie, par identifiant de partie. */
  finalBoards: ReturnType<typeof finalBoards>;
  /** Statistiques de carriere, avec leur progression sur 7 jours. `null` sans releve. */
  career: ReturnType<typeof careerView>;
  /** Dernieres troupes de guerre lues dans le jeu, la plus recente d'abord. */
  warbands: ReturnType<typeof recentWarbands>;
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
    finalBoards: finalBoards(handle, filters),
    heroRaces: heroRaceShares(handle, filters),
    // Independantes des filtres : ce sont des compteurs de toute la carriere.
    career: careerView(handle, toLocalIso(new Date(Date.now() - 7 * 86_400_000)).slice(0, 10)),
    warbands: recentWarbands(handle, 5),
  };
}

let fenetre: BrowserWindow | null = null;

/** Ouvre le tableau de bord, ou le ramene devant s'il est deja ouvert. */
export function openDashboard(): void {
  if (fenetre !== null && !fenetre.isDestroyed()) {
    if (fenetre.isMinimized()) fenetre.restore();
    fenetre.focus();
    return;
  }

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
  window.on('closed', () => {
    fenetre = null;
  });
  void window.loadFile(join(__dirname, 'ui', 'renderer', 'index.html'));
  fenetre = window;
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
