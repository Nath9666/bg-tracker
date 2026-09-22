/**
 * GameStateMachine : applique les evenements du LineParser a un modele d'entites.
 *
 * Le meme module servira en direct (phase 4) : seule la source des lignes
 * change. Il ne fait qu'entretenir l'etat, sans en tirer de conclusions
 * metier ; c'est le role du GameExtractor.
 */
import type { EntityRef, LogEvent } from '../parser/events.js';

/** Une entite du jeu : carte, joueur, heros, enchantement... */
export interface Entity {
  id: number;
  /** Vide tant que la carte est cachee au joueur. */
  cardId: string;
  tags: Map<string, string>;
}

export interface PlayerState {
  entityId: number;
  playerId: number;
  /** Nom de compte, connu par `DebugPrintGame`. `null` si la ligne manque. */
  name: string | null;
  /**
   * Vrai pour l'utilisateur. Seul critere fiable : un `GameAccountId` non nul.
   * Les `PlayerID` changent d'une partie a l'autre (voir docs/LOG_FORMAT.md).
   */
  isLocal: boolean;
}

/** Une partie, du `CREATE_GAME` au `STATE=COMPLETE`. */
export interface Game {
  /** Heure du `CREATE_GAME`, telle qu'ecrite dans le log. */
  startedAt: string;
  /** Heure du `STATE=COMPLETE`, `null` si la partie n'est pas allee au bout. */
  endedAt: string | null;
  complete: boolean;
  /** `BuildNumber`, `GameType`, `FormatType`, `ScenarioID`, lus dans `DebugPrintGame`. */
  meta: Map<string, string>;
  entities: Map<number, Entity>;
  gameEntityId: number | null;
  /** Indexes par id d'entite. */
  players: Map<number, PlayerState>;
  localPlayerEntityId: number | null;
  /** Le joueur au `GameAccountId` nul, qui porte Bob et les heros adverses. */
  proxyPlayerEntityId: number | null;
  /** Entite heros de l'utilisateur, donnee par le tag `HERO_ENTITY`. */
  heroEntityId: number | null;
  /**
   * Dernier nom utilise pour designer le joueur fictif.
   *
   * Ce joueur est renomme d'apres le heros qu'il controle : « Bob le barman »
   * pendant le recrutement, le pseudo de l'adversaire pendant un combat.
   */
  proxyPlayerName: string | null;
  /** Noms references qui n'ont pu etre rattaches a aucune entite. */
  unresolvedNames: Set<string>;
}

function emptyGame(startedAt: string): Game {
  return {
    startedAt,
    endedAt: null,
    complete: false,
    meta: new Map(),
    entities: new Map(),
    gameEntityId: null,
    players: new Map(),
    localPlayerEntityId: null,
    proxyPlayerEntityId: null,
    heroEntityId: null,
    proxyPlayerName: null,
    unresolvedNames: new Set(),
  };
}

function entityOf(game: Game, id: number): Entity {
  let entity = game.entities.get(id);
  if (entity === undefined) {
    entity = { id, cardId: '', tags: new Map() };
    game.entities.set(id, entity);
  }
  return entity;
}

export interface GameStateMachineOptions {
  /** Appele au `CREATE_GAME`. */
  onGameStart?: (game: Game) => void;
  /**
   * Appele quand une partie se termine : `STATE=COMPLETE`, ou `CREATE_GAME`
   * suivant qui interrompt une partie restee incomplete.
   */
  onGameEnd?: (game: Game) => void;
}

export class GameStateMachine {
  #current: Game | null = null;
  /** Entite a laquelle rattacher les prochains `tag=` indentes. */
  #definitionTarget: number | null = null;
  readonly #options: GameStateMachineOptions;

  constructor(options: GameStateMachineOptions = {}) {
    this.#options = options;
  }

  /** La partie en cours, ou `null` hors partie. */
  get current(): Game | null {
    return this.#current;
  }

  /**
   * Resout une reference d'entite en identifiant.
   *
   * La forme nom demande du contexte : `GameEntity`, le nom de compte d'un
   * joueur, ou n'importe quel autre nom. Ce dernier cas designe toujours le
   * joueur fictif, qui prend le nom du heros qu'il controle (verifie :
   * `TAG_CHANGE Entity=LazyTurtle tag=HERO_ENTITY value=80`, ou 80 est Bob).
   */
  resolve(ref: EntityRef): number | null {
    const game = this.#current;
    if (game === null) return null;

    switch (ref.kind) {
      case 'id':
        return ref.id;

      case 'entity':
        return ref.id;

      case 'name': {
        if (ref.name === 'GameEntity') return game.gameEntityId;

        for (const player of game.players.values()) {
          if (player.name === ref.name) return player.entityId;
        }

        if (game.proxyPlayerEntityId !== null) {
          game.proxyPlayerName = ref.name;
          return game.proxyPlayerEntityId;
        }

        game.unresolvedNames.add(ref.name);
        return null;
      }
    }
  }

