/**
 * Emplacement du dossier `Logs` de Hearthstone, sur n'importe quelle machine.
 *
 * Par ordre de priorite :
 *
 * 1. la variable d'environnement `BG_TRACKER_LOGS`, pour forcer un dossier ;
 * 2. le registre Windows, ou Battle.net inscrit l'emplacement d'installation
 *    (`...\Uninstall\Hearthstone`, valeur `InstallLocation`) ;
 * 3. l'emplacement par defaut de Battle.net, `C:\Program Files (x86)\Hearthstone`.
 *
 * Verifie le 25/09/2026 : le registre donne bien `F:\SteamLibrary\Hearthstone`
 * sur la machine d'origine, installee ailleurs que par defaut.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY_KEY = String.raw`HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Hearthstone`;
const DEFAULT_INSTALL = String.raw`C:\Program Files (x86)\Hearthstone`;

export interface LogsFolderSources {
  env?: Record<string, string | undefined>;
  /** Emplacement d'installation lu dans le registre, `null` s'il n'y est pas. */
  readInstallLocation?: () => string | null;
  exists?: (path: string) => boolean;
}

/** Lit `InstallLocation` avec `reg.exe`, sans ouvrir de fenetre. */
export function readInstallLocationFromRegistry(): string | null {
  if (process.platform !== 'win32') return null;

  const result = spawnSync('reg', ['query', REGISTRY_KEY, '/v', 'InstallLocation'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return null;

  // `    InstallLocation    REG_SZ    F:\SteamLibrary\Hearthstone`
  const ligne = result.stdout.split(/\r?\n/).find((l) => /InstallLocation/.test(l));
  const valeur = ligne?.split(/\s+REG_\w+\s+/)[1]?.trim();
  return valeur === undefined || valeur.length === 0 ? null : valeur;
}

/** Le dossier `Logs` retenu, et d'ou vient cette reponse. */
export interface LogsFolder {
  path: string;
  source: 'env' | 'registry' | 'default';
  /** Faux si le dossier n'existe pas : le jeu n'est peut-etre jamais lance, ou pas installe. */
  exists: boolean;
}

export function findLogsFolder(sources: LogsFolderSources = {}): LogsFolder {
  const env = sources.env ?? process.env;
  const exists = sources.exists ?? existsSync;
  const readInstall = sources.readInstallLocation ?? readInstallLocationFromRegistry;

  const force = env['BG_TRACKER_LOGS'];
  if (force !== undefined && force.length > 0) {
    return { path: force, source: 'env', exists: exists(force) };
  }

  const installe = readInstall();
  if (installe !== null) {
    const path = join(installe, 'Logs');
    return { path, source: 'registry', exists: exists(path) };
  }

  const path = join(DEFAULT_INSTALL, 'Logs');
  return { path, source: 'default', exists: exists(path) };
}

/** Raccourci : le chemin seul. */
export function logsFolderPath(): string {
  return findLogsFolder().path;
}
