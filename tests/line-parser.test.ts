import { describe, expect, it } from 'vitest';
import {
  isIgnoredBody,
  isIgnoredSource,
  parseEntityRef,
  parseLine,
} from '../src/parser/line-parser.js';
import { readSessionLines } from '../src/reader/session-reader.js';
import { SAMPLE_SESSION_LINE_COUNT, sampleSessionFolder } from './helpers/sample-session.js';

// Toutes les lignes ci-dessous sont copiees telles quelles depuis
// fixtures/sample-game-1/Power_old.log, sauf mention contraire.

describe('parseEntityRef', () => {
  it('lit la forme numerique', () => {
    expect(parseEntityRef('247')).toEqual({ kind: 'id', id: 247 });
  });

  it('lit la forme nom, y compris avec des espaces ou un caractere #', () => {
    expect(parseEntityRef('GameEntity')).toEqual({ kind: 'name', name: 'GameEntity' });
    expect(parseEntityRef('AkiLif#2498')).toEqual({ kind: 'name', name: 'AkiLif#2498' });
    expect(parseEntityRef('Bob le barman')).toEqual({ kind: 'name', name: 'Bob le barman' });
    expect(parseEntityRef('МиниНиндзя')).toEqual({ kind: 'name', name: 'МиниНиндзя' });
  });

  it('lit la forme bloc detaille', () => {
    expect(
      parseEntityRef(
        '[entityName=Maître-éclaireur Tavish id=89 zone=PLAY zonePos=0 cardId=BG22_HERO_000_SKIN_A player=7]',
      ),
    ).toEqual({
      kind: 'entity',
      id: 89,
      entityName: 'Maître-éclaireur Tavish',
      zone: 'PLAY',
      zonePos: 0,
      cardId: 'BG22_HERO_000_SKIN_A',
      player: 7,
    });
  });

  it('lit un bloc dont le nom contient des crochets', () => {
    // Le nom lui-meme porte des crochets : chercher le premier `]` couperait trop tot.
    const ref = parseEntityRef(
      '[entityName=UNKNOWN ENTITY [cardType=INVALID] id=631 zone=PLAY zonePos=0 cardId= player=15]',
    );

    expect(ref).toEqual({
      kind: 'entity',
      id: 631,
      entityName: 'UNKNOWN ENTITY [cardType=INVALID]',
      zone: 'PLAY',
      zonePos: 0,
      cardId: '',
      player: 15,
    });
  });

  it('accepte un nom vide', () => {
    const ref = parseEntityRef(
      '[entityName= id=513 zone=PLAY zonePos=0 cardId=TB_BaconShopBadsongE player=7]',
    );
    expect(ref).toMatchObject({ kind: 'entity', id: 513, entityName: '' });
  });

  it('renvoie null pour une reference vide', () => {
    expect(parseEntityRef('')).toBeNull();
    expect(parseEntityRef('   ')).toBeNull();
  });
});

describe('parseLine : lignes ignorees', () => {
  it('ecarte les doublons PowerTaskList, qui rejouent les memes evenements', () => {
    expect(
      parseLine('D 02:48:30.3211164 PowerTaskList.DebugPrintPower() - CREATE_GAME'),
    ).toBeNull();
  });

  it('ecarte les autres sources', () => {
    expect(
      parseLine('D 02:48:30.3211164 PowerProcessor.EndCurrentTaskList() - m_currentTaskList=null'),
    ).toBeNull();
    expect(
      parseLine(
        'D 02:55:28.7166620 PowerSpellController [taskListId=1766].InitPowerSpell() - FAILED to attach',
      ),
    ).toBeNull();
  });

  it('ecarte une ligne vide ou sans prefixe', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('CREATE_GAME')).toBeNull();
  });
});

