import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../src/db/database.js';
import { importGames } from '../src/db/import.js';
import { importCards } from '../src/cards/import-cards.js';
import { buildIndex } from '../src/cards/card-database.js';
import { createHeroBaseResolver, stripSkinSuffix } from '../src/db/hero-base.js';
import { parseStatsArgs } from '../src/cli/stats.js';
import {
  finalBoardRaces,
  heroPickCard,
  heroStats,
  overview,
  placeDistribution,
  playedHeroes,
  tierCurve,
  timeline,
} from '../src/stats/stats.js';
import { emptyKeywords } from '../src/types.js';
import type { GameSummary } from '../src/types.js';

// Cartes reelles. Vol'jin est le cas qui piege : son heros de base est
// BG20_HERO_201, que le retrait du suffixe ne donne pas.
const CARDS = buildIndex(
  [
    { id: 'BG22_HERO_000', dbfId: 77987, name: 'Tavish Foudrepique', type: 'HERO', battlegroundsHero: true },
    { id: 'BG22_HERO_000_SKIN_A', dbfId: 98808, name: 'Maître-éclaireur Tavish', type: 'HERO', battlegroundsSkinParentId: 77987 },
    { id: 'BG20_HERO_201', dbfId: 71463, name: 'Vol’jin', type: 'HERO', battlegroundsHero: true },
    { id: 'TB_BaconShop_HERO_201_SKIN_D', dbfId: 96572, name: 'Vol’aileron', type: 'HERO', battlegroundsSkinParentId: 71463 },
    { id: 'BG26_HERO_104', dbfId: 90000, name: 'Cariel Roame', type: 'HERO', battlegroundsHero: true },
    { id: 'BG36_760', dbfId: 133075, name: 'Capitaine Macaron', type: 'MINION', techLevel: 4, races: ['MURLOC', 'PIRATE'] },
    { id: 'BG28_300', dbfId: 104551, name: 'Liche inoffensive', type: 'MINION', techLevel: 1, races: ['UNDEAD'] },
    { id: 'BG35_143', dbfId: 120677, name: 'Sans type', type: 'MINION', techLevel: 2 },
  ],
  [],
);

function game(over: Partial<GameSummary> = {}): GameSummary {
  return {
    startedAt: '2026-09-20T01:00:00.000+02:00',
    endedAt: '2026-09-20T01:25:00.000+02:00',
    buildNumber: 251952,
    gameType: 'GT_BATTLEGROUNDS',
    playerName: 'AkiLif#2498',
    heroOffered: [],
    heroChosen: 'BG26_HERO_104',
    heroSkinParentDbfId: null,
    finalPlace: 4,
    finalTurn: 12,
    tierUps: [],
    turns: [],
    decisions: [],
    picks: [],
    opponents: [],
    gameSeed: '1',
    ...over,
  };
}

function seeded(games: GameSummary[]): Db {
  const db = openDatabase(':memory:');
  importCards(db, CARDS);
  importGames(db, games, 'test');
  return db;
}

describe('overview', () => {
  it('resume les parties retenues', () => {
    const db = seeded([
      game({ gameSeed: '1', finalPlace: 1 }),
      game({ gameSeed: '2', finalPlace: 4 }),
      game({ gameSeed: '3', finalPlace: 7 }),
    ]);

    expect(overview(db)).toMatchObject({
      games: 3,
      averagePlace: 4,
      top4Rate: 2 / 3,
      wins: 1,
    });
  });

  it('ecarte les parties inachevees, dont la place n’est pas un resultat', () => {
    const db = seeded([
      game({ gameSeed: '1', finalPlace: 1 }),
      game({ gameSeed: '2', finalPlace: 8, endedAt: null }),
    ]);

    expect(overview(db).games).toBe(1);
    expect(overview(db, { includeIncomplete: true }).games).toBe(2);
  });

  it('rend la derniere cote saisie', () => {
    const db = seeded([
      game({ gameSeed: '1', startedAt: '2026-09-20T01:00:00.000+02:00' }),
      game({ gameSeed: '2', startedAt: '2026-09-21T01:00:00.000+02:00' }),
    ]);
    db.prepare('UPDATE games SET rating_after = 8000 WHERE game_seed = ?').run('1');
    db.prepare('UPDATE games SET rating_after = 8412 WHERE game_seed = ?').run('2');

    expect(overview(db).latestRating).toBe(8412);
  });

  it('ne compte rien quand aucune partie ne passe les filtres', () => {
    expect(overview(seeded([game()]), { heroBaseId: 'BG99_999' }).games).toBe(0);
  });
});

