/**
 * GameExtractor : etat de partie + evenements -> `GameSummary`.
 *
 * Certaines valeurs ne se lisent pas dans l'etat final. Le tour d'une montee de
 * palier, par exemple, n'existe qu'au moment ou elle se produit. L'extracteur
 * suit donc le flux d'evenements en parallele du `GameStateMachine`, et ne
 * conclut qu'a la fin de la partie.
 */
import type { LogEvent, EntityRef } from '../parser/events.js';
import { parseLine } from '../parser/line-parser.js';
import { GameStateMachine, type Game } from '../state/game-state.js';
import type {
  BoardMinion,
  CombatResult,
  DecisionAction,
  DecisionRecord,
  GameSummary,
  PickRecord,
  TierUp,
  TurnRecord,
} from '../types.js';
import { LogClock } from './log-clock.js';

/** Seules les parties de Champs de bataille nous interessent. */
export const BATTLEGROUNDS = 'GT_BATTLEGROUNDS';

/** `ChoiceType` du choix de heros, en debut de partie. */
const MULLIGAN = 'MULLIGAN';

/**
 * Tour de jeu a partir du compteur `TURN`.
 *
 * `TURN` avance a chaque phase, recrutement puis combat : deux crans par tour.
 */
export function gameTurn(turn: number): number {
  return Math.floor((turn + 1) / 2);
}

/**
 * Cartes support qui designent une action de boutique.
 *
 * Le log ne distingue que `POWER` et `END_TURN` : c'est la carte portant
 * l'option qui dit ce que le joueur a fait.
 */
const ACTION_CARDS: ReadonlyArray<readonly [RegExp, DecisionAction]> = [
  [/^TB_BaconShop_DragBuy_Spell$/, 'buySpell'],
  [/^TB_BaconShop_DragBuy$/, 'buy'],
  [/^TB_BaconShop_DragSell$/, 'sell'],
  [/Reroll_Button$/, 'reroll'],
  [/LockAll_Button$/, 'freeze'],
  [/^TB_BaconShopTechUp/, 'tierUp'],
];

/**
 * Nature d'une action, d'apres sa carte support.
 *
 * `cardType` sert au seul cas que la carte ne trahit pas : le pouvoir heroique,
 * dont le `cardId` change avec le heros.
 */
export function decisionAction(cardId: string, cardType: string | undefined): DecisionAction {
  for (const [pattern, action] of ACTION_CARDS) {
    if (pattern.test(cardId)) return action;
  }
  if (cardType === 'HERO_POWER') return 'heroPower';
  return cardId.length === 0 ? 'other' : 'play';
}

/** Une option proposee, retenue jusqu'a ce que le joueur en choisisse une. */
interface OfferedOption {
  cardId: string;
  entityId: number | null;
}

/** Choix en cours de construction, rempli au fil des lignes. */
interface ChoiceInProgress {
  id: number;
  choiceType: string;
  /** Tour de jeu au moment ou le choix a ete propose. */
  turn: number | null;
  sourceCardId: string;
  options: string[];
  chosen: string | null;
}

/** Combat commence, dont on attend l'issue. */
interface PendingCombat {
  turn: number;
  tavernTier: number | null;
  gold: number | null;
  /** Armure et degats cumules juste avant le combat, pour en deduire la perte. */
  armorBefore: number;
  damageBefore: number;
  opponentHero: string | null;
  board: BoardMinion[];
}

/** Ce qui doit etre observe au vol, faute d'exister dans l'etat final. */
interface Accumulator {
  startedAt: string | null;
  /** Dernier compteur `TURN` vu sur l'entite de jeu. */
  turn: number;
  tierUps: TierUp[];
  lastTier: number;
  choices: Map<number, ChoiceInProgress>;
  /** Identifiant du choix dont `SendChoices` annonce la reponse. */
  answering: number | null;
  turns: TurnRecord[];
  decisions: DecisionRecord[];
  /** Options du lot courant, par index. */
  options: Map<number, OfferedOption>;
  combat: PendingCombat | null;
  inCombat: boolean;
  /** Or total du tour, lu sur le joueur. */
  gold: number | null;
  /**
   * Entite heros du mandataire hors combat, c'est-a-dire Bob.
   *
   * Pendant un combat, le mandataire prend le heros de l'adversaire : toute
   * autre valeur que celle-ci designe donc l'adversaire du tour.
   */
  bobEntityId: number | null;
}

