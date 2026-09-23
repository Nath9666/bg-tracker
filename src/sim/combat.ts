/**
 * Estimation du prochain combat.
 *
 * Le simulateur de Firestone joue le combat quelques milliers de fois et compte
 * les issues. On ne lui donne que ce que le joueur a deja vu : son propre
 * plateau, et celui de son prochain adversaire **tel qu'il etait au dernier
 * affrontement**. C'est la meme limite que Hearthstone Deck Tracker, et c'est
 * la principale source d'erreur : entre-temps l'adversaire a acheté, vendu et
 * ameliore. D'ou `staleTurns`, qui dit a quel point l'estimation est vieille.
 */
import { simulateBattle } from '@firestone-hs/simulate-bgs-battle';
import { currentHealth, type BoardMinion } from '../types.js';
import type { SimCards } from './sim-cards.js';

/** Au-dela, la precision ne bouge plus d'un point : mesure a 98 ms. */
export const DEFAULT_SIMULATIONS = 1000;

export interface CombatSide {
  heroCardId: string | null;
  /** PV restants, armure comprise. */
  health: number | null;
  tavernTier: number | null;
  board: readonly BoardMinion[];
}

export interface CombatInput {
  turn: number;
  player: CombatSide;
  opponent: CombatSide;
  /** Tour ou le plateau adverse a ete vu. `null` si jamais affronte. */
  opponentBoardTurn: number | null;
}

export interface CombatOdds {
  winPercent: number;
  tiePercent: number;
  lossPercent: number;
  /** Part des combats ou l'adversaire meurt. */
  lethalDealtPercent: number;
  /** Part des combats ou le joueur meurt. */
  lethalTakenPercent: number;
  averageDamageDealt: number;
  averageDamageTaken: number;
  simulations: number;
  durationMs: number;
  /** Nombre de tours ecoules depuis que le plateau adverse a ete vu. */
  staleTurns: number | null;
}

export interface SimulateOptions {
  simulations?: number;
  /** Plafond de temps laisse au simulateur, en millisecondes. */
  maxDurationMs?: number;
}

/**
 * Traduit un serviteur vers le format du simulateur.
 *
 * Exporte pour etre testee directement : c'est ici qu'un mot-cle oublie
 * passerait inapercu, l'issue d'un combat etant trop bruitee pour le reveler.
 */
export function toBoardEntity(minion: BoardMinion, entityId: number): Record<string, unknown> {
  return {
    entityId,
    cardId: minion.cardId,
    attack: minion.atk ?? 0,
    // Le simulateur attend les PV **restants**, pas la vie maximale.
    health: currentHealth(minion) ?? 1,
    maxHealth: minion.health ?? 1,
    taunt: minion.keywords.taunt,
    divineShield: minion.keywords.divineShield,
    venomous: minion.keywords.venomous,
    poisonous: minion.keywords.poisonous,
    reborn: minion.keywords.reborn,
    windfury: minion.keywords.windfury || minion.keywords.megaWindfury,
    stealth: minion.keywords.stealth,
  };
}

function toBoard(side: CombatSide, firstEntityId: number): Record<string, unknown> {
  return {
    player: {
      cardId: side.heroCardId ?? '',
      hpLeft: side.health ?? 30,
      tavernTier: side.tavernTier ?? 1,
      // Les pouvoirs heroiques et les quetes ne sont pas encore extraits des
      // logs : un heros dont le pouvoir agit en combat sera sous-estime.
      heroPowers: [],
      questEntities: [],
    },
    board: side.board.map((minion, index) => toBoardEntity(minion, firstEntityId + index)),
  };
}

/**
 * Estime le prochain combat.
 *
 * Renvoie `null` quand il n'y a rien a simuler : les deux plateaux vides, ou
 * aucun plateau adverse connu.
 */
export function simulateCombat(
  sim: SimCards,
  input: CombatInput,
  options: SimulateOptions = {},
): CombatOdds | null {
  if (input.player.board.length === 0 && input.opponent.board.length === 0) return null;

  const simulations = options.simulations ?? DEFAULT_SIMULATIONS;
  const info = {
    playerBoard: toBoard(input.player, 1000),
    opponentBoard: toBoard(input.opponent, 2000),
    options: {
      numberOfSimulations: simulations,
      maxAcceptableDuration: options.maxDurationMs ?? 2000,
    },
    gameState: { currentTurn: input.turn, anomalies: [] },
  };

  const debut = Date.now();
  const iterator = simulateBattle(info as never, sim.cards, sim.cardsData);
  let step = iterator.next();
  while (step.done !== true) step = iterator.next();
  const result = step.value;

  return {
    winPercent: result.wonPercent,
    tiePercent: result.tiedPercent,
    lossPercent: result.lostPercent,
    lethalDealtPercent: result.wonLethalPercent,
    lethalTakenPercent: result.lostLethalPercent,
    averageDamageDealt: result.averageDamageWon,
    averageDamageTaken: result.averageDamageLost,
    simulations,
    durationMs: Date.now() - debut,
    staleTurns:
      input.opponentBoardTurn === null ? null : Math.max(0, input.turn - input.opponentBoardTurn),
  };
}
