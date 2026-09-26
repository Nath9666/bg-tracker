import { describe, expect, it } from 'vitest';
import { GameStateMachine, type Game } from '../src/state/game-state.js';
import { readGames } from '../src/state/read-games.js';
import { parseLine } from '../src/parser/line-parser.js';
import { readSessionLines } from '../src/reader/session-reader.js';
import { sampleSessionFolder } from './helpers/sample-session.js';

/** Joue des lignes de log brutes et rend les parties terminees. */
async function runLines(lines: string[]): Promise<Game[]> {
  async function* stream(): AsyncGenerator<string> {
    for (const line of lines) yield line;
  }

  const games: Game[] = [];
  for await (const game of readGames(stream())) games.push(game);
  return games;
}

/** Prefixe une ligne de corps avec un horodatage et la source DebugPrintPower. */
function power(body: string, time = '02:48:30.3211164'): string {
  return `D ${time} GameState.DebugPrintPower() - ${body}`;
}

function game(body: string, time = '02:48:30.3211164'): string {
  return `D ${time} GameState.DebugPrintGame() - ${body}`;
}

/** Ouverture de partie minimale, calquee sur le log de reference. */
const OPENING = [
  power('CREATE_GAME'),
  power('    GameEntity EntityID=19'),
  power('        tag=CARDTYPE value=GAME'),
  power('    Player EntityID=20 PlayerID=7 GameAccountId=[hi=144115198130930503 lo=1025141059]'),
  power('        tag=HERO_ENTITY value=37'),
  power('    Player EntityID=21 PlayerID=15 GameAccountId=[hi=0 lo=0]'),
  power('        tag=HERO_ENTITY value=80'),
  game('BuildNumber=251952'),
  game('GameType=GT_BATTLEGROUNDS'),
  game('PlayerID=7, PlayerName=AkiLif#2498'),
  game('PlayerID=15, PlayerName=МиниНиндзя'),
];

const COMPLETE = power('TAG_CHANGE Entity=GameEntity tag=STATE value=COMPLETE', '03:13:48.9378732');

describe('bornes de partie', () => {
  it('ouvre au CREATE_GAME et ferme au STATE=COMPLETE', async () => {
    const [first] = await runLines([...OPENING, COMPLETE]);

    expect(first?.startedAt).toBe('02:48:30.3211164');
    expect(first?.endedAt).toBe('03:13:48.9378732');
    expect(first?.complete).toBe(true);
  });

  it('rend une partie inachevee en fin de flux', async () => {
    const [first] = await runLines(OPENING);

    expect(first?.complete).toBe(false);
    expect(first?.endedAt).toBeNull();
  });

  it('decoupe plusieurs parties dans un meme flux', async () => {
    const games = await runLines([...OPENING, COMPLETE, ...OPENING, COMPLETE]);
    expect(games).toHaveLength(2);
    expect(games.every((g) => g.complete)).toBe(true);
  });

  it('cloture une partie restee ouverte quand la suivante commence', async () => {
    const games = await runLines([...OPENING, ...OPENING, COMPLETE]);

    expect(games).toHaveLength(2);
    expect(games[0]?.complete).toBe(false);
    expect(games[1]?.complete).toBe(true);
  });

  it('ignore les lignes qui trainent apres la fin d’une partie', async () => {
    // Le log de reference en porte deux, 48 secondes apres le COMPLETE.
    const games = await runLines([
      ...OPENING,
      COMPLETE,
      power('TAG_CHANGE Entity=133 tag=PLAYER_TRIPLES value=5', '03:14:36.7651850'),
    ]);

    expect(games).toHaveLength(1);
    expect(games[0]?.entities.has(133)).toBe(false);
  });

  it('n’ouvre rien avant le premier CREATE_GAME', async () => {
    expect(await runLines([power('TAG_CHANGE Entity=19 tag=TURN value=1')])).toEqual([]);
  });
});

