/**
 * Normalisation d'un heros vers son heros de base.
 *
 * Un skin a son propre `cardId` (`BG22_HERO_000_SKIN_A`). Pour regrouper les
 * parties par heros, il faut remonter au heros de base.
 *
 * ⚠️ Retirer le suffixe `_SKIN_x` ne suffit pas : sur les 653 heros a skin de
 * HearthstoneJSON, 16 donnent alors un `cardId` inexistant, et certains un
 * heros **faux** — `TB_BaconShop_HERO_201_SKIN_D` a pour base `BG20_HERO_201`,
 * que la chaine ne laisse pas deviner. Le lien correct vient soit du log
 * (`BACON_SKIN_PARENT_ID`), soit de la base de cartes
 * (`battlegroundsSkinParentId`), qui couvre les 653 cas.
 */
import type { Db } from './database.js';

/** Retrait du suffixe de skin. Dernier recours, avant toute base de cartes. */
export function stripSkinSuffix(cardId: string): string {
  return cardId.replace(/_SKIN_[A-Za-z0-9]+$/, '');
}

export interface HeroBaseResolver {
  /**
   * @param cardId heros joue ou propose.
   * @param skinParentDbfId `BACON_SKIN_PARENT_ID` du log, quand il est connu.
   */
  (cardId: string, skinParentDbfId?: number | null): string;
}

/**
 * Construit un resolveur adosse a la table `cards`.
 *
 * L'ordre compte : le log d'abord quand il donne le parent, la base de cartes
 * ensuite, le retrait du suffixe en dernier. Sans table `cards` remplie, seul
 * le dernier s'applique.
 */
export function createHeroBaseResolver(db: Db): HeroBaseResolver {
  const byDbfId = db.prepare('SELECT card_id AS cardId FROM cards WHERE dbf_id = ?');
  const parentOf = db.prepare('SELECT skin_parent_dbf_id AS parent FROM cards WHERE card_id = ?');

  const toCardId = (dbfId: number): string | undefined =>
    (byDbfId.get(dbfId) as { cardId: string } | undefined)?.cardId;

  return (cardId, skinParentDbfId) => {
    if (skinParentDbfId !== undefined && skinParentDbfId !== null) {
      const fromLog = toCardId(skinParentDbfId);
      if (fromLog !== undefined) return fromLog;
    }

    const parent = (parentOf.get(cardId) as { parent: number | null } | undefined)?.parent;
    if (parent !== null && parent !== undefined) {
      const fromCards = toCardId(parent);
      if (fromCards !== undefined) return fromCards;
    }

    return stripSkinSuffix(cardId);
  };
}
