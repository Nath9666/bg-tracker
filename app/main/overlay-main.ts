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
import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { followLogs } from '../../src/reader/live-reader.js';
import { logsFolderPath } from '../../src/reader/hearthstone-path.js';
import { LiveTracker, type LiveState } from '../../src/live/live-tracker.js';
import { loadIndex, type CardInfo } from '../../src/cards/card-database.js';
import { database } from './database.js';
import { runTask } from './tasks.js';
import {
  DEFAULT_RATINGS_PATH,
  listGames,
  writeRatingsTemplate,
  appendRating,
  detectRatingChange,
  type RatingSnapshot,
} from '../../src/ratings/ratings.js';
import {
  heroPickCard,
  restingView,
  tierCurve,
  timeline,
  type HeroPickCard,
  type RestingView,
  type TimelinePoint,
} from '../../src/stats/stats.js';
import { createHeroBaseResolver } from '../../src/db/hero-base.js';
import { openRatingReader, type RatingReader } from '../../src/memory/rating-reader.js';
import { toLocalIso } from '../../src/extract/log-clock.js';
import { loadPool, poolByTier, racesSeen, type PoolMinion, type TierPool } from '../../src/pool/minion-pool.js';
import { SIM_CARDS_PATH, loadSimCards, type SimCards } from '../../src/sim/sim-cards.js';
import { combatOdds, oddsSignature, type CombatEstimate } from '../../src/sim/combat-odds.js';

/**
 * Dossier `Logs` de Hearthstone : `BG_TRACKER_LOGS`, sinon le registre, sinon
 * l'emplacement par defaut (voir src/reader/hearthstone-path.ts).
 */
const LOGS_FOLDER = logsFolderPath();

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
   * Ce qui peut encore sortir de la taverne, par palier, pour les types
   * deduits de la partie en cours.
   */
  pool: TierPool[];
  /** Types du lobby deduits des serviteurs deja vus. */
  lobbyRaces: string[];
  /** Cote lue dans la memoire du jeu. `null` si illisible, sans que rien d'autre n'en souffre. */
  rating: RatingSnapshot | null;
  /** Vrai si les types viennent de la memoire du jeu, faux s'ils sont deduits de ce qui a ete vu. */
  lobbyRacesFromGame: boolean;
  /** Fiches d'aide au choix, une par heros propose. Vide hors du choix du heros. */
  heroPicks: HeroPickCard[];
  /** Ecran de repos, entre deux parties. `null` pendant une partie. */
  resting: RestingView | null;
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

let prompt: BrowserWindow | null = null;
let latest: OverlayPayload | null = null;

/**
 * Fenetres de l'overlay, toutes transparentes et traversantes aux clics.
 *
 * Quatre plutot qu'une seule : chaque coin de l'ecran sert a autre chose
 * pendant une partie, et un panneau unique obligerait a tout lire au meme
 * endroit. Les clics les traversent, elles ne genent donc jamais le jeu.
 */
type OverlayMode = 'left' | 'right' | 'combat' | 'bonus';

const fenetres = new Map<OverlayMode, BrowserWindow>();

/** Geometrie de chaque fenetre, calculee sur la zone de travail de l'ecran. */
function geometrie(
  mode: OverlayMode,
  workArea: Electron.Rectangle,
): { x: number; y: number; width: number; height: number } {
  const marge = 12;

  switch (mode) {
    // Combats passes et a venir : la colonne la plus longue, et la seule qui
    // grandit sans borne. Toute la hauteur disponible, moins la bande de bonus
    // du bas : ce qui depasse est invisible, la fenetre laissant passer les
    // clics.
    case 'left':
      return {
        x: workArea.x + marge,
        y: workArea.y + marge,
        width: 320,
        height: workArea.height - 2 * marge - 72,
      };
    // Rythme de paliers et jauges : consultes entre deux combats.
    case 'right':
      return {
        x: workArea.x + workArea.width - 300 - marge,
        y: workArea.y + marge,
        width: 300,
        height: Math.min(460, workArea.height - 2 * marge),
      };
    // Estimation : au centre, la ou on regarde pendant un combat.
    case 'combat':
      return {
        x: workArea.x + Math.round((workArea.width - 460) / 2),
        y: workArea.y + 8,
        width: 460,
        height: 150,
      };
    // Bonus cumules : une bande en bas, hors du champ de jeu.
    case 'bonus':
      return {
        x: workArea.x + Math.round((workArea.width - 720) / 2),
        y: workArea.y + workArea.height - 64,
        width: 720,
        height: 56,
      };
  }
}