describe('parseLine : DebugPrintPower', () => {
  it('lit CREATE_GAME, avec son horodatage et son indentation', () => {
    expect(parseLine('D 02:48:30.3211164 GameState.DebugPrintPower() - CREATE_GAME')).toEqual({
      type: 'createGame',
      timestamp: '02:48:30.3211164',
      indent: 0,
      source: 'power',
    });
  });

  it('lit GameEntity et retient son indentation', () => {
    const event = parseLine(
      'D 02:48:30.3211164 GameState.DebugPrintPower() -     GameEntity EntityID=19',
    );
    expect(event).toMatchObject({ type: 'gameEntityDef', id: 19, indent: 4 });
  });

  it('lit Player, avec son GameAccountId', () => {
    const event = parseLine(
      'D 02:48:30.3211164 GameState.DebugPrintPower() -     Player EntityID=20 PlayerID=7 GameAccountId=[hi=144115198130930503 lo=1025141059]',
    );
    expect(event).toMatchObject({
      type: 'playerDef',
      entityId: 20,
      playerId: 7,
      gameAccountHi: '144115198130930503',
      gameAccountLo: '1025141059',
    });
  });

  it('lit un tag indente sous une creation', () => {
    const event = parseLine(
      'D 02:48:30.3211164 GameState.DebugPrintPower() -         tag=CARDTYPE value=GAME',
    );
    expect(event).toMatchObject({ type: 'tagDef', tag: 'CARDTYPE', value: 'GAME', indent: 8 });
  });

  it('garde les tags qui n’ont qu’un numero', () => {
    const event = parseLine(
      'D 02:48:30.3211164 GameState.DebugPrintPower() -         tag=937 value=3459',
    );
    expect(event).toMatchObject({ type: 'tagDef', tag: '937', value: '3459' });
  });

  it('lit FULL_ENTITY', () => {
    const event = parseLine(
      'D 02:48:39.2686715 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=132 CardID=TB_BaconShop_HP_044',
    );
    expect(event).toMatchObject({ type: 'fullEntity', id: 132, cardId: 'TB_BaconShop_HP_044' });
  });

  it('lit SHOW_ENTITY, dont l’entite est ici un simple numero', () => {
    const event = parseLine(
      'D 02:49:01.0842210 GameState.DebugPrintPower() -     SHOW_ENTITY - Updating Entity=247 CardID=TB_BaconShop_HP_038e',
    );
    expect(event).toMatchObject({
      type: 'showEntity',
      entity: { kind: 'id', id: 247 },
      cardId: 'TB_BaconShop_HP_038e',
    });
  });

  it('lit CHANGE_ENTITY : c’est ainsi qu’un bibelot prend sa carte definitive', () => {
    const event = parseLine(
      'D 02:55:11.5507405 GameState.DebugPrintPower() - CHANGE_ENTITY - Updating Entity=[entityName=Bibelot inférieur id=321 zone=PLAY zonePos=0 cardId=BG30_Trinket_1st player=7] CardID=BG30_MagicItem_547',
    );
    expect(event).toMatchObject({
      type: 'changeEntity',
      entity: { kind: 'entity', id: 321, cardId: 'BG30_Trinket_1st' },
      cardId: 'BG30_MagicItem_547',
    });
  });

  it('lit HIDE_ENTITY', () => {
    const event = parseLine(
      'D 02:49:36.9657942 GameState.DebugPrintPower() -         HIDE_ENTITY - Entity=[entityName= id=513 zone=PLAY zonePos=0 cardId=TB_BaconShopBadsongE player=7] tag=ZONE value=REMOVEDFROMGAME',
    );
    expect(event).toMatchObject({
      type: 'hideEntity',
      entity: { kind: 'entity', id: 513 },
      tag: 'ZONE',
      value: 'REMOVEDFROMGAME',
    });
  });

  it('lit TAG_CHANGE sur GameEntity', () => {
    const event = parseLine(
      'D 02:49:01.0842210 GameState.DebugPrintPower() -     TAG_CHANGE Entity=GameEntity tag=TURN value=1',
    );
    expect(event).toMatchObject({
      type: 'tagChange',
      entity: { kind: 'name', name: 'GameEntity' },
      tag: 'TURN',
      value: '1',
      suffix: null,
    });
  });

  it('lit TAG_CHANGE sur un nom a espaces', () => {
    const event = parseLine(
      'D 02:49:01.0842210 GameState.DebugPrintPower() -     TAG_CHANGE Entity=Bob le barman tag=NUM_TURNS_IN_PLAY value=1',
    );
    expect(event).toMatchObject({
      type: 'tagChange',
      entity: { kind: 'name', name: 'Bob le barman' },
      tag: 'NUM_TURNS_IN_PLAY',
    });
  });

  it('isole le suffixe DEF CHANGE au lieu de le coller a la valeur', () => {
    const event = parseLine(
      'D 02:53:32.5378968 GameState.DebugPrintPower() -                 TAG_CHANGE Entity=2542 tag=1475 value=3 DEF CHANGE',
    );
    expect(event).toMatchObject({
      type: 'tagChange',
      entity: { kind: 'id', id: 2542 },
      tag: '1475',
      value: '3',
      suffix: 'DEF CHANGE',
    });
  });

  it('lit BLOCK_START sans cible', () => {
    const event = parseLine(
      'D 02:56:33.9130229 GameState.DebugPrintPower() - BLOCK_START BlockType=TRIGGER Entity=LazyTurtle EffectCardId=System.Collections.Generic.List`1[System.String] EffectIndex=-1 Target=0 SubOption=-1 TriggerKeyword=TAG_NOT_SET',
    );
    expect(event).toMatchObject({
      type: 'blockStart',
      blockType: 'TRIGGER',
      entity: { kind: 'name', name: 'LazyTurtle' },
      effectCardId: 'System.Collections.Generic.List`1[System.String]',
      effectIndex: -1,
      target: null,
      subOption: -1,
      triggerKeyword: 'TAG_NOT_SET',
    });
  });

  it('lit BLOCK_START dont la cible est un bloc d’entite : c’est un achat', () => {
    const event = parseLine(
      'D 02:49:35.9154182 GameState.DebugPrintPower() - BLOCK_START BlockType=PLAY Entity=[entityName=Faire glisser pour acheter id=331 zone=PLAY zonePos=0 cardId=TB_BaconShop_DragBuy player=7] EffectCardId=System.Collections.Generic.List`1[System.String] EffectIndex=0 Target=[entityName=Liche inoffensive id=330 zone=PLAY zonePos=2 cardId=BG28_300 player=15] SubOption=-1',
    );
    expect(event).toMatchObject({
      type: 'blockStart',
      blockType: 'PLAY',
      entity: { kind: 'entity', cardId: 'TB_BaconShop_DragBuy' },
      target: { kind: 'entity', id: 330, cardId: 'BG28_300' },
      triggerKeyword: null,
    });
  });

  it('lit BLOCK_END', () => {
    expect(parseLine('D 02:48:30.3211164 GameState.DebugPrintPower() - BLOCK_END')).toMatchObject({
      type: 'blockEnd',
    });
  });
});

