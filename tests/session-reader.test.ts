import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  openSession,
  parseSessionFolderName,
  readSessionLines,
} from '../src/reader/session-reader.js';
import { SAMPLE_SESSION_LINE_COUNT, sampleSessionFolder } from './helpers/sample-session.js';

/** Cree un dossier de session temporaire avec le contenu demande. */
async function makeSession(name: string, files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bg-tracker-test-'));
  const folder = join(root, name);
  await mkdir(folder);
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(folder, file), content, 'utf8');
  }
  return folder;
}

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

const SESSION = 'Hearthstone_2026_09_19_02_47_25';

describe('parseSessionFolderName', () => {
  it('lit la date et l’heure de lancement', () => {
    expect(parseSessionFolderName('Hearthstone_2026_09_22_00_28_13')).toEqual(
      new Date(2026, 8, 22, 0, 28, 13),
    );
  });

  it('interprete le nom en heure locale, comme les lignes de log', () => {
    const date = parseSessionFolderName(SESSION);
    expect(date?.getHours()).toBe(2);
    expect(date?.getMinutes()).toBe(47);
  });

  it('renvoie null pour un nom qui ne suit pas la convention', () => {
    expect(parseSessionFolderName('Logs')).toBeNull();
    expect(parseSessionFolderName('Hearthstone_2026_09_22')).toBeNull();
    expect(parseSessionFolderName('Hearthstone_2026_9_22_0_28_13')).toBeNull();
  });

  it('refuse une date impossible plutot que de la laisser deborder', () => {
    // `new Date(2026, 12, 1)` donnerait janvier 2027 sans broncher.
    expect(parseSessionFolderName('Hearthstone_2026_13_01_00_00_00')).toBeNull();
    expect(parseSessionFolderName('Hearthstone_2026_02_31_00_00_00')).toBeNull();
    expect(parseSessionFolderName('Hearthstone_2026_09_22_25_00_00')).toBeNull();
  });
});

describe('openSession', () => {
  it('liste Power_old.log avant Power.log', async () => {
    const folder = await makeSession(SESSION, {
      'Power.log': 'recent\r\n',
      'Power_old.log': 'ancien\r\n',
    });
    const session = await openSession(folder);

    expect(session.files.map((path) => path.split(/[\\/]/).pop())).toEqual([
      'Power_old.log',
      'Power.log',
    ]);
    expect(session.startedAt).toEqual(new Date(2026, 8, 19, 2, 47, 25));
  });

  it('ignore les autres fichiers du dossier de session', async () => {
    const folder = await makeSession(SESSION, {
      'Power.log': 'a\r\n',
      'Hearthstone.log': 'bruit\r\n',
      'LoadingScreen.log': 'bruit\r\n',
    });
    const session = await openSession(folder);

    expect(session.files).toHaveLength(1);
    expect(session.files[0]?.endsWith('Power.log')).toBe(true);
  });

  it('accepte un dossier sans aucun fichier Power', async () => {
    const session = await openSession(await makeSession(SESSION, {}));
    expect(session.files).toEqual([]);
  });

  it('laisse startedAt a null quand le dossier est nomme autrement', async () => {
    const session = await openSession(await makeSession('archive-2026', { 'Power.log': '' }));
    expect(session.startedAt).toBeNull();
  });

  it('signale un dossier introuvable', async () => {
    await expect(openSession(join(tmpdir(), 'bg-tracker-absent'))).rejects.toThrow(/introuvable/);
  });
});

