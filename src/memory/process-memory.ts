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
const QueryFullProcessImageNameW = kernel32.func(
  'bool QueryFullProcessImageNameW(void* handle, uint32 flags, _Out_ uint16* name, _Inout_ uint32* size)',
);

/** Droits demandes : interroger et lire, jamais ecrire. */
const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;
/** Suffit à interroger le nom d'un processus, sans droit de lire sa mémoire. */
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
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

/**
 * Identifiant du processus dont l'exécutable porte ce nom, insensible à la
 * casse (ex. `Hearthstone.exe`). `null` si aucun processus ne correspond.
 *
 * N'ouvre chaque processus qu'en `PROCESS_QUERY_LIMITED_INFORMATION` : pas
 * besoin de lire sa mémoire pour connaître son nom, et ce droit est accordé
 * beaucoup plus largement par Windows.
 */
const ESCAPE_REGEX_CHARS = /[.*+?^${}()|[\]\\]/g;

export function findProcessIdByName(exeName: string): number | null {
  const escaped = exeName.replace(ESCAPE_REGEX_CHARS, String.raw`\$&`);
  const pattern = new RegExp(`${escaped}$`, 'i');

  for (const pid of listProcessIds()) {
    const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (!handle) continue;

    const buffer = new Uint16Array(MAX_PATH);
    const size = [MAX_PATH];
    const ok = QueryFullProcessImageNameW(handle, 0, buffer, size);
    CloseHandle(handle);

    if (ok && pattern.test(utf16(buffer.subarray(0, size[0]!)))) return pid;
  }

  return null;
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

const MemoryBasicInformation = koffi.struct('MEMORY_BASIC_INFORMATION', {
  BaseAddress: 'uint64',
  AllocationBase: 'uint64',
  AllocationProtect: 'uint32',
  PartitionId: 'uint16',
  RegionSize: 'uint64',
  State: 'uint32',
  Protect: 'uint32',
  Type: 'uint32',
});
const VirtualQueryEx = kernel32.func(
  'size_t VirtualQueryEx(void* handle, uint64 address, _Out_ MEMORY_BASIC_INFORMATION* info, size_t length)',
);

const MEM_COMMIT = 0x1000;
const MEM_PRIVATE = 0x20000;
const PAGE_READWRITE = 0x04;
/** Bloc de lecture : assez gros pour aller vite, assez petit pour ne pas saturer la memoire. */
const SCAN_CHUNK = 0x400000n;
const USER_SPACE_END = 0x7fffffffffffn;

/**
 * Adresses alignees ou figure ce pointeur, dans le tas du processus.
 *
 * Ne parcourt que la memoire privee, engagee et en lecture-ecriture : c'est la
 * que vivent les objets geres. Sert a retrouver les instances d'une classe par
 * leur pointeur de table virtuelle, quand aucune variable globale n'y mene.
 * Environ 1,8 s pour les ~1,9 Go d'un Hearthstone en cours (mesure le
 * 26/09/2026) : a lancer hors du processus principal.
 *
 * Toutes les occurrences ne sont pas des objets vivants : de la memoire
 * liberee ou un tableau peut porter la meme valeur. A l'appelant de verifier.
 */
export function findPointerOccurrences(target: ProcessHandle, value: bigint): bigint[] {
  const motif = Buffer.alloc(8);
  motif.writeBigUInt64LE(value);

  const trouves: bigint[] = [];
  let adresse = 0n;
  while (adresse < USER_SPACE_END) {
    const info: Record<string, number | bigint> = {};
    if (VirtualQueryEx(target.handle, adresse, info, koffi.sizeof(MemoryBasicInformation)) === 0) break;

    const base = BigInt(info['BaseAddress']!);
    const taille = BigInt(info['RegionSize']!);
    if (taille === 0n) break;

    if (info['State'] === MEM_COMMIT && info['Protect'] === PAGE_READWRITE && info['Type'] === MEM_PRIVATE) {
      for (let off = 0n; off < taille; off += SCAN_CHUNK) {
        const n = taille - off < SCAN_CHUNK ? taille - off : SCAN_CHUNK;
        const bloc = readMemory(target, base + off, Number(n));
        if (bloc === null) continue;
        for (let i = bloc.indexOf(motif); i !== -1; i = bloc.indexOf(motif, i + 1)) {
          if (i % 8 === 0) trouves.push(base + off + BigInt(i));
        }
      }
    }
    adresse = base + taille;
  }
  return trouves;
}
