import { appendFile, cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { importSessions } from '../src/db/import-sessions.js';
import {
  forgetImportedSessions,
  isSessionImported,
  markSessionImported,
  sessionFingerprint,
} from '../src/db/session-state.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { sampleSessionFolder, SAMPLE_SESSION_FOLDER_NAME } from './helpers/sample-session.js';

/** Copie jetable de la session d'exemple, pour pouvoir la modifier. */
async function sessionJetable(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bg-import-'));
  const folder = join(root, SAMPLE_SESSION_FOLDER_NAME);
  await cp(await sampleSessionFolder(), folder, { recursive: true });
  return folder;
}

describe('importSessions', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('importe une session, puis la saute si rien n’a bouge', async () => {
    const folder = await sessionJetable();

    const premier = await importSessions(db, [folder]);
    expect(premier.skipped).toBe(0);
    expect(premier.inserted).toBeGreaterThan(0);

    const second = await importSessions(db, [folder]);
    expect(second.skipped).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.sessions[0]?.skipped).toBe(true);
  });

  it('relit une session encore en cours, qui a grossi', async () => {
    const folder = await sessionJetable();
    await importSessions(db, [folder]);

    // Une session en cours grossit : son empreinte change, donc elle est relue.
    await appendFile(join(folder, 'Power_old.log'), 'D 00:00:00.0000000 GameState.x\n');

    const apres = await importSessions(db, [folder]);
    expect(apres.skipped).toBe(0);
    expect(apres.sessions[0]?.games).toBeGreaterThan(0);
  });

  it('relit tout avec force, sans rien dupliquer', async () => {
    const folder = await sessionJetable();
    const premier = await importSessions(db, [folder]);
    const parties = () => (db.prepare('SELECT COUNT(*) AS n FROM games').get() as { n: number }).n;
    const avant = parties();

    const force = await importSessions(db, [folder], { force: true });

    expect(force.skipped).toBe(0);
    expect(force.inserted).toBe(0);
    expect(force.updated).toBe(premier.inserted);
    expect(parties()).toBe(avant);
  });

  it('relit tout apres un oubli des empreintes', async () => {
    const folder = await sessionJetable();
    await importSessions(db, [folder]);

    forgetImportedSessions(db);

    expect((await importSessions(db, [folder])).skipped).toBe(0);
  });
});

describe('sessionFingerprint', () => {
  it('change quand le fichier change, pas autrement', async () => {
    const db = openDatabase(':memory:');
    const folder = await sessionJetable();

    const avant = await sessionFingerprint(db, folder);
    expect(await sessionFingerprint(db, folder)).toBe(avant);

    await appendFile(join(folder, 'Power_old.log'), 'x\n');
    expect(await sessionFingerprint(db, folder)).not.toBe(avant);
  });

  it('porte la version du schema, pour qu’une migration invalide tout', async () => {
    const db = openDatabase(':memory:');
    const folder = await sessionJetable();

    expect(await sessionFingerprint(db, folder)).toMatch(/^v\d+\|/);
  });
});

describe('isSessionImported', () => {
  it('ne reconnait que l’empreinte exacte', () => {
    const db = openDatabase(':memory:');

    expect(isSessionImported(db, 'a', 'v1|x')).toBe(false);
    markSessionImported(db, 'a', 'v1|x');
    expect(isSessionImported(db, 'a', 'v1|x')).toBe(true);
    expect(isSessionImported(db, 'a', 'v1|y')).toBe(false);
    expect(isSessionImported(db, 'b', 'v1|x')).toBe(false);
  });
});
