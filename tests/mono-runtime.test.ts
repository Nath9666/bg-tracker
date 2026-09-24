import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fieldOffsetFromAccessor,
  findAssembly,
  getRootDomain,
  listAssemblies,
  MonoLayoutError,
} from '../src/memory/mono-runtime.js';
import {
  closeProcess,
  findModule,
  findProcessIdByName,
  openProcess,
  type ModuleInfo,
  type ProcessHandle,
} from '../src/memory/process-memory.js';

/**
 * Ces tests visent le **vrai processus Hearthstone**, sur la machine du
 * developpeur : aucune donnee de test ne peut imiter un runtime Mono en
 * memoire. Ils sont sautes proprement quand le jeu n'est pas lance, y
 * compris en integration continue, plutot que d'echouer.
 */
const hearthstonePid = process.platform === 'win32' ? findProcessIdByName('Hearthstone.exe') : null;

describe.skipIf(hearthstonePid === null)('runtime Mono, sur le jeu en cours', () => {
  let hs: ProcessHandle;
  let mono: ModuleInfo;

  beforeAll(() => {
    hs = openProcess(hearthstonePid!);
    mono = findModule(hs, /mono.*\.dll$/i)!;
    expect(mono).not.toBeNull();
  });

  afterAll(() => {
    closeProcess(hs);
  });

  it('retrouve le domaine racine', () => {
    const domain = getRootDomain(hs, mono);

    expect(domain).toBeGreaterThan(0n);
    // Un pointeur de heap Mono est toujours aligne.
    expect(domain % 8n).toBe(0n);
  });

  it('enumere les assemblies, avec mscorlib et Assembly-CSharp', () => {
    const domain = getRootDomain(hs, mono);
    const assemblies = listAssemblies(hs, mono, domain);

    // Une session Hearthstone en charge autour de 120.
    expect(assemblies.length).toBeGreaterThan(50);
    expect(assemblies.some((a) => a.name === 'mscorlib')).toBe(true);
    // C'est la ou vit le code du jeu, la cote comprise.
    expect(assemblies.some((a) => a.name === 'Assembly-CSharp')).toBe(true);
  });

  it('ne rend pas de doublons ni d’adresses nulles', () => {
    const domain = getRootDomain(hs, mono);
    const assemblies = listAssemblies(hs, mono, domain);

    const noms = assemblies.map((a) => a.name);
    expect(new Set(noms).size).toBe(noms.length);
    expect(assemblies.every((a) => a.assembly !== 0n && a.image !== 0n)).toBe(true);
  });

  it('retrouve une assembly precise par son nom', () => {
    const domain = getRootDomain(hs, mono);
    const assemblies = listAssemblies(hs, mono, domain);

    expect(findAssembly(assemblies, 'Assembly-CSharp')).not.toBeNull();
    expect(findAssembly(assemblies, 'assembly-csharp')).toBeNull(); // sensible à la casse
    expect(findAssembly(assemblies, 'CetteAssemblyNexistePas')).toBeNull();
  });

  it('leve une erreur explicite sur un export absent', () => {
    expect(() => fieldOffsetFromAccessor(hs, mono, 'fonction_qui_nexiste_pas')).toThrow(
      MonoLayoutError,
    );
  });

  it('leve une erreur explicite sur un export qui n’est pas un accesseur simple', () => {
    // mono_get_root_domain existe bien, mais son prologue est `mov rax,
    // [rip+X]; ret`, pas `mov rax, [rcx+X]; ret` : la fonction doit refuser
    // de l'interpreter comme un decalage de champ plutot que de rendre un
    // nombre errone.
    expect(() => fieldOffsetFromAccessor(hs, mono, 'mono_get_root_domain')).toThrow(
      MonoLayoutError,
    );
  });
});
