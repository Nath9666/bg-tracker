/**
 * Chaine complete : lignes -> evenements -> parties.
 *
 * Un fichier contient plusieurs parties a la suite (voir docs/LOG_FORMAT.md),
 * et peut se terminer sur une partie inachevee : celle-ci est rendue elle
 * aussi, avec `complete: false`.
 */
import { parseLine } from '../parser/line-parser.js';
import { GameStateMachine, type Game } from './game-state.js';

export async function* readGames(lines: AsyncIterable<string>): AsyncGenerator<Game> {
  const finished: Game[] = [];
  const machine = new GameStateMachine({
    onGameEnd: (game) => {
      finished.push(game);
    },
  });

  for await (const line of lines) {
    const event = parseLine(line);
    if (event !== null) machine.apply(event);
    yield* drain(finished);
  }

  machine.finish();
  yield* drain(finished);
}

function* drain(games: Game[]): Generator<Game> {
  for (const game of games.splice(0, games.length)) yield game;
}
