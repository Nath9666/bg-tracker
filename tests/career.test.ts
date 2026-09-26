import { describe, expect, it } from 'vitest';
import {
  careerView,
  latestSnapshot,
  recentWarbands,
  saveSnapshot,
  saveWarbands,
  warbandSignature,
} from '../src/career/career.js';
import { openDatabase } from '../src/db/database.js';

// Les chiffres de l'utilisateur, tels qu'affiches par le jeu le 26/09/2026.
const RELEVE = {
  top4: 1188,
  wins: 188,
  minionsKilled: 145916,
  triples: 5512,
  tavernUpgrades: 9106,
  playersEliminated: 1449,
  maxMinionDamage: 124303,
  strongestMinionAtk: 29805,
  strongestMinionHealth: 58794,
  secondsPlayed: 3204502,
  bestStreak: 14,
};

describe('saveSnapshot', () => {
  it('enregistre un releve et le relit a l’identique', () => {
    const db = openDatabase(':memory:');
    expect(saveSnapshot(db, '2026-09-26T12:00:00', RELEVE)).toBe(true);
    expect(latestSnapshot(db)).toEqual({ takenAt: '2026-09-26T12:00:00', stats: RELEVE });
  });

  it('ignore un releve identique au precedent', () => {
    // Le jeu relit ces chiffres a chaque ouverture de l'ecran.
    const db = openDatabase(':memory:');
    saveSnapshot(db, '2026-09-26T12:00:00', RELEVE);
    expect(saveSnapshot(db, '2026-09-26T13:00:00', RELEVE)).toBe(false);
    expect(latestSnapshot(db)?.takenAt).toBe('2026-09-26T12:00:00');
  });

  it('enregistre des qu’un compteur bouge', () => {
    const db = openDatabase(':memory:');
    saveSnapshot(db, '2026-09-26T12:00:00', RELEVE);
    expect(saveSnapshot(db, '2026-09-26T13:00:00', { ...RELEVE, top4: 1189 })).toBe(true);
    expect(latestSnapshot(db)?.stats['top4']).toBe(1189);
  });

  it('refuse un releve vide ou non numerique', () => {
    const db = openDatabase(':memory:');
    expect(saveSnapshot(db, '2026-09-26T12:00:00', {})).toBe(false);
    expect(saveSnapshot(db, '2026-09-26T12:00:00', { top4: Number.NaN })).toBe(false);
    expect(latestSnapshot(db)).toBeNull();
  });
});

describe('careerView', () => {
  it('rend les compteurs dans l’ordre du jeu, avec leur libelle', () => {
    const db = openDatabase(':memory:');
    saveSnapshot(db, '2026-09-26T12:00:00', RELEVE);

    const vue = careerView(db, '2026-09-20');
    expect(vue?.lines.map((l) => l.key).slice(0, 3)).toEqual(['top4', 'wins', 'minionsKilled']);
    expect(vue?.lines[0]).toMatchObject({ label: 'Tops 4', value: 1188, delta: null });
  });

  it('donne la progression depuis le premier releve de la periode', () => {
    const db = openDatabase(':memory:');
    saveSnapshot(db, '2026-09-10T12:00:00', { ...RELEVE, top4: 1100 }); // hors periode
    saveSnapshot(db, '2026-09-20T12:00:00', { ...RELEVE, top4: 1180, triples: 5500 });
    saveSnapshot(db, '2026-09-26T12:00:00', RELEVE);

    const vue = careerView(db, '2026-09-19');
    expect(vue?.lines.find((l) => l.key === 'top4')?.delta).toBe(8);
    expect(vue?.lines.find((l) => l.key === 'triples')?.delta).toBe(12);
  });

  it('garde un compteur inconnu, sous son nom brut', () => {
    const db = openDatabase(':memory:');
    saveSnapshot(db, '2026-09-26T12:00:00', { top4: 1188, nouveauCompteur: 7 });
    expect(careerView(db, '2026-09-01')?.lines.at(-1)).toMatchObject({ key: 'nouveauCompteur', value: 7 });
  });

  it('rend null sans aucun releve', () => {
    expect(careerView(openDatabase(':memory:'), '2026-09-01')).toBeNull();
  });
});

describe('troupes de guerre', () => {
  const CARIEL = {
    heroCardId: 'BG21_HERO_000',
    heroName: 'Cariel Roame',
    place: 2,
    minions: [
      { cardId: 'BG23_318', atk: 38, health: 34, golden: false },
      { cardId: 'BG36_103_G', atk: 287, health: 273, golden: true },
    ],
  };
  const THORIM = { heroCardId: 'BG27_HERO_801', heroName: 'Thorim', place: 1, minions: [] };

  it('enregistre les troupes jamais vues, une seule fois', () => {
    const db = openDatabase(':memory:');
    expect(saveWarbands(db, '2026-09-26T12:00:00', [CARIEL, THORIM])).toBe(2);
    // Le jeu remontre les memes a chaque ouverture de l'ecran.
    expect(saveWarbands(db, '2026-09-26T13:00:00', [CARIEL, THORIM])).toBe(0);
  });

  it('les rend de la plus recente a la plus ancienne', () => {
    const db = openDatabase(':memory:');
    saveWarbands(db, '2026-09-25T12:00:00', [THORIM]);
    saveWarbands(db, '2026-09-26T12:00:00', [CARIEL, THORIM]);

    expect(recentWarbands(db).map((w) => w.heroName)).toEqual(['Cariel Roame', 'Thorim']);
  });

  it('garde l’ordre du jeu au sein d’un meme releve', () => {
    const db = openDatabase(':memory:');
    saveWarbands(db, '2026-09-26T12:00:00', [CARIEL, THORIM]);
    expect(recentWarbands(db).map((w) => w.place)).toEqual([2, 1]);
  });

  it('distingue deux parties du meme heros', () => {
    const autre = { ...CARIEL, place: 5 };
    expect(warbandSignature(autre)).not.toBe(warbandSignature(CARIEL));
  });

  it('restitue les serviteurs, dores compris, avec leur nom a defaut de la base', () => {
    const db = openDatabase(':memory:');
    saveWarbands(db, '2026-09-26T12:00:00', [CARIEL]);
    expect(recentWarbands(db)[0]?.minions[1]).toMatchObject({ cardId: 'BG36_103_G', golden: true, name: 'BG36_103_G' });
  });
});