describe('parseLine : DebugPrintGame', () => {
  it('lit une metadonnee simple', () => {
    expect(
      parseLine('D 02:48:30.3211164 GameState.DebugPrintGame() - BuildNumber=251952'),
    ).toMatchObject({ type: 'gameMeta', key: 'BuildNumber', value: '251952', source: 'game' });
    expect(
      parseLine('D 02:48:30.3211164 GameState.DebugPrintGame() - GameType=GT_BATTLEGROUNDS'),
    ).toMatchObject({ type: 'gameMeta', key: 'GameType', value: 'GT_BATTLEGROUNDS' });
  });

  it('lit un couple PlayerID / PlayerName', () => {
    expect(
      parseLine(
        'D 02:48:30.3211164 GameState.DebugPrintGame() - PlayerID=15, PlayerName=МиниНиндзя',
      ),
    ).toMatchObject({ type: 'playerMeta', playerId: 15, playerName: 'МиниНиндзя' });
  });
});

describe('parseLine : choix', () => {
  it('lit l’en-tete d’un choix', () => {
    expect(
      parseLine(
        'D 02:55:10.5031264 GameState.DebugPrintEntityChoices() - id=3 Player=AkiLif#2498 TaskList=1618 ChoiceType=GENERAL CountMin=1 CountMax=1',
      ),
    ).toMatchObject({
      type: 'choicesOffered',
      id: 3,
      player: 'AkiLif#2498',
      taskList: 1618,
      choiceType: 'GENERAL',
      countMin: 1,
      countMax: 1,
      source: 'choices',
    });
  });

  it('accepte un TaskList vide, observe sur le MULLIGAN', () => {
    // Ligne tiree de Hearthstone_2026_09_22_00_28_13/Power.log.
    expect(
      parseLine(
        'D 00:32:03.9974557 GameState.DebugPrintEntityChoices() - id=1 Player=AkiLif#2498 TaskList= ChoiceType=MULLIGAN CountMin=1 CountMax=1',
      ),
    ).toMatchObject({ type: 'choicesOffered', id: 1, taskList: null, choiceType: 'MULLIGAN' });
  });

  it('lit la source d’un choix', () => {
    expect(
      parseLine(
        'D 02:55:10.5031264 GameState.DebugPrintEntityChoices() -   Source=[entityName=Bibelot inférieur id=321 zone=PLAY zonePos=0 cardId=BG30_Trinket_1st player=7]',
      ),
    ).toMatchObject({
      type: 'choiceSource',
      entity: { kind: 'entity', cardId: 'BG30_Trinket_1st' },
    });
  });

  it('lit une source qui n’est qu’un nom, comme au mulligan', () => {
    expect(
      parseLine('D 02:48:39.2686715 GameState.DebugPrintEntityChoices() -   Source=GameEntity'),
    ).toMatchObject({ type: 'choiceSource', entity: { kind: 'name', name: 'GameEntity' } });
  });

  it('lit une option proposee', () => {
    expect(
      parseLine(
        'D 02:48:39.2686715 GameState.DebugPrintEntityChoices() -   Entities[2]=[entityName=Maître-éclaireur Tavish id=89 zone=HAND zonePos=1 cardId=BG22_HERO_000_SKIN_A player=7]',
      ),
    ).toMatchObject({
      type: 'choiceEntity',
      index: 2,
      entity: { kind: 'entity', id: 89, cardId: 'BG22_HERO_000_SKIN_A' },
      source: 'choices',
    });
  });

  it('lit l’en-tete de SendChoices', () => {
    expect(
      parseLine('D 02:48:57.2027884 GameState.SendChoices() - id=1 ChoiceType=MULLIGAN'),
    ).toMatchObject({ type: 'choiceMade', id: 1, choiceType: 'MULLIGAN', source: 'sendChoices' });
  });

  it('lit l’entite retenue', () => {
    expect(
      parseLine(
        'D 02:48:57.2027884 GameState.SendChoices() -   m_chosenEntities[0]=[entityName=Maître-éclaireur Tavish id=89 zone=HAND zonePos=3 cardId=BG22_HERO_000_SKIN_A player=7]',
      ),
    ).toMatchObject({
      type: 'choiceChosen',
      index: 0,
      entity: { kind: 'entity', id: 89, cardId: 'BG22_HERO_000_SKIN_A' },
    });
  });

  it('distingue DebugPrintEntitiesChosen par sa source, a ligne identique', () => {
    const chosen = parseLine(
      'D 02:48:57.2027884 GameState.DebugPrintEntitiesChosen() -   Entities[0]=[entityName=Maître-éclaireur Tavish id=89 zone=HAND zonePos=3 cardId=BG22_HERO_000_SKIN_A player=7]',
    );
    expect(chosen).toMatchObject({ type: 'choiceEntity', index: 0, source: 'entitiesChosen' });

    expect(
      parseLine(
        'D 02:48:57.2027884 GameState.DebugPrintEntitiesChosen() - id=1 Player=AkiLif#2498 EntitiesCount=1',
      ),
    ).toMatchObject({ type: 'entitiesChosen', id: 1, player: 'AkiLif#2498', count: 1 });
  });
});

