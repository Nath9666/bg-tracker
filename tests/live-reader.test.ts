import { appendFile, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  activeLogFile,
  followLogs,
  listSessionFolders,
  readFrom,
  type LiveBatch,
} from '../src/reader/live-reader.js';

const S1 = 'Hearthstone_2026_09_22_16_48_50';
const S2 = 'Hearthstone_2026_09_23_09_00_00';

async function makeLogs(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bg-live-'));
}

async function session(root: string, name: string): Promise<string> {
  const folder = join(root, name);
  await mkdir(folder, { recursive: true });
  return folder;
}

describe('listSessionFolders', () => {
  it('ne retient que les dossiers de session, du plus ancien au plus recent', async () => {
    const root = await makeLogs();
    await session(root, S2);
    await session(root, S1);
    await session(root, 'Screenshots');

    expect(await listSessionFolders(root)).toEqual([S1, S2]);
  });

  it('rend une liste vide pour un dossier absent', async () => {
    expect(await listSessionFolders(join(tmpdir(), 'bg-absent'))).toEqual([]);
  });
});

describe('activeLogFile', () => {
  it('prefere Power_old.log, la session etant alors terminee', async () => {
    const folder = await session(await makeLogs(), S1);
    await writeFile(join(folder, 'Power.log'), '', 'utf8');
    await writeFile(join(folder, 'Power_old.log'), '', 'utf8');

    expect(await activeLogFile(folder)).toBe(join(folder, 'Power_old.log'));
  });

  it('prend Power.log quand la session tourne', async () => {
    const folder = await session(await makeLogs(), S1);
    await writeFile(join(folder, 'Power.log'), '', 'utf8');

    expect(await activeLogFile(folder)).toBe(join(folder, 'Power.log'));
  });

  it('rend null tant qu’aucun fichier n’existe', async () => {
    expect(await activeLogFile(await session(await makeLogs(), S1))).toBeNull();
  });
});

describe('readFrom', () => {
  async function fichier(contenu: string): Promise<string> {
    const path = join(await makeLogs(), 'Power.log');
    await writeFile(path, contenu, 'utf8');
    return path;
  }

  it('rend les lignes ajoutees depuis l’offset', async () => {
    const path = await fichier('a\r\nb\r\n');
    const premier = await readFrom(path, 0);

    expect(premier.lines).toEqual(['a', 'b']);

    await appendFile(path, 'c\r\n', 'utf8');
    const second = await readFrom(path, premier.offset);

    expect(second.lines).toEqual(['c']);
  });

  it('retient une ligne encore incomplete jusqu’a son saut de ligne', async () => {
    const path = await fichier('a\r\nb sans fin');
    const premier = await readFrom(path, 0);

    // `b sans fin` est peut-etre en cours d'ecriture : on ne la rend pas.
    expect(premier.lines).toEqual(['a']);

    await appendFile(path, ' de ligne\r\n', 'utf8');
    expect((await readFrom(path, premier.offset)).lines).toEqual(['b sans fin de ligne']);
  });

  it('ne rend rien quand rien n’a ete ajoute', async () => {
    const path = await fichier('a\r\n');
    const premier = await readFrom(path, 0);

    expect((await readFrom(path, premier.offset)).lines).toEqual([]);
  });

  it('repart du debut si le fichier a retreci', async () => {
    const path = await fichier('une premiere ligne bien longue\r\n');
    const premier = await readFrom(path, 0);

    await writeFile(path, 'court\r\n', 'utf8');
    const second = await readFrom(path, premier.offset);

    expect(second.lines).toEqual(['court']);
  });

  it('compte les octets, pas les caracteres', async () => {
    // Les noms de joueur sont en UTF-8 : un offset compte en caracteres
    // decalerait la lecture suivante.
    const path = await fichier('МиниНиндзя\r\n');
    const premier = await readFrom(path, 0);

    await appendFile(path, 'suite\r\n', 'utf8');
    expect((await readFrom(path, premier.offset)).lines).toEqual(['suite']);
  });

  it('ne casse pas sur un fichier absent', async () => {
    expect(await readFrom(join(tmpdir(), 'bg-absent.log'), 0)).toEqual({ lines: [], offset: 0 });
  });
});

