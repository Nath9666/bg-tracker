import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CardIndex,
  buildIndex,
  loadIndex,
  saveIndex,
} from '../src/cards/card-database.js';
import { importCards } from '../src/cards/import-cards.js';
import { parseCardsArgs } from '../src/cli/cards.js';
import { openDatabase, type Db } from '../src/db/database.js';
import { resolveHeroBaseId } from '../src/db/import.js';
import { formatSummary } from '../src/cli/parse.js';
import type { GameSummary } from '../src/types.js';

// Cartes reelles, copiees de HearthstoneJSON.
const FRENCH = [
  { id: 'BG36_760', dbfId: 133075, name: 'Capitaine Macaron', type: 'MINION', techLevel: 4, races: ['MURLOC', 'PIRATE'], cardClass: 'NEUTRAL', isBattlegroundsPoolMinion: true },
  { id: 'BG22_HERO_000', dbfId: 77987, name: 'Tavish Foudrepique', type: 'HERO', cardClass: 'NEUTRAL', battlegroundsHero: true },
  { id: 'BG22_HERO_000_SKIN_A', dbfId: 98808, name: 'Maître-éclaireur Tavish', type: 'HERO', cardClass: 'NEUTRAL' },
  { id: 'BG30_MagicItem_547', dbfId: 112399, name: 'Cercueil confortable', type: 'BATTLEGROUND_TRINKET', cardClass: 'NEUTRAL' },
  { name: 'sans identifiant' },
];

const ENGLISH = [
  { id: 'BG36_760', name: 'Captain Macaron' },
  { id: 'BG22_HERO_000', name: 'Tavish Stormpike' },
  { id: 'BG22_HERO_000_SKIN_A', name: 'Trailblazer Tavish' },
];

function index(): CardIndex {
  return new CardIndex(buildIndex(FRENCH, ENGLISH));
}

describe('buildIndex', () => {
  it('retient les champs utiles', () => {
    const [minion] = buildIndex(FRENCH, ENGLISH);

    expect(minion).toEqual({
      cardId: 'BG36_760',
      dbfId: 133075,
      name: 'Capitaine Macaron',
      nameEn: 'Captain Macaron',
      type: 'MINION',
      techLevel: 4,
      races: ['MURLOC', 'PIRATE'],
      cardClass: 'NEUTRAL',
      isBgHero: false,
      isBgPoolMinion: true,
    });
  });

  it('ecarte une carte sans identifiant', () => {
    expect(buildIndex(FRENCH, ENGLISH)).toHaveLength(4);
  });

  it('garde le nom francais quand l’anglais manque', () => {
    const trinket = buildIndex(FRENCH, ENGLISH).find((c) => c.cardId === 'BG30_MagicItem_547');
    expect(trinket?.nameEn).toBe('Cercueil confortable');
  });

  it('laisse techLevel a null hors serviteur', () => {
    const hero = buildIndex(FRENCH, ENGLISH).find((c) => c.cardId === 'BG22_HERO_000');
    expect(hero?.techLevel).toBeNull();
    expect(hero?.isBgHero).toBe(true);
  });
});

describe('CardIndex', () => {
  it('retrouve une carte par cardId et par dbfId', () => {
    const cards = index();

    expect(cards.get('BG36_760')?.name).toBe('Capitaine Macaron');
    expect(cards.byDbfId(77987)?.cardId).toBe('BG22_HERO_000');
    expect(cards.size).toBe(4);
  });

  it('retombe sur le cardId quand la carte est inconnue', () => {
    expect(index().name('BG99_999')).toBe('BG99_999');
    expect(index().label('BG99_999')).toBe('BG99_999');
  });

  it('detaille le palier et les types d’un serviteur', () => {
    expect(index().label('BG36_760')).toBe('Capitaine Macaron (T4, murloc/pirate)');
  });

  it('donne le nom seul pour un heros ou un bibelot', () => {
    expect(index().label('BG22_HERO_000')).toBe('Tavish Foudrepique');
    expect(index().label('BG30_MagicItem_547')).toBe('Cercueil confortable');
  });
});

describe('cache sur disque', () => {
  it('se relit a l’identique', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'bg-cards-')), 'index.json');
    await saveIndex(path, buildIndex(FRENCH, ENGLISH));

    const cards = await loadIndex(path);
    expect(cards?.size).toBe(4);
    expect(cards?.name('BG36_760')).toBe('Capitaine Macaron');
  });

  it('renvoie null quand le cache manque ou est illisible', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bg-cards-'));
    expect(await loadIndex(join(dir, 'absent.json'))).toBeNull();

    const broken = join(dir, 'casse.json');
    await writeFile(broken, '{ pas du json', 'utf8');
    expect(await loadIndex(broken)).toBeNull();
  });
});

