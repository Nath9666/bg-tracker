/**
 * LineParser : une ligne de `Power.log` -> un evenement type, ou `null`.
 *
 * Fonction pure et sans etat : elle ne connait ni la partie en cours, ni les
 * lignes precedentes. Toutes les expressions regulieres ci-dessous viennent de
 * formes reellement observees dans le log de reference (docs/LOG_FORMAT.md).
 *
 * Seules les lignes `GameState.*` sont retenues. `PowerTaskList` rejoue les
 * memes evenements pour l'animation : les prendre en compte doublerait tout.
 */
import type { EntityRef, LogEvent, LogEventMeta, LogEventSource } from './events.js';

/** `D 02:48:30.3211164 GameState.DebugPrintPower() - <indentation><corps>` */
const LINE = /^[A-Z] (\d{2}:\d{2}:\d{2}\.\d+) GameState\.(\w+)\(\) - (.*)$/;

const SOURCES: Readonly<Record<string, LogEventSource>> = {
  DebugPrintPower: 'power',
  DebugPrintGame: 'game',
  DebugPrintEntityChoices: 'choices',
  SendChoices: 'sendChoices',
  DebugPrintEntitiesChosen: 'entitiesChosen',
  DebugPrintOptions: 'options',
  SendOption: 'sendOption',
};

/**
 * Bloc detaille d'entite.
 *
 * Le nom peut contenir des crochets (`UNKNOWN ENTITY [cardType=INVALID]`,
 * `TagTransferPlayerEnchant [DNT]`), donc on ne peut pas se contenter de
 * chercher le premier `]`. On s'accroche a la suite de champs fixes, qui elle
 * ne varie jamais. `cardId` peut etre vide.
 */
const ENTITY_BLOCK =
  /^\[entityName=(.*) id=(-?\d+) zone=(\w*) zonePos=(-?\d+) cardId=(\S*) player=(-?\d+)\]$/;

const ONLY_DIGITS = /^-?\d+$/;

/**
 * Lit une reference a une entite sous l'une de ses trois formes.
 * Renvoie `null` pour une reference vide (`mainEntity=` sur `END_TURN`).
 */
export function parseEntityRef(raw: string): EntityRef | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  const block = ENTITY_BLOCK.exec(text);
  if (block !== null) {
    const [, entityName, id, zone, zonePos, cardId, player] = block as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return {
      kind: 'entity',
      id: Number(id),
      entityName,
      zone,
      zonePos: Number(zonePos),
      cardId,
      player: Number(player),
    };
  }

  if (ONLY_DIGITS.test(text)) return { kind: 'id', id: Number(text) };

  return { kind: 'name', name: text };
}

/** Identique, mais refuse une reference vide la ou le log en fournit toujours une. */
function requireEntityRef(raw: string): EntityRef {
  const ref = parseEntityRef(raw);
  if (ref === null) throw new Error(`Reference d'entite vide : ${JSON.stringify(raw)}`);
  return ref;
}

/**
 * Lit un `Target=`. Le log ecrit `Target=0` quand l'action n'a pas de cible :
 * aucune entite ne porte l'id 0, on le ramene donc a `null`.
 */
function parseTarget(raw: string): EntityRef | null {
  const ref = parseEntityRef(raw);
  return ref?.kind === 'id' && ref.id === 0 ? null : ref;
}

// --- Formes de lignes, par source -------------------------------------------

