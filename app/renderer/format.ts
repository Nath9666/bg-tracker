/** Mises en forme partagees par les vues. */

export function place(value: number | null): string {
  return value === null ? '—' : value.toFixed(2);
}

export function percent(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)} %`;
}

export function turn(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

export function shortDate(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

export function dateTime(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`;
}

const MOIS = [
  'janv.',
  'fevr.',
  'mars',
  'avril',
  'mai',
  'juin',
  'juil.',
  'aout',
  'sept.',
  'oct.',
  'nov.',
  'dec.',
];

/**
 * Etiquette d'une periode du graphique de cote.
 *
 * La cle porte deja la finesse : `2026`, `2026-09`, `2026-09-20`, ou un id de
 * partie. Sa longueur suffit a choisir la mise en forme.
 */
export function periodLabel(key: string): string {
  if (/^\d{4}$/.test(key)) return key;
  if (/^\d{4}-\d{2}$/.test(key))
    return `${MOIS[Number(key.slice(5, 7)) - 1] ?? ''} ${key.slice(0, 4)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return `${key.slice(8, 10)}/${key.slice(5, 7)}`;
  return key;
}

/** Noms francais des types de serviteur, tels qu'affiches en jeu. */
const RACES: Record<string, string> = {
  BEAST: 'Bête',
  DEMON: 'Démon',
  DRAGON: 'Dragon',
  ELEMENTAL: 'Elémentaire',
  MECHANICAL: 'Méca',
  MURLOC: 'Murloc',
  NAGA: 'Naga',
  PIRATE: 'Pirate',
  QUILBOAR: 'Huran',
  ABERRATION: 'Aberration',
  UNDEAD: 'Mort-vivant',
  ALL: 'Tous types',
  aucun: 'Aucun type',
};

export function raceName(race: string): string {
  return RACES[race] ?? race.toLowerCase();
}