function newAccumulator(): Accumulator {
  return {
    startedAt: null,
    turn: 0,
    // Tout le monde commence au palier 1 : ce n'est pas une montee.
    lastTier: 1,
    tierUps: [],
    choices: new Map(),
    answering: null,
    turns: [],
    decisions: [],
    options: new Map(),
    combat: null,
    inCombat: false,
    gold: null,
    bobEntityId: null,
  };
}

export interface ExtractOptions {
  /**
   * Date et heure de lancement de la session, tirees du nom du dossier.
   * Les lignes ne portent que l'heure, c'est la seule source de la date.
   */
  sessionDate: Date;
}

export class GameExtractor {
  readonly #machine: GameStateMachine;
  readonly #clock: LogClock;
  #accumulator: Accumulator | null = null;

  constructor(options: ExtractOptions, onGame: (summary: GameSummary) => void) {
    this.#clock = new LogClock(options.sessionDate);
    this.#machine = new GameStateMachine({
      onGameStart: () => {
        this.#accumulator = newAccumulator();
      },
      onGameEnd: (game) => {
        const accumulator = this.#accumulator;
        this.#accumulator = null;
        if (accumulator === null) return;

        // La partie s'arrete pendant le dernier combat quand le joueur est
        // elimine : ce combat n'a pas de fin de phase, on le cloture ici.
        if (accumulator.combat !== null) this.#endCombat(game, accumulator);

        // Les autres modes de jeu passent par les memes lignes : on les ecarte.
        if (game.meta.get('GameType') !== BATTLEGROUNDS) return;
        onGame(this.#summarize(game, accumulator));
      },
    });
  }

  apply(event: LogEvent): void {
    // L'etat doit etre a jour avant qu'on l'interroge : c'est lui qui resout
    // les references et qui connait l'entite heros du joueur.
    this.#machine.apply(event);

    const accumulator = this.#accumulator;
    const game = this.#machine.current;
    if (accumulator === null || game === null) return;

    accumulator.startedAt ??= this.#clock.toIso(event.timestamp);

    switch (event.type) {
      case 'tagChange':
        this.#observeTagChange(event.entity, event.tag, event.value, game, accumulator);
        break;

      case 'choicesOffered':
        accumulator.choices.set(event.id, {
          id: event.id,
          choiceType: event.choiceType,
          turn: accumulator.turn > 0 ? gameTurn(accumulator.turn) : null,
          sourceCardId: '',
          options: [],
          chosen: null,
        });
        accumulator.answering = event.id;
        break;

      case 'choiceSource': {
        const choice = accumulator.choices.get(accumulator.answering ?? -1);
        if (choice !== undefined) choice.sourceCardId = cardIdOf(event.entity, game);
        break;
      }

      case 'choiceEntity': {
        // `DebugPrintEntitiesChosen` reprend la meme forme de ligne que les
        // options proposees : seule la source les distingue.
        if (event.source !== 'choices') break;
        const choice = accumulator.choices.get(accumulator.answering ?? -1);
        if (choice !== undefined) choice.options.push(cardIdOf(event.entity, game));
        break;
      }

      case 'optionsOffered':
        accumulator.options = new Map();
        break;

      case 'option':
        accumulator.options.set(event.index, {
          cardId: event.mainEntity?.kind === 'entity' ? event.mainEntity.cardId : '',
          entityId: event.mainEntity?.kind === 'entity' ? event.mainEntity.id : null,
        });
        break;

      case 'optionSent':
        this.#recordDecision(event.selectedOption, event.selectedTarget, event.selectedPosition, game, accumulator);
        break;

      case 'choiceMade':
        accumulator.answering = event.id;
        break;

      case 'choiceChosen': {
        const choice = accumulator.choices.get(accumulator.answering ?? -1);
        if (choice !== undefined) choice.chosen = cardIdOf(event.entity, game);
        break;
      }

      default:
        break;
    }
  }

  /** Cloture une partie restee ouverte en fin de flux. */
  finish(): void {
    this.#machine.finish();
  }

  /** Traduit une option retenue en decision, avec son contexte. */
  #recordDecision(
    selectedOption: number,
    selectedTarget: number,
    selectedPosition: number,
    game: Game,
    accumulator: Accumulator,
  ): void {
    const option = accumulator.options.get(selectedOption);
    const cardId = option?.cardId ?? '';
    const support = option?.entityId === null || option?.entityId === undefined
      ? undefined
      : game.entities.get(option.entityId);

    const hero = game.heroEntityId === null ? undefined : game.entities.get(game.heroEntityId);
    // `selectedTarget` vaut 0 quand l'action n'a pas de cible.
    const target = selectedTarget === 0 ? undefined : game.entities.get(selectedTarget);

    accumulator.decisions.push({
      sequence: accumulator.decisions.length + 1,
      turn: accumulator.turn > 0 ? gameTurn(accumulator.turn) : null,
      action: decisionAction(cardId, support?.tags.get('CARDTYPE')),
      cardId,
      targetCardId: target?.cardId ?? null,
      position: selectedPosition >= 0 ? selectedPosition : null,
      gold: accumulator.gold,
      tavernTier: hero === undefined ? null : numberTag(hero.tags.get('PLAYER_TECH_LEVEL')),
      health: hero === undefined ? null : remainingHealthOf(hero.tags),
      board: readZone(game, game.localPlayerEntityId, 'PLAY'),
      hand: readZone(game, game.localPlayerEntityId, 'HAND'),
      // Pendant un combat, cette zone porte le plateau adverse et non la
      // boutique : on ne la retient que hors combat.
      shop: accumulator.inCombat ? [] : readZone(game, game.proxyPlayerEntityId, 'PLAY'),
    });
  }

  #observeTagChange(
    ref: EntityRef,
    tag: string,
    value: string,
    game: Game,
    accumulator: Accumulator,
  ): void {
    const id = this.#machine.resolve(ref);
    if (id === null) return;

    if (tag === 'TURN' && id === game.gameEntityId) {
      accumulator.turn = Number(value);
      return;
    }

    // Piege connu : d'autres entites du joueur recoivent PLAYER_TECH_LEVEL,
    // dont des copies de heros adverses a 0. Seule l'entite heros compte.
    if (tag === 'PLAYER_TECH_LEVEL' && id === game.heroEntityId) {
      const tier = Number(value);
      if (tier > accumulator.lastTier) {
        accumulator.tierUps.push({ tier, turn: gameTurn(accumulator.turn) });
        accumulator.lastTier = tier;
      }
      return;
    }

    if (tag === 'RESOURCES' && id === game.localPlayerEntityId) {
      accumulator.gold = Number(value);
      return;
    }

    if (tag === 'HERO_ENTITY' && id === game.proxyPlayerEntityId) {
      this.#observeProxyHero(Number(value), game, accumulator);
      return;
    }

    if (tag === 'BACON_IN_COMBAT_PHASE' && id === game.gameEntityId) {
      if (value === '1') this.#startCombat(game, accumulator);
      else this.#endCombat(game, accumulator);
    }
  }

  /**
   * Le mandataire change de heros : Bob pendant le recrutement, l'adversaire
   * pendant le combat. La premiere valeur vue hors combat donne donc Bob, et
   * toute autre valeur pendant un combat donne l'adversaire du tour.
   */
  #observeProxyHero(heroEntityId: number, game: Game, accumulator: Accumulator): void {
    if (!accumulator.inCombat) {
      accumulator.bobEntityId = heroEntityId;
      return;
    }

    const combat = accumulator.combat;
    if (combat === null || combat.opponentHero !== null) return;
    if (heroEntityId === accumulator.bobEntityId) return;

    const cardId = game.entities.get(heroEntityId)?.cardId ?? '';
    if (cardId.length > 0) combat.opponentHero = cardId;
  }

  #startCombat(game: Game, accumulator: Accumulator): void {
    if (accumulator.inCombat) return;
    accumulator.inCombat = true;

    const hero = game.heroEntityId !== null ? game.entities.get(game.heroEntityId) : undefined;
    accumulator.combat = {
      turn: gameTurn(accumulator.turn),
      tavernTier: hero === undefined ? null : numberTag(hero.tags.get('PLAYER_TECH_LEVEL')),
      gold: accumulator.gold,
      armorBefore: Number(hero?.tags.get('ARMOR') ?? 0),
      damageBefore: Number(hero?.tags.get('DAMAGE') ?? 0),
      opponentHero: null,
      board: readBoard(game),
    };
  }

  /** Cloture le combat en cours et en tire un `TurnRecord`. */
  #endCombat(game: Game, accumulator: Accumulator): void {
    const combat = accumulator.combat;
    accumulator.inCombat = false;
    accumulator.combat = null;
    if (combat === null) return;

    const hero = game.heroEntityId !== null ? game.entities.get(game.heroEntityId) : undefined;
    const armor = Number(hero?.tags.get('ARMOR') ?? 0);
    const damage = Number(hero?.tags.get('DAMAGE') ?? 0);
    const health = hero === undefined ? null : numberTag(hero.tags.get('HEALTH'));

    // L'armure encaisse avant les points de vie : la perte reelle cumule la
    // baisse d'armure et la hausse des degats.
    const damageTaken = combat.armorBefore - armor + (damage - combat.damageBefore);

    const player =
      game.localPlayerEntityId !== null ? game.entities.get(game.localPlayerEntityId) : undefined;
    const won = player?.tags.get('BACON_WON_LAST_COMBAT') === '1';

    accumulator.turns.push({
      turn: combat.turn,
      tavernTier: combat.tavernTier,
      gold: combat.gold,
      health: health === null ? null : health - damage + armor,
      opponentHero: combat.opponentHero,
      combatResult: combatResult(won, damageTaken),
      damageTaken: Math.max(damageTaken, 0),
      board: combat.board,
    });
  }

  #summarize(game: Game, accumulator: Accumulator): GameSummary {
    const hero = game.heroEntityId !== null ? game.entities.get(game.heroEntityId) : undefined;
    const localPlayer =
      game.localPlayerEntityId !== null ? game.players.get(game.localPlayerEntityId) : undefined;
    const gameEntity = game.gameEntityId !== null ? game.entities.get(game.gameEntityId) : undefined;

    const mulligan = [...accumulator.choices.values()].find(
      (choice) => choice.choiceType === MULLIGAN,
    );

    const picks: PickRecord[] = [...accumulator.choices.values()]
      .filter((choice) => choice.choiceType !== MULLIGAN && choice.chosen !== null)
      .sort((a, b) => a.id - b.id)
      .map((choice) => ({
        choiceId: choice.id,
        sourceCardId: choice.sourceCardId,
        turn: choice.turn,
        options: choice.options,
        chosen: choice.chosen ?? '',
      }));

    const place = hero?.tags.get('PLAYER_LEADERBOARD_PLACE');
    const skinParent = hero?.tags.get('BACON_SKIN_PARENT_ID');

    return {
      startedAt: accumulator.startedAt ?? this.#clock.toIso(game.startedAt) ?? game.startedAt,
      endedAt: game.endedAt === null ? null : this.#clock.toIso(game.endedAt),
      buildNumber: Number(game.meta.get('BuildNumber') ?? 0),
      gameType: game.meta.get('GameType') ?? '',
      playerName: localPlayer?.name ?? '',
      heroOffered: mulligan?.options ?? [],
      heroChosen: mulligan?.chosen ?? hero?.cardId ?? '',
      heroSkinParentDbfId: skinParent === undefined ? null : Number(skinParent),
      finalPlace: place === undefined ? null : Number(place),
      finalTurn: accumulator.turn > 0 ? gameTurn(accumulator.turn) : null,
      tierUps: accumulator.tierUps,
      turns: accumulator.turns,
      decisions: accumulator.decisions,
      picks,
      opponents: opponentHeroes(game),
      gameSeed: gameEntity?.tags.get('GAME_SEED') ?? null,
    };
  }
}

