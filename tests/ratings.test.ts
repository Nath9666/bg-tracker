import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  listGames,
  matchRatings,
  parseRatings,
  writeRatingsTemplate,
  type RatedGame,
} from '../src/ratings/ratings.js';
import { parseRatingsArgs } from '../src/cli/ratings.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { importGames } from '../src/db/import.js';
import type { GameSummary } from '../src/types.js';

const GAMES: RatedGame[] = [
  { id: 'a', datetime: '2026-09-22T02:04:04.660+02:00', label: 'Souveraine Cire-Reine 4e', rating: null },
  { id: 'b', datetime: '2026-09-22T02:29:15.814+02:00', label: 'Guff Totem-Runique 6e', rating: null },
  { id: 'c', datetime: '2026-09-22T02:56:47.033+02:00', label: 'Cénarius, seigneur de la forêt 1e', rating: null },
];

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'bg-ratings-')), 'ratings.csv');
}

describe('parseRatings', () => {
  it('lit les lignes completes', () => {
    const entries = parseRatings(
      'datetime,rating,partie\n2026-09-22T02:04:04.660+02:00,8412,Guff 6e\n',
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ datetime: '2026-09-22T02:04:04.660+02:00', rating: 8412 });
  });

  it('ignore l’en-tete, les lignes vides et celles sans cote', () => {
    const entries = parseRatings(
      ['datetime,rating,partie', '', '2026-09-22T02:04:04.660+02:00,,Guff 6e', '  '].join('\n'),
    );

    expect(entries).toEqual([]);
  });

  it('ignore une cote ou une date illisible', () => {
    expect(parseRatings('pas une date,8412\n2026-09-22T02:04:04+02:00,beaucoup\n')).toEqual([]);
  });

  it('accepte une ligne sans troisieme colonne', () => {
    expect(parseRatings('2026-09-22T02:04:04+02:00,8412')[0]?.rating).toBe(8412);
  });

  it('n’est pas trouble par une virgule dans le libelle', () => {
    const entries = parseRatings('2026-09-22T02:56:47.033+02:00,9001,"Cénarius, seigneur 1e"');
    expect(entries[0]?.rating).toBe(9001);
  });

  it('arrondit une cote decimale', () => {
    expect(parseRatings('2026-09-22T02:04:04+02:00,8412.6')[0]?.rating).toBe(8413);
  });
});

