import { mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  archiveLogs,
  ensureRatingsFile,
  listSessions,
  sessionLabel,
  type ArchiveOptions,
  type Manifest,
} from '../src/archive/archive-logs.js';
import { parseArchiveArgs } from '../scripts/archive-logs.js';
import { readSessionLines } from '../src/reader/session-reader.js';

const CREATE_GAME = 'D 02:48:30.3211164 GameState.DebugPrintPower() - CREATE_GAME';
const NOISE = 'D 02:48:30.3211164 PowerTaskList.DebugPrintPower() - CREATE_GAME';
const TAG = 'D 02:48:30.3211164 GameState.DebugPrintPower() - TAG_CHANGE Entity=19 tag=TURN value=1';

/** Contenu d'un Power.log contenant `games` parties. */
function logWith(games: number): string {
  const lines: string[] = [];
  for (let i = 0; i < games; i += 1) {
    lines.push(CREATE_GAME, TAG, NOISE);
  }
  return `${lines.join('\r\n')}\r\n`;
}

interface Layout {
  [session: string]: { [file: string]: string };
}

async function makeLogs(layout: Layout): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bg-logs-'));
  for (const [session, files] of Object.entries(layout)) {
    await mkdir(join(root, session), { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      await writeFile(join(root, session, file), content, 'utf8');
    }
  }
  return root;
}

async function makeDest(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bg-archive-'));
}

function options(source: string, dest: string, over: Partial<ArchiveOptions> = {}): ArchiveOptions {
  return { source, dest, keep: 10, dryRun: false, ...over };
}

async function manifestOf(dest: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(dest, 'manifest.json'), 'utf8')) as Manifest;
}

const S1 = 'Hearthstone_2026_09_20_00_53_42';
const S2 = 'Hearthstone_2026_09_21_00_36_03';
const S3 = 'Hearthstone_2026_09_22_00_28_13';

describe('listSessions', () => {
  it('ne retient que les dossiers de session, tries du plus ancien au plus recent', async () => {
    const source = await makeLogs({
      [S3]: { 'Power.log': '' },
      [S1]: { 'Power.log': '' },
      Screenshots: { 'a.png': '' },
      Hearthstone_pas_une_date: { 'Power.log': '' },
    });

    expect(await listSessions(source)).toEqual([S1, S3]);
  });

  it('rend une liste vide pour un dossier absent', async () => {
    expect(await listSessions(join(tmpdir(), 'bg-absent'))).toEqual([]);
  });
});

describe('archiveLogs', () => {
  it('compresse les Power.log et compte les parties', async () => {
    const source = await makeLogs({ [S1]: { 'Power_old.log': logWith(3) } });
    const dest = await makeDest();

    const result = await archiveLogs(options(source, dest));

    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ session: S1, file: 'Power_old.log', games: 3 });
    expect(result.gamesKept).toBe(3);

    const archived = await stat(join(dest, S1, 'Power_old.log.gz'));
    expect(archived.isFile()).toBe(true);
  });

  it('ne compte pas les doublons PowerTaskList comme des parties', async () => {
    // logWith ecrit une ligne PowerTaskList CREATE_GAME par partie.
    const source = await makeLogs({ [S1]: { 'Power.log': logWith(2) } });
    const result = await archiveLogs(options(source, await makeDest()));

    expect(result.files[0]?.games).toBe(2);
  });

  it('ignore les autres fichiers de log de la session', async () => {
    const source = await makeLogs({
      [S1]: { 'Power.log': logWith(1), 'Hearthstone.log': 'bruit', 'LoadingScreen.log': 'bruit' },
    });
    const dest = await makeDest();
    await archiveLogs(options(source, dest));

    expect(await readdir(join(dest, S1))).toEqual(['Power.log.gz']);
  });

  it('ne touche pas aux fichiers d’origine', async () => {
    const source = await makeLogs({ [S1]: { 'Power_old.log': logWith(2) } });
    const before = await readFile(join(source, S1, 'Power_old.log'), 'utf8');

    await archiveLogs(options(source, await makeDest()));

    expect(await readFile(join(source, S1, 'Power_old.log'), 'utf8')).toBe(before);
  });

  it('saute un fichier deja archive et inchange', async () => {
    const source = await makeLogs({ [S1]: { 'Power_old.log': logWith(2) } });
    const dest = await makeDest();

    await archiveLogs(options(source, dest));
    const second = await archiveLogs(options(source, dest));

    expect(second.files[0]).toMatchObject({ skipped: true, games: 2 });
  });

  it('rearchive un fichier qui a grossi, comme une session encore en cours', async () => {
    const source = await makeLogs({ [S1]: { 'Power.log': logWith(1) } });
    const dest = await makeDest();
    await archiveLogs(options(source, dest));

    await writeFile(join(source, S1, 'Power.log'), logWith(4), 'utf8');
    const second = await archiveLogs(options(source, dest));

    expect(second.files[0]).toMatchObject({ skipped: false, games: 4 });
    expect(second.gamesKept).toBe(4);
  });

  it('repart de zero si le manifeste est illisible', async () => {
    const source = await makeLogs({ [S1]: { 'Power.log': logWith(1) } });
    const dest = await makeDest();
    await archiveLogs(options(source, dest));
    await writeFile(join(dest, 'manifest.json'), '{ pas du json', 'utf8');

    const second = await archiveLogs(options(source, dest));
    expect(second.files[0]?.skipped).toBe(false);
  });

  it('signale une source sans aucune session', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'bg-vide-'));
    await expect(archiveLogs(options(empty, await makeDest()))).rejects.toThrow(/Aucune session/);
  });
});