/** PV restants d'un heros : l'armure encaisse avant les points de vie. */
function remainingHealthOf(tags: Map<string, string>): number | null {
  const health = numberTag(tags.get('HEALTH'));
  if (health === null) return null;
  return health - Number(tags.get('DAMAGE') ?? 0) + Number(tags.get('ARMOR') ?? 0);
}

function numberTag(value: string | undefined): number | null {
  return value === undefined ? null : Number(value);
}

/**
 * Issue d'un combat.
 *
 * `BACON_WON_LAST_COMBAT` ne vaut que 0 ou 1 : l'egalite ne s'y lit pas. Mais
 * une egalite ne coute aucun point de vie, alors qu'une defaite en coute
 * toujours. Attention, ce tag n'est emis qu'aux changements : c'est sa valeur
 * courante qu'il faut lire, pas l'evenement.
 */
export function combatResult(won: boolean, damageTaken: number): CombatResult {
  if (won) return 'win';
  return damageTaken > 0 ? 'loss' : 'tie';
}

/**
 * Plateau d'un joueur, range par position.
 *
 * Par defaut celui de l'utilisateur. Le suivi en direct s'en sert aussi pour le
 * plateau adverse, porte par le joueur fictif pendant un combat.
 *
 * Hors combat, on le lit avant que le jeu ne cree ses copies, sinon le plateau
 * serait pollue par des doublons.
 */
