/**
 * Etat de la partie en cours, pour l'overlay.
 *
 * Le meme `GameStateMachine` que hors ligne, alimente en continu par le suivi
 * de `Power.log`. Ce module n'en retient que ce qui a un sens a l'ecran.
 *
 * ⚠️ Limite volontaire (voir CLAUDE.md) : on n'affiche que ce que le joueur a
 * **deja vu**. Les plateaux adverses viennent des combats deja joues, jamais
 * d'une information cachee.
 */
import type { LogEvent } from '../parser/events.js';
import { parseLine } from '../parser/line-parser.js';
import { GameStateMachine, type Game } from '../state/game-state.js';
import { combatResult, gameTurn, readBoard } from '../extract/game-extractor.js';
import type { BoardMinion, CombatResult, TierUp } from '../types.js';

/** Ce qu'on sait d'un adversaire du lobby. */
export interface OpponentSnapshot {
  heroCardId: string;
  /** Palier de taverne au dernier combat contre lui. */
  tier: number | null;
  /** PV restants, armure comprise. */
  health: number | null;
  place: number | null;
  /** Tour du dernier affrontement. `null` si jamais affronte. */
  lastFoughtTurn: number | null;
  /** Son plateau lors de ce combat. */
  board: BoardMinion[];
}

/** Un combat deja joue. */
export interface CombatLog {
  turn: number;
  opponentHero: string | null;
  result: CombatResult | null;
  damageTaken: number | null;
}

export interface LiveState {
  /** Dossier de session suivi. */
  session: string | null;
  inGame: boolean;
  turn: number | null;
  phase: 'recruit' | 'combat' | null;
  heroCardId: string | null;
  tavernTier: number | null;
  gold: number | null;
  health: number | null;
  place: number | null;
  /** Plateau du joueur, tel qu'il est en ce moment. */
  board: BoardMinion[];
  /** Adversaires rencontres, du plus recemment affronte au plus ancien. */
  opponents: OpponentSnapshot[];
  combats: CombatLog[];
  /** Montees de palier de la partie en cours, dans l'ordre. */
  tierUps: TierUp[];
  /**
   * Heros du prochain adversaire, annonce par le jeu avant le combat.
   *
   * `null` tant qu'il n'est pas annonce, ou si son heros est encore inconnu
   * (premiere rencontre du lobby).
   */
  nextOpponentHero: string | null;
}

/** Combat commence, dont on attend l'issue. */
interface PendingCombat {
  turn: number;
  opponentHero: string | null;
  opponentEntityId: number | null;
  /** Plateau adverse fige a la premiere attaque. `null` avant. */
  board: BoardMinion[] | null;
  armorBefore: number;
  damageBefore: number;
}

export function emptyState(): LiveState {
  return {
    session: null,
    inGame: false,
    turn: null,
    phase: null,
    heroCardId: null,
    tavernTier: null,
    gold: null,
    health: null,
    place: null,
    board: [],
    opponents: [],
    combats: [],
    tierUps: [],
    nextOpponentHero: null,
  };
}

function numberTag(value: string | undefined): number | null {
  return value === undefined ? null : Number(value);
}

/**
 * Place au classement d'un heros adverse.
 *
 * L'entite designee pendant un combat est une copie de circonstance, qui ne
 * porte pas toujours `PLAYER_LEADERBOARD_PLACE`. La place se lit donc sur
 * l'entite du meme `cardId` qui la porte, celle du vrai joueur du lobby.
 */
function leaderboardPlace(game: Game, cardId: string): number | null {
  for (const entity of game.entities.values()) {
    if (entity.cardId !== cardId) continue;
    const place = entity.tags.get('PLAYER_LEADERBOARD_PLACE');
    if (place !== undefined) return Number(place);
  }
  return null;
}

/** PV restants d'un heros : l'armure encaisse avant les points de vie. */
function remainingHealth(tags: Map<string, string>): number | null {
  const health = numberTag(tags.get('HEALTH'));
  if (health === null) return null;
  return health - Number(tags.get('DAMAGE') ?? 0) + Number(tags.get('ARMOR') ?? 0);
}

/**
 * Suit la partie en cours et tient un etat pret a afficher.
 *
 * Alimenter avec `pushLine` au fil du suivi de `Power.log`, puis lire `state`.
 */
export class LiveTracker {
  readonly #machine: GameStateMachine;
  #state: LiveState = emptyState();

  /** Combat en cours : rempli entre le debut de la phase et son issue. */
  #combat: PendingCombat | null = null;

  /** Entite heros du mandataire hors combat, c'est-a-dire Bob. */
  #bobEntityId: number | null = null;

