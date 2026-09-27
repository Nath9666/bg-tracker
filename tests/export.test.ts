import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDataset, writeDataset, type ExportedDecision } from '../src/export/dataset.js';
import { parseExportArgs } from '../src/cli/export.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { importGames } from '../src/db/import.js';
import { importCards } from '../src/cards/import-cards.js';
import { buildIndex } from '../src/cards/card-database.js';
import { emptyKeywords } from '../src/types.js';
import type { BoardMinion, DecisionRecord, GameSummary } from '../src/types.js';

const CARDS = buildIndex(
  [
    {
      id: 'BG36_760',
      dbfId: 1,
      name: 'Capitaine Macaron',
      type: 'MINION',
      techLevel: 4,
      races: ['MURLOC', 'PIRATE'],
    },
    {
      id: 'BG28_300',
      dbfId: 2,
      name: 'Liche inoffensive',
      type: 'MINION',
      techLevel: 1,
      races: ['UNDEAD'],
    },
    { id: 'BG26_HERO_104', dbfId: 3, name: 'Cariel Roame', type: 'HERO' },
  ],
  [],
);

function minion(cardId: string, position: number): BoardMinion {
  return {
    position,
    cardId,
    atk: 3,
    health: 2,
    damage: 0,
    golden: false,
    keywords: emptyKeywords(),
  };
}

function decision(over: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    sequence: 1,
    turn: 4,
    action: 'buy',
    cardId: 'TB_BaconShop_DragBuy',
    targetCardId: 'BG36_760',
    position: 0,
    gold: 6,
    tavernTier: 2,
    health: 30,
    board: [minion('BG28_300', 1)],
    hand: [],
    shop: [minion('BG36_760', 1), minion('BG28_300', 2)],
    ...over,
  };
}

function game(over: Partial<GameSummary> = {}): GameSummary {
  return {
    startedAt: '2026-09-20T01:00:00.000+02:00',
    endedAt: '2026-09-20T01:25:00.000+02:00',
    buildNumber: 251952,
    gameType: 'GT_BATTLEGROUNDS',
    playerName: 'AkiLif#2498',
    heroOffered: [],
    heroLocked: [],
    heroChosen: 'BG26_HERO_104',
    heroSkinParentDbfId: null,
    finalPlace: 2,
    finalTurn: 12,
    tierUps: [],
    turns: [],
    decisions: [decision()],
    picks: [],
    opponents: [],
    gameSeed: '1',
    ...over,
  };
}

function seeded(games: GameSummary[]): Db {
  const db = openDatabase(':memory:');
  importCards(db, CARDS);
  importGames(db, games, 'test');
  return db;
}

describe('buildDataset', () => {
  it('rend une ligne par decision, avec l’issue de la partie', () => {
    const [ligne] = buildDataset(seeded([game()]));

    expect(ligne).toMatchObject({
      gameId: '1-2026-09-20',
      finalPlace: 2,
      top4: true,
      action: 'buy',
      targetCardId: 'BG36_760',
      turn: 4,
      gold: 6,
      tavernTier: 2,
    });
  });

  it('joint le nom et le palier de chaque carte visible', () => {
    const [ligne] = buildDataset(seeded([game()]));

    expect(ligne?.shop).toHaveLength(2);
    expect(ligne?.shop[0]).toMatchObject({
      cardId: 'BG36_760',
      name: 'Capitaine Macaron',
      techLevel: 4,
      races: ['MURLOC', 'PIRATE'],
    });
    expect(ligne?.board.map((c) => c.name)).toEqual(['Liche inoffensive']);
  });

  it('marque top4 d’apres la place finale', () => {
    expect(buildDataset(seeded([game({ finalPlace: 4 })]))[0]?.top4).toBe(true);
    expect(buildDataset(seeded([game({ finalPlace: 5 })]))[0]?.top4).toBe(false);
  });

  it('ecarte les parties inachevees, sans issue exploitable', () => {
    expect(buildDataset(seeded([game({ endedAt: null })]))).toEqual([]);
  });

  it('ne garde que les tops 4 quand on le demande', () => {
    const db = seeded([
      game({ gameSeed: '1', finalPlace: 2 }),
      game({ gameSeed: '2', finalPlace: 7 }),
    ]);

    expect(buildDataset(db)).toHaveLength(2);
    const bons = buildDataset(db, { top4Only: true });
    expect(bons).toHaveLength(1);
    expect(bons[0]?.finalPlace).toBe(2);
  });

  it('rattache chaque carte a sa propre decision', () => {
    const db = seeded([
      game({
        decisions: [
          decision({ sequence: 1, shop: [minion('BG36_760', 1)] }),
          decision({ sequence: 2, shop: [minion('BG28_300', 1), minion('BG36_760', 2)] }),
        ],
      }),
    ]);

    const lignes = buildDataset(db);
    expect(lignes[0]?.shop.map((c) => c.cardId)).toEqual(['BG36_760']);
    expect(lignes[1]?.shop.map((c) => c.cardId)).toEqual(['BG28_300', 'BG36_760']);
  });

  it('accepte une decision sans rien de visible', () => {
    const db = seeded([game({ decisions: [decision({ board: [], hand: [], shop: [] })] })]);
    expect(buildDataset(db)[0]).toMatchObject({ board: [], hand: [], shop: [] });
  });
});

describe('writeDataset', () => {
  async function fichier(): Promise<string> {
    return join(await mkdtemp(join(tmpdir(), 'bg-export-')), 'decisions.jsonl');
  }

  it('ecrit une ligne de JSON par decision', async () => {
    const path = await fichier();
    const decisions = buildDataset(seeded([game()]));
    const lignes = await writeDataset(path, decisions);

    const texte = await readFile(path, 'utf8');
    const analysees = texte
      .trim()
      .split('\n')
      .map((ligne) => JSON.parse(ligne) as ExportedDecision);

    expect(lignes).toBe(1);
    expect(analysees).toHaveLength(1);
    expect(analysees[0]?.targetCardId).toBe('BG36_760');
    // Les listes imbriquees survivent, ce qu'un CSV ne permettrait pas.
    expect(analysees[0]?.shop).toHaveLength(2);
  });

  it('ecrit un fichier vide sans decision', async () => {
    const path = await fichier();
    expect(await writeDataset(path, [])).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('');
  });
});

describe('parseExportArgs', () => {
  it('a des valeurs par defaut', () => {
    expect(parseExportArgs([])).toEqual({
      db: 'data/bg-tracker.db',
      out: 'data/export/decisions.jsonl',
      top4Only: false,
    });
  });

  it('accepte --top4, --out et --db', () => {
    expect(parseExportArgs(['--top4', '--out', 'a.jsonl', '--db', 'b.db'])).toEqual({
      db: 'b.db',
      out: 'a.jsonl',
      top4Only: true,
    });
  });

  it('refuse une option inconnue ou sans valeur', () => {
    expect(() => parseExportArgs(['--out'])).toThrow(/Valeur manquante/);
    expect(() => parseExportArgs(['--tout'])).toThrow(/Option inconnue/);
  });
});
