import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { createGameStateFilter, type FilterStats } from '../scripts/make-fixture.js';

const FIXTURE = new URL('./fixtures/sample-game-1.min.log.gz', import.meta.url);

/** Passe un texte dans le filtre, en le decoupant en morceaux de `chunkSize`. */
async function runFilter(
  text: string,
  chunkSize = text.length,
): Promise<{ output: string; stats: FilterStats }> {
  const stats: FilterStats = { linesRead: 0, linesKept: 0 };
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));

  const filter = createGameStateFilter(stats);
  const collected: string[] = [];
  filter.on('data', (chunk: Buffer | string) => collected.push(chunk.toString()));
  await pipeline(Readable.from(chunks.length > 0 ? chunks : ['']), filter);

  return { output: collected.join(''), stats };
}

// Lignes reelles copiees depuis fixtures/sample-game-1/Power_old.log.
const GAME_STATE = 'D 02:48:30.3211164 GameState.DebugPrintPowerList() - Count=44\r\n';
const GAME_STATE_POWER = 'D 02:48:30.3211164 GameState.DebugPrintPower() - CREATE_GAME\r\n';
const TASK_LIST = 'D 02:48:30.3211164 PowerTaskList.DebugPrintPower() - CREATE_GAME\r\n';
const SPELL_CONTROLLER =
  'D 02:55:28.7166620 PowerSpellController [taskListId=1766].InitPowerSpell() - FAILED to attach\r\n';

describe('createGameStateFilter', () => {
  it('ne garde que les lignes GameState.*', async () => {
    const { output, stats } = await runFilter(
      GAME_STATE + TASK_LIST + GAME_STATE_POWER + SPELL_CONTROLLER,
    );

    expect(output).toBe(GAME_STATE + GAME_STATE_POWER);
    expect(stats).toEqual({ linesRead: 4, linesKept: 2 });
  });

  it('conserve les fins de ligne CRLF d\u2019origine', async () => {
    const { output } = await runFilter(GAME_STATE);
    expect(output.endsWith('\r\n')).toBe(true);
  });

  it('recolle les lignes coupees entre deux morceaux du flux', async () => {
    const text = GAME_STATE + TASK_LIST + GAME_STATE_POWER;
    const { output, stats } = await runFilter(text, 7);

    expect(output).toBe(GAME_STATE + GAME_STATE_POWER);
    expect(stats).toEqual({ linesRead: 3, linesKept: 2 });
  });

  it('garde une derniere ligne non terminee par un saut de ligne', async () => {
    const truncated = GAME_STATE_POWER.trimEnd();
    const { output, stats } = await runFilter(GAME_STATE + truncated);

    expect(output).toBe(GAME_STATE + truncated);
    expect(stats).toEqual({ linesRead: 2, linesKept: 2 });
  });

  it('ignore une derniere ligne non terminee qui n\u2019est pas GameState', async () => {
    const { output, stats } = await runFilter(GAME_STATE + TASK_LIST.trimEnd());

    expect(output).toBe(GAME_STATE);
    expect(stats).toEqual({ linesRead: 2, linesKept: 1 });
  });

  it('accepte un flux vide', async () => {
    const { output, stats } = await runFilter('');
    expect(output).toBe('');
    expect(stats).toEqual({ linesRead: 0, linesKept: 0 });
  });
});

describe('extrait sample-game-1.min.log.gz', () => {
  it('contient exactement les lignes GameState de la partie de reference', async () => {
    const text = gunzipSync(await readFile(FIXTURE)).toString('utf8');
    const lines = text.split('\r\n');

    // Le fichier se termine par un CRLF : le dernier element est vide.
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(141_637);
    expect(lines.every((line) => / GameState\./.test(line))).toBe(true);

    // Une seule partie, du CREATE_GAME au STATE=COMPLETE.
    expect(text).toContain('GameState.DebugPrintPower() - CREATE_GAME');
    expect(text).toContain('TAG_CHANGE Entity=GameEntity tag=STATE value=COMPLETE');
  });

  it('reste compresse sous la barre du Mo, pour rester versionnable', async () => {
    const compressed = await readFile(FIXTURE);
    expect(compressed.byteLength).toBeLessThan(1_000_000);
  });
});