describe('identification du joueur local', () => {
  it('retient le joueur au GameAccountId non nul', async () => {
    const [first] = await runLines([...OPENING, COMPLETE]);

    expect(first?.localPlayerEntityId).toBe(20);
    expect(first?.proxyPlayerEntityId).toBe(21);
    expect(first?.players.get(20)).toMatchObject({
      playerId: 7,
      name: 'AkiLif#2498',
      isLocal: true,
    });
    expect(first?.players.get(21)).toMatchObject({ playerId: 15, isLocal: false });
  });

  it('ne se repose pas sur PlayerID=7, qui change d’une partie a l’autre', async () => {
    // Paire relevee sur une autre partie : EntityID=14 / PlayerID=5.
    const [first] = await runLines([
      power('CREATE_GAME'),
      power('    GameEntity EntityID=13'),
      power(
        '    Player EntityID=14 PlayerID=5 GameAccountId=[hi=144115198130930503 lo=1025141059]',
      ),
      power('    Player EntityID=15 PlayerID=13 GameAccountId=[hi=0 lo=0]'),
      COMPLETE,
    ]);

    expect(first?.localPlayerEntityId).toBe(14);
    expect(first?.proxyPlayerEntityId).toBe(15);
  });
});

describe('entite heros du joueur', () => {
  it('suit HERO_ENTITY : le remplacant du debut cede la place au vrai heros', async () => {
    const [first] = await runLines([
      ...OPENING,
      power('TAG_CHANGE Entity=AkiLif#2498 tag=HERO_ENTITY value=89'),
      power('FULL_ENTITY - Creating ID=89 CardID=BG22_HERO_000_SKIN_A'),
      COMPLETE,
    ]);

    expect(first?.heroEntityId).toBe(89);
    expect(first?.entities.get(89)?.cardId).toBe('BG22_HERO_000_SKIN_A');
  });

  it('ne confond pas le HERO_ENTITY du joueur fictif avec celui du joueur', async () => {
    const [first] = await runLines([
      ...OPENING,
      power('TAG_CHANGE Entity=AkiLif#2498 tag=HERO_ENTITY value=89'),
      power('TAG_CHANGE Entity=Bob le barman tag=HERO_ENTITY value=1448'),
      COMPLETE,
    ]);

    expect(first?.heroEntityId).toBe(89);
    expect(first?.entities.get(21)?.tags.get('HERO_ENTITY')).toBe('1448');
  });
});

describe('resolution des references d’entite', () => {
  it('resout GameEntity et les noms de joueur', async () => {
    const [first] = await runLines([
      ...OPENING,
      power('TAG_CHANGE Entity=GameEntity tag=TURN value=26'),
      power('TAG_CHANGE Entity=AkiLif#2498 tag=RESOURCES value=3'),
      COMPLETE,
    ]);

    expect(first?.entities.get(19)?.tags.get('TURN')).toBe('26');
    expect(first?.entities.get(20)?.tags.get('RESOURCES')).toBe('3');
  });

  it('rattache un nom inconnu au joueur fictif', async () => {
    // Verifie sur le log : `Entity=LazyTurtle tag=HERO_ENTITY value=80`, ou 80
    // est l'entite de Bob. Les pseudos adverses et « Bob le barman » designent
    // la meme entite, renommee d'apres le heros qu'elle controle.
    const [first] = await runLines([
      ...OPENING,
      power('TAG_CHANGE Entity=LazyTurtle tag=HERO_ENTITY value=80'),
      COMPLETE,
    ]);

    expect(first?.entities.get(21)?.tags.get('HERO_ENTITY')).toBe('80');
    expect(first?.proxyPlayerName).toBe('LazyTurtle');
    expect(first?.unresolvedNames.size).toBe(0);
  });

  it('resout la forme numerique et la forme bloc detaille', async () => {
    const [first] = await runLines([
      ...OPENING,
      power('TAG_CHANGE Entity=247 tag=ZONE value=PLAY'),
      power(
        'TAG_CHANGE Entity=[entityName=A. F. Kah id=133 zone=SETASIDE zonePos=0 cardId=TB_BaconShop_HERO_16 player=15] tag=PLAYER_LEADERBOARD_PLACE value=3',
      ),
      COMPLETE,
    ]);

    expect(first?.entities.get(247)?.tags.get('ZONE')).toBe('PLAY');
    expect(first?.entities.get(133)?.tags.get('PLAYER_LEADERBOARD_PLACE')).toBe('3');
  });

  it('complete un cardId encore inconnu depuis une reference detaillee', async () => {
    const [first] = await runLines([
      ...OPENING,
      power(
        'TAG_CHANGE Entity=[entityName=A. F. Kah id=133 zone=SETASIDE zonePos=0 cardId=TB_BaconShop_HERO_16 player=15] tag=ZONE value=SETASIDE',
      ),
      COMPLETE,
    ]);

    expect(first?.entities.get(133)?.cardId).toBe('TB_BaconShop_HERO_16');
  });

  it('n’ecrase pas un cardId connu', async () => {
    const [first] = await runLines([
      ...OPENING,
      power('FULL_ENTITY - Creating ID=321 CardID=BG30_MagicItem_547'),
      power(
        'TAG_CHANGE Entity=[entityName=Bibelot inférieur id=321 zone=PLAY zonePos=0 cardId=BG30_Trinket_1st player=7] tag=ZONE value=PLAY',
      ),
      COMPLETE,
    ]);

    expect(first?.entities.get(321)?.cardId).toBe('BG30_MagicItem_547');
  });
});

