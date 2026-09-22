/**
 * Evenements produits par le LineParser.
 *
 * L'union est volontairement proche du log : un type d'evenement par forme de
 * ligne reellement observee dans `Power.log` (voir docs/LOG_FORMAT.md). C'est
 * au GameStateMachine, ensuite, d'en tirer du sens.
 */

/**
 * Reference a une entite. Le log utilise trois formes, decrites dans
 * docs/LOG_FORMAT.md :
 *
 * - `Entity=19` -> `{ kind: 'id' }`
 * - `Entity=AkiLif#2498`, `Entity=GameEntity`, `Entity=Bob le barman` -> `{ kind: 'name' }`
 * - `Entity=[entityName=... id=89 zone=PLAY zonePos=0 cardId=... player=7]` -> `{ kind: 'entity' }`
 */
export type EntityRef =
  | { kind: 'id'; id: number }
  | { kind: 'name'; name: string }
  | {
      kind: 'entity';
      id: number;
      entityName: string;
      zone: string;
      zonePos: number;
      /** Vide quand la carte est cachee au joueur. */
      cardId: string;
      player: number;
    };

/** Methode `GameState.*` qui a produit la ligne. */
export type LogEventSource =
  /** `GameState.DebugPrintPower()` */
  | 'power'
  /** `GameState.DebugPrintGame()` */
  | 'game'
  /** `GameState.DebugPrintEntityChoices()` */
  | 'choices'
  /** `GameState.SendChoices()` */
  | 'sendChoices'
  /** `GameState.DebugPrintEntitiesChosen()` */
  | 'entitiesChosen'
  /** `GameState.DebugPrintOptions()` */
  | 'options'
  /** `GameState.SendOption()` */
  | 'sendOption';

export interface LogEventMeta {
  /** Heure locale telle qu'ecrite dans le log, ex. `02:48:30.3211164`. Sans date. */
  timestamp: string;
  /** Nombre d'espaces d'indentation : profondeur d'imbrication de la ligne. */
  indent: number;
  source: LogEventSource;
}

/** `CREATE_GAME` : debut d'une partie. */
export interface CreateGameEvent extends LogEventMeta {
  type: 'createGame';
}

/** `GameEntity EntityID=19`, juste apres `CREATE_GAME`. */
export interface GameEntityDefEvent extends LogEventMeta {
  type: 'gameEntityDef';
  id: number;
}

/** `Player EntityID=20 PlayerID=7 GameAccountId=[hi=... lo=...]`. */
export interface PlayerDefEvent extends LogEventMeta {
  type: 'playerDef';
  entityId: number;
  playerId: number;
  /** `hi=0 lo=0` designe le joueur fictif, pas l'utilisateur. */
  gameAccountHi: string;
  gameAccountLo: string;
}

/** `FULL_ENTITY - Creating ID=37 CardID=TB_BaconShop_HERO_PH`. */
export interface FullEntityEvent extends LogEventMeta {
  type: 'fullEntity';
  id: number;
  cardId: string;
}

/** `SHOW_ENTITY - Updating Entity=[...] CardID=...` : revele une carte cachee. */
export interface ShowEntityEvent extends LogEventMeta {
  type: 'showEntity';
  entity: EntityRef;
  cardId: string;
}

/** `CHANGE_ENTITY - Updating Entity=[...] CardID=...` : transforme une carte en une autre. */
export interface ChangeEntityEvent extends LogEventMeta {
  type: 'changeEntity';
  entity: EntityRef;
  cardId: string;
}

/** `HIDE_ENTITY - Entity=[...] tag=ZONE value=PLAY`. */
export interface HideEntityEvent extends LogEventMeta {
  type: 'hideEntity';
  entity: EntityRef;
  tag: string;
  value: string;
}

/** `tag=ATK value=3` : tag indente sous une creation d'entite. */
export interface TagDefEvent extends LogEventMeta {
  type: 'tagDef';
  tag: string;
  value: string;
}

/** `TAG_CHANGE Entity=<ref> tag=RESOURCES value=3`. */
export interface TagChangeEvent extends LogEventMeta {
  type: 'tagChange';
  entity: EntityRef;
  tag: string;
  value: string;
  /** Suffixe libre observe sur quelques lignes, ex. `DEF CHANGE`. */
  suffix: string | null;
}

/** `BLOCK_START BlockType=TRIGGER Entity=<ref> EffectCardId=... EffectIndex=0 Target=0 SubOption=-1 [TriggerKeyword=...]`. */
export interface BlockStartEvent extends LogEventMeta {
  type: 'blockStart';
  blockType: string;
  entity: EntityRef | null;
  effectCardId: string;
  effectIndex: number;
  /** Cible de l'action. `null` quand le log ecrit `Target=0`. */
  target: EntityRef | null;
  subOption: number;
  /** Absent sur une partie des lignes. */
  triggerKeyword: string | null;
}