describe('readSessionLines', () => {
  it('enchaine Power_old.log puis Power.log comme un seul flux', async () => {
    const folder = await makeSession(SESSION, {
      'Power_old.log': 'ancien 1\r\nancien 2\r\n',
      'Power.log': 'recent 1\r\nrecent 2\r\n',
    });

    expect(await collect(readSessionLines(folder))).toEqual([
      'ancien 1',
      'ancien 2',
      'recent 1',
      'recent 2',
    ]);
  });

  it('lit un dossier qui ne contient que Power.log', async () => {
    const folder = await makeSession(SESSION, { 'Power.log': 'seule\r\n' });
    expect(await collect(readSessionLines(folder))).toEqual(['seule']);
  });

  it('lit un dossier qui ne contient que Power_old.log', async () => {
    const folder = await makeSession(SESSION, { 'Power_old.log': 'seule\r\n' });
    expect(await collect(readSessionLines(folder))).toEqual(['seule']);
  });

  it('ne produit rien pour un dossier sans fichier Power', async () => {
    const folder = await makeSession(SESSION, { 'Hearthstone.log': 'bruit\r\n' });
    expect(await collect(readSessionLines(folder))).toEqual([]);
  });

  it('ne produit rien pour un fichier vide', async () => {
    const folder = await makeSession(SESSION, { 'Power.log': '' });
    expect(await collect(readSessionLines(folder))).toEqual([]);
  });

  it('saute un Power_old.log vide sans perdre Power.log', async () => {
    const folder = await makeSession(SESSION, {
      'Power_old.log': '',
      'Power.log': 'recent\r\n',
    });
    expect(await collect(readSessionLines(folder))).toEqual(['recent']);
  });

  it('retire le \\r final et l’espace que le jeu laisse en fin de ligne', async () => {
    // Ligne reelle : le jeu ecrit bien un espace avant le saut de ligne.
    const line =
      'D 02:48:30.3211164 GameState.DebugPrintPower() - TAG_CHANGE Entity=AkiLif#2498 tag=RESOURCES value=3 ';
    const folder = await makeSession(SESSION, { 'Power.log': `${line}\r\n` });

    const [read] = await collect(readSessionLines(folder));
    expect(read).toBe(line.trimEnd());
    expect(read).not.toMatch(/\s$/);
  });

  it('conserve l’indentation de debut de ligne, qui porte l’imbrication', async () => {
    const indented = 'D 02:48:30.3211164 GameState.DebugPrintPower() -     GameEntity EntityID=19';
    const folder = await makeSession(SESSION, { 'Power.log': `${indented}\r\n` });

    expect((await collect(readSessionLines(folder)))[0]).toBe(indented);
  });

  it('lit une derniere ligne non terminee par un saut de ligne', async () => {
    const folder = await makeSession(SESSION, { 'Power.log': 'a\r\nb' });
    expect(await collect(readSessionLines(folder))).toEqual(['a', 'b']);
  });

  it('gere les caracteres non latins des noms de joueur', async () => {
    const line =
      'D 02:48:30.3211164 GameState.DebugPrintGame() - PlayerID=15, PlayerName=МиниНиндзя';
    const folder = await makeSession(SESSION, { 'Power.log': `${line}\r\n` });
    expect((await collect(readSessionLines(folder)))[0]).toBe(line);
  });
});

describe('lecture de l’extrait de reference', () => {
  it('lit les 141 637 lignes de la session, sans \\r residuel', async () => {
    const folder = await sampleSessionFolder();
    const session = await openSession(folder);

    expect(session.startedAt).toEqual(new Date(2026, 8, 19, 2, 47, 25));
    expect(session.files).toHaveLength(1);

    let count = 0;
    let first = '';
    let last = '';
    for await (const line of readSessionLines(folder)) {
      if (count === 0) first = line;
      last = line;
      count += 1;
      if (line.includes('\r')) throw new Error(`\\r residuel ligne ${count}`);
    }

    expect(count).toBe(SAMPLE_SESSION_LINE_COUNT);
    expect(first).toBe('D 02:48:30.3211164 GameState.DebugPrintPowerList() - Count=44');

    // Le fichier ne s'arrete pas au STATE=COMPLETE de 03:13:48 : deux lignes
    // trainent 48 secondes plus tard (voir docs/LOG_FORMAT.md). Le decoupage
    // des parties devra les ignorer.
    expect(last).toBe(
      'D 03:14:36.7651850 GameState.DebugPrintPower() - TAG_CHANGE Entity=[entityName=A. F. Kah id=133 zone=SETASIDE zonePos=0 cardId=TB_BaconShop_HERO_16 player=15] tag=PLAYER_TRIPLES value=5',
    );
  });

  it('peut s’arreter apres quelques lignes sans lire les 19 Mo', async () => {
    const folder = await sampleSessionFolder();

    const head: string[] = [];
    for await (const line of readSessionLines(folder)) {
      head.push(line);
      if (head.length === 3) break;
    }

    expect(head).toHaveLength(3);
    expect(head[1]).toBe('D 02:48:30.3211164 GameState.DebugPrintPower() - CREATE_GAME');
  });
});
