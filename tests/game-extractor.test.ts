import { describe, expect, it } from 'vitest';
import { extractGames, gameTurn } from '../src/extract/game-extractor.js';
import { LogClock } from '../src/extract/log-clock.js';
import { readSessionLines } from '../src/reader/session-reader.js';
import type { GameSummary } from '../src/types.js';
import { sampleSessionFolder } from './helpers/sample-session.js';

/** Date de lancement du dossier `Hearthstone_2026_09_19_02_47_25`. */
const SESSION_DATE = new Date(2026, 8, 19, 2, 47, 25);

async function runLines(lines: string[], sessionDate = SESSION_DATE): Promise<GameSummary[]> {
  async function* stream(): AsyncGenerator<string> {
    for (const line of lines) yield line;
  }

  const games: GameSummary[] = [];
  for await (const summary of extractGames(stream(), { sessionDate })) games.push(summary);
  return games;
}

function power(body: string, time = '02:48:30.3211164'): string {
  return `D ${time} GameState.DebugPrintPower() - ${body}`;
}

function meta(body: string, time = '02:48:30.3211164'): string {
  return `D ${time} GameState.DebugPrintGame() - ${body}`;
}

function opening(gameType = 'GT_BATTLEGROUNDS'): string[] {
  return [
    power('CREATE_GAME'),
    power('    GameEntity EntityID=19'),
    power('        tag=GAME_SEED value=817997359'),
    power('    Player EntityID=20 PlayerID=7 GameAccountId=[hi=144115198130930503 lo=1025141059]'),
    power('    Player EntityID=21 PlayerID=15 GameAccountId=[hi=0 lo=0]'),
    meta('BuildNumber=251952'),
    meta(`GameType=${gameType}`),
    meta('PlayerID=7, PlayerName=AkiLif#2498'),
    power('TAG_CHANGE Entity=AkiLif#2498 tag=HERO_ENTITY value=89'),
    power('FULL_ENTITY - Creating ID=89 CardID=BG22_HERO_000_SKIN_A'),
  ];
}

const COMPLETE = power('TAG_CHANGE Entity=GameEntity tag=STATE value=COMPLETE', '03:13:48.9378732');

describe('gameTurn', () => {
  it('convertit le compteur TURN en tour de jeu', () => {
    // TURN avance a chaque phase : recrutement puis combat.
    expect(gameTurn(3)).toBe(2);
    expect(gameTurn(9)).toBe(5);
    expect(gameTurn(13)).toBe(7);
    expect(gameTurn(19)).toBe(10);
    expect(gameTurn(26)).toBe(13);
  });
});

describe('LogClock', () => {
  it('date une heure de log avec le jour de la session', () => {
    const clock = new LogClock(SESSION_DATE);
    expect(clock.toIso('02:48:30.3211164')).toMatch(/^2026-09-19T02:48:30\.321[+-]\d{2}:\d{2}$/);
  });

  it('passe au jour suivant quand l’heure recule', () => {
    const clock = new LogClock(new Date(2026, 8, 19, 23, 50, 0));

    expect(clock.toIso('23:55:00.0000000')).toContain('2026-09-19T23:55:00');
    expect(clock.toIso('00:05:00.0000000')).toContain('2026-09-20T00:05:00');
    expect(clock.toIso('00:06:00.0000000')).toContain('2026-09-20T00:06:00');
  });

  it('enchaine plusieurs minuits', () => {
    const clock = new LogClock(new Date(2026, 8, 19, 12, 0, 0));
    clock.toIso('23:00:00.0000000');
    expect(clock.toIso('01:00:00.0000000')).toContain('2026-09-20T01:00:00');
    clock.toIso('23:00:00.0000000');
    expect(clock.toIso('01:00:00.0000000')).toContain('2026-09-21T01:00:00');
  });

  it('ne change pas de jour sur un recul modere', () => {
    // Cas reel : deux fichiers d'une meme session se recouvrent, l'heure
    // repasse de 20:12 a 16:51. Ce n'est pas minuit, c'est une relecture.
    const clock = new LogClock(new Date(2026, 8, 22, 16, 48, 50));

    expect(clock.toIso('20:12:01.9250000')).toContain('2026-09-22T20:12:01');
    expect(clock.toIso('16:51:17.5138809')).toContain('2026-09-22T16:51:17');
    expect(clock.toIso('20:12:01.9250000')).toContain('2026-09-22T20:12:01');
  });

  it('renvoie null pour une heure mal formee', () => {
    expect(new LogClock(SESSION_DATE).toIso('pas une heure')).toBeNull();
  });
});

