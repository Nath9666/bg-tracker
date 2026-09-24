import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeProcess,
  findModule,
  findProcessIdByName,
  listModules,
  listProcessIds,
  openProcess,
  ProcessNotFound,
  readCString,
  readInt32,
  readMemory,
  readPointer,
  type ProcessHandle,
} from '../src/memory/process-memory.js';

/**
 * Ces tests visent **notre propre processus**, pas Hearthstone : il est
 * toujours la, et son contenu est verifiable sans rien supposer du jeu.
 */
const surWindows = process.platform === 'win32';

describe.skipIf(!surWindows)('lecture memoire', () => {
  let moi: ProcessHandle;

  beforeAll(() => {
    moi = openProcess(process.pid);
  });

  afterAll(() => {
    if (moi !== undefined) closeProcess(moi);
  });

  it('enumere les processus du systeme', () => {
    const pids = listProcessIds();

    expect(pids.length).toBeGreaterThan(10);
    expect(pids).toContain(process.pid);
  });

  it('refuse un processus qui n’existe pas', () => {
    // 0xFFFFFFF0 : hors de portee des identifiants reels.
    expect(() => openProcess(0xfffffff0)).toThrow(ProcessNotFound);
  });

  it('liste les modules charges', () => {
    const modules = listModules(moi);

    expect(modules.length).toBeGreaterThan(5);
    expect(modules.some((m) => /\.exe$/i.test(m.name))).toBe(true);
    expect(modules.some((m) => /^kernel32\.dll$/i.test(m.name))).toBe(true);
  });

  it('donne un chemin et une adresse a chaque module', () => {
    const kernel32 = findModule(moi, /^kernel32\.dll$/i);

    expect(kernel32).not.toBeNull();
    expect(kernel32!.base).toBeGreaterThan(0n);
    expect(kernel32!.path.toLowerCase()).toContain('kernel32.dll');
  });

  it('rend null pour un module absent', () => {
    expect(findModule(moi, /^module-qui-nexiste-pas\.dll$/)).toBeNull();
  });

  it('lit l’en-tete d’un module charge', () => {
    // Verification falsifiable : tout module Windows commence par « MZ », et
    // porte « PE » a l'offset indique par son en-tete DOS.
    const kernel32 = findModule(moi, /^kernel32\.dll$/i)!;

    const dos = readMemory(moi, kernel32.base, 0x40);
    expect(dos).not.toBeNull();
    expect(dos!.toString('latin1', 0, 2)).toBe('MZ');

    const pe = readMemory(moi, kernel32.base + BigInt(dos!.readUInt32LE(0x3c)), 4);
    expect(pe!.toString('latin1', 0, 2)).toBe('PE');
  });

  it('rend null sur une adresse nulle ou illisible', () => {
    // Suivre un pointeur mene souvent a une adresse invalide : ce n'est pas
    // une anomalie, donc pas une exception.
    expect(readMemory(moi, 0n, 8)).toBeNull();
    expect(readMemory(moi, 0xdeadbeefn, 8)).toBeNull();
    expect(readMemory(moi, 1n, 0)).toBeNull();
  });

  it('lit un entier et un pointeur', () => {
    const kernel32 = findModule(moi, /^kernel32\.dll$/i)!;

    // `MZ` plus l'entete DOS : les deux premiers octets valent 0x5A4D.
    expect(readInt32(moi, kernel32.base)! & 0xffff).toBe(0x5a4d);
    expect(readPointer(moi, 0n)).toBe(0n);
    expect(readInt32(moi, 0n)).toBeNull();
  });

  it('lit une chaine terminee par zero', () => {
    const kernel32 = findModule(moi, /^kernel32\.dll$/i)!;
    const dos = readMemory(moi, kernel32.base, 0x40)!;

    // Le stub DOS contient « This program cannot be run in DOS mode ».
    const stub = readCString(moi, kernel32.base + BigInt(dos.readUInt32LE(0x3c)) - 0x40n, 64);
    expect(typeof stub).toBe('string');

    expect(readCString(moi, 0n)).toBeNull();
  });
});

describe.skipIf(!surWindows)('findProcessIdByName', () => {
  it('trouve un processus par le nom de son executable', () => {
    // Notre propre processus n'a pas de nom d'executable stable a tester
    // (ca depend du runtime), donc on verifie l'absence, qui est le seul
    // comportement independant de la machine.
    expect(findProcessIdByName('un-executable-qui-nexiste-surement-pas.exe')).toBeNull();
  });

  it('ne demande que le droit minimal, sans PROCESS_VM_READ', () => {
    // Verification indirecte : la fonction ne doit pas lever meme sur un
    // processus systeme protege qu'on ne pourrait pas ouvrir en lecture
    // memoire. On se contente ici qu'elle rende un resultat (null ou un pid)
    // sans exception, sur l'ensemble des processus visibles.
    expect(() => findProcessIdByName('svchost.exe')).not.toThrow();
  });
});