const CREATE_GAME = /^CREATE_GAME$/;
const GAME_ENTITY_DEF = /^GameEntity EntityID=(\d+)$/;
const PLAYER_DEF = /^Player EntityID=(\d+) PlayerID=(\d+) GameAccountId=\[hi=(\d+) lo=(\d+)\]$/;
const FULL_ENTITY = /^FULL_ENTITY - Creating ID=(\d+) CardID=(\S*)$/;
const SHOW_ENTITY = /^SHOW_ENTITY - Updating Entity=(.+) CardID=(\S*)$/;
const CHANGE_ENTITY = /^CHANGE_ENTITY - Updating Entity=(.+) CardID=(\S*)$/;
const HIDE_ENTITY = /^HIDE_ENTITY - Entity=(.+) tag=(\S+) value=(\S+)$/;
const TAG_DEF = /^tag=(\S+) value=(\S+)$/;
// Quelques lignes portent un suffixe libre apres la valeur, ex. `DEF CHANGE`.
const TAG_CHANGE = /^TAG_CHANGE Entity=(.+) tag=(\S+) value=(\S+)(?: (.+))?$/;
// `Target=` vaut `0` quand il n'y a pas de cible, mais porte un bloc d'entite
// complet sur les actions ciblees (achat, pose, pouvoir heroique).
const BLOCK_START =
  /^BLOCK_START BlockType=(\S+) Entity=(.*) EffectCardId=(\S*) EffectIndex=(-?\d+) Target=(.*) SubOption=(-?\d+)(?: TriggerKeyword=(\S+))?$/;
const BLOCK_END = /^BLOCK_END$/;

const PLAYER_META = /^PlayerID=(\d+), PlayerName=(.*)$/;
const GAME_META = /^(\w+)=(.*)$/;

const CHOICES_OFFERED =
  /^id=(\d+) Player=(.+) TaskList=(\d*) ChoiceType=(\S+) CountMin=(\d+) CountMax=(\d+)$/;
const CHOICE_SOURCE = /^Source=(.+)$/;
const CHOICE_ENTITY = /^Entities\[(\d+)\]=(.+)$/;
const CHOICE_MADE = /^id=(\d+) ChoiceType=(\S+)$/;
const CHOICE_CHOSEN = /^m_chosenEntities\[(\d+)\]=(.+)$/;
const ENTITIES_CHOSEN = /^id=(\d+) Player=(.+) EntitiesCount=(\d+)$/;

const OPTIONS_OFFERED = /^id=(\d+)$/;
const OPTION = /^option (\d+) type=(\S+) mainEntity=(.*) error=(\S+) errorParam=(.*)$/;
const OPTION_TARGET = /^target (\d+) entity=(.*) error=(\S+) errorParam=(.*)$/;
const OPTION_SUB = /^subOption (\d+) entity=(.*) error=(\S+) errorParam=(.*)$/;
const OPTION_SENT =
  /^selectedOption=(-?\d+) selectedSubOption=(-?\d+) selectedTarget=(-?\d+) selectedPosition=(-?\d+)$/;

/**
 * Methodes `GameState.*` connues mais sans interet.
 *
 * - `DebugPrintPowerList` n'annonce qu'un nombre de lignes a suivre.
 * - `OnEntityChoices` signale qu'un choix est mis en file ; `DebugPrintEntityChoices`
 *   le detaille juste apres. Une seule ligne sur une session de six parties.
 */
const IGNORED_SOURCES = new Set(['DebugPrintPowerList', 'OnEntityChoices']);

/** Une methode `GameState.*` connue, mais dont les lignes ne servent a rien. */
export function isIgnoredSource(method: string): boolean {
  return IGNORED_SOURCES.has(method);
}

/**
 * Lignes reconnues mais volontairement ignorees : elles ne servent ni au
 * modele d'entites, ni au resume de partie. Les lister explicitement permet
 * de distinguer « connu et sans interet » de « forme inattendue », et de le
 * verifier par un test sur le log complet.
 */
const IGNORED = [
  /^META_DATA - Meta=/,
  /^SUB_SPELL_START - /,
  /^SUB_SPELL_END$/,
  // Attention : ces trois formes ecrivent ' = ' avec des espaces, contrairement
  // a tout le reste du log.
  /^Info\[\d+\] = /,
  /^Source = /,
  /^Targets\[\d+\] = /,
  /^Count=\d+$/,
];

/** Une ligne connue mais sans interet pour le tracker. */
export function isIgnoredBody(body: string): boolean {
  return IGNORED.some((pattern) => pattern.test(body));
}

// --- Parsing par source ------------------------------------------------------