describe('parseLine : options', () => {
  it('lit l’en-tete d’une liste d’options', () => {
    expect(parseLine('D 02:49:01.3347131 GameState.DebugPrintOptions() - id=1')).toMatchObject({
      type: 'optionsOffered',
      id: 1,
      source: 'options',
    });
  });

  it('lit une option sans entite principale', () => {
    expect(
      parseLine(
        'D 02:49:01.3347131 GameState.DebugPrintOptions() - option 0 type=END_TURN mainEntity= error=INVALID errorParam=',
      ),
    ).toMatchObject({
      type: 'option',
      index: 0,
      optionType: 'END_TURN',
      mainEntity: null,
      error: 'INVALID',
      errorParam: '',
    });
  });

  it('lit une option et sa cible', () => {
    expect(
      parseLine(
        'D 02:49:01.3347131 GameState.DebugPrintOptions() - option 1 type=POWER mainEntity=[entityName=Prêt à tirer id=211 zone=PLAY zonePos=0 cardId=BG22_HERO_000p_Alt player=7] error=NONE errorParam=',
      ),
    ).toMatchObject({ type: 'option', index: 1, optionType: 'POWER', error: 'NONE' });

    expect(
      parseLine(
        'D 02:49:01.3347131 GameState.DebugPrintOptions() - target 1 entity=[entityName=Liche inoffensive id=330 zone=PLAY zonePos=2 cardId=BG28_300 player=15] error=NONE errorParam=',
      ),
    ).toMatchObject({ type: 'optionTarget', index: 1, entity: { kind: 'entity', id: 330 } });
  });

  it('lit une sous-option, quand une carte propose plusieurs effets', () => {
    // Ligne tiree de Hearthstone_2026_09_22_00_28_13/Power.log.
    expect(
      parseLine(
        'D 00:40:38.3779961 GameState.DebugPrintOptions() -     subOption 0 entity=[entityName=Bon appétit id=4713 zone=SETASIDE zonePos=0 cardId=BG30_123t player=15] error=NONE errorParam=',
      ),
    ).toMatchObject({
      type: 'optionSubOption',
      index: 0,
      entity: { kind: 'entity', id: 4713, cardId: 'BG30_123t' },
    });
  });

  it('lit l’action effectivement jouee', () => {
    expect(
      parseLine(
        'D 02:49:35.9154182 GameState.SendOption() - selectedOption=7 selectedSubOption=-1 selectedTarget=330 selectedPosition=0',
      ),
    ).toMatchObject({
      type: 'optionSent',
      selectedOption: 7,
      selectedSubOption: -1,
      selectedTarget: 330,
      selectedPosition: 0,
      source: 'sendOption',
    });
  });
});