  /**
   * Heros de chaque joueur du lobby, par `PLAYER_ID`.
   *
   * Les entites heros portent ce tag, et `NEXT_OPPONENT_PLAYER_ID` s'y refere :
   * c'est ce qui permet de nommer le prochain adversaire avant le combat.
   */
  readonly #heroByPlayerId = new Map<string, string>();

  /** Dernier `NEXT_OPPONENT_PLAYER_ID` annonce, en attente de resolution. */
  #nextOpponentPlayerId: string | null = null;

  constructor() {
    this.#machine = new GameStateMachine({
      onGameStart: () => {
        const session = this.#state.session;
        this.#state = { ...emptyState(), session, inGame: true };
        this.#combat = null;
        this.#bobEntityId = null;
        this.#heroByPlayerId.clear();
        this.#nextOpponentPlayerId = null;
      },
      onGameEnd: (game) => {
        // Le dernier combat n'a pas de fin de phase quand le joueur est
        // elimine : on le cloture ici, sinon il manquerait a l'historique.
        if (this.#combat !== null) this.#endCombat(game);
        this.#state = { ...this.#state, inGame: false, phase: null };
      },
    });
  }

  get state(): LiveState {
    return this.#state;
  }

  /** Change de session suivie : remet l'etat a zero. */
  setSession(session: string): void {
    this.#state = { ...emptyState(), session };
    this.#combat = null;
  }

  /** Alimente le suivi avec une ligne brute de `Power.log`. */
  pushLine(line: string): void {
    const event = parseLine(line);
    if (event !== null) this.apply(event);
  }

  apply(event: LogEvent): void {
    this.#machine.apply(event);

    const game = this.#machine.current;
    if (game === null || event.type !== 'tagChange') return;

    const id = this.#machine.resolve(event.entity);
    if (id === null) return;

    if (id === game.gameEntityId) {
      if (event.tag === 'TURN') this.#state = { ...this.#state, turn: gameTurn(Number(event.value)) };
      if (event.tag === 'BACON_IN_COMBAT_PHASE') {
        if (event.value === '1') this.#startCombat(game);
        else this.#endCombat(game);
      }
      return;
    }

    if (id === game.localPlayerEntityId && event.tag === 'RESOURCES') {
      this.#state = { ...this.#state, gold: Number(event.value) };
      return;
    }

    if (id === game.proxyPlayerEntityId && event.tag === 'HERO_ENTITY') {
      this.#observeProxyHero(Number(event.value), game);
      return;
    }

    // Montee de taverne : on garde le tour de chacune, pour comparer le rythme
    // de cette partie a celui des parties reussies.
    if (event.tag === 'PLAYER_TECH_LEVEL' && id === game.heroEntityId) {
      const tier = Number(event.value);
      const dernier = this.#state.tierUps.at(-1)?.tier ?? 1;
      if (tier > dernier && this.#state.turn !== null) {
        this.#state = {
          ...this.#state,
          tierUps: [...this.#state.tierUps, { tier, turn: this.#state.turn }],
        };
      }
    }

    // Les entites heros portent le PLAYER_ID de leur joueur : on s'en sert pour
    // traduire l'annonce du prochain adversaire en heros.
    if (event.tag === 'PLAYER_ID') {
      const entity = game.entities.get(id);
      if (entity !== undefined && entity.cardId.length > 0) {
        this.#heroByPlayerId.set(event.value, entity.cardId);
        this.#resolveNextOpponent(game);
      }
    }

    if (event.tag === 'NEXT_OPPONENT_PLAYER_ID' && id === game.heroEntityId) {
      this.#nextOpponentPlayerId = event.value;
      this.#resolveNextOpponent(game);
      return;
    }

    // Le plateau et les jauges du joueur changent sans arret : on les relit
    // plutot que de suivre chaque tag un par un.
    if (id === game.heroEntityId) this.#refreshHero(game);

    // Pendant un combat, le plateau adverse se remplit au fil de la phase. On
    // le fige a la premiere attaque : les effets de debut de combat ont alors
    // eu lieu, et c'est ce plateau-la qui se bat.
    if (event.tag === 'ATTACKING' && event.value === '1' && this.#combat?.board === null) {
      this.#combat.board = readBoard(game, game.proxyPlayerEntityId);
    }
  }

  /**
   * Traduit l'annonce du prochain adversaire en heros.
   *
   * L'annonce peut precéder la connaissance du heros : le lobby n'est decouvert
   * qu'au fil des combats. On reessaie donc a chaque nouveau `PLAYER_ID`.
   */
  #resolveNextOpponent(game: Game): void {
    const playerId = this.#nextOpponentPlayerId;
    if (playerId === null) return;

    const hero = this.#heroByPlayerId.get(playerId) ?? null;
    // Ne jamais se designer soi-meme : le tag peut porter notre propre id
    // entre deux combats.
    const own = game.heroEntityId === null ? undefined : game.entities.get(game.heroEntityId);
    const nextOpponentHero = hero === own?.cardId ? null : hero;

    if (nextOpponentHero !== this.#state.nextOpponentHero) {
      this.#state = { ...this.#state, nextOpponentHero };
    }
  }

  #refreshHero(game: Game): void {
    const hero = game.heroEntityId === null ? undefined : game.entities.get(game.heroEntityId);
    if (hero === undefined) return;

    this.#state = {
      ...this.#state,
      heroCardId: hero.cardId,
      tavernTier: numberTag(hero.tags.get('PLAYER_TECH_LEVEL')),
      health: remainingHealth(hero.tags),
      place: numberTag(hero.tags.get('PLAYER_LEADERBOARD_PLACE')),
      board: readBoard(game, game.localPlayerEntityId),
    };
  }

  /**
   * Le mandataire change de heros : Bob hors combat, l'adversaire pendant.
   * La premiere valeur vue hors combat donne donc Bob.
   */
  #observeProxyHero(heroEntityId: number, game: Game): void {
    if (this.#combat === null) {
      this.#bobEntityId = heroEntityId;
      return;
    }
    if (this.#combat.opponentHero !== null || heroEntityId === this.#bobEntityId) return;

    const cardId = game.entities.get(heroEntityId)?.cardId ?? '';
    if (cardId.length === 0) return;

    this.#combat.opponentHero = cardId;
    this.#combat.opponentEntityId = heroEntityId;
  }

  #startCombat(game: Game): void {
    const hero = game.heroEntityId === null ? undefined : game.entities.get(game.heroEntityId);
    this.#combat = {
      turn: this.#state.turn ?? 0,
      opponentHero: null,
      opponentEntityId: null,
      board: null,
      armorBefore: Number(hero?.tags.get('ARMOR') ?? 0),
      damageBefore: Number(hero?.tags.get('DAMAGE') ?? 0),
    };
    this.#state = { ...this.#state, phase: 'combat' };
  }

  #endCombat(game: Game): void {
    const combat = this.#combat;
    this.#combat = null;
    this.#state = { ...this.#state, phase: 'recruit' };
    if (combat === null) return;

    const hero = game.heroEntityId === null ? undefined : game.entities.get(game.heroEntityId);
    const armor = Number(hero?.tags.get('ARMOR') ?? 0);
    const damage = Number(hero?.tags.get('DAMAGE') ?? 0);
    const damageTaken = Math.max(combat.armorBefore - armor + (damage - combat.damageBefore), 0);

    const player =
      game.localPlayerEntityId === null ? undefined : game.entities.get(game.localPlayerEntityId);
    const won = player?.tags.get('BACON_WON_LAST_COMBAT') === '1';

    const combats = [
      ...this.#state.combats,
      {
        turn: combat.turn,
        opponentHero: combat.opponentHero,
        result: combat.opponentHero === null ? null : combatResult(won, damageTaken),
        damageTaken,
      },
    ];

    this.#state = { ...this.#state, combats, opponents: this.#rememberOpponent(game, combat) };
    this.#refreshHero(game);
  }

  /** Met a jour la fiche de l'adversaire affronte, ou la cree. */
  #rememberOpponent(game: Game, combat: PendingCombat): OpponentSnapshot[] {
    if (combat.opponentHero === null) return this.#state.opponents;

    const heroEntity =
      combat.opponentEntityId === null ? undefined : game.entities.get(combat.opponentEntityId);
    const proxy =
      game.proxyPlayerEntityId === null ? undefined : game.entities.get(game.proxyPlayerEntityId);

    const fiche: OpponentSnapshot = {
      heroCardId: combat.opponentHero,
      tier: numberTag(proxy?.tags.get('PLAYER_TECH_LEVEL')),
      health: heroEntity === undefined ? null : remainingHealth(heroEntity.tags),
      place:
        numberTag(heroEntity?.tags.get('PLAYER_LEADERBOARD_PLACE')) ??
        leaderboardPlace(game, combat.opponentHero),
      lastFoughtTurn: combat.turn,
      board: combat.board ?? [],
    };

    // Le plus recemment affronte en tete.
    return [fiche, ...this.#state.opponents.filter((o) => o.heroCardId !== fiche.heroCardId)];
  }
}
