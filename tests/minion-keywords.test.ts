import { describe, expect, it } from 'vitest';
import { extractGames } from '../src/extract/game-extractor.js';
import { readSessionLines } from '../src/reader/session-reader.js';
import { currentHealth, type BoardMinion, type GameSummary } from '../src/types.js';
import { sampleSessionFolder } from './helpers/sample-session.js';

const SESSION_DATE = new Date(2026, 8, 19, 2, 47, 25);

let cache: Promise<GameSummary[]> | null = null;

/** Les parties de l'extrait reel, extraites une seule fois. */
function sampleGames(): Promise<GameSummary[]> {
  cache ??= (async () => {
    const folder = await sampleSessionFolder();
    const games: GameSummary[] = [];
    for await (const summary of extractGames(readSessionLines(folder), {
      sessionDate: SESSION_DATE,
    })) {
      games.push(summary);
    }
    return games;
  })();
  return cache;
}

/** Tous les serviteurs vus sur un plateau au fil de la partie. */
async function boardMinions(): Promise<BoardMinion[]> {
  const games = await sampleGames();
  return games.flatMap((game) => game.turns.flatMap((turn) => turn.board));
}

/**
 * Tout ce que le joueur a eu sous les yeux : plateau, main et boutique.
 *
 * Le resume hors ligne ne porte pas les plateaux adverses, et dans l'extrait
 * le joueur n'a jamais pose de Provocation. C'est la boutique qui en montre.
 */
async function visibleMinions(): Promise<BoardMinion[]> {
  const games = await sampleGames();
  return [
    ...(await boardMinions()),
    ...games.flatMap((game) =>
      game.decisions.flatMap((decision) => [...decision.board, ...decision.hand, ...decision.shop]),
    ),
  ];
}

describe('mots-cles des serviteurs, sur un log reel', () => {
  it('releve chaque mot-cle present dans l’extrait', async () => {
    const minions = await visibleMinions();

    const compte = (clef: keyof BoardMinion['keywords']): number =>
      minions.filter((minion) => minion.keywords[clef]).length;

    // L'extrait contient ces tags, verifie par grep sur la fixture.
    expect(compte('divineShield')).toBeGreaterThan(0);
    expect(compte('taunt')).toBeGreaterThan(0);
    expect(compte('reborn')).toBeGreaterThan(0);
    expect(compte('venomous')).toBeGreaterThan(0);
  });

  it('laisse a faux les mots-cles absents de l’extrait', async () => {
    const minions = await boardMinions();

    // POISONOUS a laisse la place a VENOMOUS : aucun dans l'extrait.
    expect(minions.some((minion) => minion.keywords.poisonous)).toBe(false);
  });

  it('ne met pas tout le plateau sous le meme mot-cle', async () => {
    const minions = await boardMinions();
    const avec = minions.filter((minion) => minion.keywords.divineShield).length;

    // Un tag mal rattache marquerait tout le monde : le compte doit rester
    // une minorite des serviteurs vus.
    expect(avec).toBeLessThan(minions.length);
  });
});

describe('degats subis', () => {
  it('distingue la vie maximale des PV restants', async () => {
    const minions = await boardMinions();
    const blesse = minions.find((minion) => minion.damage > 0);

    expect(blesse).toBeDefined();
    expect(currentHealth(blesse!)).toBe(blesse!.health! - blesse!.damage);
    expect(currentHealth(blesse!)).toBeLessThan(blesse!.health!);
  });

  it('laisse les degats a zero sur un serviteur intact', async () => {
    const minions = await boardMinions();
    const intact = minions.find((minion) => minion.damage === 0);

    expect(intact).toBeDefined();
    expect(currentHealth(intact!)).toBe(intact!.health);
  });

  it('ne rend jamais de PV restants negatifs sur un plateau', async () => {
    const minions = await boardMinions();

    // Un serviteur mort quitte la zone PLAY : ce qui reste sur le plateau est
    // toujours vivant.
    for (const minion of minions) {
      if (minion.health === null) continue;
      expect(currentHealth(minion)).toBeGreaterThan(0);
    }
  });
});
