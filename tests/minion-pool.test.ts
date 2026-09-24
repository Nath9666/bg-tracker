import { describe, expect, it } from 'vitest';
import {
  inLobby,
  loadPool,
  poolByTier,
  racesSeen,
  SANS_TYPE,
  type PoolMinion,
} from '../src/pool/minion-pool.js';
import { openDatabase } from '../src/db/database.js';
import { importCards } from '../src/cards/import-cards.js';
import { buildIndex } from '../src/cards/card-database.js';

function minion(over: Partial<PoolMinion> = {}): PoolMinion {
  return { cardId: 'X', name: 'X', techLevel: 1, races: [], ...over };
}

const POOL: PoolMinion[] = [
  minion({ cardId: 'm1', techLevel: 1, races: ['MURLOC'] }),
  minion({ cardId: 'm2', techLevel: 1, races: ['DRAGON'] }),
  minion({ cardId: 'm3', techLevel: 1, races: [] }),
  minion({ cardId: 'm4', techLevel: 2, races: ['MURLOC', 'PIRATE'] }),
  minion({ cardId: 'm5', techLevel: 2, races: ['ALL'] }),
];

describe('inLobby', () => {
  it('garde les serviteurs d’un type actif', () => {
    expect(inLobby(minion({ races: ['MURLOC'] }), new Set(['MURLOC']))).toBe(true);
    expect(inLobby(minion({ races: ['DRAGON'] }), new Set(['MURLOC']))).toBe(false);
  });

  it('garde toujours les serviteurs sans type', () => {
    // Ils sont dans toutes les parties, quels que soient les types tirés.
    expect(inLobby(minion({ races: [] }), new Set(['MURLOC']))).toBe(true);
  });

  it('garde toujours ceux de tous les types', () => {
    expect(inLobby(minion({ races: ['ALL'] }), new Set(['MURLOC']))).toBe(true);
  });

  it('suffit d’un type actif sur deux', () => {
    expect(inLobby(minion({ races: ['MURLOC', 'PIRATE'] }), new Set(['PIRATE']))).toBe(true);
  });
});

describe('poolByTier', () => {
  it('annonce tout le pool tant qu’aucun type n’est connu', () => {
    // C'est la verite en debut de partie : on n'a rien vu, tout est possible.
    const paliers = poolByTier(POOL, new Set());

    expect(paliers.map((p) => p.tier)).toEqual([1, 2]);
    expect(paliers[0]?.total).toBe(3);
    expect(paliers[1]?.total).toBe(2);
  });

  it('retire les types absents du lobby', () => {
    const paliers = poolByTier(POOL, new Set(['MURLOC']));

    // T1 : le murloc et le sans-type, pas le dragon.
    expect(paliers[0]?.total).toBe(2);
    // T2 : le murloc/pirate et celui de tous les types.
    expect(paliers[1]?.total).toBe(2);
  });

  it('ne compte qu’une fois un serviteur a deux types', () => {
    const paliers = poolByTier(POOL, new Set(['MURLOC', 'PIRATE']));
    const t2 = paliers.find((p) => p.tier === 2);

    expect(t2?.total).toBe(2);
    // Mais il apparait bien sous ses deux types dans la repartition.
    const murloc = t2?.byRace.find((r) => r.race === 'MURLOC')?.count;
    const pirate = t2?.byRace.find((r) => r.race === 'PIRATE')?.count;
    expect(murloc).toBe(1);
    expect(pirate).toBe(1);
  });

  it('range les sans-type sous leur propre etiquette', () => {
    const t1 = poolByTier(POOL, new Set())[0];
    expect(t1?.byRace.some((r) => r.race === SANS_TYPE)).toBe(true);
  });

  it('range les types du plus fourni au moins fourni', () => {
    const large: PoolMinion[] = [
      minion({ cardId: 'a', techLevel: 3, races: ['BEAST'] }),
      minion({ cardId: 'b', techLevel: 3, races: ['BEAST'] }),
      minion({ cardId: 'c', techLevel: 3, races: ['NAGA'] }),
    ];

    expect(poolByTier(large, new Set())[0]?.byRace.map((r) => r.race)).toEqual(['BEAST', 'NAGA']);
  });
});

describe('racesSeen', () => {
  it('deduit les types du lobby des serviteurs vus', () => {
    expect(racesSeen(['m1', 'm2'], POOL)).toEqual(new Set(['MURLOC', 'DRAGON']));
  });

  it('ne conclut rien d’un sans-type ni d’un tous-types', () => {
    // Ces serviteurs sont dans toutes les parties : les voir n'apprend rien.
    expect(racesSeen(['m3', 'm5'], POOL)).toEqual(new Set());
  });

  it('releve les deux types d’un serviteur qui en a deux', () => {
    expect(racesSeen(['m4'], POOL)).toEqual(new Set(['MURLOC', 'PIRATE']));
  });

  it('ignore une carte inconnue du pool', () => {
    expect(racesSeen(['inconnue'], POOL)).toEqual(new Set());
  });
});

describe('loadPool', () => {
  it('ne lit que les serviteurs du pool, avec leur palier', () => {
    const db = openDatabase(':memory:');
    importCards(
      db,
      buildIndex(
        [
          {
            id: 'p1',
            dbfId: 1,
            name: 'Murloc',
            type: 'MINION',
            techLevel: 2,
            races: ['MURLOC'],
            isBattlegroundsPoolMinion: true,
          },
          // Hors pool : un jeton d'invocation a un palier, mais jamais achetable.
          { id: 'j1', dbfId: 3, name: 'Jeton', type: 'MINION', techLevel: 2, races: [] },
          { id: 'h1', dbfId: 2, name: 'Héros', type: 'HERO', battlegroundsHero: true },
        ],
        [],
      ),
    );

    const pool = loadPool(db);
    expect(pool).toEqual([{ cardId: 'p1', name: 'Murloc', techLevel: 2, races: ['MURLOC'] }]);
  });
});