describe('writeRatingsTemplate', () => {
  it('ecrit une ligne par partie, la plus ancienne d’abord', async () => {
    const path = await tempFile();
    const result = await writeRatingsTemplate(path, GAMES);

    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines[0]).toBe('datetime,rating,partie');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain('02:04:04');
    expect(result).toMatchObject({ added: 3, kept: 0 });
  });

  it('protege par des guillemets un libelle contenant une virgule', async () => {
    const path = await tempFile();
    await writeRatingsTemplate(path, GAMES);

    expect(await readFile(path, 'utf8')).toContain('"Cénarius, seigneur de la forêt 1e"');
  });

  it('conserve les cotes deja saisies', async () => {
    const path = await tempFile();
    await writeRatingsTemplate(path, GAMES);

    const filled = (await readFile(path, 'utf8')).replace(
      '2026-09-22T02:29:15.814+02:00,,',
      '2026-09-22T02:29:15.814+02:00,8412,',
    );
    await writeFile(path, filled, 'utf8');

    const second = await writeRatingsTemplate(path, GAMES);
    expect(second).toMatchObject({ added: 2, kept: 1 });
    expect(await readFile(path, 'utf8')).toContain('2026-09-22T02:29:15.814+02:00,8412,');
  });

  it('ajoute les nouvelles parties sans perdre les anciennes cotes', async () => {
    const path = await tempFile();
    await writeRatingsTemplate(path, GAMES.slice(0, 1));
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace('02:00,,', '02:00,8000,'),
      'utf8',
    );

    const second = await writeRatingsTemplate(path, GAMES);
    expect(second).toMatchObject({ added: 2, kept: 1 });
  });

  it('replace une cote quand l’horodatage de la partie a change', async () => {
    // Cas reel : la cote est saisie pendant que la partie est encore en cours,
    // donc en face de son heure de debut. Une fois la partie terminee, la ligne
    // porte son heure de fin ; sans replacement, la cote resterait orpheline et
    // la partie paraitrait sans cote.
    const path = await tempFile();
    const enCours: RatedGame = {
      id: 'z',
      datetime: '2026-09-22T18:55:40.487+02:00',
      label: 'Sindragosa 7e (inachevée)',
      rating: null,
    };
    await writeRatingsTemplate(path, [enCours]);
    await writeFile(
      path,
      (await readFile(path, 'utf8')).replace('487+02:00,,', '487+02:00,4605,'),
      'utf8',
    );

    const terminee: RatedGame = {
      id: 'z',
      datetime: '2026-09-22T19:13:57.895+02:00',
      label: 'Sindragosa 7e',
      rating: null,
    };
    const result = await writeRatingsTemplate(path, [terminee]);

    const text = await readFile(path, 'utf8');
    expect(text).toContain('2026-09-22T19:13:57.895+02:00,4605,Sindragosa 7e');
    expect(text).not.toContain('18:55:40');
    expect(result).toMatchObject({ added: 0, kept: 1 });
  });

  it('reprend la cote deja en base quand le fichier n’en a pas', async () => {
    // Cas de la saisie faite dans l'interface : elle va en base, et le fichier
    // doit la refleter au lieu de rester vide.
    const path = await tempFile();
    await writeRatingsTemplate(path, [{ ...GAMES[0]!, rating: 4637 }]);

    expect(await readFile(path, 'utf8')).toContain('02:04:04.660+02:00,4637,');
  });

  it('laisse le fichier primer sur la base, comme modification la plus recente', async () => {
    const path = await tempFile();
    await writeFile(
      path,
      `datetime,rating,partie
${GAMES[0]!.datetime},9000,corrige a la main
`,
      'utf8',
    );

    await writeRatingsTemplate(path, [{ ...GAMES[0]!, rating: 4637 }]);
    const text = await readFile(path, 'utf8');

    expect(text).toContain(',9000,');
    expect(text).not.toContain(',4637,');
  });

  it('ne perd pas une saisie qui ne correspond a aucune partie', async () => {
    const path = await tempFile();
    await writeFile(path, 'datetime,rating\n2020-01-01T00:00:00+02:00,7000\n', 'utf8');

    await writeRatingsTemplate(path, GAMES);
    const text = await readFile(path, 'utf8');

    expect(text).toContain('2020-01-01T00:00:00+02:00,7000');
    expect(text).toContain('sans partie correspondante');
  });
});

describe('matchRatings', () => {
  it('rattache une cote a la partie du meme instant', () => {
    const matches = matchRatings(GAMES, parseRatings('2026-09-22T02:29:15.814+02:00,8412'));

    expect(matches).toEqual([
      { gameId: 'b', rating: 8412, datetime: '2026-09-22T02:29:15.814+02:00', gapMinutes: 0 },
    ]);
  });

  it('accepte une saisie approximative, a la partie la plus proche', () => {
    // Saisie a la minute, cinq minutes apres la fin de la partie.
    const matches = matchRatings(GAMES, parseRatings('2026-09-22T02:34:00+02:00,8412'));

    expect(matches[0]?.gameId).toBe('b');
    expect(matches[0]?.gapMinutes).toBe(5);
  });

  it('laisse de cote une saisie trop eloignee', () => {
    expect(matchRatings(GAMES, parseRatings('2026-09-25T12:00:00+02:00,8412'))).toEqual([]);
  });

  it('n’attribue qu’une cote par partie, du couple le plus serre au plus large', () => {
    const matches = matchRatings(
      GAMES,
      parseRatings(
        ['2026-09-22T02:29:15.814+02:00,8412', '2026-09-22T02:30:00+02:00,8500'].join('\n'),
      ),
    );

    // La saisie exacte prend la partie b, l'autre se reporte sur sa voisine.
    expect(matches.find((m) => m.gameId === 'b')?.rating).toBe(8412);
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((m) => m.gameId)).size).toBe(2);
  });

  it('respecte la tolerance demandee', () => {
    const ratings = parseRatings('2026-09-22T03:30:00+02:00,8412');

    expect(matchRatings(GAMES, ratings, 10)).toEqual([]);
    expect(matchRatings(GAMES, ratings, 120)).toHaveLength(1);
  });
});