function parsePower(body: string, meta: LogEventMeta): LogEvent | null {
  if (CREATE_GAME.test(body)) return { ...meta, type: 'createGame' };
  if (BLOCK_END.test(body)) return { ...meta, type: 'blockEnd' };

  const tagChange = TAG_CHANGE.exec(body);
  if (tagChange !== null) {
    return {
      ...meta,
      type: 'tagChange',
      entity: requireEntityRef(tagChange[1]!),
      tag: tagChange[2]!,
      value: tagChange[3]!,
      suffix: tagChange[4] ?? null,
    };
  }

  const tagDef = TAG_DEF.exec(body);
  if (tagDef !== null) {
    return { ...meta, type: 'tagDef', tag: tagDef[1]!, value: tagDef[2]! };
  }

  const fullEntity = FULL_ENTITY.exec(body);
  if (fullEntity !== null) {
    return { ...meta, type: 'fullEntity', id: Number(fullEntity[1]), cardId: fullEntity[2]! };
  }

  const showEntity = SHOW_ENTITY.exec(body);
  if (showEntity !== null) {
    return {
      ...meta,
      type: 'showEntity',
      entity: requireEntityRef(showEntity[1]!),
      cardId: showEntity[2]!,
    };
  }

  const changeEntity = CHANGE_ENTITY.exec(body);
  if (changeEntity !== null) {
    return {
      ...meta,
      type: 'changeEntity',
      entity: requireEntityRef(changeEntity[1]!),
      cardId: changeEntity[2]!,
    };
  }

  const hideEntity = HIDE_ENTITY.exec(body);
  if (hideEntity !== null) {
    return {
      ...meta,
      type: 'hideEntity',
      entity: requireEntityRef(hideEntity[1]!),
      tag: hideEntity[2]!,
      value: hideEntity[3]!,
    };
  }

  const blockStart = BLOCK_START.exec(body);
  if (blockStart !== null) {
    return {
      ...meta,
      type: 'blockStart',
      blockType: blockStart[1]!,
      entity: parseEntityRef(blockStart[2]!),
      effectCardId: blockStart[3]!,
      effectIndex: Number(blockStart[4]),
      target: parseTarget(blockStart[5]!),
      subOption: Number(blockStart[6]),
      triggerKeyword: blockStart[7] ?? null,
    };
  }

  const gameEntity = GAME_ENTITY_DEF.exec(body);
  if (gameEntity !== null) {
    return { ...meta, type: 'gameEntityDef', id: Number(gameEntity[1]) };
  }

  const player = PLAYER_DEF.exec(body);
  if (player !== null) {
    return {
      ...meta,
      type: 'playerDef',
      entityId: Number(player[1]),
      playerId: Number(player[2]),
      gameAccountHi: player[3]!,
      gameAccountLo: player[4]!,
    };
  }

  return null;
}

function parseGame(body: string, meta: LogEventMeta): LogEvent | null {
  const player = PLAYER_META.exec(body);
  if (player !== null) {
    return { ...meta, type: 'playerMeta', playerId: Number(player[1]), playerName: player[2]! };
  }

  const gameMeta = GAME_META.exec(body);
  if (gameMeta !== null) {
    return { ...meta, type: 'gameMeta', key: gameMeta[1]!, value: gameMeta[2]! };
  }

  return null;
}

function parseChoices(body: string, meta: LogEventMeta): LogEvent | null {
  const offered = CHOICES_OFFERED.exec(body);
  if (offered !== null) {
    return {
      ...meta,
      type: 'choicesOffered',
      id: Number(offered[1]),
      player: offered[2]!,
      taskList: offered[3]!.length > 0 ? Number(offered[3]) : null,
      choiceType: offered[4]!,
      countMin: Number(offered[5]),
      countMax: Number(offered[6]),
    };
  }

  const source = CHOICE_SOURCE.exec(body);
  if (source !== null) {
    return { ...meta, type: 'choiceSource', entity: requireEntityRef(source[1]!) };
  }

  const entity = CHOICE_ENTITY.exec(body);
  if (entity !== null) {
    return {
      ...meta,
      type: 'choiceEntity',
      index: Number(entity[1]),
      entity: requireEntityRef(entity[2]!),
    };
  }

  return null;
}