  /** Applique un evenement a l'etat courant. */
  apply(event: LogEvent): void {
    if (event.type === 'createGame') {
      this.#startGame(event.timestamp);
      return;
    }

    const game = this.#current;
    if (game === null) return;

    switch (event.type) {
      case 'gameEntityDef': {
        game.gameEntityId = event.id;
        entityOf(game, event.id);
        this.#definitionTarget = event.id;
        break;
      }

      case 'playerDef': {
        entityOf(game, event.entityId);
        // `hi=0 lo=0` : joueur fictif. Tout le reste, c'est l'utilisateur.
        const isLocal = event.gameAccountHi !== '0' || event.gameAccountLo !== '0';
        game.players.set(event.entityId, {
          entityId: event.entityId,
          playerId: event.playerId,
          name: null,
          isLocal,
        });
        if (isLocal) game.localPlayerEntityId = event.entityId;
        else game.proxyPlayerEntityId = event.entityId;
        this.#definitionTarget = event.entityId;
        break;
      }

      case 'fullEntity': {
        const entity = entityOf(game, event.id);
        if (event.cardId.length > 0) entity.cardId = event.cardId;
        this.#definitionTarget = event.id;
        break;
      }

      case 'showEntity':
      case 'changeEntity': {
        const id = this.resolve(event.entity);
        if (id === null) break;
        const entity = entityOf(game, id);
        if (event.cardId.length > 0) entity.cardId = event.cardId;
        this.#definitionTarget = id;
        break;
      }

      case 'tagDef': {
        if (this.#definitionTarget === null) break;
        this.#setTag(game, this.#definitionTarget, event.tag, event.value);
        break;
      }

      case 'tagChange': {
        const id = this.resolve(event.entity);
        if (id === null) break;
        this.#noteCardId(game, event.entity);
        this.#setTag(game, id, event.tag, event.value);
        if (event.tag === 'STATE' && event.value === 'COMPLETE' && id === game.gameEntityId) {
          this.#endGame(event.timestamp);
        }
        break;
      }

      case 'hideEntity': {
        const id = this.resolve(event.entity);
        if (id === null) break;
        this.#noteCardId(game, event.entity);
        this.#setTag(game, id, event.tag, event.value);
        break;
      }

      case 'playerMeta': {
        for (const player of game.players.values()) {
          if (player.playerId === event.playerId) player.name = event.playerName;
        }
        break;
      }

      case 'gameMeta': {
        game.meta.set(event.key, event.value);
        break;
      }

      default:
        break;
    }
  }

  /** Cloture une partie restee ouverte en fin de flux. */
  finish(): void {
    if (this.#current !== null) this.#endGame(null);
  }

  #startGame(timestamp: string): void {
    // Une partie deja ouverte n'ira jamais au bout : on la rend telle quelle.
    if (this.#current !== null) this.#endGame(null);

    const game = emptyGame(timestamp);
    this.#current = game;
    this.#definitionTarget = null;
    this.#options.onGameStart?.(game);
  }

  #endGame(timestamp: string | null): void {
    const game = this.#current;
    if (game === null) return;

    game.endedAt = timestamp;
    game.complete = timestamp !== null;
    this.#current = null;
    this.#definitionTarget = null;
    this.#options.onGameEnd?.(game);
  }

  #setTag(game: Game, id: number, tag: string, value: string): void {
    entityOf(game, id).tags.set(tag, value);

    // L'entite heros de l'utilisateur change en cours de partie : au
    // CREATE_GAME c'est un remplacant, le vrai heros arrive au mulligan.
    if (tag === 'HERO_ENTITY' && id === game.localPlayerEntityId) {
      game.heroEntityId = Number(value);
    }
  }

  /**
   * La forme detaillee d'une reference porte le cardId : on en profite pour
   * completer une entite encore anonyme, sans jamais ecraser ce qu'on sait.
   */
  #noteCardId(game: Game, ref: EntityRef): void {
    if (ref.kind !== 'entity' || ref.cardId.length === 0) return;
    const entity = entityOf(game, ref.id);
    if (entity.cardId.length === 0) entity.cardId = ref.cardId;
  }
}
