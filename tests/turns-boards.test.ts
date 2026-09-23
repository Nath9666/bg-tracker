import { describe, expect, it } from 'vitest';
import { combatResult, extractGames } from '../src/extract/game-extractor.js';
import { readSessionLines } from '../src/reader/session-reader.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { importGames } from '../src/db/import.js';
import { emptyKeywords } from '../src/types.js';
import type { GameSummary } from '../src/types.js';
import { sampleSessionFolder } from './helpers/sample-session.js';

const SESSION_DATE = new Date(2026, 8, 19, 2, 47, 25);

async function runLines(lines: string[]): Promise<GameSummary[]> {
  async function* stream(): AsyncGenerator<string> {
    for (const line of lines) yield line;
  }

  const games: GameSummary[] = [];
  for await (const summary of extractGames(stream(), { sessionDate: SESSION_DATE })) {
    games.push(summary);
  }
  return games;
}

function power(body: string, time = '02:48:30.3211164'): string {
  return `D ${time} GameState.DebugPrintPower() - ${body}`;
}

const OPENING = [
  power('CREATE_GAME'),
  power('    GameEntity EntityID=19'),
  power('    Player EntityID=20 PlayerID=7 GameAccountId=[hi=1 lo=1]'),
  power('    Player EntityID=21 PlayerID=15 GameAccountId=[hi=0 lo=0]'),
  'D 02:48:30.3211164 GameState.DebugPrintGame() - GameType=GT_BATTLEGROUNDS',
  'D 02:48:30.3211164 GameState.DebugPrintGame() - PlayerID=7, PlayerName=AkiLif#2498',
  power('TAG_CHANGE Entity=AkiLif#2498 tag=HERO_ENTITY value=89'),
  power('FULL_ENTITY - Creating ID=89 CardID=BG22_HERO_000_SKIN_A'),
  power('        tag=HEALTH value=30'),
  // Bob : le heros du mandataire hors combat.
  power('FULL_ENTITY - Creating ID=80 CardID=TB_BaconShopBob'),
  power('TAG_CHANGE Entity=Bob le barman tag=HERO_ENTITY value=80'),
];

const COMPLETE = power('TAG_CHANGE Entity=GameEntity tag=STATE value=COMPLETE', '03:13:48.9378732');

/** Cree un serviteur sur le plateau du joueur. */
function minion(id: number, cardId: string, position: number, atk: number, health: number, golden = false): string[] {
  const lines = [
    power(`FULL_ENTITY - Creating ID=${id} CardID=${cardId}`),
    power('        tag=CARDTYPE value=MINION'),
    power('        tag=CONTROLLER value=7'),
    power('        tag=ZONE value=PLAY'),
    power(`        tag=ZONE_POSITION value=${position}`),
    power(`        tag=ATK value=${atk}`),
    power(`        tag=HEALTH value=${health}`),
  ];
  if (golden) lines.push(power('        tag=PREMIUM value=1'));
  return lines;
}

/** Un tour complet : recrutement puis combat. */
function turn(counter: number, opponentEntity: number, opponentCard: string): string[] {
  return [
    power(`TAG_CHANGE Entity=GameEntity tag=TURN value=${counter}`),
    power(`FULL_ENTITY - Creating ID=${opponentEntity} CardID=${opponentCard}`),
    power('TAG_CHANGE Entity=GameEntity tag=BACON_IN_COMBAT_PHASE value=1'),
    power(`TAG_CHANGE Entity=Bob le barman tag=HERO_ENTITY value=${opponentEntity}`),
  ];
}

const BACK_TO_SHOP = [
  power('TAG_CHANGE Entity=Bob le barman tag=HERO_ENTITY value=80'),
  power('TAG_CHANGE Entity=GameEntity tag=BACON_IN_COMBAT_PHASE value=0'),
];