describe('filtrage des modes de jeu', () => {
  it('ne rend que les parties de Champs de bataille', async () => {
    expect(await runLines([...opening('GT_RANKED'), COMPLETE])).toEqual([]);
    expect(await runLines([...opening(), COMPLETE])).toHaveLength(1);
  });

  it('rend une partie inachevee, sans date de fin', async () => {
    const [only] = await runLines(opening());

    expect(only?.endedAt).toBeNull();
    expect(only?.startedAt).toContain('2026-09-19T02:48:30');
  });
});

describe('montees de palier', () => {
  it('retient le tour de chaque montee, d’apres le dernier TURN vu', async () => {
    const [only] = await runLines([
      ...opening(),
      power('TAG_CHANGE Entity=GameEntity tag=TURN value=3'),
      power('TAG_CHANGE Entity=89 tag=PLAYER_TECH_LEVEL value=2'),
      power('TAG_CHANGE Entity=GameEntity tag=TURN value=9'),
      power('TAG_CHANGE Entity=89 tag=PLAYER_TECH_LEVEL value=3'),
      COMPLETE,
    ]);

    expect(only?.tierUps).toEqual([
      { tier: 2, turn: 2 },
      { tier: 3, turn: 5 },
    ]);
  });

  it('ne compte pas le palier 1 de depart', async () => {
    const [only] = await runLines([
      ...opening(),
      power('TAG_CHANGE Entity=89 tag=PLAYER_TECH_LEVEL value=1'),
      COMPLETE,
    ]);

    expect(only?.tierUps).toEqual([]);
  });

  it('ignore le PLAYER_TECH_LEVEL porte par d’autres entites du joueur', async () => {
    // Piege documente : les copies de heros adverses et les enchantements de
    // transfert recoivent aussi ce tag, souvent a 0.
    const [only] = await runLines([
      ...opening(),
      power('TAG_CHANGE Entity=GameEntity tag=TURN value=3'),
      power('FULL_ENTITY - Creating ID=444 CardID=TB_BaconShop_HERO_16'),
      power('TAG_CHANGE Entity=444 tag=PLAYER_TECH_LEVEL value=6'),
      power('TAG_CHANGE Entity=89 tag=PLAYER_TECH_LEVEL value=2'),
      COMPLETE,
    ]);

    expect(only?.tierUps).toEqual([{ tier: 2, turn: 2 }]);
  });
});

describe('choix', () => {
  const MULLIGAN = [
    'D 02:48:39.2686715 GameState.DebugPrintEntityChoices() - id=1 Player=AkiLif#2498 TaskList=7 ChoiceType=MULLIGAN CountMin=1 CountMax=1',
    'D 02:48:39.2686715 GameState.DebugPrintEntityChoices() -   Source=GameEntity',
    'D 02:48:39.2686715 GameState.DebugPrintEntityChoices() -   Entities[0]=[entityName=Drek’Thar id=91 zone=HAND zonePos=3 cardId=BG22_HERO_002 player=7]',
    'D 02:48:39.2686715 GameState.DebugPrintEntityChoices() -   Entities[1]=[entityName=Tavish id=89 zone=HAND zonePos=1 cardId=BG22_HERO_000_SKIN_A player=7]',
    'D 02:48:57.2027884 GameState.SendChoices() - id=1 ChoiceType=MULLIGAN',
    'D 02:48:57.2027884 GameState.SendChoices() -   m_chosenEntities[0]=[entityName=Tavish id=89 zone=HAND zonePos=3 cardId=BG22_HERO_000_SKIN_A player=7]',
  ];

  const TRIPLE = [
    'D 02:53:10.5031264 GameState.DebugPrintEntityChoices() - id=2 Player=AkiLif#2498 TaskList=1618 ChoiceType=GENERAL CountMin=1 CountMax=1',
    'D 02:53:10.5031264 GameState.DebugPrintEntityChoices() -   Source=[entityName=Triple id=300 zone=PLAY zonePos=0 cardId=TB_BaconShop_Triples_01 player=7]',
    'D 02:53:10.5031264 GameState.DebugPrintEntityChoices() -   Entities[0]=[entityName=A id=301 zone=SETASIDE zonePos=0 cardId=BG35_143 player=7]',
    'D 02:53:10.5031264 GameState.DebugPrintEntityChoices() -   Entities[1]=[entityName=B id=302 zone=SETASIDE zonePos=0 cardId=BG36_760 player=7]',
    'D 02:53:12.5031264 GameState.SendChoices() - id=2 ChoiceType=GENERAL',
    'D 02:53:12.5031264 GameState.SendChoices() -   m_chosenEntities[0]=[entityName=B id=302 zone=SETASIDE zonePos=0 cardId=BG36_760 player=7]',
  ];

  it('range le mulligan dans heroOffered / heroChosen, pas dans picks', async () => {
    const [only] = await runLines([...opening(), ...MULLIGAN, COMPLETE]);

    expect(only?.heroOffered).toEqual(['BG22_HERO_002', 'BG22_HERO_000_SKIN_A']);
    expect(only?.heroChosen).toBe('BG22_HERO_000_SKIN_A');
    expect(only?.picks).toEqual([]);
  });

  it('retient la source, les options et le choix d’une decouverte', async () => {
    const [only] = await runLines([...opening(), ...MULLIGAN, ...TRIPLE, COMPLETE]);

    expect(only?.picks).toEqual([
      {
        choiceId: 2,
        sourceCardId: 'TB_BaconShop_Triples_01',
        turn: null,
        options: ['BG35_143', 'BG36_760'],
        chosen: 'BG36_760',
      },
    ]);
  });

  it('ne compte pas deux fois les Entities[] de DebugPrintEntitiesChosen', async () => {
    // Cette source reprend la meme forme de ligne que les options proposees.
    const [only] = await runLines([
      ...opening(),
      ...TRIPLE,
      'D 02:53:12.5031264 GameState.DebugPrintEntitiesChosen() - id=2 Player=AkiLif#2498 EntitiesCount=1',
      'D 02:53:12.5031264 GameState.DebugPrintEntitiesChosen() -   Entities[0]=[entityName=B id=302 zone=SETASIDE zonePos=0 cardId=BG36_760 player=7]',
      COMPLETE,
    ]);

    expect(only?.picks[0]?.options).toEqual(['BG35_143', 'BG36_760']);
  });

  it('ecarte un choix propose mais jamais tranche', async () => {
    const [only] = await runLines([...opening(), ...TRIPLE.slice(0, 4), COMPLETE]);
    expect(only?.picks).toEqual([]);
  });
});