describe('followLogs', () => {
  /** Collecte les lots jusqu'a en avoir `attendus`, puis arrete le suivi. */
  async function collecter(
    root: string,
    attendus: number,
    fromStart = true,
  ): Promise<LiveBatch[]> {
    const controle = new AbortController();
    const lots: LiveBatch[] = [];

    const timeout = setTimeout(() => controle.abort(), 5000);
    for await (const lot of followLogs(
      { logsFolder: root, pollMs: 10, fromStart },
      controle.signal,
    )) {
      lots.push(lot);
      if (lots.length >= attendus) break;
    }
    clearTimeout(timeout);
    return lots;
  }

  it('signale la session puis rend ses lignes', async () => {
    const root = await makeLogs();
    const folder = await session(root, S1);
    await writeFile(join(folder, 'Power.log'), 'premiere\r\n', 'utf8');

    const lots = await collecter(root, 2);

    expect(lots[0]).toMatchObject({ session: S1, newSession: true, lines: [] });
    expect(lots[1]).toMatchObject({ session: S1, newSession: false, lines: ['premiere'] });
  });

  it('suit les lignes ajoutees au fil de l’eau', async () => {
    const root = await makeLogs();
    const folder = await session(root, S1);
    const path = join(folder, 'Power.log');
    await writeFile(path, 'une\r\n', 'utf8');

    setTimeout(() => void appendFile(path, 'deux\r\n', 'utf8'), 60);
    const lots = await collecter(root, 3);

    expect(lots.flatMap((lot) => lot.lines)).toEqual(['une', 'deux']);
  });

  it('bascule sur la nouvelle session quand le jeu est relance', async () => {
    const root = await makeLogs();
    const premiere = await session(root, S1);
    await writeFile(join(premiere, 'Power.log'), 'ancienne\r\n', 'utf8');

    setTimeout(() => {
      void session(root, S2).then((folder) =>
        writeFile(join(folder, 'Power.log'), 'nouvelle\r\n', 'utf8'),
      );
    }, 80);

    const lots = await collecter(root, 4);

    expect(lots.filter((lot) => lot.newSession).map((lot) => lot.session)).toEqual([S1, S2]);
    expect(lots.flatMap((lot) => lot.lines)).toEqual(['ancienne', 'nouvelle']);
  });

  it('continue apres le renommage de Power.log en Power_old.log', async () => {
    // Le jeu renomme son fichier en fin de session : le suivi doit reprendre
    // sur le fichier renomme, au meme endroit, sans tout relire.
    const root = await makeLogs();
    const folder = await session(root, S1);
    const actif = join(folder, 'Power.log');
    await writeFile(actif, 'avant\r\n', 'utf8');

    setTimeout(() => {
      void rename(actif, join(folder, 'Power_old.log')).then(() =>
        appendFile(join(folder, 'Power_old.log'), 'apres\r\n', 'utf8'),
      );
    }, 80);

    const lots = await collecter(root, 3);

    expect(lots.flatMap((lot) => lot.lines)).toEqual(['avant', 'apres']);
  });

  it('attend sans broncher un dossier de logs encore vide', async () => {
    const root = await makeLogs();

    setTimeout(() => {
      void session(root, S1).then((folder) =>
        writeFile(join(folder, 'Power.log'), 'enfin\r\n', 'utf8'),
      );
    }, 60);

    const lots = await collecter(root, 2);
    expect(lots.flatMap((lot) => lot.lines)).toEqual(['enfin']);
  });

  it('part de la fin par defaut, pour ne pas rejouer le passe', async () => {
    const root = await makeLogs();
    const folder = await session(root, S1);
    const path = join(folder, 'Power.log');
    await writeFile(path, 'deja jouee\r\n', 'utf8');

    setTimeout(() => void appendFile(path, 'en cours\r\n', 'utf8'), 60);
    const lots = await collecter(root, 2, false);

    expect(lots.flatMap((lot) => lot.lines)).toEqual(['en cours']);
  });

  it('s’arrete sur le signal', async () => {
    const root = await makeLogs();
    await session(root, S1);
    const controle = new AbortController();
    controle.abort();

    const lots: LiveBatch[] = [];
    for await (const lot of followLogs({ logsFolder: root, pollMs: 10 }, controle.signal)) {
      lots.push(lot);
    }

    expect(lots).toEqual([]);
  });
});