describe('combatResult', () => {
  it('lit la victoire sur le tag', () => {
    expect(combatResult(true, 0)).toBe('win');
  });

  it('distingue l’egalite de la defaite par les degats', () => {
    // BACON_WON_LAST_COMBAT ne vaut que 0 ou 1 : une egalite s'y lit comme une
    // defaite, mais elle ne coute aucun point de vie.
    expect(combatResult(false, 0)).toBe('tie');
    expect(combatResult(false, 7)).toBe('loss');
  });
});

describe('extraction des tours', () => {
  it('enregistre un tour par combat', async () => {
    const [only] = await runLines([
      ...OPENING,
      power('TAG_CHANGE Entity=AkiLif#2498 tag=RESOURCES value=3'),
      power('TAG_CHANGE Entity=89 tag=PLAYER_TECH_LEVEL value=1'),
      ...turn(2, 500, 'BG30_HERO_304'),
      power('TAG_CHANGE Entity=AkiLif#2498 tag=BACON_WON_LAST_COMBAT value=1'),
      ...BACK_TO_SHOP,
      COMPLETE,
    ]);

    expect(only?.turns).toHaveLength(1);
    expect(only?.turns[0]).toMatchObject({
      turn: 1,
      tavernTier: 1,
      gold: 3,
      opponentHero: 'BG30_HERO_304',
      combatResult: 'win',
      damageTaken: 0,
    });
  });

  it('ne prend pas Bob pour un adversaire', async () => {
    const [only] = await runLines([
      ...OPENING,
      ...turn(2, 500, 'BG30_HERO_304'),
      ...BACK_TO_SHOP,
      COMPLETE,
    ]);

    expect(only?.turns[0]?.opponentHero).toBe('BG30_HERO_304');
  });

  it('deduit les degats de la perte d’armure puis des points de vie', async () => {
    const [only] = await runLines([
      ...OPENING,
      power('TAG_CHANGE Entity=89 tag=ARMOR value=5'),
      ...turn(2, 500, 'BG30_HERO_304'),
      // L'armure encaisse 5, les points de vie 3.
      power('TAG_CHANGE Entity=89 tag=ARMOR value=0'),
      power('TAG_CHANGE Entity=89 tag=DAMAGE value=3'),
      ...BACK_TO_SHOP,
      COMPLETE,
    ]);

    expect(only?.turns[0]).toMatchObject({
      combatResult: 'loss',
      damageTaken: 8,
      health: 27,
    });
  });

  it('compte une egalite quand rien n’est perdu sans victoire', async () => {
    const [only] = await runLines([
      ...OPENING,
      ...turn(2, 500, 'BG30_HERO_304'),
      ...BACK_TO_SHOP,
      COMPLETE,
    ]);

    expect(only?.turns[0]?.combatResult).toBe('tie');
  });

  it('cloture le dernier combat meme si le joueur est elimine', async () => {
    // Le joueur meurt pendant le combat : la phase ne revient jamais a 0.
    const [only] = await runLines([
      ...OPENING,
      ...turn(2, 500, 'BG30_HERO_304'),
      power('TAG_CHANGE Entity=89 tag=DAMAGE value=30'),
      COMPLETE,
    ]);

    expect(only?.turns).toHaveLength(1);
    expect(only?.turns[0]).toMatchObject({ combatResult: 'loss', damageTaken: 30, health: 0 });
  });

  it('enchaine plusieurs tours', async () => {
    const [only] = await runLines([
      ...OPENING,
      ...turn(2, 500, 'BG30_HERO_304'),
      ...BACK_TO_SHOP,
      ...turn(4, 501, 'BG34_HERO_001'),
      ...BACK_TO_SHOP,
      COMPLETE,
    ]);

    expect(only?.turns.map((t) => [t.turn, t.opponentHero])).toEqual([
      [1, 'BG30_HERO_304'],
      [2, 'BG34_HERO_001'],
    ]);
  });
});

