import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { openRatingReader, tryReadRating } from '../src/memory/rating-reader.js';
import { findProcessIdByName } from '../src/memory/process-memory.js';

/**
 * Tests sur le vrai jeu : aucune donnee de test ne peut imiter le tas geré de
 * Hearthstone. Sautes quand le jeu n'est pas lance.
 */
const enCours = process.platform === 'win32' && findProcessIdByName('Hearthstone.exe') !== null;

describe.skipIf(!enCours)('cote lue dans le jeu', () => {
  it('rend une cote Solo et Duo plausibles', () => {
    const lecteur = openRatingReader();
    try {
      const cote = lecteur.read();
      // Les cotes des Champs de bataille vont de 0 a une vingtaine de milliers.
      expect(cote.solo).toBeGreaterThanOrEqual(0);
      expect(cote.solo).toBeLessThan(30_000);
      expect(cote.duos).toBeGreaterThanOrEqual(0);
      expect(cote.duos).toBeLessThan(30_000);
    } finally {
      lecteur.close();
    }
  });

  it('rend la meme valeur a chaque relecture', () => {
    const lecteur = openRatingReader();
    try {
      expect(lecteur.read()).toEqual(lecteur.read());
    } finally {
      lecteur.close();
    }
  });

  it('ne leve jamais en lecture ponctuelle', () => {
    expect(() => tryReadRating()).not.toThrow();
    expect(tryReadRating()).not.toBeNull();
  });
});

describe('sans le jeu', () => {
  it.skipIf(enCours)('rend null plutot que de lever', () => {
    expect(tryReadRating()).toBeNull();
  });
});

describe('raceName', () => {
  it('traduit les numeros de type au format de la base de cartes', async () => {
    const { raceName } = await import('../src/memory/rating-reader.js');
    expect(raceName(14)).toBe('MURLOC');
    expect(raceName(43)).toBe('QUILBOAR');
    expect(raceName(126)).toBe('ABERRATION');
    // Firestone ecrit MECH, HearthstoneJSON MECHANICAL : on s'aligne sur la base.
    expect(raceName(17)).toBe('MECHANICAL');
    expect(raceName(9999)).toBeNull();
  });
});

describe.skipIf(!enCours)('types de la partie', () => {
  it('rend null hors partie, ou cinq types connus en partie', () => {
    const lecteur = openRatingReader();
    try {
      const types = lecteur.lobbyRaces();
      // Hors partie, GameState n'existe pas ; en partie, un lobby compte
      // cinq types. Les deux sont legitimes selon le moment du test.
      if (types !== null) {
        expect(types.length).toBeGreaterThanOrEqual(4);
        expect(types.length).toBeLessThanOrEqual(6);
      }
    } finally {
      lecteur.close();
    }
  });
});