describe('retention', () => {
  it('garde les sessions les plus recentes couvrant le nombre de parties demande', async () => {
    const source = await makeLogs({
      [S1]: { 'Power_old.log': logWith(2) },
      [S2]: { 'Power_old.log': logWith(3) },
      [S3]: { 'Power_old.log': logWith(6) },
    });
    const dest = await makeDest();

    const result = await archiveLogs(options(source, dest, { keep: 8 }));

    // 6 puis 3 atteignent 8 : la plus ancienne part, celle qui porte la 8e reste.
    expect(result.pruned).toEqual([S1]);
    expect(result.gamesKept).toBe(9);
    expect(await readdir(dest)).toEqual([S2, S3, 'manifest.json']);
  });

  it('garde tout quand il n’y a pas assez de parties', async () => {
    const source = await makeLogs({ [S1]: { 'Power.log': logWith(2) } });
    const result = await archiveLogs(options(source, await makeDest(), { keep: 10 }));

    expect(result.pruned).toEqual([]);
    expect(result.gamesKept).toBe(2);
  });

  it('ne relit jamais une session deja ecartee', async () => {
    const source = await makeLogs({
      [S1]: { 'Power_old.log': logWith(5) },
      [S3]: { 'Power_old.log': logWith(5) },
    });
    const dest = await makeDest();

    const first = await archiveLogs(options(source, dest, { keep: 3 }));
    expect(first.pruned).toEqual([S1]);

    const manifest = await manifestOf(dest);
    expect(manifest.pruned).toEqual([S1]);

    // Au passage suivant, la session ecartee n'apparait meme plus.
    const second = await archiveLogs(options(source, dest, { keep: 3 }));
    expect(second.files.map((f) => f.session)).toEqual([S3]);
  });
});

describe('renommage par le jeu', () => {
  it('retire la copie de Power.log quand la source ne porte plus que Power_old.log', async () => {
    // Hearthstone renomme le fichier en fin de session. Sans ce nettoyage,
    // l'archive garde deux copies du meme contenu et le lecteur relit toute la
    // session deux fois.
    const source = await makeLogs({ [S1]: { 'Power.log': logWith(3) } });
    const dest = await makeDest();
    await archiveLogs(options(source, dest));
    expect(await readdir(join(dest, S1))).toEqual(['Power.log.gz']);

    await rename(join(source, S1, 'Power.log'), join(source, S1, 'Power_old.log'));
    const second = await archiveLogs(options(source, dest));

    expect(second.discarded).toEqual([`${S1}/Power.log`]);
    expect(await readdir(join(dest, S1))).toEqual(['Power_old.log.gz']);
    expect((await manifestOf(dest)).files).not.toHaveProperty(`${S1}/Power.log`);
  });

  it('ne compte plus deux fois les parties de la session renommee', async () => {
    const source = await makeLogs({ [S1]: { 'Power.log': logWith(3) } });
    const dest = await makeDest();
    await archiveLogs(options(source, dest));

    await rename(join(source, S1, 'Power.log'), join(source, S1, 'Power_old.log'));
    const second = await archiveLogs(options(source, dest));

    expect(second.gamesKept).toBe(3);
  });

  it('laisse tranquille une session qui porte vraiment les deux fichiers', async () => {
    const source = await makeLogs({
      [S1]: { 'Power.log': logWith(1), 'Power_old.log': logWith(2) },
    });
    const dest = await makeDest();
    const result = await archiveLogs(options(source, dest));

    expect(result.discarded).toEqual([]);
    expect((await readdir(join(dest, S1))).sort()).toEqual(['Power.log.gz', 'Power_old.log.gz']);
  });
});