describe('capture du plateau', () => {
  it('retient les serviteurs du joueur, ranges par position', async () => {
    const [only] = await runLines([
      ...OPENING,
      ...minion(301, 'BG28_300', 2, 3, 2),
      ...minion(302, 'BG36_760', 1, 5, 3, true),
      ...turn(2, 500, 'BG30_HERO_304'),
      ...BACK_TO_SHOP,
      COMPLETE,
    ]);

    expect(only?.turns[0]?.board).toEqual([
      {
        position: 1,
        cardId: 'BG36_760',
        atk: 5,
        health: 3,
        damage: 0,
        golden: true,
        keywords: emptyKeywords(),
      },
      {
        position: 2,
        cardId: 'BG28_300',
        atk: 3,
        health: 2,
        damage: 0,
        golden: false,
        keywords: emptyKeywords(),
      },
    ]);
  });

  it('ignore les serviteurs de l’adversaire et ceux hors du plateau', async () => {
    const [only] = await runLines([
      ...OPENING,
      ...minion(301, 'BG28_300', 1, 3, 2),
      // Contrôlé par le mandataire.
      power('FULL_ENTITY - Creating ID=400 CardID=BG35_143'),
      power('        tag=CARDTYPE value=MINION'),
      power('        tag=CONTROLLER value=15'),
      power('        tag=ZONE value=PLAY'),
      // En main, pas sur le plateau.
      power('FULL_ENTITY - Creating ID=401 CardID=BG25_016'),
      power('        tag=CARDTYPE value=MINION'),
      power('        tag=CONTROLLER value=7'),
      power('        tag=ZONE value=HAND'),
      ...turn(2, 500, 'BG30_HERO_304'),
      ...BACK_TO_SHOP,
      COMPLETE,
    ]);

    expect(only?.turns[0]?.board.map((m) => m.cardId)).toEqual(['BG28_300']);
  });
});

