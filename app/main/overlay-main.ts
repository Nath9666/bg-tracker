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
import { existsSync } from 'node:fs';
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
import { tierCurve } from '../../src/stats/stats.js';
import { SIM_CARDS_PATH, loadSimCards, type SimCards } from '../../src/sim/sim-cards.js';
import { combatOdds, oddsSignature, type CombatEstimate } from '../../src/sim/combat-odds.js';

/** Dossier `Logs` de Hearthstone. */
const LOGS_FOLDER =
  process.env['BG_TRACKER_LOGS'] ?? 'F:\\SteamLibrary\\Hearthstone\\Logs';

/**
 * Rythme de montee de taverne dans les parties reussies, tire de la base.
 *
 * Sert de reference a la partie en cours : « tu es T5 au tour 10, dans tes
 * tops 4 tu y etais au tour 9 ». Le nombre de parties est transmis aussi : sur
 * un historique mince, la reference ne vaut pas grand-chose et il faut le dire.
 */
export interface PaceReference {
  tier: number;
  /** Tour moyen d'arrivee a ce palier dans les tops 4. */
  top4Turn: number | null;
  top4Games: number;
}

/** Ce que l'overlay recoit : l'etat, plus de quoi nommer les cartes. */
export interface OverlayPayload {
  state: LiveState;
  /** cardId -> nom et details, pour les cartes citees par l'etat. */
  cards: Record<string, Pick<CardInfo, 'name' | 'techLevel' | 'races'>>;
  pace: PaceReference[];
  /**
   * Estimation du combat en cours.
   *
   * `null` quand la base de cartes du simulateur n'est pas installee : le
   * reste de l'overlay continue de fonctionner sans elle.
   */
  odds: CombatEstimate | null;
}

/** Derniere partie terminee, proposee a la saisie de cote. */
export interface RatingPrompt {
  gameId: string;
  label: string;
  datetime: string;
}

let simCards: SimCards | null = null;
let simUnavailable = false;
/** Derniere estimation, et la signature de l'etat qui l'a produite. */
let oddsCache: { signature: string; value: CombatEstimate } | null = null;

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

/** Reference de rythme, calculee une fois : elle ne bouge pas en cours de session. */
let pace: PaceReference[] | null = null;

/**
 * Charge la base du simulateur, une fois, en tache de fond.
 *
 * On ne la telecharge jamais ici : 42 Mo au milieu d'une partie serait une
 * mauvaise surprise. Sans le cache, l'estimation reste simplement absente et
 * le reste de l'overlay fonctionne.
 */
function startSimCards(): void {
  if (!existsSync(SIM_CARDS_PATH)) {
    simUnavailable = true;
    console.warn(
      `Estimation de combat désactivée : ${SIM_CARDS_PATH} absent. Lancer « npm run sim-cards ».`,
    );
    return;
  }

  void loadSimCards()
    .then((loaded) => {
      simCards = loaded;
    })
    .catch((error: unknown) => {
      simUnavailable = true;
      console.warn(
        `Estimation de combat désactivée : ${error instanceof Error ? error.message : String(error)}`,
      );
    });
}

/**
 * Estimation du combat en cours, mise en cache.
 *
 * Les logs arrivent par lots toutes les 700 ms ; relancer 1000 simulations a
 * chaque lot couterait 100 ms de processus principal pour rien. Les deux
 * plateaux etant figes au debut du combat, la signature ne bouge qu'au combat
 * suivant : une seule serie de simulations par combat.
 */
function computeOdds(state: LiveState): CombatEstimate | null {
  if (simUnavailable) return null;

  // Le chargement est lance en tache de fond au demarrage : tant qu'il n'a
  // pas fini, l'overlay affiche le reste sans attendre.
  if (simCards === null) return null;

  const signature = oddsSignature(state);
  if (oddsCache?.signature === signature) return oddsCache.value;

  const value = combatOdds(simCards, state);
  oddsCache = { signature, value };
  return value;
}

function paceReference(): PaceReference[] {
  pace ??= tierCurve(database()).map((point) => ({
    tier: point.tier,
    top4Turn: point.top4Turn,
    top4Games: point.top4Games,
  }));
  return pace;
}

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

  return { state, cards, pace: paceReference(), odds: computeOdds(state) };
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
  startSimCards();
  void follow(controller.signal);
});

app.on('window-all-closed', () => {
  controller.abort();
  db?.close();
  db = null;
  app.quit();
});
