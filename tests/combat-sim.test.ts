import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { simulateCombat, toBoardEntity, type CombatSide } from '../src/sim/combat.js';
import { loadSimCards, SIM_CARDS_PATH, type SimCards } from '../src/sim/sim-cards.js';
import { emptyKeywords, type BoardMinion } from '../src/types.js';

/**
 * Le moteur a besoin de la base de cartes de Firestone, 42 Mo mis en cache
 * dans `data/`. On ne la telecharge pas depuis les tests : sur un depot frais,
 * `npm test` ne doit pas dependre du reseau. Ces tests-la sont donc sautes
 * tant que `npm run sim-cards` n'a pas ete lance ; la traduction, elle, est
 * testee dans tous les cas.
 */
const moteurDisponible = existsSync(SIM_CARDS_PATH);
let sim: SimCards;

function minion(over: Partial<BoardMinion> = {}): BoardMinion {
  return {
    position: 1,
    // Carte inconnue du simulateur : aucun effet propre, donc ces tests
    // portent sur les mecanismes et non sur le texte d'une carte reelle.
    cardId: 'TEST_VANILLA',
    atk: 3,
    health: 3,
    damage: 0,
    golden: false,
    keywords: emptyKeywords(),
    ...over,
  };
}

function side(board: BoardMinion[], over: Partial<CombatSide> = {}): CombatSide {
  return { heroCardId: 'TB_BaconShop_HERO_08', health: 30, tavernTier: 4, board, ...over };
}

function odds(player: BoardMinion[], opponent: BoardMinion[], turn = 10) {
  return simulateCombat(
    sim,
    { turn, player: side(player), opponent: side(opponent), opponentBoardTurn: turn - 2 },
    { simulations: 600 },
  );
}

describe.skipIf(!moteurDisponible)('simulateCombat', () => {
  beforeAll(async () => {
    sim = await loadSimCards();
  }, 60_000);

  it('donne la victoire quasi certaine a un plateau ecrasant', () => {
    const resultat = odds(
      [minion({ position: 1, atk: 20, health: 20 }), minion({ position: 2, atk: 20, health: 20 })],
      [minion({ position: 1, atk: 1, health: 1 })],
    );

    expect(resultat).not.toBeNull();
    expect(resultat!.winPercent).toBeGreaterThan(95);
    expect(resultat!.lossPercent).toBeLessThan(5);
  });

  it('donne la defaite quasi certaine au plateau inverse', () => {
    const resultat = odds(
      [minion({ position: 1, atk: 1, health: 1 })],
      [minion({ position: 1, atk: 20, health: 20 }), minion({ position: 2, atk: 20, health: 20 })],
    );

    expect(resultat!.lossPercent).toBeGreaterThan(95);
    expect(resultat!.winPercent).toBeLessThan(5);
  });

  it('annonce le nul quand les deux plateaux sont vides de menace', () => {
    const resultat = odds([minion({ atk: 0, health: 5 })], [minion({ atk: 0, health: 5 })]);

    expect(resultat!.tiePercent).toBeGreaterThan(95);
  });

  it('compte le letal quand l’adversaire est a bout de PV', () => {
    const resultat = simulateCombat(
      sim,
      {
        turn: 12,
        player: side([minion({ atk: 30, health: 30 })]),
        opponent: side([], { health: 3 }),
        opponentBoardTurn: 11,
      },
      { simulations: 400 },
    );

    expect(resultat!.lethalDealtPercent).toBeGreaterThan(95);
    expect(resultat!.lethalTakenPercent).toBe(0);
  });

  it('rend des pourcentages qui totalisent 100', () => {
    const resultat = odds([minion({ atk: 5, health: 5 })], [minion({ atk: 4, health: 6 })]);
    const total = resultat!.winPercent + resultat!.tiePercent + resultat!.lossPercent;

    expect(total).toBeCloseTo(100, 0);
  });

  it('tient compte du Bouclier divin', () => {
    const nu = odds([minion({ atk: 3, health: 3 })], [minion({ atk: 3, health: 3 })]);
    const protege = odds(
      [minion({ atk: 3, health: 3, keywords: { ...emptyKeywords(), divineShield: true } })],
      [minion({ atk: 3, health: 3 })],
    );

    // Sans bouclier les deux serviteurs s'entretuent ; avec, le joueur survit.
    expect(nu!.tiePercent).toBeGreaterThan(90);
    expect(protege!.winPercent).toBeGreaterThan(90);
  });

  it('tient compte du Venimeux, qui tue n’importe quoi', () => {
    const resultat = odds(
      [minion({ atk: 1, health: 5, keywords: { ...emptyKeywords(), venomous: true } })],
      [minion({ atk: 1, health: 50 })],
    );

    // Sans venin, un 1/5 ne viendrait jamais a bout d'un 1/50.
    expect(resultat!.winPercent).toBeGreaterThan(50);
  });

  it('lit les PV restants, pas la vie maximale', () => {
    // 5/10 contre 5/6 : le joueur encaisse 5, survit a 5 PV et gagne.
    // Le meme serviteur deja blesse de 6 n'a plus que 4 PV : il meurt au
    // premier echange et la partie bascule.
    // Les deux serviteurs se frappent simultanement. 5/10 contre 5/6 : chacun
    // encaisse 5 par echange, les deux tombent au second -> nul.
    // Le meme serviteur deja blesse de 6 n'a plus que 4 PV : il meurt au
    // premier echange et laisse un 5/1 debout en face -> defaite.
    const intact = odds([minion({ atk: 5, health: 10 })], [minion({ atk: 5, health: 6 })]);
    const blesse = odds(
      [minion({ atk: 5, health: 10, damage: 6 })],
      [minion({ atk: 5, health: 6 })],
    );

    expect(intact!.tiePercent).toBeGreaterThan(90);
    expect(blesse!.lossPercent).toBeGreaterThan(90);
  });

  it('compte les tours ecoules depuis que le plateau adverse a ete vu', () => {
    const resultat = odds([minion()], [minion()], 14);
    expect(resultat!.staleTurns).toBe(2);
  });

  it('renonce quand les deux plateaux sont vides', () => {
    expect(odds([], [])).toBeNull();
  });
});

describe('toBoardEntity', () => {
  it('transmet chaque mot-cle au simulateur', () => {
    const traduit = toBoardEntity(
      minion({
        keywords: {
          divineShield: true,
          taunt: true,
          venomous: true,
          poisonous: true,
          reborn: true,
          windfury: true,
          megaWindfury: false,
          stealth: true,
        },
      }),
      7,
    );

    expect(traduit).toMatchObject({
      entityId: 7,
      divineShield: true,
      taunt: true,
      venomous: true,
      poisonous: true,
      reborn: true,
      windfury: true,
      stealth: true,
    });
  });

  it('laisse a faux les mots-cles absents', () => {
    const traduit = toBoardEntity(minion(), 1);

    expect(traduit).toMatchObject({
      divineShield: false,
      taunt: false,
      venomous: false,
      poisonous: false,
      reborn: false,
      windfury: false,
      stealth: false,
    });
  });

  it('traite le Vent de furie ameliore comme un Vent de furie', () => {
    const mega = minion({ keywords: { ...emptyKeywords(), megaWindfury: true } });

    expect(toBoardEntity(mega, 1)).toMatchObject({ windfury: true });
  });

  it('envoie les PV restants et garde la vie maximale a part', () => {
    const blesse = minion({ atk: 4, health: 10, damage: 6 });

    expect(toBoardEntity(blesse, 1)).toMatchObject({ attack: 4, health: 4, maxHealth: 10 });
  });
});
