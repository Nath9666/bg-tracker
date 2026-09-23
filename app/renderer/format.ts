/** Mises en forme partagees par les vues. */

export function place(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

export function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)} %`;
}

export function turn(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

export function shortDate(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

export function dateTime(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 16)}`;
}

/** Noms francais des types de serviteur, tels qu'affiches en jeu. */
const RACES: Record<string, string> = {
  BEAST: "Bête",
  DEMON: "Démon",
  DRAGON: "Dragon",
  ELEMENTAL: "Elémentaire",
  MECHANICAL: "Méca",
  MURLOC: "Murloc",
  NAGA: "Naga",
  PIRATE: "Pirate",
  QUILBOAR: "Huran",
  UNDEAD: "Mort-vivant",
  ALL: "Tous types",
  aucun: "Aucun type",
};

export function raceName(race: string): string {
  return RACES[race] ?? race.toLowerCase();
}