describe('couverture sur le log de reference', () => {
  it('reconnait ou ecarte explicitement chacune des 141 637 lignes', async () => {
    const PREFIX = /^[A-Z] \d{2}:\d{2}:\d{2}\.\d+ GameState\.(\w+)\(\) - (.*)$/;
    const counts = new Map<string, number>();
    const unknown: string[] = [];
    let lines = 0;

    for await (const line of readSessionLines(await sampleSessionFolder())) {
      lines += 1;
      const event = parseLine(line);
      if (event !== null) {
        counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
        continue;
      }

      const match = PREFIX.exec(line);
      if (match === null) continue;
      if (isIgnoredSource(match[1]!) || isIgnoredBody(match[2]!.trimStart())) continue;
      if (unknown.length < 5) unknown.push(line);
    }

    expect(unknown).toEqual([]);
    expect(lines).toBe(SAMPLE_SESSION_LINE_COUNT);

    // Valeurs relevees a la main sur le log de reference.
    expect(Object.fromEntries(counts)).toEqual({
      tagChange: 63_355,
      tagDef: 46_802,
      optionTarget: 10_734,
      option: 4_513,
      blockEnd: 3_312,
      blockStart: 3_335,
      fullEntity: 2_451,
      showEntity: 1_196,
      hideEntity: 1_102,
      optionsOffered: 147,
      optionSent: 134,
      choiceEntity: 43,
      choicesOffered: 10,
      choiceSource: 10,
      choiceMade: 10,
      choiceChosen: 10,
      entitiesChosen: 10,
      gameMeta: 4,
      playerDef: 2,
      playerMeta: 2,
      changeEntity: 2,
      createGame: 1,
      gameEntityDef: 1,
    });
  });
});
