/**
 * Estimation du combat a venir, a partir de l'etat en direct.
 *
 * Ne s'exprime que quand il y a vraiment de quoi : le jeu a annonce le
 * prochain adversaire, et le joueur l'a deja affronte au moins une fois. A la
 * premiere rencontre d'un adversaire, son plateau n'a jamais ete vu et il n'y
 * a rien a estimer -- c'est aussi la regle que s'impose l'overlay : ne montrer
 * que ce que le joueur a deja vu.
 */
import { simulateCombat, type CombatOdds, type SimulateOptions } from './combat.js';
import type { SimCards } from './sim-cards.js';
import type { LiveState } from '../live/live-tracker.js';

/** Pourquoi il n'y a pas d'estimation a afficher. */
export type NoOddsReason =
  | 'notInGame'
  | 'inCombat'
  | 'noNextOpponent'
  | 'opponentNeverFought'
  | 'nothingToSimulate';

export type NextCombatOdds =
  | { kind: 'odds'; odds: CombatOdds; opponentHero: string }
  | { kind: 'none'; reason: NoOddsReason };

/**
 * Estime le prochain combat.
 *
 * Pendant le combat lui-meme, on se tait : les deux plateaux sont en train de
 * changer et l'issue arrive de toute facon dans quelques secondes.
 */
export function nextCombatOdds(
  sim: SimCards,
  state: LiveState,
  options: SimulateOptions = {},
): NextCombatOdds {
  if (!state.inGame || state.turn === null) return { kind: 'none', reason: 'notInGame' };
  if (state.phase === 'combat') return { kind: 'none', reason: 'inCombat' };

  const hero = state.nextOpponentHero;
  if (hero === null) return { kind: 'none', reason: 'noNextOpponent' };

  const snapshot = state.opponents.find((opponent) => opponent.heroCardId === hero);
  if (snapshot === undefined || snapshot.lastFoughtTurn === null) {
    return { kind: 'none', reason: 'opponentNeverFought' };
  }

  const odds = simulateCombat(
    sim,
    {
      turn: state.turn,
      player: {
        heroCardId: state.heroCardId,
        health: state.health,
        tavernTier: state.tavernTier,
        board: state.board,
      },
      opponent: {
        heroCardId: snapshot.heroCardId,
        health: snapshot.health,
        tavernTier: snapshot.tier,
        board: snapshot.board,
      },
      opponentBoardTurn: snapshot.lastFoughtTurn,
    },
    options,
  );

  if (odds === null) return { kind: 'none', reason: 'nothingToSimulate' };
  return { kind: 'odds', odds, opponentHero: hero };
}

/**
 * Signature de ce qui change le resultat.
 *
 * L'overlay recoit un lot de lignes toutes les 700 ms ; relancer 1000
 * simulations a chaque fois serait du gaspillage. Tant que la signature ne
 * bouge pas, l'estimation precedente reste valable.
 */
export function oddsSignature(state: LiveState): string {
  const minion = (m: { cardId: string; atk: number | null; health: number | null; damage: number }): string =>
    `${m.cardId}/${m.atk ?? '-'}/${(m.health ?? 0) - m.damage}`;

  const hero = state.nextOpponentHero ?? '-';
  const snapshot = state.opponents.find((opponent) => opponent.heroCardId === hero);

  return [
    state.turn ?? '-',
    state.phase ?? '-',
    hero,
    state.board.map(minion).join(','),
    snapshot?.lastFoughtTurn ?? '-',
    (snapshot?.board ?? []).map(minion).join(','),
  ].join('|');
}