describe('application des tags', () => {
  it('rattache les tags indentes a la derniere entite definie', async () => {
    const [first] = await runLines([...OPENING, COMPLETE]);

    expect(first?.entities.get(19)?.tags.get('CARDTYPE')).toBe('GAME');
    expect(first?.entities.get(20)?.tags.get('HERO_ENTITY')).toBe('37');
    expect(first?.entities.get(21)?.tags.get('HERO_ENTITY')).toBe('80');
  });

  it('suit CHANGE_ENTITY, par lequel un bibelot prend sa carte definitive', async () => {
    const [first] = await runLines([
      ...OPENING,
      power('FULL_ENTITY - Creating ID=321 CardID=BG30_Trinket_1st'),
      power(
        'CHANGE_ENTITY - Updating Entity=[entityName=Bibelot inférieur id=321 zone=PLAY zonePos=0 cardId=BG30_Trinket_1st player=7] CardID=BG30_MagicItem_547',
      ),
      COMPLETE,
    ]);

    expect(first?.entities.get(321)?.cardId).toBe('BG30_MagicItem_547');
  });

  it('applique le tag porte par un HIDE_ENTITY', async () => {
    const [first] = await runLines([
      ...OPENING,
      power('FULL_ENTITY - Creating ID=513 CardID=TB_BaconShopBadsongE'),
      power(
        'HIDE_ENTITY - Entity=[entityName= id=513 zone=PLAY zonePos=0 cardId=TB_BaconShopBadsongE player=7] tag=ZONE value=REMOVEDFROMGAME',
      ),
      COMPLETE,
    ]);

    expect(first?.entities.get(513)?.tags.get('ZONE')).toBe('REMOVEDFROMGAME');
  });
});

describe('GameStateMachine : callbacks', () => {
  it('signale le debut et la fin de partie', async () => {
    const events: string[] = [];
    const machine = new GameStateMachine({
      onGameStart: () => events.push('start'),
      onGameEnd: (g) => events.push(g.complete ? 'end' : 'end-incomplete'),
    });

    for (const line of [...OPENING, COMPLETE, ...OPENING]) {
      const event = parseLine(line);
      if (event !== null) machine.apply(event);
    }
    expect(machine.current).not.toBeNull();
    machine.finish();

    expect(events).toEqual(['start', 'end', 'start', 'end-incomplete']);
    expect(machine.current).toBeNull();
  });
});

describe('partie de reference', () => {
  it('reconstruit la partie complete du log de reference', async () => {
    const games: Game[] = [];
    for await (const g of readGames(readSessionLines(await sampleSessionFolder()))) games.push(g);

    expect(games).toHaveLength(1);
    const [only] = games;
    if (only === undefined) throw new Error('aucune partie');

    expect(only.complete).toBe(true);
    expect(only.startedAt).toBe('02:48:30.3211164');
    expect(only.endedAt).toBe('03:13:48.9378732');
    expect(only.meta.get('BuildNumber')).toBe('251952');
    expect(only.meta.get('GameType')).toBe('GT_BATTLEGROUNDS');

    // Joueur local et son heros : les valeurs du tableau de reference.
    expect(only.players.get(only.localPlayerEntityId!)).toMatchObject({
      playerId: 7,
      name: 'AkiLif#2498',
    });
    expect(only.heroEntityId).toBe(89);
    expect(only.entities.get(89)?.cardId).toBe('BG22_HERO_000_SKIN_A');

    const hero = only.entities.get(89);
    expect(hero?.tags.get('PLAYER_LEADERBOARD_PLACE')).toBe('3');
    expect(hero?.tags.get('PLAYER_TECH_LEVEL')).toBe('5');
    expect(only.entities.get(only.gameEntityId!)?.tags.get('TURN')).toBe('26');
    expect(only.entities.get(only.gameEntityId!)?.tags.get('GAME_SEED')).toBe('817997359');

    // Aucun nom reference ne doit rester sans entite.
    expect([...only.unresolvedNames]).toEqual([]);
    expect(only.entities.size).toBe(2454);
  });
});