/** `BLOCK_END`. */
export interface BlockEndEvent extends LogEventMeta {
  type: 'blockEnd';
}

/** `DebugPrintGame` : `BuildNumber=251952`, `GameType=GT_BATTLEGROUNDS`... */
export interface GameMetaEvent extends LogEventMeta {
  type: 'gameMeta';
  key: string;
  value: string;
}

/** `DebugPrintGame` : `PlayerID=7, PlayerName=AkiLif#2498`. */
export interface PlayerMetaEvent extends LogEventMeta {
  type: 'playerMeta';
  playerId: number;
  playerName: string;
}

/** En-tete d'un choix propose : `id=3 Player=... TaskList=1618 ChoiceType=GENERAL CountMin=1 CountMax=1`. */
export interface ChoicesOfferedEvent extends LogEventMeta {
  type: 'choicesOffered';
  id: number;
  player: string;
  /** `null` : le log ecrit parfois `TaskList=` vide sur le MULLIGAN. */
  taskList: number | null;
  /** `MULLIGAN` pour le choix du heros, `GENERAL` pour les decouvertes. */
  choiceType: string;
  countMin: number;
  countMax: number;
}

/** `Source=[...]` d'un choix : la carte qui declenche la decouverte. */
export interface ChoiceSourceEvent extends LogEventMeta {
  type: 'choiceSource';
  entity: EntityRef;
}

/**
 * `Entities[0]=[...]`. La source distingue les deux cas : `choices` pour les
 * options proposees, `entitiesChosen` pour celles finalement retenues.
 */
export interface ChoiceEntityEvent extends LogEventMeta {
  type: 'choiceEntity';
  index: number;
  entity: EntityRef;
}

/** `SendChoices` : `id=1 ChoiceType=MULLIGAN`. */
export interface ChoiceMadeEvent extends LogEventMeta {
  type: 'choiceMade';
  id: number;
  choiceType: string;
}

/** `SendChoices` : `m_chosenEntities[0]=[...]`, l'option retenue. */
export interface ChoiceChosenEvent extends LogEventMeta {
  type: 'choiceChosen';
  index: number;
  entity: EntityRef;
}

/** `DebugPrintEntitiesChosen` : `id=1 Player=AkiLif#2498 EntitiesCount=1`. */
export interface EntitiesChosenEvent extends LogEventMeta {
  type: 'entitiesChosen';
  id: number;
  player: string;
  count: number;
}

/** `DebugPrintOptions` : `id=1`, en-tete d'une liste d'actions possibles. */
export interface OptionsOfferedEvent extends LogEventMeta {
  type: 'optionsOffered';
  id: number;
}

/** `option 1 type=POWER mainEntity=[...] error=NONE errorParam=`. */
export interface OptionEvent extends LogEventMeta {
  type: 'option';
  index: number;
  optionType: string;
  /** `null` quand `mainEntity=` est vide, comme sur `END_TURN`. */
  mainEntity: EntityRef | null;
  error: string;
  errorParam: string;
}

/** `target 0 entity=[...] error=NONE errorParam=` : cible possible de l'option precedente. */
export interface OptionTargetEvent extends LogEventMeta {
  type: 'optionTarget';
  index: number;
  entity: EntityRef | null;
  error: string;
  errorParam: string;
}

/**
 * `subOption 0 entity=[...] error=NONE errorParam=` : variante d'une option,
 * quand une carte propose plusieurs effets (ex. `Bon appetit` / `A table`).
 */
export interface OptionSubOptionEvent extends LogEventMeta {
  type: 'optionSubOption';
  index: number;
  entity: EntityRef | null;
  error: string;
  errorParam: string;
}

/** `SendOption` : `selectedOption=7 selectedSubOption=-1 selectedTarget=330 selectedPosition=0`. */
export interface OptionSentEvent extends LogEventMeta {
  type: 'optionSent';
  selectedOption: number;
  selectedSubOption: number;
  selectedTarget: number;
  selectedPosition: number;
}

export type LogEvent =
  | CreateGameEvent
  | GameEntityDefEvent
  | PlayerDefEvent
  | FullEntityEvent
  | ShowEntityEvent
  | ChangeEntityEvent
  | HideEntityEvent
  | TagDefEvent
  | TagChangeEvent
  | BlockStartEvent
  | BlockEndEvent
  | GameMetaEvent
  | PlayerMetaEvent
  | ChoicesOfferedEvent
  | ChoiceSourceEvent
  | ChoiceEntityEvent
  | ChoiceMadeEvent
  | ChoiceChosenEvent
  | EntitiesChosenEvent
  | OptionsOfferedEvent
  | OptionEvent
  | OptionTargetEvent
  | OptionSubOptionEvent
  | OptionSentEvent;
