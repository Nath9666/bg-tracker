/**
 * Lecture de la memoire d'un processus Windows.
 *
 * ⚠️ Ce module **sort de la regle « uniquement les fichiers de log »**. Il
 * existe pour une seule raison : la cote (MMR) n'apparait dans aucun des dix
 * fichiers qu'une session ecrit (verifie, voir docs/LOG_FORMAT.md), et
 * Hearthstone Deck Tracker ne fait pas autrement. Voir CLAUDE.md pour la
 * decision.
 *
 * En lecture seule, et rien n'est jamais ecrit dans le processus vise.
 *
 * Passe par `koffi`, un FFI a binaires precompilis : pas de `node-gyp`, donc
 * pas de recompilation a chaque version d'Electron. `memoryjs`, le module
 * habituel pour cet usage, ne se compile plus depuis Node 18.
 */
import koffi from 'koffi';

const kernel32 = koffi.load('kernel32.dll');
const psapi = koffi.load('psapi.dll');

const OpenProcess = kernel32.func('void* OpenProcess(uint32 access, bool inherit, uint32 pid)');
const CloseHandle = kernel32.func('bool CloseHandle(void* handle)');
const ReadProcessMemory = kernel32.func(
  'bool ReadProcessMemory(void* handle, void* address, _Out_ void* buffer, size_t size, _Out_ size_t* read)',
);
const EnumProcesses = kernel32.func(
  'bool K32EnumProcesses(_Out_ uint32* pids, uint32 size, _Out_ uint32* needed)',
);
const EnumProcessModulesEx = kernel32.func(
  'bool K32EnumProcessModulesEx(void* handle, _Out_ void** modules, uint32 size, _Out_ uint32* needed, uint32 filter)',
);
const GetModuleFileNameExW = psapi.func(
  'uint32 GetModuleFileNameExW(void* handle, void* module, _Out_ uint16* name, uint32 size)',
);

/** Droits demandes : interroger et lire, jamais ecrire. */
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;
const LIST_MODULES_ALL = 0x03;

/** Taille d'un pointeur. Le jeu et Node sont tous deux en 64 bits. */
const POINTER_SIZE = 8;
const MAX_PATH = 260;

export interface ProcessHandle {
  pid: number;
  /** Poignee Win32 opaque. */
  handle: unknown;
}

export interface ModuleInfo {
  /** Nom du fichier seul, ex. `mono-2.0-bdwgc.dll`. */
  name: string;
  path: string;
  base: bigint;
}

/** Un processus introuvable, ou qu'on n'a pas le droit d'ouvrir. */
export class ProcessNotFound extends Error {}

function utf16(buffer: Uint16Array): string {
  return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    .toString('utf16le')
    .split('\0')[0] ?? '';
}

/**
 * Identifiants de tous les processus visibles.
 *
 * Beaucoup ne seront pas ouvrables : c'est normal, on ignore les echecs.
 */
export function listProcessIds(): number[] {
  const pids = new Uint32Array(4096);
  const needed = [0];
  if (!EnumProcesses(pids, pids.byteLength, needed)) return [];
  return [...pids.slice(0, Math.floor(needed[0]! / 4))];
}

/** Ouvre un processus en lecture. */
export function openProcess(pid: number): ProcessHandle {
  const handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
  if (!handle) throw new ProcessNotFound(`Processus ${pid} : ouverture refusée`);
  return { pid, handle };
}

export function closeProcess(target: ProcessHandle): void {
  CloseHandle(target.handle);
}

/** Modules charges par le processus, le premier etant l'executable lui-meme. */
export function listModules(target: ProcessHandle): ModuleInfo[] {
  const modules = new Array<unknown>(2048).fill(null);
  const needed = [0];
  if (
    !EnumProcessModulesEx(
      target.handle,
      modules,
      modules.length * POINTER_SIZE,
      needed,
      LIST_MODULES_ALL,
    )
  ) {
    return [];
  }

  const count = Math.min(Math.floor(needed[0]! / POINTER_SIZE), modules.length);
  const found: ModuleInfo[] = [];

  for (let i = 0; i < count; i += 1) {
    const module = modules[i];
    if (module === null || module === undefined) continue;

    const nom = new Uint16Array(MAX_PATH);
    if (GetModuleFileNameExW(target.handle, module, nom, MAX_PATH) === 0) continue;

    const path = utf16(nom);
    found.push({
      path,
      name: path.split(/[\\/]/).pop() ?? path,
      base: koffi.address(module as never),
    });
  }

  return found;
}

/** Premier module dont le nom correspond, insensible a la casse. */
export function findModule(target: ProcessHandle, pattern: RegExp): ModuleInfo | null {
  return listModules(target).find((module) => pattern.test(module.name)) ?? null;
}

/**
 * Lit `size` octets a l'adresse donnee.
 *
 * Renvoie `null` plutot que de lever : une adresse invalide est un cas
 * courant quand on suit des pointeurs, pas une anomalie.
 */
export function readMemory(target: ProcessHandle, address: bigint, size: number): Buffer | null {
  if (address === 0n || size <= 0) return null;

  const buffer = Buffer.alloc(size);
  const read = [0];
  if (!ReadProcessMemory(target.handle, address, buffer, size, read)) return null;
  if (read[0] !== size) return null;

  return buffer;
}

/** Lit un pointeur 64 bits. `0n` signifie nul, comme dans le processus vise. */
export function readPointer(target: ProcessHandle, address: bigint): bigint {
  return readMemory(target, address, POINTER_SIZE)?.readBigUInt64LE(0) ?? 0n;
}

export function readInt32(target: ProcessHandle, address: bigint): number | null {
  return readMemory(target, address, 4)?.readInt32LE(0) ?? null;
}

/**
 * Lit une chaine C terminee par zero.
 *
 * `max` borne la lecture : sans lui, une adresse erronee ferait lire jusqu'a
 * la fin de la page.
 */
export function readCString(target: ProcessHandle, address: bigint, max = 256): string | null {
  const buffer = readMemory(target, address, max);
  if (buffer === null) return null;

  const fin = buffer.indexOf(0);
  return buffer.toString('utf8', 0, fin === -1 ? max : fin);
}
