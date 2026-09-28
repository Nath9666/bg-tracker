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
  /** Aucun combat encore joue, ou plateau adverse pas encore revele. */
  | 'boardsNotRevealed'
  | 'nothingToSimulate';

export type CombatEstimate =
  | { kind: 'odds'; odds: CombatOdds; opponentHero: string | null; turn: number }
  | { kind: 'none'; reason: NoOddsReason };

/** Estime le combat en cours. */
export function combatOdds(
  sim: SimCards,
  state: LiveState,
  options: SimulateOptions = {},
): CombatEstimate {
  if (!state.inGame) return { kind: 'none', reason: 'notInGame' };

  // Pas de condition sur la phase : le dernier combat reste estimable pendant
  // le recrutement qui suit, sinon l'affichage ne durerait que le combat.
  const combat = state.currentCombat;
  if (combat === null) return { kind: 'none', reason: 'boardsNotRevealed' };

  const opposant = state.opponents.find((o) => o.heroCardId === combat.opponentHero);

  const odds = simulateCombat(
    sim,
    {
      turn: combat.turn,
      // Tout vient du debut du combat, fige par le tracker : jamais l'etat
      // courant, qui peut deja porter les degats de ce combat.
      player: {
        heroCardId: state.heroCardId,
        health: combat.playerHealth,
        tavernTier: combat.playerTavernTier,
        board: combat.playerBoard,
      },
      opponent: {
        heroCardId: combat.opponentHero,
        // Ceux du dernier affrontement. Pas ceux du heros en combat : c'est
        // une copie dont les PV ne sont pas les vrais (verifie le 28/09/2026 :
        // 2 a 8 PV lus quand il lui en restait 30 a 45). Perimes, ils ne
        // peuvent que sous-estimer le letal inflige, jamais l'inventer.
        health: opposant?.health ?? null,
        tavernTier: opposant?.tier ?? null,
        board: combat.opponentBoard,
      },
      // Les deux plateaux viennent du combat en cours : rien de perime.
      opponentBoardTurn: combat.turn,
      // Le plafond en vigueur au debut de ce combat, tel que le jeu l'annonce.
      damageCap: combat.damageCap,
    },
    options,
  );

  if (odds === null) return { kind: 'none', reason: 'nothingToSimulate' };
  return { kind: 'odds', odds, opponentHero: combat.opponentHero, turn: combat.turn };
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

  const minion = (m: {
    cardId: string;
    atk: number | null;
    health: number | null;
    damage: number;
  }): string => `${m.cardId}/${m.atk ?? '-'}/${(m.health ?? 0) - m.damage}`;

  return [
    combat.turn,
    combat.opponentHero ?? '-',
    combat.playerBoard.map(minion).join(','),
    combat.opponentBoard.map(minion).join(','),
  ].join('|');
}
