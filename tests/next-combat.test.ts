import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { nextCombatOdds, oddsSignature } from '../src/sim/next-combat.js';
import { loadSimCards, SIM_CARDS_PATH, type SimCards } from '../src/sim/sim-cards.js';
import { emptyState, type LiveState, type OpponentSnapshot } from '../src/live/live-tracker.js';
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

function opponent(over: Partial<OpponentSnapshot> = {}): OpponentSnapshot {
  return {
    heroCardId: 'BG26_HERO_104',
    tier: 4,
    health: 25,
    place: 3,
    lastFoughtTurn: 8,
    board: [minion()],
    ...over,
  };
}

/** Un etat en recrutement, prochain adversaire connu et deja affronte. */
function state(over: Partial<LiveState> = {}): LiveState {
  return {
    ...emptyState(),
    inGame: true,
    turn: 10,
    phase: 'recruit',
    heroCardId: 'BG22_HERO_000',
    tavernTier: 4,
    health: 30,
    board: [minion()],
    opponents: [opponent()],
    nextOpponentHero: 'BG26_HERO_104',
    ...over,
  };
}

describe.skipIf(!moteurDisponible)('nextCombatOdds', () => {
  beforeAll(async () => {
    sim = await loadSimCards();
  }, 60_000);

  it('estime le combat quand tout est connu', () => {
    const resultat = nextCombatOdds(sim, state(), { simulations: 300 });

    expect(resultat.kind).toBe('odds');
    if (resultat.kind !== 'odds') return;
    expect(resultat.opponentHero).toBe('BG26_HERO_104');
    expect(resultat.odds.staleTurns).toBe(2);
  });

  it('se tait hors partie', () => {
    const resultat = nextCombatOdds(sim, state({ inGame: false }), { simulations: 300 });
    expect(resultat).toEqual({ kind: 'none', reason: 'notInGame' });
  });

  it('se tait pendant le combat, dont l’issue arrive de toute facon', () => {
    const resultat = nextCombatOdds(sim, state({ phase: 'combat' }), { simulations: 300 });
    expect(resultat).toEqual({ kind: 'none', reason: 'inCombat' });
  });

  it('se tait tant que le prochain adversaire n’est pas annonce', () => {
    const resultat = nextCombatOdds(sim, state({ nextOpponentHero: null }), { simulations: 300 });
    expect(resultat).toEqual({ kind: 'none', reason: 'noNextOpponent' });
  });

  it('se tait sur un adversaire jamais affronte', () => {
    // Regle de l'overlay : ne montrer que ce que le joueur a deja vu.
    const jamaisVu = nextCombatOdds(sim, state({ opponents: [] }), { simulations: 300 });
    expect(jamaisVu).toEqual({ kind: 'none', reason: 'opponentNeverFought' });

    const connuDeNom = nextCombatOdds(
      sim,
      state({ opponents: [opponent({ lastFoughtTurn: null, board: [] })] }),
      { simulations: 300 },
    );
    expect(connuDeNom).toEqual({ kind: 'none', reason: 'opponentNeverFought' });
  });

  it('se tait quand les deux plateaux sont vides', () => {
    const resultat = nextCombatOdds(
      sim,
      state({ board: [], opponents: [opponent({ board: [] })] }),
      { simulations: 300 },
    );
    expect(resultat).toEqual({ kind: 'none', reason: 'nothingToSimulate' });
  });
});

describe('oddsSignature', () => {
  it('ne bouge pas tant que rien n’a change', () => {
    expect(oddsSignature(state())).toBe(oddsSignature(state()));
  });

  it('change quand le plateau du joueur change', () => {
    const avant = oddsSignature(state());

    expect(oddsSignature(state({ board: [minion({ atk: 4 })] }))).not.toBe(avant);
    expect(oddsSignature(state({ board: [minion(), minion({ position: 2 })] }))).not.toBe(avant);
  });

  it('change quand un serviteur est blesse', () => {
    // Les PV restants comptent : un plateau amoche ne vaut pas le meme combat.
    expect(oddsSignature(state({ board: [minion({ damage: 2 })] }))).not.toBe(
      oddsSignature(state()),
    );
  });

  it('change quand l’adversaire ou son plateau change', () => {
    const avant = oddsSignature(state());

    expect(oddsSignature(state({ nextOpponentHero: 'BG22_HERO_002' }))).not.toBe(avant);
    expect(
      oddsSignature(state({ opponents: [opponent({ board: [minion({ atk: 9 })] })] })),
    ).not.toBe(avant);
  });

  it('change au tour suivant et au passage en combat', () => {
    const avant = oddsSignature(state());

    expect(oddsSignature(state({ turn: 11 }))).not.toBe(avant);
    expect(oddsSignature(state({ phase: 'combat' }))).not.toBe(avant);
  });
});
