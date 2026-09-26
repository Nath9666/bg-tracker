/**
 * Export du jeu de donnees vers Python.
 *
 * Une ligne par decision, au format JSON Lines : `pandas.read_json(lines=True)`
 * le lit directement, et les listes imbriquees (plateau, main, boutique)
 * passent sans mise a plat, ce qu'un CSV ne permettrait pas.
 *
 * Chaque ligne porte **l'issue de la partie**. C'est ce qui distingue
 * « ce que le joueur ferait » de « ce qui marche » : entrainer un modele sur
 * les seules parties de top 4 lui fait apprendre les bonnes parties du joueur
 * plutot que ses habitudes, erreurs comprises.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Db } from '../db/database.js';

export const DEFAULT_EXPORT_PATH = 'data/export/decisions.jsonl';

/** Une carte visible au moment d'une decision. */
export interface ExportedCard {
  cardId: string;
  name: string;
  /** Palier de taverne de la carte. `null` hors serviteur de Champs de bataille. */
  techLevel: number | null;
  races: string[];
  position: number;
  atk: number | null;
  health: number | null;
  golden: boolean;
}

/** Une decision, prete a etre apprise. */
export interface ExportedDecision {
  gameId: string;
  /** Issue de la partie, l'etiquette la plus utile. */
  finalPlace: number | null;
  /** Vrai pour une partie de top 4. */
  top4: boolean;
  ratingAfter: number | null;
  heroCardId: string | null;
  startedAt: string;

  sequence: number;
  turn: number | null;
  action: string;
  cardId: string | null;
  /** Carte retenue : c'est la cible a predire pour un achat ou une vente. */
  targetCardId: string | null;
  position: number | null;
  gold: number | null;
  tavernTier: number | null;
  health: number | null;

  board: ExportedCard[];
  hand: ExportedCard[];
  /** Les alternatives : ce qui etait propose et n'a pas ete pris. */
  shop: ExportedCard[];
}

interface DecisionRow {
  gameId: string;
  finalPlace: number | null;
  ratingAfter: number | null;
  heroCardId: string | null;
  startedAt: string;
  sequence: number;
  turn: number | null;
  action: string;
  cardId: string | null;
  targetCardId: string | null;
  position: number | null;
  gold: number | null;
  tavernTier: number | null;
  health: number | null;
}

interface CardRow {
  gameId: string;
  sequence: number;
  zone: string;
  position: number;
  cardId: string;
  atk: number | null;
  health: number | null;
  golden: number;
  name: string | null;
  techLevel: number | null;
  races: string | null;
}

export interface ExportOptions {
  /** N'exporter que les parties de top 4. */
  top4Only?: boolean;
}

/**
 * Construit le jeu de donnees.
 *
 * Les parties inachevees sont ecartees : leur place n'est pas un resultat, donc
 * elles ne peuvent pas servir d'etiquette.
 */
export function buildDataset(db: Db, options: ExportOptions = {}): ExportedDecision[] {
  const condition = options.top4Only === true ? 'AND g.final_place <= 4' : '';

  const decisions = db
    .prepare(
      `SELECT d.game_id AS gameId, g.final_place AS finalPlace, g.rating_after AS ratingAfter,
              g.hero_card_id AS heroCardId, g.started_at AS startedAt,
              d.sequence, d.turn, d.action, d.card_id AS cardId,
              d.target_card_id AS targetCardId, d.position, d.gold,
              d.tavern_tier AS tavernTier, d.health
       FROM decisions d
       JOIN games g ON g.id = d.game_id
       WHERE g.complete = 1 AND g.final_place IS NOT NULL ${condition}
       ORDER BY g.started_at, d.sequence`,
    )
    .all() as DecisionRow[];

  const cards = db
    .prepare(
      `SELECT dc.game_id AS gameId, dc.sequence, dc.zone, dc.position,
              dc.card_id AS cardId, dc.atk, dc.health, dc.golden,
              c.name, c.tech_level AS techLevel, c.races
       FROM decision_cards dc
       JOIN games g ON g.id = dc.game_id
       LEFT JOIN cards c ON c.card_id = dc.card_id
       WHERE g.complete = 1 AND g.final_place IS NOT NULL ${condition}
       ORDER BY dc.position`,
    )
    .all() as CardRow[];

  // Regroupement par decision, en une passe : une jointure par decision serait
  // des milliers de requetes.
  const parDecision = new Map<
    string,
    { board: ExportedCard[]; hand: ExportedCard[]; shop: ExportedCard[] }
  >();
  for (const card of cards) {
    const clef = `${card.gameId}#${card.sequence}`;
    const zones = parDecision.get(clef) ?? { board: [], hand: [], shop: [] };
    const exported: ExportedCard = {
      cardId: card.cardId,
      name: card.name ?? card.cardId,
      techLevel: card.techLevel,
      races: card.races === null || card.races === '' ? [] : card.races.split(','),
      position: card.position,
      atk: card.atk,
      health: card.health,
      golden: card.golden === 1,
    };

    if (card.zone === 'board') zones.board.push(exported);
    else if (card.zone === 'hand') zones.hand.push(exported);
    else zones.shop.push(exported);
    parDecision.set(clef, zones);
  }

  return decisions.map((row) => {
    const zones = parDecision.get(`${row.gameId}#${row.sequence}`);
    return {
      ...row,
      top4: row.finalPlace !== null && row.finalPlace <= 4,
      board: zones?.board ?? [],
      hand: zones?.hand ?? [],
      shop: zones?.shop ?? [],
    };
  });
}

/** Ecrit le jeu de donnees en JSON Lines. Renvoie le nombre de lignes. */
export async function writeDataset(
  path: string,
  decisions: readonly ExportedDecision[],
): Promise<number> {
  await mkdir(dirname(path), { recursive: true });
  const lignes = decisions.map((decision) => JSON.stringify(decision));
  await writeFile(path, lignes.length === 0 ? '' : `${lignes.join('\n')}\n`, 'utf8');
  return lignes.length;
}
