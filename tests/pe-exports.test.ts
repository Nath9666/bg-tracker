import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findExport, PeParseError } from '../src/memory/pe-exports.js';
import {
  closeProcess,
  findModule,
  openProcess,
  type ModuleInfo,
  type ProcessHandle,
} from '../src/memory/process-memory.js';

const surWindows = process.platform === 'win32';

describe.skipIf(!surWindows)('findExport', () => {
  let moi: ProcessHandle;
  let kernel32: ModuleInfo;

  beforeAll(() => {
    moi = openProcess(process.pid);
    kernel32 = findModule(moi, /^kernel32\.dll$/i)!;
  });

  afterAll(() => {
    closeProcess(moi);
  });

  it('localise un export connu', () => {
    const adresse = findExport(moi, kernel32, 'OpenProcess');

    expect(adresse).not.toBeNull();
    // L'adresse doit tomber dans les 16 Mo suivant la base du module : au-dela,
    // c'est le signe qu'on a mal lu le RVA.
    expect(adresse! - kernel32.base).toBeGreaterThan(0n);
    expect(adresse! - kernel32.base).toBeLessThan(0x1000000n);
  });

  it('rend null pour un nom absent', () => {
    expect(findExport(moi, kernel32, 'CetteFonctionNexistePas')).toBeNull();
  });

  it('retrouve plusieurs exports differents', () => {
    // Des fonctions connues, a des index differents dans la table triee.
    const closeHandle = findExport(moi, kernel32, 'CloseHandle');
    const readProcessMemory = findExport(moi, kernel32, 'ReadProcessMemory');

    expect(closeHandle).not.toBeNull();
    expect(readProcessMemory).not.toBeNull();
    expect(closeHandle).not.toBe(readProcessMemory);
  });

  it('rejette un module dont l’en-tête DOS est invalide', () => {
    const faux: ModuleInfo = { ...kernel32, base: kernel32.base + 1n };
    expect(() => findExport(moi, faux, 'OpenProcess')).toThrow(PeParseError);
  });
});
