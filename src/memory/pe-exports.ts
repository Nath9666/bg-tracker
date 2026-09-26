/**
 * Table d'exports d'un module PE, lue a distance.
 *
 * Sert a localiser une fonction du runtime Mono par son nom (par exemple
 * `mono_get_root_domain`) sans l'executer : on ne peut pas appeler de code
 * dans le processus vise, seulement lire sa memoire. Localiser l'export donne
 * une adresse a partir de laquelle chercher le pointeur qui nous interesse
 * (voir `mono-runtime.ts`).
 *
 * Format standard, verifiable sur n'importe quel module : `kernel32.dll` sert
 * de cas de test, ses exports etant stables et toujours presents.
 */
import type { ModuleInfo } from './process-memory.js';
import { readMemory } from './process-memory.js';
import type { ProcessHandle } from './process-memory.js';

const DOS_HEADER_SIZE = 0x40;
const PE_MAGIC_OFFSET = 0x3c;
/** PE32+ (x64). PE32 (x86) vaut 0x10b : non gere, le jeu et Node sont en x64. */
const PE64_MAGIC = 0x20b;
const OPTIONAL_HEADER_OFFSET = 24;
/** Offset du DataDirectory des exports dans un optional header PE32+. */
const EXPORT_DATA_DIRECTORY_OFFSET = 112;
const EXPORT_DIRECTORY_SIZE = 40;
const MAX_EXPORT_NAME = 128;

export class PeParseError extends Error {}

/** Adresse (pas seulement RVA) d'un export, prete a lire ou a sonder. */
export function findExport(target: ProcessHandle, module: ModuleInfo, name: string): bigint | null {
  const dos = readMemory(target, module.base, DOS_HEADER_SIZE);
  if (dos === null || dos.toString('latin1', 0, 2) !== 'MZ') {
    throw new PeParseError(`${module.name} : en-tête DOS invalide`);
  }

  const peBase = module.base + BigInt(dos.readUInt32LE(PE_MAGIC_OFFSET));
  const coff = readMemory(target, peBase, 24);
  if (coff === null || coff.toString('latin1', 0, 2) !== 'PE') {
    throw new PeParseError(`${module.name} : en-tête PE invalide`);
  }

  const sizeOfOptionalHeader = coff.readUInt16LE(20);
  const optHeader = readMemory(
    target,
    peBase + BigInt(OPTIONAL_HEADER_OFFSET),
    sizeOfOptionalHeader,
  );
  if (optHeader === null || optHeader.readUInt16LE(0) !== PE64_MAGIC) {
    throw new PeParseError(`${module.name} : n'est pas un module PE32+ (x64)`);
  }

  const exportDirRva = optHeader.readUInt32LE(EXPORT_DATA_DIRECTORY_OFFSET);
  if (exportDirRva === 0) return null; // pas de table d'exports.

  const expDir = readMemory(target, module.base + BigInt(exportDirRva), EXPORT_DIRECTORY_SIZE);
  if (expDir === null) throw new PeParseError(`${module.name} : table d'exports illisible`);

  const numberOfNames = expDir.readUInt32LE(24);
  const addressOfFunctions = expDir.readUInt32LE(28);
  const addressOfNames = expDir.readUInt32LE(32);
  const addressOfNameOrdinals = expDir.readUInt32LE(36);

  const names = readMemory(target, module.base + BigInt(addressOfNames), numberOfNames * 4);
  const ordinals = readMemory(
    target,
    module.base + BigInt(addressOfNameOrdinals),
    numberOfNames * 2,
  );
  if (names === null || ordinals === null) return null;

  for (let i = 0; i < numberOfNames; i += 1) {
    const nameRva = names.readUInt32LE(i * 4);
    const nameBuf = readMemory(target, module.base + BigInt(nameRva), MAX_EXPORT_NAME);
    if (nameBuf === null) continue;

    const end = nameBuf.indexOf(0);
    const found = nameBuf.toString('latin1', 0, end === -1 ? MAX_EXPORT_NAME : end);
    if (found !== name) continue;

    const ordinal = ordinals.readUInt16LE(i * 2);
    const functions = readMemory(
      target,
      module.base + BigInt(addressOfFunctions) + BigInt(ordinal * 4),
      4,
    );
    if (functions === null) return null;

    return module.base + BigInt(functions.readUInt32LE(0));
  }

  return null;
}