function createWindow(mode: OverlayMode): void {
  const { workArea } = screen.getPrimaryDisplay();

  const window = new BrowserWindow({
    ...geometrie(mode, workArea),
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
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true);
  // Les clics traversent la fenetre : l'overlay ne gene jamais le jeu.
  window.setIgnoreMouseEvents(true, { forward: true });

  void window.loadFile(join(__dirname, 'ui', 'overlay', 'index.html'), { query: { mode } });
  fenetres.set(mode, window);
}

function createOverlay(): void {
  for (const mode of ['left', 'right', 'combat', 'bonus'] as OverlayMode[]) createWindow(mode);
}

/**
 * Fenetre de saisie de la cote, ouverte en fin de partie./**
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
/** Parties en base, pour l'ecran de repos. Relues apres chaque sync. */
let historique: TimelinePoint[] | null = null;

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

let pool: PoolMinion[] | null = null;

/** Le pool complet, lu une seule fois : il ne change pas d'une partie a l'autre. */
function minionPool(): PoolMinion[] {
  pool ??= loadPool(database());
  return pool;
}

/**
 * Cote lue dans la memoire du jeu (voir src/memory/rating-reader.ts).
 *
 * Le lecteur reste ouvert entre deux lectures : sa preparation coute ~30 ms,
 * une lecture ~20 ms. Toute erreur le referme et rend `null` ; il sera rouvert
 * a la lecture suivante. Rien, ici, ne doit empecher l'overlay de tourner.
 */
let lecteurCote: RatingReader | null = null;
let derniereCote: { valeur: RatingSnapshot | null; quand: number } = { valeur: null, quand: 0 };

function lireCote(): RatingSnapshot | null {
  try {
    lecteurCote ??= openRatingReader();
    return lecteurCote.read();
  } catch {
    lecteurCote?.close();
    lecteurCote = null;
    return null;
  }
}

/** Cote pour l'affichage : relue au plus toutes les 10 secondes. */
function coteAffichee(): RatingSnapshot | null {
  if (Date.now() - derniereCote.quand > 10_000) {
    derniereCote = { valeur: lireCote(), quand: Date.now() };
  }
  return derniereCote.valeur;
}

/**
 * Attend que le serveur envoie la nouvelle cote, puis l'inscrit dans
 * `ratings.csv`, datee de maintenant. Le prochain `npm run sync` la rattache
 * a la partie qui vient de finir.
 *
 * Rend vrai si la cote a ete enregistree. Au bout de trois minutes sans
 * changement (jeu ferme, deconnexion), on abandonne : la saisie manuelle
 * prend le relais.
 */
async function enregistrerCote(avant: RatingSnapshot): Promise<boolean> {
  const limite = Date.now() + 3 * 60_000;
  while (Date.now() < limite) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const maintenant = lireCote();
    if (maintenant === null) continue;

    const changement = detectRatingChange(avant, maintenant);
    if (changement === null) continue;

    await appendRating(
      DEFAULT_RATINGS_PATH,
      toLocalIso(new Date()),
      changement.rating,
      `lue en jeu (${changement.mode === 'solo' ? 'Solo' : 'Duo'})`,
    );
    derniereCote = { valeur: maintenant, quand: Date.now() };
    return true;
  }
  return false;
}

