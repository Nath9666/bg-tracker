/** Noms francais des types de serviteur, partages avec le tableau de bord. */
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
  ABERRATION: "Aberration",
  UNDEAD: "Mort-vivant",
  ALL: "Tous types",
  aucun: "Aucun type",
};

export function raceName(race: string): string {
  return RACES[race] ?? race.toLowerCase();
}
