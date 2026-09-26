import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSessions, formatSummary, parseCliArgs } from '../src/cli/parse.js';
import { openSession, resolveSessionDate } from '../src/reader/session-reader.js';
import type { GameSummary } from '../src/types.js';
import { sampleSessionFolder } from './helpers/sample-session.js';

describe('parseCliArgs', () => {
  it('lit un dossier seul', () => {
    expect(parseCliArgs(['fixtures/sample-game-1'])).toEqual({
      folder: 'fixtures/sample-game-1',
      json: false,
      ids: false,
    });
  });

  it('reconnait --json, quelle que soit sa position', () => {
    expect(parseCliArgs(['--json', 'fixtures/sample-game-1'])).toEqual({
      folder: 'fixtures/sample-game-1',
      json: true,
      ids: false,
    });
    expect(parseCliArgs(['fixtures/sample-game-1', '--json']).json).toBe(true);
  });

  it('refuse une ligne de commande sans dossier', () => {
    expect(() => parseCliArgs([])).toThrow(/Usage/);
  });

  it('reconnait --ids, qui garde les cardId bruts', () => {
    expect(parseCliArgs(['dossier', '--ids']).ids).toBe(true);
  });

  it('refuse une option inconnue', () => {
    expect(() => parseCliArgs(['dossier', '--verbose'])).toThrow(/Option inconnue/);
  });

  it('refuse plusieurs dossiers', () => {
    expect(() => parseCliArgs(['a', 'b'])).toThrow(/un seul dossier/i);
  });
});

describe('findSessions', () => {
  async function makeTree(layout: Record<string, string[]>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'bg-cli-'));
    for (const [folder, files] of Object.entries(layout)) {
      const path = folder === '.' ? root : join(root, folder);
      await mkdir(path, { recursive: true });
      for (const file of files) await writeFile(join(path, file), '', 'utf8');
    }
    return root;
  }

  it('reconnait une session unique quand les logs sont a la racine', async () => {
    const root = await makeTree({ '.': ['Power_old.log'] });
    expect(await findSessions(root)).toEqual([root]);
  });

  it('descend d’un niveau pour un dossier d’archive', async () => {
    const root = await makeTree({
      Hearthstone_2026_09_21_00_36_03: ['Power_old.log.gz'],
      Hearthstone_2026_09_22_00_28_13: ['Power.log'],
      autre: ['notes.txt'],
    });

    expect(await findSessions(root)).toEqual([
      join(root, 'Hearthstone_2026_09_21_00_36_03'),
      join(root, 'Hearthstone_2026_09_22_00_28_13'),
    ]);
  });

  it('rend une liste vide quand aucun Power.log n’est trouve', async () => {
    const root = await makeTree({ '.': ['notes.txt'], docs: ['a.md'] });
    expect(await findSessions(root)).toEqual([]);
  });

  it('signale un dossier introuvable', async () => {
    await expect(findSessions(join(tmpdir(), 'bg-absent'))).rejects.toThrow(/introuvable/);
  });
});

describe('resolveSessionDate', () => {
  it('prefere la date du nom de dossier', async () => {
    const folder = await sampleSessionFolder();
    const date = await resolveSessionDate(await openSession(folder));

    expect(date).toEqual(new Date(2026, 8, 19, 2, 47, 25));
  });

  it('se rabat sur le jour du fichier quand le dossier n’est pas nomme ainsi', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bg-sans-nom-'));
    await writeFile(join(root, 'Power.log'), '', 'utf8');

    const date = await resolveSessionDate(await openSession(root));

    // Minuit : l'heure de modification est celle de la fin de session, la
    // prendre telle quelle ferait croire a un passage de minuit.
    expect(date.getHours()).toBe(0);
    expect(date.getMinutes()).toBe(0);
    expect(date.getSeconds()).toBe(0);
  });
});

describe('formatSummary', () => {
  const base: GameSummary = {
    startedAt: '2026-09-19T02:48:30.321+02:00',
    endedAt: '2026-09-19T03:13:48.937+02:00',
    buildNumber: 251952,
    gameType: 'GT_BATTLEGROUNDS',
    playerName: 'AkiLif#2498',
    heroOffered: ['BG22_HERO_002', 'BG22_HERO_000_SKIN_A'],
    heroChosen: 'BG22_HERO_000_SKIN_A',
    heroSkinParentDbfId: 77987,
    finalPlace: 3,
    finalTurn: 13,
    tierUps: [{ tier: 2, turn: 2 }],
    turns: [],
    decisions: [],
    picks: [
      {
        choiceId: 2,
        sourceCardId: 'TB_BaconShop_Triples_01',
        turn: 4,
        options: ['BG35_143', 'BG36_760'],
        chosen: 'BG36_760',
      },
    ],
    opponents: ['BG30_HERO_304'],
    gameSeed: '817997359',
  };

  it('affiche la date, la duree et le resultat', () => {
    const text = formatSummary(base, 1).join('\n');

    expect(text).toContain('Partie 1  19/09/2026 02:48 → 03:13  (25 min)');
    expect(text).toContain('AkiLif#2498 · build 251952 · seed 817997359');
    expect(text).toContain('3e place au tour 13');
    expect(text).toContain('T2 au tour 2');
  });

  it('designe les cartes par leur cardId', () => {
    const text = formatSummary(base, 1).join('\n');

    expect(text).toContain('BG22_HERO_000_SKIN_A');
    // La colonne du tour precede la source du choix.
    expect(text).toContain('#2   t4  TB_BaconShop_Triples_01 → BG36_760');
    expect(text).toContain('parmi BG35_143, BG36_760');
  });

  it('ecrit « 1re » pour une victoire', () => {
    expect(formatSummary({ ...base, finalPlace: 1 }, 1).join('\n')).toContain('1re place');
  });

  it('signale une partie inachevee', () => {
    const text = formatSummary({ ...base, endedAt: null }, 2).join('\n');

    expect(text).toContain('(en cours)');
    expect(text).toContain('partie inachevée');
  });

  it('reste lisible quand des valeurs manquent', () => {
    const text = formatSummary(
      {
        ...base,
        finalPlace: null,
        finalTurn: null,
        tierUps: [],
        picks: [],
        opponents: [],
        gameSeed: null,
      },
      1,
    ).join('\n');

    expect(text).toContain('place inconnue');
    expect(text).toContain('aucune montée');
    expect(text).toContain('seed —');
  });
});