/**
 * Types de la partie lus en memoire. Fixes pour toute la partie : une fois
 * lus, on ne relit plus jusqu'a la partie suivante (`session` change, ou
 * `inGame` repasse a faux).
 */
let typesPartie: string[] | null = null;
let typesRelusA = 0;

function typesDeLaPartie(state: LiveState): string[] | null {
  if (!state.inGame) {
    typesPartie = null;
    return null;
  }
  if (typesPartie === null && Date.now() - typesRelusA > 2_000) {
    typesRelusA = Date.now();
    try {
      lecteurCote ??= openRatingReader();
      // `null` tant que le jeu n'a pas rempli la liste : on reessaiera, et la
      // deduction par les serviteurs vus sert en attendant.
      typesPartie = lecteurCote.lobbyRaces();
    } catch {
      lecteurCote?.close();
      lecteurCote = null;
    }
  }
  return typesPartie;
}

/** Fiches du choix de heros, recalculees seulement quand les propositions changent. */
let fiches: { clef: string; valeur: HeroPickCard[] } = { clef: '', valeur: [] };

function fichesHeros(offres: readonly string[], types: ReadonlySet<string>): HeroPickCard[] {
  const clef = `${offres.join(',')}|${[...types].sort().join(',')}`;
  if (fiches.clef === clef) return fiches.valeur;

  const db = database();
  const base = createHeroBaseResolver(db);
  // Plusieurs skins d'un meme heros donnent la meme fiche : une seule suffit.
  const heros = [...new Set(offres.map((cardId) => base(cardId)))];
  fiches = { clef, valeur: heros.map((id) => heroPickCard(db, id, types)) };
  return fiches.valeur;
}

/** Dernier etat du tracker, pour redessiner sans attendre une ligne de log. */
let etatCourant: LiveState | null = null;
/** Vrai entre la fin d'une partie et l'arrivee de sa nouvelle cote. */
let coteEnAttente = false;

/**
 * Redessine les fenetres avec l'etat courant.
 *
 * L'overlay ne se redessine d'ordinaire qu'a l'arrivee de lignes de log. Or
 * apres une partie, dans le menu, le log ne bouge presque plus : la cote qui
 * arrive quelques secondes apres la fin, ou la partie que le sync vient
 * d'importer, ne s'afficheraient jamais.
 */
async function rediffuser(): Promise<void> {
  if (etatCourant !== null) broadcast(await buildPayload(etatCourant));
}

let syncEnCours: Promise<boolean> | null = null;

/**
 * Synchronise en arriere-plan : archive, import, rattachement des cotes.
 * Environ 3 secondes quand seule la derniere session a bouge.
 *
 * Dans un processus a part (voir tasks.ts) : l'import ecrit en base de facon
 * synchrone et gelerait l'overlay, et l'application installee n'a pas `npm`.
 * Un seul a la fois ; un echec est journalise, jamais propage.
 */
function lancerSync(): Promise<boolean> {
  syncEnCours ??= runTask('sync').finally(() => {
    syncEnCours = null;
    // La base a change : le rythme de reference et les fiches heros aussi.
    pace = null;
    fiches = { clef: '', valeur: [] };
    historique = null;
  });
  return syncEnCours;
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

  // Les types lus dans le jeu font foi ; a defaut, on les deduit de ce qui a
  // deja ete vu, ce qui demande quelques tours.
  const lusEnJeu = typesDeLaPartie(state);
  const races = lusEnJeu !== null ? new Set(lusEnJeu) : racesSeen(state.seenCardIds, minionPool());

  return {
    state,
    cards,
    pace: paceReference(),
    odds: computeOdds(state),
    pool: poolByTier(minionPool(), races),
    lobbyRaces: [...races].sort(),
    rating: coteAffichee(),
    lobbyRacesFromGame: lusEnJeu !== null,
    heroPicks: state.heroOffers.length === 0 ? [] : fichesHeros(state.heroOffers, races),
    resting: state.inGame
      ? null
      : restingView(
          (historique ??= timeline(database())),
          toLocalIso(new Date()).slice(0, 10),
          { rating: coteAffichee()?.solo ?? null, place: state.place, pending: coteEnAttente },
        ),
  };
}