describe('relever la retenue', () => {
  it('fait revenir une session ecartee dont les logs existent encore', async () => {
    const source = await makeLogs({
      [S1]: { 'Power_old.log': logWith(5) },
      [S3]: { 'Power_old.log': logWith(5) },
    });
    const dest = await makeDest();

    const first = await archiveLogs(options(source, dest, { keep: 3 }));
    expect(first.pruned).toEqual([S1]);

    // Retenue relevee : la session ecartee redevient candidate.
    const second = await archiveLogs(options(source, dest, { keep: 100 }));
    expect(second.files.map((f) => f.session).sort()).toEqual([S1, S3]);
    expect(second.pruned).toEqual([]);
    expect((await manifestOf(dest)).pruned).toEqual([]);
  });

  it('ne relit pas les sessions ecartees si la retenue ne bouge pas', async () => {
    const source = await makeLogs({
      [S1]: { 'Power_old.log': logWith(5) },
      [S3]: { 'Power_old.log': logWith(5) },
    });
    const dest = await makeDest();

    await archiveLogs(options(source, dest, { keep: 3 }));
    const second = await archiveLogs(options(source, dest, { keep: 3 }));

    expect(second.files.map((f) => f.session)).toEqual([S3]);
  });

  it('retient la valeur appliquee', async () => {
    const source = await makeLogs({ [S1]: { 'Power.log': logWith(1) } });
    const dest = await makeDest();
    await archiveLogs(options(source, dest, { keep: 42 }));

    expect((await manifestOf(dest)).keep).toBe(42);
  });
});

describe('simulation', () => {
  it('compte les parties et annonce la retention sans rien ecrire', async () => {
    const source = await makeLogs({
      [S1]: { 'Power_old.log': logWith(2) },
      [S3]: { 'Power_old.log': logWith(6) },
    });
    const dest = await makeDest();

    const result = await archiveLogs(options(source, dest, { keep: 6, dryRun: true }));

    expect(result.files.map((f) => f.games)).toEqual([2, 6]);
    expect(result.pruned).toEqual([S1]);
    expect(await readdir(dest)).toEqual([]);
  });
});

describe('relecture de l’archive', () => {
  it('une session archivee se lit comme un dossier de logs d’origine', async () => {
    const source = await makeLogs({ [S1]: { 'Power_old.log': logWith(2) } });
    const dest = await makeDest();
    await archiveLogs(options(source, dest));

    const lines: string[] = [];
    for await (const line of readSessionLines(join(dest, S1))) lines.push(line);

    expect(lines.filter((line) => line.endsWith('CREATE_GAME'))).toHaveLength(4);
    expect(lines[0]).toBe(CREATE_GAME);
  });
});

describe('ensureRatingsFile', () => {
  it('cree le fichier avec son en-tete', async () => {
    const path = join(await makeDest(), 'data', 'ratings.csv');

    expect(await ensureRatingsFile(path)).toBe(true);
    expect(await readFile(path, 'utf8')).toBe('datetime,rating\n');
  });

  it('ne touche pas a un fichier existant', async () => {
    const path = join(await makeDest(), 'ratings.csv');
    await writeFile(path, 'datetime,rating\n2026-09-22T02:00,8412\n', 'utf8');

    expect(await ensureRatingsFile(path)).toBe(false);
    expect(await readFile(path, 'utf8')).toContain('8412');
  });
});

describe('parseArchiveArgs', () => {
  it('lit les options', () => {
    const parsed = parseArchiveArgs(['--dest', 'D:/archive', '--keep', '50', '--dry-run']);
    expect(parsed).toMatchObject({ dest: 'D:/archive', keep: 50, dryRun: true });
  });

  it('retient 200 parties par defaut', () => {
    // Environ un mois de jeu. Les logs bruts portent des informations que la
    // base ne garde pas, dont la phase 5 aura besoin.
    expect(parseArchiveArgs([]).keep).toBe(200);
  });

  it('refuse une retenue invalide ou une option inconnue', () => {
    expect(() => parseArchiveArgs(['--keep', '0'])).toThrow(/entier positif/);
    expect(() => parseArchiveArgs(['--keep', 'beaucoup'])).toThrow(/entier positif/);
    expect(() => parseArchiveArgs(['--keep'])).toThrow(/Valeur manquante/);
    expect(() => parseArchiveArgs(['--tout'])).toThrow(/Option inconnue/);
  });
});

describe('sessionLabel', () => {
  it('rend le nom de dossier lisible', () => {
    expect(sessionLabel(S3)).toBe('22/09/2026 00:28');
    expect(sessionLabel('autre')).toBe('autre');
  });
});
