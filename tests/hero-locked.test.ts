import { describe, expect, it } from 'vitest';
import { extractGames } from '../src/extract/game-extractor.js';
import { readSessionLines } from '../src/reader/session-reader.js';
import type { GameSummary } from '../src/types.js';
import { sampleSessionFolder } from './helpers/sample-session.js';

async function partieDeReference(): Promise<GameSummary> {
  const parties: GameSummary[] = [];
  for await (const s of extractGames(readSessionLines(await sampleSessionFolder()), {
    sessionDate: new Date(2026, 8, 19, 2, 47, 25),
  })) {
    parties.push(s);
  }
  return parties[0]!;
}

/**
 * Sans le Passe de taverne, le jeu propose quatre heros mais en verrouille
 * deux (tag `BACON_LOCKED_MULLIGAN_HERO`, pose juste avant le choix). Dans la
 * partie de reference : Drek'Thar (id 91) et Tras'tath (id 90).
 */
describe('heros verrouilles au choix, sur le log de reference', () => {
  it('garde les quatre heros proposes', async () => {
    const partie = await partieDeReference();
    expect(partie.heroOffered).toHaveLength(4);
  });

  it('marque les deux heros verrouilles', async () => {
    const partie = await partieDeReference();
    expect([...partie.heroLocked].sort()).toEqual(['BG22_HERO_002', 'BG36_HERO_101']);
  });

  it('n’a jamais choisi un heros verrouille', async () => {
    const partie = await partieDeReference();
    expect(partie.heroLocked).not.toContain(partie.heroChosen);
  });
});