function parseSendChoices(body: string, meta: LogEventMeta): LogEvent | null {
  const made = CHOICE_MADE.exec(body);
  if (made !== null) {
    return { ...meta, type: 'choiceMade', id: Number(made[1]), choiceType: made[2]! };
  }

  const chosen = CHOICE_CHOSEN.exec(body);
  if (chosen !== null) {
    return {
      ...meta,
      type: 'choiceChosen',
      index: Number(chosen[1]),
      entity: requireEntityRef(chosen[2]!),
    };
  }

  return null;
}

function parseEntitiesChosen(body: string, meta: LogEventMeta): LogEvent | null {
  const header = ENTITIES_CHOSEN.exec(body);
  if (header !== null) {
    return {
      ...meta,
      type: 'entitiesChosen',
      id: Number(header[1]),
      player: header[2]!,
      count: Number(header[3]),
    };
  }

  const entity = CHOICE_ENTITY.exec(body);
  if (entity !== null) {
    return {
      ...meta,
      type: 'choiceEntity',
      index: Number(entity[1]),
      entity: requireEntityRef(entity[2]!),
    };
  }

  return null;
}

function parseOptions(body: string, meta: LogEventMeta): LogEvent | null {
  const option = OPTION.exec(body);
  if (option !== null) {
    return {
      ...meta,
      type: 'option',
      index: Number(option[1]),
      optionType: option[2]!,
      mainEntity: parseEntityRef(option[3]!),
      error: option[4]!,
      errorParam: option[5]!,
    };
  }

  const target = OPTION_TARGET.exec(body);
  if (target !== null) {
    return {
      ...meta,
      type: 'optionTarget',
      index: Number(target[1]),
      entity: parseEntityRef(target[2]!),
      error: target[3]!,
      errorParam: target[4]!,
    };
  }

  const sub = OPTION_SUB.exec(body);
  if (sub !== null) {
    return {
      ...meta,
      type: 'optionSubOption',
      index: Number(sub[1]),
      entity: parseEntityRef(sub[2]!),
      error: sub[3]!,
      errorParam: sub[4]!,
    };
  }

  const offered = OPTIONS_OFFERED.exec(body);
  if (offered !== null) {
    return { ...meta, type: 'optionsOffered', id: Number(offered[1]) };
  }

  return null;
}

function parseSendOption(body: string, meta: LogEventMeta): LogEvent | null {
  const sent = OPTION_SENT.exec(body);
  if (sent === null) return null;

  return {
    ...meta,
    type: 'optionSent',
    selectedOption: Number(sent[1]),
    selectedSubOption: Number(sent[2]),
    selectedTarget: Number(sent[3]),
    selectedPosition: Number(sent[4]),
  };
}

/**
 * Transforme une ligne de log en evenement type.
 *
 * Renvoie `null` si la ligne n'est pas une ligne `GameState.*`, ou si sa forme
 * n'est pas exploitee (voir `isIgnoredBody`).
 */
export function parseLine(line: string): LogEvent | null {
  const match = LINE.exec(line);
  if (match === null) return null;

  const source = SOURCES[match[2]!];
  if (source === undefined) return null;

  const raw = match[3]!;
  const body = raw.trimStart();
  const meta: LogEventMeta = {
    timestamp: match[1]!,
    indent: raw.length - body.length,
    source,
  };

  switch (source) {
    case 'power':
      return parsePower(body, meta);
    case 'game':
      return parseGame(body, meta);
    case 'choices':
      return parseChoices(body, meta);
    case 'sendChoices':
      return parseSendChoices(body, meta);
    case 'entitiesChosen':
      return parseEntitiesChosen(body, meta);
    case 'options':
      return parseOptions(body, meta);
    case 'sendOption':
      return parseSendOption(body, meta);
  }
}
