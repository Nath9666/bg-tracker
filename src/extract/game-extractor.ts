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
import type { GameSummary, PickRecord, TierUp } from '../types.js';
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

/** Choix en cours de construction, rempli au fil des lignes. */
interface ChoiceInProgress {
  id: number;
  choiceType: string;
  sourceCardId: string;
  options: string[];
  chosen: string | null;
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
    }
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
        options: choice.options,
        chosen: choice.chosen ?? '',
      }));

    const place = hero?.tags.get('PLAYER_LEADERBOARD_PLACE');

    return {
      startedAt: accumulator.startedAt ?? this.#clock.toIso(game.startedAt) ?? game.startedAt,
      endedAt: game.endedAt === null ? null : this.#clock.toIso(game.endedAt),
      buildNumber: Number(game.meta.get('BuildNumber') ?? 0),
      gameType: game.meta.get('GameType') ?? '',
      playerName: localPlayer?.name ?? '',
      heroOffered: mulligan?.options ?? [],
      heroChosen: mulligan?.chosen ?? hero?.cardId ?? '',
      finalPlace: place === undefined ? null : Number(place),
      finalTurn: accumulator.turn > 0 ? gameTurn(accumulator.turn) : null,
      tierUps: accumulator.tierUps,
      picks,
      opponents: opponentHeroes(game),
      gameSeed: gameEntity?.tags.get('GAME_SEED') ?? null,
    };
  }
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
