import { describe, expect, it } from 'vitest';
import { migrate, openDatabase, schemaVersion, type Db } from '../src/db/database.js';
import { gameId, heroBaseId, importGames, pickKind } from '../src/db/import.js';
import { parseImportArgs } from '../src/cli/import.js';
import type { GameSummary } from '../src/types.js';

function freshDb(): Db {
  return openDatabase(':memory:');
}

const BASE: GameSummary = {
  startedAt: '2026-09-19T02:48:30.321+02:00',
  endedAt: '2026-09-19T03:13:48.937+02:00',
  buildNumber: 251952,
  gameType: 'GT_BATTLEGROUNDS',
  playerName: 'AkiLif#2498',
  heroOffered: ['BG22_HERO_002', 'BG22_HERO_000_SKIN_A', 'BG36_HERO_101'],
  heroChosen: 'BG22_HERO_000_SKIN_A',
  heroSkinParentDbfId: 77987,
  finalPlace: 3,
  finalTurn: 13,
  tierUps: [
    { tier: 2, turn: 2 },
    { tier: 3, turn: 5 },
  ],
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

function rows(db: Db, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[];
}

function count(db: Db, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('migrations', () => {
  it('cree le schema et enregistre sa version', () => {
    const db = freshDb();

    expect(schemaVersion(db)).toBeGreaterThan(0);
    for (const table of ['games', 'hero_offers', 'tier_ups', 'picks']) {
      expect(count(db, table)).toBe(0);
    }
  });

  it('ne rejoue pas une migration deja appliquee', () => {
    const db = freshDb();
    expect(migrate(db)).toBe(0);
  });

  it('active les cles etrangeres, pour que la cascade fonctionne', () => {
    const db = freshDb();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('clef de partie', () => {
  it('combine le seed et le jour de debut', () => {
    expect(gameId(BASE)).toBe('817997359-2026-09-19');
  });

  it('reste la meme si l’heure de debut varie a la milliseconde', () => {
    expect(gameId({ ...BASE, startedAt: '2026-09-19T02:48:30.999+02:00' })).toBe(gameId(BASE));
  });

  it('distingue deux parties de seeds differents', () => {
    expect(gameId({ ...BASE, gameSeed: '42' })).not.toBe(gameId(BASE));
  });

  it('se rabat sur l’horodatage complet sans seed', () => {
    expect(gameId({ ...BASE, gameSeed: null })).toBe('noseed-2026-09-19T02:48:30.321+02:00');
  });
});

describe('heroBaseId', () => {
  it('retire le suffixe de skin', () => {
    expect(heroBaseId('BG22_HERO_000_SKIN_A')).toBe('BG22_HERO_000');
    expect(heroBaseId('TB_BaconShop_HERO_58_SKIN_E')).toBe('TB_BaconShop_HERO_58');
  });

  it('laisse intact un heros sans skin', () => {
    expect(heroBaseId('BG26_HERO_104')).toBe('BG26_HERO_104');
    expect(heroBaseId('TB_BaconShop_HERO_14')).toBe('TB_BaconShop_HERO_14');
  });
});

describe('pickKind', () => {
  it('classe d’apres la carte source', () => {
    expect(pickKind('TB_BaconShop_Triples_01')).toBe('triple');
    expect(pickKind('BG30_Trinket_1st')).toBe('trinket');
    expect(pickKind('BG30_Trinket_2nd')).toBe('trinket');
    expect(pickKind('BG36_MidGameEffect_010')).toBe('discover');
    expect(pickKind('')).toBe('other');
  });
});

describe('importGames', () => {
  it('ecrit la partie et ses lignes filles', () => {
    const db = freshDb();
    const result = importGames(db, [BASE], 'fixtures/sample-game-1');

    expect(result).toEqual({ inserted: 1, updated: 0 });
    expect(count(db, 'games')).toBe(1);
    expect(count(db, 'hero_offers')).toBe(3);
    expect(count(db, 'tier_ups')).toBe(2);
    expect(count(db, 'picks')).toBe(2);

    const [game] = rows(db, 'SELECT * FROM games');
    expect(game).toMatchObject({
      hero_card_id: 'BG22_HERO_000_SKIN_A',
      hero_base_id: 'BG22_HERO_000',
      final_place: 3,
      final_turn: 13,
      complete: 1,
      game_seed: '817997359',
      player_name: 'AkiLif#2498',
      source_folder: 'fixtures/sample-game-1',
    });
  });

  it('marque le heros retenu parmi ceux proposes', () => {
    const db = freshDb();
    importGames(db, [BASE], 'x');

    const chosen = rows(db, 'SELECT card_id FROM hero_offers WHERE chosen = 1');
    expect(chosen).toEqual([{ card_id: 'BG22_HERO_000_SKIN_A' }]);
  });

  it('marque l’option retenue d’un choix', () => {
    const db = freshDb();
    importGames(db, [BASE], 'x');

    expect(
      rows(db, 'SELECT option_card, position, chosen, kind, turn FROM picks ORDER BY position'),
    ).toEqual([
      { option_card: 'BG35_143', position: 0, chosen: 0, kind: 'triple', turn: 4 },
      { option_card: 'BG36_760', position: 1, chosen: 1, kind: 'triple', turn: 4 },
    ]);
  });

  it('enregistre un choix dont l’option retenue n’est pas dans la liste', () => {
    const db = freshDb();
    importGames(db, [{ ...BASE, picks: [{ ...BASE.picks[0]!, chosen: 'BG99_999' }] }], 'x');

    expect(rows(db, 'SELECT option_card FROM picks WHERE chosen = 1')).toEqual([
      { option_card: 'BG99_999' },
    ]);
    expect(count(db, 'picks')).toBe(3);
  });

  it('reimporter ne cree pas de doublon', () => {
    const db = freshDb();
    importGames(db, [BASE], 'x');
    const second = importGames(db, [BASE], 'x');

    expect(second).toEqual({ inserted: 0, updated: 1 });
    expect(count(db, 'games')).toBe(1);
    expect(count(db, 'hero_offers')).toBe(3);
    expect(count(db, 'tier_ups')).toBe(2);
    expect(count(db, 'picks')).toBe(2);
  });

  it('complete une partie importee alors qu’elle etait encore en cours', () => {
    const db = freshDb();
    const inProgress: GameSummary = {
      ...BASE,
      endedAt: null,
      finalPlace: 5,
      finalTurn: 9,
      tierUps: [{ tier: 2, turn: 2 }],
    };

    importGames(db, [inProgress], 'live');
    expect(rows(db, 'SELECT complete, final_place FROM games')).toEqual([
      { complete: 0, final_place: 5 },
    ]);

    importGames(db, [BASE], 'archive');
    expect(rows(db, 'SELECT complete, final_place, source_folder FROM games')).toEqual([
      { complete: 1, final_place: 3, source_folder: 'archive' },
    ]);
    // Les montees de palier de l'import complet remplacent les partielles.
    expect(count(db, 'tier_ups')).toBe(2);
  });

  it('ne touche ni au mode ni a la cote, qui ne viennent pas du log', () => {
    const db = freshDb();
    importGames(db, [BASE], 'x');
    db.prepare("UPDATE games SET mode = 'solo', rating_after = 8412").run();

    importGames(db, [BASE], 'x');

    expect(rows(db, 'SELECT mode, rating_after FROM games')).toEqual([
      { mode: 'solo', rating_after: 8412 },
    ]);
  });

  it('supprime les lignes filles en cascade', () => {
    const db = freshDb();
    importGames(db, [BASE], 'x');
    db.prepare('DELETE FROM games').run();

    expect(count(db, 'hero_offers')).toBe(0);
    expect(count(db, 'tier_ups')).toBe(0);
    expect(count(db, 'picks')).toBe(0);
  });

  it('importe plusieurs parties d’un coup', () => {
    const db = freshDb();
    const result = importGames(
      db,
      [BASE, { ...BASE, gameSeed: '42', heroChosen: 'BG26_HERO_104' }],
      'x',
    );

    expect(result.inserted).toBe(2);
    expect(count(db, 'games')).toBe(2);
  });
});

describe('parseImportArgs', () => {
  it('lit le dossier et la base', () => {
    expect(parseImportArgs(['data/archive', '--db', 'autre.db'])).toEqual({
      folder: 'data/archive',
      db: 'autre.db',
      force: false,
    });
  });

  it('utilise la base par defaut', () => {
    expect(parseImportArgs(['data/archive']).db).toBe('data/bg-tracker.db');
  });

  it('reconnait --force, qui relit les sessions inchangees', () => {
    expect(parseImportArgs(['data/archive', '--force']).force).toBe(true);
    expect(parseImportArgs(['--force', 'data/archive']).force).toBe(true);
  });

  it('refuse une commande incomplete ou inconnue', () => {
    expect(() => parseImportArgs([])).toThrow(/Usage/);
    expect(() => parseImportArgs(['a', '--db'])).toThrow(/Valeur manquante/);
    expect(() => parseImportArgs(['a', '--verbose'])).toThrow(/Option inconnue/);
    expect(() => parseImportArgs(['a', 'b'])).toThrow(/un seul dossier/i);
  });
});