describe('aller-retour avec la base', () => {
  const summary: GameSummary = {
    startedAt: '2026-09-22T02:30:18.429+02:00',
    endedAt: '2026-09-22T02:56:47.033+02:00',
    buildNumber: 251952,
    gameType: 'GT_BATTLEGROUNDS',
    playerName: 'AkiLif#2498',
    heroOffered: ['BG32_HERO_001'],
    heroChosen: 'BG32_HERO_001',
    heroSkinParentDbfId: null,
    finalPlace: 1,
    finalTurn: 14,
    tierUps: [],
    turns: [],
    decisions: [],
    picks: [],
    opponents: [],
    gameSeed: '893952471',
  };

  function seeded(): Db {
    const db = openDatabase(':memory:');
    importGames(db, [summary], 'x');
    return db;
  }

  it('rend la cote deja enregistree', () => {
    const db = seeded();
    db.prepare('UPDATE games SET rating_after = 4637').run();

    expect(listGames(db)[0]?.rating).toBe(4637);
  });

  it('rend une cote nulle tant que rien n’est saisi', () => {
    expect(listGames(seeded())[0]?.rating).toBeNull();
  });

  it('propose la fin de chaque partie comme horodatage', () => {
    const games = listGames(seeded());

    expect(games).toHaveLength(1);
    expect(games[0]?.datetime).toBe('2026-09-22T02:56:47.033+02:00');
    expect(games[0]?.label).toContain('1e');
  });

  it('retombe sur le debut quand la partie est inachevee', () => {
    const db = openDatabase(':memory:');
    importGames(db, [{ ...summary, endedAt: null }], 'x');

    const games = listGames(db);
    expect(games[0]?.datetime).toBe('2026-09-22T02:30:18.429+02:00');
    expect(games[0]?.label).toContain('inachevée');
  });

  it('ecrit la cote sur la bonne partie', async () => {
    const db = seeded();
    const games = listGames(db);
    const path = await tempFile();
    await writeRatingsTemplate(path, games);
    await writeFile(path, (await readFile(path, 'utf8')).replace('02:00,,', '02:00,8412,'), 'utf8');

    const matches = matchRatings(games, parseRatings(await readFile(path, 'utf8')));
    for (const match of matches) {
      db.prepare('UPDATE games SET rating_after = ? WHERE id = ?').run(match.rating, match.gameId);
    }

    expect(db.prepare('SELECT rating_after FROM games').get()).toEqual({ rating_after: 8412 });
  });

  it('un reimport de la partie n’efface pas la cote', () => {
    const db = seeded();
    db.prepare('UPDATE games SET rating_after = 8412').run();

    importGames(db, [summary], 'x');

    expect(db.prepare('SELECT rating_after FROM games').get()).toEqual({ rating_after: 8412 });
  });
});

describe('parseRatingsArgs', () => {
  it('a des chemins par defaut', () => {
    expect(parseRatingsArgs([])).toEqual({ db: 'data/bg-tracker.db', file: 'data/ratings.csv' });
  });

  it('accepte --db et --file', () => {
    expect(parseRatingsArgs(['--db', 'a.db', '--file', 'b.csv'])).toEqual({
      db: 'a.db',
      file: 'b.csv',
    });
  });

  it('refuse une option inconnue ou sans valeur', () => {
    expect(() => parseRatingsArgs(['--file'])).toThrow(/Valeur manquante/);
    expect(() => parseRatingsArgs(['--tout'])).toThrow(/Option inconnue/);
  });
});

describe('writeRatingsTemplate, ecriture conditionnelle', () => {
  it('ne retouche pas un fichier deja a jour', async () => {
    const path = await tempFile();
    const premier = await writeRatingsTemplate(path, GAMES);
    const avant = (await stat(path)).mtimeMs;

    const second = await writeRatingsTemplate(path, GAMES);

    expect(premier.written).toBe(true);
    expect(second.written).toBe(false);
    expect((await stat(path)).mtimeMs).toBe(avant);
    // Le decompte reste juste, meme sans ecriture.
    expect(second.added).toBe(premier.added);
  });

  it('reecrit des qu’une partie s’ajoute', async () => {
    const path = await tempFile();
    await writeRatingsTemplate(path, GAMES.slice(0, 1));

    expect((await writeRatingsTemplate(path, GAMES)).written).toBe(true);
  });
});