export function readBoard(game: Game, playerEntityId?: number | null): BoardMinion[] {
  return readZone(game, playerEntityId ?? game.localPlayerEntityId, 'PLAY');
}

/**
 * Serviteurs d'un joueur dans une zone donnee, ranges par position.
 *
 * `PLAY` sur le joueur donne son plateau, `HAND` sa main. `PLAY` sur le joueur
 * fictif donne, pendant le recrutement, **la boutique de Bob** : les serviteurs
 * qu'il propose sont des entites qu'il controle (verifie, voir
 * docs/LOG_FORMAT.md).
 */
export function readZone(
  game: Game,
  playerEntityId: number | null | undefined,
  zone: 'PLAY' | 'HAND',
): BoardMinion[] {
  const owner =
    playerEntityId !== null && playerEntityId !== undefined
      ? game.players.get(playerEntityId)
      : undefined;
  if (owner === undefined) return [];
  const controller = String(owner.playerId);

  return [...game.entities.values()]
    .filter(
      (entity) =>
        entity.tags.get('CARDTYPE') === 'MINION' &&
        entity.tags.get('CONTROLLER') === controller &&
        entity.tags.get('ZONE') === zone,
    )
    .map((entity) => ({
      position: Number(entity.tags.get('ZONE_POSITION') ?? 0),
      cardId: entity.cardId,
      atk: numberTag(entity.tags.get('ATK')),
      health: numberTag(entity.tags.get('HEALTH')),
      // Le tag est plus sur que le suffixe `_G` : deux serviteurs dores du log
      // de reference n'ont pas ce suffixe.
      golden: entity.tags.get('PREMIUM') === '1',
    }))
    .sort((a, b) => a.position - b.position);
}