function broadcast(payload: OverlayPayload): void {
  latest = payload;
  for (const window of fenetres.values()) {
    if (!window.isDestroyed()) window.webContents.send('live', payload);
  }
}

/** Suit les logs et pousse l'etat a chaque lot de lignes. */
async function follow(signal: AbortSignal): Promise<void> {
  const tracker = new LiveTracker();
  let wasInGame = false;
  let coteAuDebut: RatingSnapshot | null = null;

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
    etatCourant = state;

    // Debut de partie : on note la cote, pour reconnaitre la nouvelle a la fin.
    if (!wasInGame && state.inGame) {
      coteAuDebut = lireCote();
      coteEnAttente = false;
    }
    // Fin de partie : la cote du jeu est encore l'ancienne, le serveur envoie
    // la nouvelle quelques secondes plus tard. On le dit, plutot que
    // d'afficher l'ancienne comme si c'etait celle de cette partie.
    if (wasInGame && !state.inGame) coteEnAttente = coteAuDebut !== null;

    broadcast(await buildPayload(state));

    // La partie vient de se terminer. Dans l'ordre : lire la cote, lancer le
    // sync (qui l'importe et la rattache), et seulement ensuite, si elle
    // manque encore, proposer la saisie. Avant le sync, la partie qui vient
    // de finir n'est pas en base : la fenetre viserait la precedente.
    if (wasInGame && !state.inGame) {
      const avant = coteAuDebut;
      void (async () => {
        if (avant !== null) await enregistrerCote(avant);
        // Cote arrivee (ou abandon au bout de trois minutes) : on redessine.
        coteEnAttente = false;
        await rediffuser();

        await lancerSync();
        // La partie est maintenant en base : courbe et bilan a jour.
        await rediffuser();
        // Et le releve de carriere, si l'ecran de statistiques a ete ouvert.
        void runTask('career');

        const last = listGames(database()).at(-1);
        if (last !== undefined && last.rating === null) {
          openRatingPrompt({ gameId: last.id, label: last.label, datetime: last.datetime });
        }
      })();
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

let controller: AbortController | null = null;

/** Demarre l'overlay : ses fenetres, le simulateur, le suivi des logs. */
export function startOverlay(): void {
  if (controller !== null) return;
  controller = new AbortController();
  createOverlay();
  startSimCards();
  void follow(controller.signal);
}

/** Arrete le suivi et ferme les fenetres de l'overlay. */
export function stopOverlay(): void {
  controller?.abort();
  controller = null;
  for (const window of fenetres.values()) if (!window.isDestroyed()) window.destroy();
  fenetres.clear();
  lecteurCote?.close();
  lecteurCote = null;
}

/** Masque ou montre les fenetres, sans arreter le suivi : rien n'est perdu. */
export function setOverlayVisible(visible: boolean): void {
  for (const window of fenetres.values()) {
    if (window.isDestroyed()) continue;
    if (visible) window.showInactive();
    else window.hide();
  }
}

/**
 * Recharge les cartes du simulateur, une fois telechargees apres le
 * demarrage (premier lancement de l'application installee).
 */
export function reloadSimCards(): void {
  simUnavailable = false;
  simCards = null;
  oddsCache = null;
  startSimCards();
}

/** Vrai pendant une partie : les travaux lourds attendent la fin. */
export function isInGame(): boolean {
  return etatCourant?.inGame === true;
}

/** Synchronise maintenant, a la demande, puis redessine. */
export async function syncNow(): Promise<boolean> {
  const ok = await lancerSync();
  await rediffuser();
  return ok;
}
