import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { readCareer } from '../src/memory/career-reader.js';
import { findProcessIdByName } from '../src/memory/process-memory.js';

/**
 * Sur le vrai jeu : aucune donnee de test ne peut imiter son tas. Saute quand
 * le jeu n'est pas lance. Quand il l'est, l'ecran de statistiques peut ne pas
 * avoir ete ouvert : `null` est alors la bonne reponse.
 */
const enCours = process.platform === 'win32' && findProcessIdByName('Hearthstone.exe') !== null;

describe.skipIf(!enCours)('statistiques de carriere lues dans le jeu', () => {
  it('rend null ou des compteurs coherents, avec au plus cinq troupes', () => {
    const lecture = readCareer();
    if (lecture === null) return;

    const s = lecture.stats;
    expect(Object.keys(s)).toHaveLength(11);
    expect(s['top4']!).toBeGreaterThanOrEqual(s['wins']!);
    expect(s['secondsPlayed']!).toBeGreaterThan(0);
    expect(lecture.warbands.length).toBeLessThanOrEqual(5);
    for (const troupe of lecture.warbands) {
      expect(troupe.place).toBeGreaterThanOrEqual(1);
      expect(troupe.place).toBeLessThanOrEqual(8);
      expect(troupe.minions.length).toBeLessThanOrEqual(7);
    }
  }, 30_000);
});
