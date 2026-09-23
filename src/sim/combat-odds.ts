/**
 * Estimation du combat en cours.
 *
 * L'estimation se fait **au moment ou le combat commence**, sur le vrai
 * plateau d'en face, et non sur le souvenir d'un affrontement precedent. C'est
 * le seul instant ou les deux plateaux sont connus exactement : avant, le
 * plateau adverse n'existe pas ; apres, il se vide.
 *
 * Ce que ca coute : l'estimation arrive quand il est trop tard pour changer
 * d'avis. Ce que ca rapporte : elle est juste. Un pourcentage calcule sur un
 * plateau vieux de trois tours ne vaut pas grand-chose, l'adversaire ayant
 * acheté, vendu et ameliore entre-temps.
 */
import { simulateCombat, type CombatOdds, type SimulateOptions } from './combat.js';
import type { SimCards } from './sim-cards.js';
import type { LiveState } from '../live/live-tracker.js';

/** Pourquoi il n'y a rien a afficher. */
export type NoOddsReason =
  | 'notInGame'
  | 'notInCombat'
  /** Le combat vient de commencer, le plateau adverse n'est pas encore revele. */
  | 'boardsNotRevealed'
  | 'nothingToSimulate';

export type CombatEstimate =
  | { kind: 'odds'; odds: CombatOdds; opponentHero: string | null }
  | { kind: 'none'; reason: NoOddsReason };

/** Estime le combat en cours. */
export function combatOdds(
  sim: SimCards,
  state: LiveState,
  options: SimulateOptions = {},
): CombatEstimate {
  if (!state.inGame) return { kind: 'none', reason: 'notInGame' };
  if (state.phase !== 'combat') return { kind: 'none', reason: 'notInCombat' };

  const combat = state.currentCombat;
  if (combat === null) return { kind: 'none', reason: 'boardsNotRevealed' };

  const opposant = state.opponents.find((o) => o.heroCardId === combat.opponentHero);

  const odds = simulateCombat(
    sim,
    {
      turn: combat.turn,
      player: {
        heroCardId: state.heroCardId,
        health: state.health,
        tavernTier: state.tavernTier,
        board: combat.playerBoard,
      },
      opponent: {
        heroCardId: combat.opponentHero,
        // Les PV adverses ne sont connus que s'il a deja ete affronte. A
        // defaut, le letal inflige sera sous-estime, jamais surestime.
        health: opposant?.health ?? null,
        tavernTier: opposant?.tier ?? null,
        board: combat.opponentBoard,
      },
      // Les deux plateaux viennent du combat en cours : rien de perime.
      opponentBoardTurn: combat.turn,
    },
    options,
  );

  if (odds === null) return { kind: 'none', reason: 'nothingToSimulate' };
  return { kind: 'odds', odds, opponentHero: combat.opponentHero };
}

/**
 * Signature de ce qui change le resultat.
 *
 * Les deux plateaux sont figes pour toute la duree du combat : la signature ne
 * bouge donc qu'au combat suivant, et les 1000 simulations ne tournent qu'une
 * fois par combat.
 */
export function oddsSignature(state: LiveState): string {
  const combat = state.currentCombat;
  if (combat === null) return `${state.phase ?? '-'}|aucun`;

  const minion = (m: { cardId: string; atk: number | null; health: number | null; damage: number }): string =>
    `${m.cardId}/${m.atk ?? '-'}/${(m.health ?? 0) - m.damage}`;

  return [
    combat.turn,
    combat.opponentHero ?? '-',
    combat.playerBoard.map(minion).join(','),
    combat.opponentBoard.map(minion).join(','),
  ].join('|');
}
