import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { combatOdds, oddsSignature } from '../src/sim/combat-odds.js';
import { loadSimCards, SIM_CARDS_PATH, type SimCards } from '../src/sim/sim-cards.js';
import { emptyState, type CombatBoards, type LiveState } from '../src/live/live-tracker.js';
import { emptyKeywords, type BoardMinion } from '../src/types.js';

const moteurDisponible = existsSync(SIM_CARDS_PATH);
let sim: SimCards;

function minion(over: Partial<BoardMinion> = {}): BoardMinion {
  return {
    position: 1,
    cardId: 'TEST_VANILLA',
    atk: 3,
    health: 3,
    damage: 0,
    golden: false,
    keywords: emptyKeywords(),
    ...over,
  };
}

function combat(over: Partial<CombatBoards> = {}): CombatBoards {
  return {
    turn: 10,
    opponentHero: 'BG26_HERO_104',
    playerBoard: [minion()],
    opponentBoard: [minion()],
    ...over,
  };
}

/** Un etat en plein combat, les deux plateaux reveles. */
function state(over: Partial<LiveState> = {}): LiveState {
  return {
    ...emptyState(),
    inGame: true,
    turn: 10,
    phase: 'combat',
    heroCardId: 'BG22_HERO_000',
    tavernTier: 4,
    health: 30,
    currentCombat: combat(),
    ...over,
  };
}

describe.skipIf(!moteurDisponible)('combatOdds', () => {
  beforeAll(async () => {
    sim = await loadSimCards();
  }, 60_000);

  it('estime le combat en cours', () => {
    const resultat = combatOdds(sim, state(), { simulations: 300 });

    expect(resultat.kind).toBe('odds');
    if (resultat.kind !== 'odds') return;
    expect(resultat.opponentHero).toBe('BG26_HERO_104');
    // Les deux plateaux viennent du combat en cours : rien de perime.
    expect(resultat.odds.staleTurns).toBe(0);
  });

  it('lit les plateaux du combat, pas celui du recrutement', () => {
    // `state.board` suit le plateau en train de se battre et serait deja
    // entame : c'est `currentCombat` qui fait foi.
    const resultat = combatOdds(
      sim,
      state({
        board: [minion({ atk: 50, health: 50 })],
        currentCombat: combat({
          playerBoard: [minion({ atk: 1, health: 1 })],
          opponentBoard: [minion({ atk: 20, health: 20 })],
        }),
      }),
      { simulations: 300 },
    );

    if (resultat.kind !== 'odds') throw new Error('estimation attendue');
    expect(resultat.odds.lossPercent).toBeGreaterThan(95);
  });

  it('se tait hors partie', () => {
    expect(combatOdds(sim, state({ inGame: false }))).toEqual({
      kind: 'none',
      reason: 'notInGame',
    });
  });

  it('se tait pendant le recrutement', () => {
    // C'est le changement demande : plus d'estimation sur un plateau memorise.
    expect(combatOdds(sim, state({ phase: 'recruit' }))).toEqual({
      kind: 'none',
      reason: 'notInCombat',
    });
  });

  it('se tait tant que le plateau adverse n’est pas revele', () => {
    expect(combatOdds(sim, state({ currentCombat: null }))).toEqual({
      kind: 'none',
      reason: 'boardsNotRevealed',
    });
  });

  it('se tait quand les deux plateaux sont vides', () => {
    const vide = state({ currentCombat: combat({ playerBoard: [], opponentBoard: [] }) });

    expect(combatOdds(sim, vide)).toEqual({ kind: 'none', reason: 'nothingToSimulate' });
  });

  it('accepte un adversaire encore sans nom', () => {
    // Le heros du mandataire peut etre reconnu apres la premiere attaque.
    const resultat = combatOdds(sim, state({ currentCombat: combat({ opponentHero: null }) }), {
      simulations: 300,
    });

    expect(resultat.kind).toBe('odds');
  });
});

describe('oddsSignature', () => {
  it('ne bouge pas pendant toute la duree du combat', () => {
    // Les plateaux sont figes : une seule serie de simulations par combat,
    // meme si les serviteurs tombent a l'ecran.
    expect(oddsSignature(state())).toBe(oddsSignature(state({ board: [minion({ atk: 9 })] })));
    expect(oddsSignature(state())).toBe(oddsSignature(state({ health: 12 })));
  });

  it('change au combat suivant', () => {
    const avant = oddsSignature(state());

    expect(oddsSignature(state({ currentCombat: combat({ turn: 11 }) }))).not.toBe(avant);
    expect(
      oddsSignature(state({ currentCombat: combat({ opponentBoard: [minion({ atk: 9 })] }) })),
    ).not.toBe(avant);
    expect(
      oddsSignature(state({ currentCombat: combat({ opponentHero: 'BG22_HERO_002' }) })),
    ).not.toBe(avant);
  });

  it('distingue l’absence de combat', () => {
    expect(oddsSignature(state({ currentCombat: null }))).not.toBe(oddsSignature(state()));
  });
});