describe('filtres', () => {
  const db = seeded([
    game({ gameSeed: '1', startedAt: '2026-09-19T01:00:00.000+02:00', finalPlace: 1 }),
    game({ gameSeed: '2', startedAt: '2026-09-21T01:00:00.000+02:00', finalPlace: 8 }),
  ]);

  it('borne la periode, borne haute exclue', () => {
    expect(overview(db, { from: '2026-09-20' }).games).toBe(1);
    expect(overview(db, { to: '2026-09-20' }).games).toBe(1);
    expect(overview(db, { from: '2026-09-19', to: '2026-09-22' }).games).toBe(2);
  });

  it('filtre par heros', () => {
    expect(overview(db, { heroBaseId: 'BG26_HERO_104' }).games).toBe(2);
  });
});

describe('placeDistribution', () => {
  it('rend les huit places, meme vides', () => {
    const rows = placeDistribution(seeded([game({ finalPlace: 1 })]));

    expect(rows).toHaveLength(8);
    expect(rows[0]).toEqual({ place: 1, games: 1, share: 1 });
    expect(rows[1]).toEqual({ place: 2, games: 0, share: 0 });
  });

  it('rend des parts nulles sans partie', () => {
    expect(placeDistribution(seeded([])).every((row) => row.share === 0)).toBe(true);
  });
});

describe('heroStats', () => {
  it('compte les parties jouees et les propositions', () => {
    const db = seeded([
      game({ gameSeed: '1', heroChosen: 'BG26_HERO_104', heroOffered: ['BG26_HERO_104', 'BG22_HERO_000'] }),
      game({ gameSeed: '2', heroChosen: 'BG26_HERO_104', heroOffered: ['BG26_HERO_104'] }),
    ]);

    const rows = heroStats(db);
    const cariel = rows.find((row) => row.heroBaseId === 'BG26_HERO_104');
    expect(cariel).toMatchObject({ played: 2, offered: 2, pickRate: 1 });

    const tavish = rows.find((row) => row.heroBaseId === 'BG22_HERO_000');
    expect(tavish).toMatchObject({ played: 0, offered: 1, pickRate: 0 });
  });

  it('rattache un skin a son heros de base, des deux cotes', () => {
    // Le skin est propose puis joue : sans normalisation commune, le heros
    // apparaitrait joue une fois mais jamais propose.
    const db = seeded([
      game({
        heroChosen: 'TB_BaconShop_HERO_201_SKIN_D',
        heroSkinParentDbfId: 71463,
        heroOffered: ['TB_BaconShop_HERO_201_SKIN_D'],
      }),
    ]);

    const voljin = heroStats(db).find((row) => row.heroBaseId === 'BG20_HERO_201');
    expect(voljin).toMatchObject({ heroName: 'Vol’jin', played: 1, offered: 1, pickRate: 1 });
    expect(heroStats(db).some((row) => row.heroBaseId === 'TB_BaconShop_HERO_201')).toBe(false);
  });

  it('classe le plus joue en tete', () => {
    const db = seeded([
      game({ gameSeed: '1', heroChosen: 'BG26_HERO_104' }),
      game({ gameSeed: '2', heroChosen: 'BG26_HERO_104' }),
      game({ gameSeed: '3', heroChosen: 'BG22_HERO_000' }),
    ]);

    expect(heroStats(db)[0]?.heroBaseId).toBe('BG26_HERO_104');
  });
});

describe('tierCurve', () => {
  it('separe les parties de top 4 du reste', () => {
    const db = seeded([
      game({ gameSeed: '1', finalPlace: 2, tierUps: [{ tier: 2, turn: 2 }, { tier: 3, turn: 4 }] }),
      game({ gameSeed: '2', finalPlace: 7, tierUps: [{ tier: 2, turn: 4 }] }),
    ]);

    const rows = tierCurve(db);
    expect(rows.find((row) => row.tier === 2)).toMatchObject({
      top4Turn: 2,
      otherTurn: 4,
      top4Games: 1,
      otherGames: 1,
    });
    expect(rows.find((row) => row.tier === 3)).toMatchObject({ top4Turn: 4, otherTurn: null });
  });
});

