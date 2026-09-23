/**
 * Bonus cumules par le joueur au fil de la partie.
 *
 * Ce sont les effets permanents qui ne se lisent nulle part sur le plateau :
 * la valeur des gemmes de sang, l'or supplementaire du prochain tour, les
 * rales d'agonie qui se declenchent deux fois. Hearthstone Deck Tracker les
 * affiche, et sans eux on oublie ce qu'on a accumule.
 *
 * Tous sont portes par l'**entite joueur**, pas par le heros ni par un
 * serviteur (verifie sur des sessions reelles, voir docs/LOG_FORMAT.md).
 */
import type { Game } from '../state/game-state.js';

export interface PlayerBonus {
  /** Clef stable, pour les tests et la mise en forme. */
  key: string;
  label: string;
  /** Deja mis en forme : `+3/+3`, `+2`, `x2`. */
  value: string;
}

function tagNumber(tags: Map<string, string> | undefined, tag: string): number {
  const brut = tags?.get(tag);
  if (brut === undefined) return 0;
  const valeur = Number(brut);
  return Number.isFinite(valeur) ? valeur : 0;
}

/**
 * Bonus actifs du joueur, les nuls ecartes.
 *
 * Un bonus a zero n'est pas affiche : la barre ne doit montrer que ce qui
 * change quelque chose. Une liste vide est donc normale en debut de partie.
 */
export function readBonuses(game: Game): PlayerBonus[] {
  const id = game.localPlayerEntityId;
  const tags = id === null ? undefined : game.entities.get(id)?.tags;
  if (tags === undefined) return [];

  const bonuses: PlayerBonus[] = [];

  // Les gemmes de sang s'accumulent : 1, puis 2/1, puis 3/3. C'est la valeur
  // courante, pas un increment.
  const gemmeAtk = tagNumber(tags, 'BACON_BLOODGEMBUFFATKVALUE');
  const gemmeVie = tagNumber(tags, 'BACON_BLOODGEMBUFFHEALTHVALUE');
  if (gemmeAtk > 0 || gemmeVie > 0) {
    bonuses.push({ key: 'bloodGem', label: 'Gemme de sang', value: `+${gemmeAtk}/+${gemmeVie}` });
  }

  const orEnPlus = tagNumber(tags, 'BACON_PLAYER_EXTRA_GOLD_NEXT_TURN');
  if (orEnPlus > 0) {
    bonuses.push({ key: 'extraGold', label: 'Or au tour suivant', value: `+${orEnPlus}` });
  }

  const actualisations = tagNumber(tags, 'BACON_FREE_REFRESH_COUNT');
  if (actualisations > 0) {
    bonuses.push({
      key: 'freeRefresh',
      label: 'Actualisations offertes',
      value: String(actualisations),
    });
  }

  // `ADDITIONAL` : le nombre de declenchements **en plus** du premier.
  const ralesEnPlus = tagNumber(tags, 'EXTRA_DEATHRATTLES_ADDITIONAL');
  if (ralesEnPlus > 0) {
    bonuses.push({ key: 'deathrattles', label: 'Râles d’agonie', value: `x${ralesEnPlus + 1}` });
  }

  return bonuses;
}
