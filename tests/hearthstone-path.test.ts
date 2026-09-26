import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findLogsFolder, readInstallLocationFromRegistry } from '../src/reader/hearthstone-path.js';

const partout = (): boolean => true;

describe('findLogsFolder', () => {
  it('prefere la variable d’environnement', () => {
    const dossier = findLogsFolder({
      env: { BG_TRACKER_LOGS: String.raw`D:\Jeux\Hearthstone\Logs` },
      readInstallLocation: () => String.raw`F:\SteamLibrary\Hearthstone`,
      exists: partout,
    });
    expect(dossier).toEqual({
      path: String.raw`D:\Jeux\Hearthstone\Logs`,
      source: 'env',
      exists: true,
    });
  });

  it('prend sinon l’emplacement inscrit dans le registre', () => {
    const dossier = findLogsFolder({
      env: {},
      readInstallLocation: () => String.raw`F:\SteamLibrary\Hearthstone`,
      exists: partout,
    });
    expect(dossier.source).toBe('registry');
    expect(dossier.path).toBe(join(String.raw`F:\SteamLibrary\Hearthstone`, 'Logs'));
  });

  it('se rabat sur l’emplacement par defaut de Battle.net', () => {
    const dossier = findLogsFolder({
      env: {},
      readInstallLocation: () => null,
      exists: () => false,
    });
    expect(dossier.source).toBe('default');
    expect(dossier.path).toContain('Hearthstone');
    // Signale l'absence plutot que de mentir.
    expect(dossier.exists).toBe(false);
  });

  it('ignore une variable d’environnement vide', () => {
    const dossier = findLogsFolder({
      env: { BG_TRACKER_LOGS: '' },
      readInstallLocation: () => null,
      exists: partout,
    });
    expect(dossier.source).toBe('default');
  });
});

describe('readInstallLocationFromRegistry', () => {
  it('rend un chemin ou null, sans lever', () => {
    // Depend de la machine : on verifie seulement le contrat.
    const valeur = readInstallLocationFromRegistry();
    expect(valeur === null || valeur.length > 0).toBe(true);
  });
});