describe('finalBoardRaces', () => {
  function withBoard(seed: string, place: number, cards: string[]): GameSummary {
    return game({
      gameSeed: seed,
      finalPlace: place,
      turns: [
        {
          turn: 1,
          tavernTier: 1,
          gold: 3,
          health: 30,
          opponentHero: null,
          combatResult: 'win',
          damageTaken: 0,
          board: [
            {
              position: 1,
              cardId: 'BG28_300',
              atk: 1,
              health: 1,
              damage: 0,
              golden: false,
              keywords: emptyKeywords(),
            },
          ],
        },
        {
          turn: 2,
          tavernTier: 2,
          gold: 4,
          health: 30,
          opponentHero: null,
          combatResult: 'win',
          damageTaken: 0,
          board: cards.map((cardId, index) => ({
            position: index + 1,
            cardId,
            atk: 1,
            health: 1,
            damage: 0,
            keywords: emptyKeywords(),
            golden: false,
          })),
        },
      ],
    });
  }

  it('retient le type dominant du dernier plateau', () => {
    const db = seeded([withBoard('1', 2, ['BG28_300', 'BG28_300', 'BG36_760'])]);

    expect(finalBoardRaces(db)).toEqual([
      { race: 'UNDEAD', games: 1, averagePlace: 2, top4Rate: 1 },
    ]);
  });

  it('range sous « aucun » un plateau sans type', () => {
    const db = seeded([withBoard('1', 5, ['BG35_143'])]);
    expect(finalBoardRaces(db)[0]?.race).toBe('aucun');
  });

  it('regroupe les parties par type dominant', () => {
    const db = seeded([
      withBoard('1', 1, ['BG28_300']),
      withBoard('2', 5, ['BG28_300']),
      withBoard('3', 3, ['BG36_760']),
    ]);

    const rows = finalBoardRaces(db);
    expect(rows[0]).toMatchObject({ race: 'UNDEAD', games: 2, averagePlace: 3 });
  });
});

describe('timeline', () => {
  it('suit les parties dans l’ordre, avec une moyenne glissante', () => {
    const db = seeded([
      game({ gameSeed: '1', startedAt: '2026-09-19T01:00:00.000+02:00', finalPlace: 2 }),
      game({ gameSeed: '2', startedAt: '2026-09-20T01:00:00.000+02:00', finalPlace: 4 }),
    ]);

    const points = timeline(db);
    expect(points.map((point) => point.place)).toEqual([2, 4]);
    expect(points[0]?.rollingPlace).toBe(2);
    expect(points[1]?.rollingPlace).toBe(3);
  });

  it('limite la moyenne glissante a sa fenetre', () => {
    const db = seeded([
      game({ gameSeed: '1', startedAt: '2026-09-19T01:00:00.000+02:00', finalPlace: 8 }),
      game({ gameSeed: '2', startedAt: '2026-09-20T01:00:00.000+02:00', finalPlace: 2 }),
      game({ gameSeed: '3', startedAt: '2026-09-21T01:00:00.000+02:00', finalPlace: 4 }),
    ]);

    // Fenetre de 2 : la premiere partie sort du calcul.
    expect(timeline(db, {}, 2)[2]?.rollingPlace).toBe(3);
  });
});

describe('playedHeroes', () => {
  it('liste les heros joues, du plus frequent au moins frequent', () => {
    const db = seeded([
      game({ gameSeed: '1', heroChosen: 'BG26_HERO_104' }),
      game({ gameSeed: '2', heroChosen: 'BG26_HERO_104' }),
      game({ gameSeed: '3', heroChosen: 'BG22_HERO_000' }),
    ]);

    expect(playedHeroes(db).map((hero) => [hero.heroName, hero.games])).toEqual([
      ['Cariel Roame', 2],
      ['Tavish Foudrepique', 1],
    ]);
  });
});

describe('createHeroBaseResolver', () => {
  it('suit le parent de skin de la base de cartes', () => {
    const db = seeded([]);
    const resolve = createHeroBaseResolver(db);

    expect(resolve('TB_BaconShop_HERO_201_SKIN_D')).toBe('BG20_HERO_201');
    expect(resolve('BG22_HERO_000_SKIN_A')).toBe('BG22_HERO_000');
  });

  it('prefere le parent donne par le log', () => {
    expect(createHeroBaseResolver(seeded([]))('BG22_HERO_000_SKIN_A', 71463)).toBe('BG20_HERO_201');
  });

  it('laisse intact un heros sans skin', () => {
    expect(createHeroBaseResolver(seeded([]))('BG26_HERO_104')).toBe('BG26_HERO_104');
  });

  it('retombe sur le retrait du suffixe pour une carte inconnue', () => {
    expect(createHeroBaseResolver(seeded([]))('BG99_HERO_001_SKIN_Z')).toBe('BG99_HERO_001');
  });
});