describe('importCards', () => {
  function db(): Db {
    return openDatabase(':memory:');
  }

  it('ecrit les cartes en base', () => {
    const database = db();
    expect(importCards(database, buildIndex(FRENCH, ENGLISH))).toBe(4);

    const row = database
      .prepare('SELECT name, name_en, tech_level, races, is_bg_hero FROM cards WHERE card_id = ?')
      .get('BG36_760');
    expect(row).toEqual({
      name: 'Capitaine Macaron',
      name_en: 'Captain Macaron',
      tech_level: 4,
      races: 'MURLOC,PIRATE',
      is_bg_hero: 0,
    });
  });

  it('met a jour une carte deja connue au lieu d’echouer', () => {
    const database = db();
    const cards = buildIndex(FRENCH, ENGLISH);
    importCards(database, cards);
    importCards(database, [{ ...cards[0]!, name: 'Nouveau nom' }]);

    const { n } = database.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number };
    expect(n).toBe(4);
    expect(
      (database.prepare('SELECT name FROM cards WHERE card_id = ?').get('BG36_760') as { name: string })
        .name,
    ).toBe('Nouveau nom');
  });
});

describe('resolveHeroBaseId', () => {
  const summary = {
    heroChosen: 'BG22_HERO_000_SKIN_A',
    heroSkinParentDbfId: 77987,
  } as GameSummary;

  const lookup = (dbfId: number): string | undefined => index().byDbfId(dbfId)?.cardId;

  it('prefere le heros designe par BACON_SKIN_PARENT_ID', () => {
    expect(resolveHeroBaseId(summary, lookup)).toBe('BG22_HERO_000');
  });

  it('retombe sur le retrait du suffixe quand le dbfId est inconnu', () => {
    // 16 heros sur 653 ne donnent pas une carte existante ainsi, mais le
    // regroupement reste coherent.
    expect(resolveHeroBaseId({ ...summary, heroSkinParentDbfId: 999_999 }, lookup)).toBe(
      'BG22_HERO_000',
    );
    expect(
      resolveHeroBaseId(
        { heroChosen: 'TB_BaconShop_HERO_44_SKIN_C', heroSkinParentDbfId: null } as GameSummary,
        lookup,
      ),
    ).toBe('TB_BaconShop_HERO_44');
  });

  it('laisse intact un heros sans skin', () => {
    expect(
      resolveHeroBaseId(
        { heroChosen: 'BG26_HERO_104', heroSkinParentDbfId: null } as GameSummary,
        lookup,
      ),
    ).toBe('BG26_HERO_104');
  });
});

describe('affichage des noms dans parse', () => {
  const summary: GameSummary = {
    startedAt: '2026-09-19T02:48:30.321+02:00',
    endedAt: '2026-09-19T03:13:48.937+02:00',
    buildNumber: 251952,
    gameType: 'GT_BATTLEGROUNDS',
    playerName: 'AkiLif#2498',
    heroOffered: ['BG22_HERO_000_SKIN_A'],
    heroChosen: 'BG22_HERO_000_SKIN_A',
    heroSkinParentDbfId: 77987,
    finalPlace: 3,
    finalTurn: 13,
    tierUps: [],
    picks: [
      {
        choiceId: 2,
        sourceCardId: 'BG30_MagicItem_547',
        turn: 5,
        options: ['BG36_760'],
        chosen: 'BG36_760',
      },
    ],
    opponents: ['BG22_HERO_000'],
    gameSeed: '1',
  };

  it('remplace les cardId par les noms quand l’index est fourni', () => {
    const text = formatSummary(summary, 1, index()).join('\n');

    expect(text).toContain('Maître-éclaireur Tavish');
    expect(text).toContain('Capitaine Macaron (T4, murloc/pirate)');
    expect(text).toContain('Cercueil confortable → Capitaine Macaron');
    expect(text).not.toContain('BG36_760');
  });

  it('garde les cardId sans index', () => {
    const text = formatSummary(summary, 1, null).join('\n');

    expect(text).toContain('BG22_HERO_000_SKIN_A');
    expect(text).toContain('BG36_760');
  });
});

describe('parseCardsArgs', () => {
  it('a des chemins par defaut', () => {
    expect(parseCardsArgs([])).toEqual({
      db: 'data/bg-tracker.db',
      index: 'data/cards/index.json',
    });
  });

  it('accepte --db et --index', () => {
    expect(parseCardsArgs(['--db', 'a.db', '--index', 'b.json'])).toEqual({
      db: 'a.db',
      index: 'b.json',
    });
  });

  it('refuse une option inconnue ou sans valeur', () => {
    expect(() => parseCardsArgs(['--db'])).toThrow(/Valeur manquante/);
    expect(() => parseCardsArgs(['--tout'])).toThrow(/Option inconnue/);
  });
});
