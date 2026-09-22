/**
 * Types partages par tous les modules du tracker.
 *
 * Les evenements de log (`LogEvent`) sont ajoutes a l'etape 4 (LineParser).
 * Ce fichier ne contient pour l'instant que le resume de partie, qui est le
 * contrat de sortie de la phase 1 (voir docs/phases/phase-1-parser.md).
 */

/** Un choix propose au joueur : decouverte, triple, bibelot... */
export interface PickRecord {
  /** Identifiant du choix dans le log (`id=` de DebugPrintEntityChoices). */
  choiceId: number;
  /** cardId de la carte a l'origine du choix, ex. `TB_BaconShop_Triples_01`. */
  sourceCardId: string;
  /** Tour de jeu ou le choix a ete propose. `null` avant le premier tour. */
  turn: number | null;
  /** cardIds des options proposees. */
  options: string[];
  /** cardId de l'option retenue. */
  chosen: string;
}

/** Un passage a un palier de taverne superieur. */
export interface TierUp {
  tier: number;
  /** Tour de jeu, pas le compteur TURN brut. */
  turn: number;
}

/** Resume d'une partie de Champs de bataille. */
export interface GameSummary {
  /** Horodatage ISO 8601 du CREATE_GAME. */
  startedAt: string;
  /** Horodatage ISO 8601 du STATE=COMPLETE, null si la partie est incomplete. */
  endedAt: string | null;
  buildNumber: number;
  /** Ex. `GT_BATTLEGROUNDS`. */
  gameType: string;
  playerName: string;
  /** cardIds des heros proposes au mulligan. */
  heroOffered: string[];
  /** cardId du heros retenu. */
  heroChosen: string;
  /**
   * `BACON_SKIN_PARENT_ID` du heros : le `dbfId` du heros de base quand le
   * joueur a equipe un skin. `null` sinon. C'est la seule facon sure de
   * regrouper les skins d'un meme heros (voir docs/LOG_FORMAT.md).
   */
  heroSkinParentDbfId: number | null;
  finalPlace: number | null;
  /** Tour de jeu = (TURN + 1) / 2. */
  finalTurn: number | null;
  tierUps: TierUp[];
  picks: PickRecord[];
  /** cardIds des heros adverses rencontres dans le lobby. */
  opponents: string[];
  gameSeed: string | null;
}
