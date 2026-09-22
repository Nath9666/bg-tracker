/**
 * Base de cartes HearthstoneJSON.
 *
 * Les logs ne contiennent que des `cardId` (`BG36_760`). Les noms, le palier de
 * taverne et les types de serviteur viennent de HearthstoneJSON, telecharge une
 * fois et mis en cache dans `data/cards/`.
 *
 * Le fichier complet fait environ 11 Mo par langue. On n'en garde qu'un index
 * reduit aux champs utiles, bien plus rapide a relire.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Langues recuperees : le client de l'utilisateur est en francais. */
export const LOCALES = ['frFR', 'enUS'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_INDEX_PATH = 'data/cards/index.json';

function cardsUrl(locale: Locale): string {
  return `https://api.hearthstonejson.com/v1/latest/${locale}/cards.json`;
}

/** Champs de HearthstoneJSON que l'on exploite. */
interface RawCard {
  id?: unknown;
  dbfId?: unknown;
  name?: unknown;
  type?: unknown;
  techLevel?: unknown;
  races?: unknown;
  cardClass?: unknown;
  battlegroundsHero?: unknown;
  isBattlegroundsPoolMinion?: unknown;
}

/** Une carte, reduite a ce dont le tracker a besoin. */
export interface CardInfo {
  cardId: string;
  dbfId: number;
  /** Nom francais. */
  name: string;
  /** Nom anglais, utile pour chercher ailleurs. */
  nameEn: string;
  /** `MINION`, `HERO`, `BATTLEGROUND_TRINKET`, `HERO_POWER`... */
  type: string;
  /** Palier de taverne. `null` hors serviteur de Champs de bataille. */
  techLevel: number | null;
  /** Types du serviteur : `MURLOC`, `PIRATE`... */
  races: string[];
  cardClass: string;
  isBgHero: boolean;
  isBgPoolMinion: boolean;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Telecharge la base de cartes d'une langue. */
export async function fetchCards(locale: Locale): Promise<RawCard[]> {
  const response = await fetch(cardsUrl(locale));
  if (!response.ok) {
    throw new Error(`HearthstoneJSON (${locale}) a repondu ${response.status}`);
  }
  return (await response.json()) as RawCard[];
}

/**
 * Croise les deux langues en un index unique.
 * Une carte absente de l'anglais garde son nom francais.
 */
export function buildIndex(french: readonly RawCard[], english: readonly RawCard[]): CardInfo[] {
  const englishNames = new Map<string, string>();
  for (const card of english) {
    const id = asString(card.id);
    if (id.length > 0) englishNames.set(id, asString(card.name));
  }

  const cards: CardInfo[] = [];
  for (const card of french) {
    const cardId = asString(card.id);
    if (cardId.length === 0) continue;

    const name = asString(card.name);
    cards.push({
      cardId,
      dbfId: typeof card.dbfId === 'number' ? card.dbfId : 0,
      name,
      nameEn: englishNames.get(cardId) ?? name,
      type: asString(card.type),
      techLevel: typeof card.techLevel === 'number' ? card.techLevel : null,
      races: Array.isArray(card.races) ? card.races.filter((r): r is string => typeof r === 'string') : [],
      cardClass: asString(card.cardClass),
      isBgHero: card.battlegroundsHero === true,
      isBgPoolMinion: card.isBattlegroundsPoolMinion === true,
    });
  }

  return cards;
}

export async function saveIndex(path: string, cards: readonly CardInfo[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(cards), 'utf8');
}

/** Index des cartes, par `cardId`. Renvoie `null` si le cache n'existe pas. */
export async function loadIndex(path: string = DEFAULT_INDEX_PATH): Promise<CardIndex | null> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return null;

  try {
    return new CardIndex(JSON.parse(raw) as CardInfo[]);
  } catch {
    return null;
  }
}

/** Consultation de la base de cartes, par `cardId` ou par `dbfId`. */
export class CardIndex {
  readonly #byCardId = new Map<string, CardInfo>();
  readonly #byDbfId = new Map<number, CardInfo>();

  constructor(cards: readonly CardInfo[]) {
    for (const card of cards) {
      this.#byCardId.set(card.cardId, card);
      if (card.dbfId !== 0) this.#byDbfId.set(card.dbfId, card);
    }
  }

  get size(): number {
    return this.#byCardId.size;
  }

  get(cardId: string): CardInfo | undefined {
    return this.#byCardId.get(cardId);
  }

  byDbfId(dbfId: number): CardInfo | undefined {
    return this.#byDbfId.get(dbfId);
  }

  /** Nom francais, ou le `cardId` lui-meme si la carte est inconnue. */
  name(cardId: string): string {
    return this.#byCardId.get(cardId)?.name ?? cardId;
  }

  /**
   * Libelle lisible : le nom, suivi du palier et des types pour un serviteur.
   * Ex. `Capitaine Macaron (T4, murloc/pirate)`.
   */
  label(cardId: string): string {
    const card = this.#byCardId.get(cardId);
    if (card === undefined) return cardId;

    const details: string[] = [];
    if (card.techLevel !== null) details.push(`T${card.techLevel}`);
    if (card.races.length > 0) details.push(card.races.join('/').toLowerCase());

    return details.length > 0 ? `${card.name} (${details.join(', ')})` : card.name;
  }
}