/**
 * cardId d'une reference : le bloc detaille le porte deja, sinon on demande a
 * l'etat. Les cartes se designent par `cardId`, jamais par `entityName`.
 */
function cardIdOf(ref: EntityRef, game: Game): string {
  if (ref.kind === 'entity' && ref.cardId.length > 0) return ref.cardId;
  if (ref.kind === 'entity' || ref.kind === 'id') {
    return game.entities.get(ref.id)?.cardId ?? '';
  }
  return '';
}

/**
 * Les heros des 7 adversaires du lobby.
 *
 * Filtrer sur le controleur ne suffit pas : pendant les combats, le jeu cree
 * des copies des heros adverses controlees par le joueur, et le controleur du
 * mandataire couvre aussi Bob et le heros de remplacement. En revanche, seuls
 * les vrais joueurs du lobby portent une place au classement.
 */
export function opponentHeroes(game: Game): string[] {
  const ownHero = game.heroEntityId !== null ? game.entities.get(game.heroEntityId)?.cardId : undefined;
  const heroes = new Set<string>();

  for (const entity of game.entities.values()) {
    if (entity.cardId.length === 0) continue;
    if (entity.tags.get('CARDTYPE') !== 'HERO') continue;
    if (!entity.tags.has('PLAYER_LEADERBOARD_PLACE')) continue;
    if (entity.cardId === ownHero) continue;
    heroes.add(entity.cardId);
  }

  return [...heroes].sort();
}

/** Chaine complete : lignes -> resumes de parties de Champs de bataille. */
export async function* extractGames(
  lines: AsyncIterable<string>,
  options: ExtractOptions,
): AsyncGenerator<GameSummary> {
  const ready: GameSummary[] = [];
  const extractor = new GameExtractor(options, (summary) => {
    ready.push(summary);
  });

  for await (const line of lines) {
    const event = parseLine(line);
    if (event !== null) extractor.apply(event);
    yield* ready.splice(0, ready.length);
  }

  extractor.finish();
  yield* ready.splice(0, ready.length);
}