describe('resume de la partie de reference', () => {
  it('reproduit toutes les valeurs verifiees a la main', async () => {
    const folder = await sampleSessionFolder();
    const summaries: GameSummary[] = [];
    for await (const summary of extractGames(readSessionLines(folder), {
      sessionDate: SESSION_DATE,
    })) {
      summaries.push(summary);
    }

    expect(summaries).toHaveLength(1);
    const [only] = summaries;
    if (only === undefined) throw new Error('aucune partie');

    expect(only.buildNumber).toBe(251952);
    expect(only.gameType).toBe('GT_BATTLEGROUNDS');
    expect(only.gameSeed).toBe('817997359');
    expect(only.playerName).toBe('AkiLif#2498');
    expect(only.startedAt).toContain('2026-09-19T02:48:30');
    expect(only.endedAt).toContain('2026-09-19T03:13:48');

    expect(only.heroOffered).toEqual([
      'BG22_HERO_002',
      'TB_BaconShop_HERO_34',
      'BG22_HERO_000_SKIN_A',
      'BG36_HERO_101',
    ]);
    expect(only.heroChosen).toBe('BG22_HERO_000_SKIN_A');

    expect(only.finalPlace).toBe(3);
    expect(only.finalTurn).toBe(13);

    expect(only.tierUps).toEqual([
      { tier: 2, turn: 2 },
      { tier: 3, turn: 5 },
      { tier: 4, turn: 7 },
      { tier: 5, turn: 10 },
    ]);

    // Neuf choix GENERAL, ids 2 a 10.
    expect(only.picks.map((pick) => pick.choiceId)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);

    expect(only.picks[0]).toMatchObject({
      choiceId: 2,
      sourceCardId: 'TB_BaconShop_Triples_01',
      chosen: 'BG36_760',
    });
    expect(only.picks[1]).toEqual({
      choiceId: 3,
      sourceCardId: 'BG30_Trinket_1st',
      turn: 6,
      options: [
        'BG30_MagicItem_703',
        'BG30_MagicItem_547',
        'BG36_MagicItem_811',
        'BG36_MagicItem_202',
      ],
      chosen: 'BG30_MagicItem_547',
    });
    expect(only.picks.find((pick) => pick.choiceId === 7)).toMatchObject({
      sourceCardId: 'BG30_Trinket_2nd',
      chosen: 'BG30_MagicItem_406',
    });
    expect(only.picks.find((pick) => pick.choiceId === 10)).toMatchObject({
      sourceCardId: 'TB_BaconShop_Triples_01',
      chosen: 'BG35_883',
    });

    expect(only.opponents).toEqual([
      'BG22_HERO_201_SKIN_C',
      'BG30_HERO_304',
      'BG34_HERO_001',
      'TB_BaconShop_HERO_16',
      'TB_BaconShop_HERO_58_SKIN_E',
      'TB_BaconShop_HERO_70',
      'TB_BaconShop_HERO_93',
    ]);
  });
});