describe('partie de reference', () => {
  it('reconstruit les 13 tours, leurs adversaires et leurs plateaux', async () => {
    const summaries: GameSummary[] = [];
    for await (const summary of extractGames(readSessionLines(await sampleSessionFolder()), {
      sessionDate: SESSION_DATE,
    })) {
      summaries.push(summary);
    }

    const [only] = summaries;
    if (only === undefined) throw new Error('aucune partie');

    // Un tour par combat, jusqu'a l'elimination au tour 13.
    expect(only.turns).toHaveLength(13);
    expect(only.turns.map((t) => t.turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);

    expect(only.turns[0]).toMatchObject({
      turn: 1,
      tavernTier: 1,
      gold: 3,
      health: 44,
      combatResult: 'win',
      damageTaken: 0,
    });

    // Dernier tour : le joueur tombe a zero et sort 3e.
    expect(only.turns[12]).toMatchObject({ turn: 13, combatResult: 'loss', health: -2 });

    // Une victoire ou une egalite ne coute jamais de points de vie.
    for (const turn of only.turns) {
      if (turn.combatResult !== 'loss') expect(turn.damageTaken).toBe(0);
      else expect(turn.damageTaken).toBeGreaterThan(0);
    }

    // Les 7 adversaires du lobby, et eux seuls.
    const opponents = new Set(only.turns.map((t) => t.opponentHero));
    expect([...opponents].sort()).toEqual(only.opponents);

    // Le plateau grandit puis plafonne a 7.
    expect(only.turns[0]?.board).toHaveLength(1);
    expect(Math.max(...only.turns.map((t) => t.board.length))).toBe(7);
    expect(only.turns.every((t) => t.board.every((m) => m.position >= 1 && m.position <= 7))).toBe(
      true,
    );
  });
});

describe('decisions', () => {
  /** Serviteur propose par Bob : controle par le joueur fictif, en jeu. */
  function shopMinion(id: number, cardId: string, position: number): string[] {
    return [
      power(`FULL_ENTITY - Creating ID=${id} CardID=${cardId}`),
      power('        tag=CARDTYPE value=MINION'),
      power('        tag=CONTROLLER value=15'),
      power('        tag=ZONE value=PLAY'),
      power(`        tag=ZONE_POSITION value=${position}`),
      power('        tag=ATK value=4'),
      power('        tag=HEALTH value=4'),
    ];
  }

  /** Serviteur dans la main du joueur. */
  function handMinion(id: number, cardId: string, position: number): string[] {
    return [
      power(`FULL_ENTITY - Creating ID=${id} CardID=${cardId}`),
      power('        tag=CARDTYPE value=MINION'),
      power('        tag=CONTROLLER value=7'),
      power('        tag=ZONE value=HAND'),
      power(`        tag=ZONE_POSITION value=${position}`),
    ];
  }

  /** Un lot d'options, puis l'action retenue. */
  function action(index: number, cardId: string, cible = 0, position = 0): string[] {
    return [
      'D 02:48:30.3211164 GameState.DebugPrintOptions() - id=1',
      `D 02:48:30.3211164 GameState.DebugPrintOptions() - option ${index} type=POWER mainEntity=[entityName=x id=90${index} zone=PLAY zonePos=0 cardId=${cardId} player=7] error=NONE errorParam=`,
      `D 02:48:30.3211164 GameState.SendOption() - selectedOption=${index} selectedSubOption=-1 selectedTarget=${cible} selectedPosition=${position}`,
    ];
  }

  it('classe les actions d’apres leur carte support', async () => {
    const [only] = await runLines([
      ...OPENING,
      ...action(1, 'TB_BaconShop_DragBuy'),
      ...action(2, 'TB_BaconShop_DragSell'),
      ...action(3, 'TB_BaconShop_8p_Reroll_Button'),
      ...action(4, 'TB_BaconShopLockAll_Button'),
      ...action(5, 'TB_BaconShopTechUp03_Button'),
      ...action(6, 'TB_BaconShop_DragBuy_Spell'),
      ...action(7, 'BG28_300'),
      COMPLETE,
    ]);

    expect(only?.decisions.map((d) => d.action)).toEqual([
      'buy',
      'sell',
      'reroll',
      'freeze',
      'tierUp',
      'buySpell',
      'play',
    ]);
  });

  it('numerote les decisions dans l’ordre', async () => {
    const [only] = await runLines([
      ...OPENING,
      ...action(1, 'TB_BaconShop_DragBuy'),
      ...action(2, 'TB_BaconShop_DragSell'),
      COMPLETE,
    ]);

    expect(only?.decisions.map((d) => d.sequence)).toEqual([1, 2]);
  });

  it('retient la cible et l’emplacement de pose', async () => {
    const [only] = await runLines([
      ...OPENING,
      power('FULL_ENTITY - Creating ID=777 CardID=BG36_760'),
      ...action(1, 'TB_BaconShop_DragBuy', 777, 3),
      COMPLETE,
    ]);

    expect(only?.decisions[0]).toMatchObject({
      action: 'buy',
      targetCardId: 'BG36_760',
      position: 3,
    });
  });

  it('laisse la cible vide quand l’action n’en a pas', async () => {
    // Le log ecrit `selectedTarget=0` dans ce cas.
    const [only] = await runLines([...OPENING, ...action(1, 'TB_BaconShopLockAll_Button'), COMPLETE]);
    expect(only?.decisions[0]?.targetCardId).toBeNull();
  });

  it('retient ce que le joueur avait sous les yeux', async () => {
    // Sans la boutique, on sait ce qu'il a pris mais pas ce qu'il a ecarte.
    const [only] = await runLines([
      ...OPENING,
      ...minion(301, 'BG28_300', 1, 3, 2),
      ...shopMinion(401, 'BG36_760', 1),
      ...shopMinion(402, 'BG35_143', 2),
      ...handMinion(501, 'BG25_016', 1),
      ...action(1, 'TB_BaconShop_DragBuy', 401),
      COMPLETE,
    ]);

    const decision = only?.decisions[0];
    expect(decision?.board.map((m) => m.cardId)).toEqual(['BG28_300']);
    expect(decision?.hand.map((m) => m.cardId)).toEqual(['BG25_016']);
    expect(decision?.shop.map((m) => m.cardId)).toEqual(['BG36_760', 'BG35_143']);
    // La carte prise fait partie des options qui etaient proposees.
    expect(decision?.targetCardId).toBe('BG36_760');
  });

  it('n’appelle pas boutique le plateau adverse pendant un combat', async () => {
    // Hors recrutement, cette zone porte les serviteurs de l'adversaire.
    const [only] = await runLines([
      ...OPENING,
      ...turn(2, 500, 'BG30_HERO_304'),
      ...shopMinion(401, 'BG36_760', 1),
      ...action(1, 'BG28_300'),
      ...BACK_TO_SHOP,
      COMPLETE,
    ]);

    expect(only?.decisions[0]?.shop).toEqual([]);
  });

  it('enregistre le contexte de la decision', async () => {
    const [only] = await runLines([
      ...OPENING,
      power('TAG_CHANGE Entity=GameEntity tag=TURN value=9'),
      power('TAG_CHANGE Entity=AkiLif#2498 tag=RESOURCES value=8'),
      power('TAG_CHANGE Entity=89 tag=PLAYER_TECH_LEVEL value=3'),
      ...action(1, 'TB_BaconShop_DragBuy'),
      COMPLETE,
    ]);

    expect(only?.decisions[0]).toMatchObject({ turn: 5, gold: 8, tavernTier: 3, health: 30 });
  });
});

describe('import des tours et des plateaux', () => {
  function freshDb(): Db {
    return openDatabase(':memory:');
  }

  async function referenceSummary(): Promise<GameSummary> {
    for await (const summary of extractGames(readSessionLines(await sampleSessionFolder()), {
      sessionDate: SESSION_DATE,
    })) {
      return summary;
    }
    throw new Error('aucune partie');
  }

  it('ecrit un tour par combat et un plateau par tour', async () => {
    const db = freshDb();
    const summary = await referenceSummary();
    importGames(db, [summary], 'x');

    const turns = db.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number };
    const boards = db.prepare('SELECT COUNT(*) AS n FROM boards').get() as { n: number };

    expect(turns.n).toBe(13);
    expect(boards.n).toBe(summary.turns.reduce((total, t) => total + t.board.length, 0));

    expect(
      db.prepare('SELECT combat_result, damage_taken, gold FROM turns WHERE turn = 1').get(),
    ).toEqual({ combat_result: 'win', damage_taken: 0, gold: 3 });
  });

  it('ne duplique rien au reimport', async () => {
    const db = freshDb();
    const summary = await referenceSummary();
    importGames(db, [summary], 'x');
    importGames(db, [summary], 'x');

    expect((db.prepare('SELECT COUNT(*) AS n FROM turns').get() as { n: number }).n).toBe(13);
  });

  it('supprime tours, plateaux et decisions en cascade', async () => {
    const db = freshDb();
    importGames(db, [await referenceSummary()], 'x');
    db.prepare('DELETE FROM games').run();

    for (const table of ['turns', 'boards', 'decisions', 'decision_cards']) {
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
  });

  it('ecrit ce qui etait visible a chaque decision', async () => {
    const db = freshDb();
    const summary = await referenceSummary();
    importGames(db, [summary], 'x');

    const attendu = summary.decisions.reduce(
      (total, d) => total + d.board.length + d.hand.length + d.shop.length,
      0,
    );
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM decision_cards').get() as { n: number };
    expect(n).toBe(attendu);
    expect(n).toBeGreaterThan(1000);

    // Les trois zones sont representées.
    const zones = db
      .prepare('SELECT DISTINCT zone FROM decision_cards ORDER BY zone')
      .all() as { zone: string }[];
    expect(zones.map((z) => z.zone)).toEqual(['board', 'hand', 'shop']);
  });

  it('ecrit les 134 decisions de la partie de reference', async () => {
    const db = freshDb();
    const summary = await referenceSummary();
    importGames(db, [summary], 'x');

    const { n } = db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number };
    expect(n).toBe(summary.decisions.length);
    expect(n).toBe(134);

    // Un reimport ne duplique rien.
    importGames(db, [summary], 'x');
    expect((db.prepare('SELECT COUNT(*) AS n FROM decisions').get() as { n: number }).n).toBe(134);
  });
});