describe('stripSkinSuffix', () => {
  it('retire le suffixe, sans garantie d’exactitude', () => {
    expect(stripSkinSuffix('BG22_HERO_000_SKIN_A')).toBe('BG22_HERO_000');
    expect(stripSkinSuffix('BG26_HERO_104')).toBe('BG26_HERO_104');
  });
});

describe('parseStatsArgs', () => {
  it('lit les filtres', () => {
    expect(parseStatsArgs(['--from', '2026-09-20', '--hero', 'BG22_HERO_000', '--incomplete'])).toEqual({
      db: 'data/bg-tracker.db',
      from: '2026-09-20',
      heroBaseId: 'BG22_HERO_000',
      includeIncomplete: true,
    });
  });

  it('refuse une option inconnue ou sans valeur', () => {
    expect(() => parseStatsArgs(['--from'])).toThrow(/Valeur manquante/);
    expect(() => parseStatsArgs(['--tout'])).toThrow(/Option inconnue/);
  });
});

describe('heroPickCard', () => {
  /** Une partie avec Cariel, dont le plateau final est fait de ces cartes. */
  function partie(seed: string, place: number, cards: string[], over: Partial<GameSummary> = {}): GameSummary {
    return game({
      gameSeed: seed,
      finalPlace: place,
      heroChosen: 'BG26_HERO_104',
      turns: [
        {
          turn: 8,
          tavernTier: 4,
          gold: 10,
          health: 20,
          opponentHero: null,
          combatResult: 'win',
          damageTaken: 0,
          board: cards.map((cardId, index) => ({
            position: index + 1,
            cardId,
            atk: 1,
            health: 1,
            damage: 0,
            golden: false,
            keywords: emptyKeywords(),
          })),
        },
      ],
      ...over,
    });
  }

  const UNDEAD = ['BG28_300', 'BG28_300'];
  const MURLOC_PIRATE = ['BG36_760', 'BG36_760'];

  it('reprend place moyenne, top 4 et taux de selection', () => {
    const db = seeded([
      partie('1', 2, UNDEAD, { heroOffered: ['BG26_HERO_104', 'BG20_HERO_201'] }),
      partie('2', 6, UNDEAD, { heroOffered: ['BG26_HERO_104'] }),
      // Proposee sans etre choisie : fait baisser le taux de selection.
      game({ gameSeed: '3', heroChosen: 'BG20_HERO_201', heroOffered: ['BG26_HERO_104', 'BG20_HERO_201'] }),
    ]);

    expect(heroPickCard(db, 'BG26_HERO_104')).toMatchObject({
      heroName: 'Cariel Roame',
      played: 2,
      averagePlace: 4,
      top4Rate: 0.5,
      pickRate: 2 / 3,
    });
  });

  it('retient le type qui a mene le plus loin, pas le plus frequent', () => {
    const db = seeded([
      partie('1', 7, UNDEAD),
      partie('2', 6, UNDEAD),
      partie('3', 1, MURLOC_PIRATE),
    ]);

    // Mort-vivant est joue deux fois, mais Murloc a donne la victoire.
    expect(heroPickCard(db, 'BG26_HERO_104').bestRace).toMatchObject({ race: 'MURLOC', averagePlace: 1 });
  });

  it('se limite aux types de la partie quand ils sont connus', () => {
    const db = seeded([partie('1', 6, UNDEAD), partie('2', 1, MURLOC_PIRATE)]);

    const carte = heroPickCard(db, 'BG26_HERO_104', new Set(['UNDEAD', 'BEAST']));
    // Murloc a fait mieux, mais il n'est pas dans la partie.
    expect(carte.bestRace?.race).toBe('UNDEAD');
    expect(carte.bestRaceInLobby).toBe(true);
  });

  it('montre le meilleur type tout court quand aucun ne sort dans la partie', () => {
    const db = seeded([partie('1', 1, MURLOC_PIRATE)]);

    const carte = heroPickCard(db, 'BG26_HERO_104', new Set(['BEAST']));
    expect(carte.bestRace?.race).toBe('MURLOC');
    expect(carte.bestRaceInLobby).toBe(false);
  });

  it('donne une fiche vide mais nommee pour un heros jamais joue', () => {
    const db = seeded([]);

    expect(heroPickCard(db, 'BG20_HERO_201')).toMatchObject({
      heroName: 'Vol’jin',
      played: 0,
      averagePlace: null,
      bestRace: null,
    });
  });
});
