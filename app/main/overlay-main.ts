/**
 * Processus principal de l'overlay.
 *
 * Il suit `Power.log` en direct, tient l'etat de la partie et le pousse vers
 * deux fenetres :
 *
 *  - l'**overlay**, transparent, toujours au premier plan, qui laisse passer
 *    les clics pour ne jamais gener le jeu ;
 *  - une **saisie de cote**, fenetre normale qui s'ouvre en fin de partie.
 *
 * Il ne fait que lire des fichiers et n'envoie jamais rien au jeu (voir les
 * limites dans CLAUDE.md).
 */
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { followLogs } from '../../src/reader/live-reader.js';
import { LiveTracker, type LiveState } from '../../src/live/live-tracker.js';
import { loadIndex, type CardInfo } from '../../src/cards/card-database.js';
import { DEFAULT_DB_PATH, openDatabase, type Db } from '../../src/db/database.js';
import {
  DEFAULT_RATINGS_PATH,
  listGames,
  writeRatingsTemplate,
} from '../../src/ratings/ratings.js';

/** Dossier `Logs` de Hearthstone. */
const LOGS_FOLDER =
  process.env['BG_TRACKER_LOGS'] ?? 'F:\\SteamLibrary\\Hearthstone\\Logs';

/** Ce que l'overlay recoit : l'etat, plus de quoi nommer les cartes. */
export interface OverlayPayload {
  state: LiveState;
  /** cardId -> nom et details, pour les cartes citees par l'etat. */
  cards: Record<string, Pick<CardInfo, 'name' | 'techLevel' | 'races'>>;
}

/** Derniere partie terminee, proposee a la saisie de cote. */
export interface RatingPrompt {
  gameId: string;
  label: string;
  datetime: string;
}

let overlay: BrowserWindow | null = null;
let prompt: BrowserWindow | null = null;
let db: Db | null = null;
let latest: OverlayPayload | null = null;

function database(): Db {
  db ??= openDatabase(process.env['BG_TRACKER_DB'] ?? DEFAULT_DB_PATH);
  return db;
}

function createOverlay(): void {
  const { workArea } = screen.getPrimaryDisplay();

  overlay = new BrowserWindow({
    x: workArea.x + 12,
    y: workArea.y + 12,
    width: 340,
    height: Math.min(760, workArea.height - 24),
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, 'overlay-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Au-dessus du jeu, meme en plein ecran fenetre.
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true);
  // Les clics traversent la fenetre : l'overlay ne gene jamais le jeu.
  overlay.setIgnoreMouseEvents(true, { forward: true });

  void overlay.loadFile(join(__dirname, 'ui', 'overlay', 'index.html'));
}

/**
 * Fenetre de saisie de la cote, ouverte en fin de partie.
 *
 * Elle, en revanche, est normale : on doit pouvoir y taper.
 */
function openRatingPrompt(game: RatingPrompt): void {
  if (prompt !== null && !prompt.isDestroyed()) {
    prompt.webContents.send('prompt', game);
    prompt.focus();
    return;
  }

  const { workArea } = screen.getPrimaryDisplay();
  prompt = new BrowserWindow({
    x: workArea.x + workArea.width - 380,
    y: workArea.y + workArea.height - 220,
    width: 360,
    height: 190,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#1d1a29',
    webPreferences: {
      preload: join(__dirname, 'overlay-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void prompt
    .loadFile(join(__dirname, 'ui', 'overlay', 'index.html'), { query: { mode: 'rating' } })
    .then(() => prompt?.webContents.send('prompt', game));
}

/** Index des cartes, charge une seule fois : le fichier fait plusieurs Mo. */
let cardIndex: Awaited<ReturnType<typeof loadIndex>> = null;

/** Prepare le lot envoye a l'overlay : l'etat et le nom des cartes citees. */
async function buildPayload(state: LiveState): Promise<OverlayPayload> {
  cardIndex ??= await loadIndex();
  const index = cardIndex;
  const cards: OverlayPayload['cards'] = {};

  const noter = (cardId: string | null): void => {
    if (cardId === null || cardId.length === 0 || cards[cardId] !== undefined) return;
    const card = index?.get(cardId);
    cards[cardId] = {
      name: card?.name ?? cardId,
      techLevel: card?.techLevel ?? null,
      races: card?.races ?? [],
    };
  };

  noter(state.heroCardId);
  for (const minion of state.board) noter(minion.cardId);
  for (const combat of state.combats) noter(combat.opponentHero);
  for (const opponent of state.opponents) {
    noter(opponent.heroCardId);
    for (const minion of opponent.board) noter(minion.cardId);
  }

  return { state, cards };
}

function broadcast(payload: OverlayPayload): void {
  latest = payload;
  if (overlay !== null && !overlay.isDestroyed()) overlay.webContents.send('live', payload);
}

/** Suit les logs et pousse l'etat a chaque lot de lignes. */
async function follow(signal: AbortSignal): Promise<void> {
  const tracker = new LiveTracker();
  let wasInGame = false;

  // `fromStart` : on relit la session depuis le debut pour rattraper la partie
  // deja commencee. Sans cela, lancer l'overlay en cours de partie laisserait
  // l'ecran vide jusqu'a la suivante. Le tracker ne retient que la derniere
  // partie, les precedentes de la session ne font que defiler.
  for await (const batch of followLogs(
    { logsFolder: LOGS_FOLDER, pollMs: 700, fromStart: true },
    signal,
  )) {
    if (batch.newSession) {
      tracker.setSession(batch.session);
    } else {
      for (const line of batch.lines) tracker.pushLine(line);
    }

    const state = tracker.state;
    broadcast(await buildPayload(state));

    // La partie vient de se terminer : on propose d'en noter la cote.
    if (wasInGame && !state.inGame) {
      const games = listGames(database());
      const last = games.at(-1);
      if (last !== undefined && last.rating === null) {
        openRatingPrompt({ gameId: last.id, label: last.label, datetime: last.datetime });
      }
    }
    wasInGame = state.inGame;
  }
}

ipcMain.handle('live:current', () => latest);

ipcMain.handle('live:setRating', async (_event, gameId: string, rating: number | null) => {
  const handle = database();
  handle.prepare('UPDATE games SET rating_after = ? WHERE id = ?').run(rating, gameId);
  await writeRatingsTemplate(DEFAULT_RATINGS_PATH, listGames(handle));
});

ipcMain.on('live:closePrompt', () => {
  prompt?.close();
  prompt = null;
});

const controller = new AbortController();

void app.whenReady().then(() => {
  createOverlay();
  void follow(controller.signal);
});

app.on('window-all-closed', () => {
  controller.abort();
  db?.close();
  db = null;
  app.quit();
});
