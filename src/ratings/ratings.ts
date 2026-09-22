/**
 * Cote (MMR) saisie a la main.
 *
 * Elle n'apparait nulle part dans les logs : l'utilisateur la note dans
 * `data/ratings.csv`. Le fichier est **pre-rempli** avec une ligne par partie,
 * pour qu'il n'ait qu'a completer la colonne `rating` en face de chaque date.
 *
 * Format : `datetime,rating,partie`. La troisieme colonne n'est qu'un repere
 * lisible, reecrit a chaque passage et jamais relu.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_RATINGS_PATH = 'data/ratings.csv';

const HEADER = 'datetime,rating,partie';

/** Une cote relevee, telle qu'ecrite dans le fichier. */
export interface RatingEntry {
  /** Horodatage ISO, tel que saisi. */
  datetime: string;
  /** Instant correspondant, en millisecondes. */
  time: number;
  rating: number;
}

/** Une partie a proposer dans le fichier. */
export interface RatedGame {
  id: string;
  /** Fin de la partie, ou son debut si elle n'est pas allee au bout. */
  datetime: string;
  /** Repere lisible : heros et place. */
  label: string;
}

/**
 * Decoupe une ligne en trois champs.
 *
 * Seules les deux premieres colonnes comptent ; la troisieme peut contenir des
 * virgules (« Cenarius, seigneur de la foret ») et n'est donc pas decoupee.
 */
function splitLine(line: string): [string, string, string] {
  const first = line.indexOf(',');
  if (first === -1) return [line.trim(), '', ''];
  const second = line.indexOf(',', first + 1);
  if (second === -1) return [line.slice(0, first).trim(), line.slice(first + 1).trim(), ''];
  return [
    line.slice(0, first).trim(),
    line.slice(first + 1, second).trim(),
    line.slice(second + 1).trim(),
  ];
}

/**
 * Lit le fichier de cotes.
 *
 * Les lignes vides, l'en-tete et les lignes sans cote sont ignorees en silence :
 * un fichier pre-rempli mais pas encore complete est normal.
 */
export function parseRatings(csv: string): RatingEntry[] {
  const entries: RatingEntry[] = [];

  for (const raw of csv.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const [datetime, rating] = splitLine(line);
    if (datetime === 'datetime') continue;
    if (rating.length === 0) continue;

    const value = Number(rating);
    const time = Date.parse(datetime);
    if (!Number.isFinite(value) || Number.isNaN(time)) continue;

    entries.push({ datetime, time, rating: Math.round(value) });
  }

  return entries;
}

function quote(value: string): string {
  return value.includes(',') ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface TemplateResult {
  /** Lignes ajoutees pour des parties encore absentes du fichier. */
  added: number;
  /** Cotes deja saisies, conservees telles quelles. */
  kept: number;
}

/**
 * Ecrit le fichier avec une ligne par partie, la plus ancienne d'abord.
 *
 * Les cotes deja saisies sont **replacees en face de leur partie**, par le meme
 * rapprochement que `matchRatings`. C'est necessaire : l'horodatage d'une
 * partie change quand elle se termine, puisqu'on affichait son debut tant
 * qu'elle etait en cours. Sans ce replacement, une cote saisie entre-temps
 * resterait orpheline et la partie paraitrait sans cote.
 *
 * Une saisie qui ne tombe sur aucune partie n'est pas perdue : elle reste en
 * fin de fichier, signalee comme telle.
 */
export async function writeRatingsTemplate(
  path: string,
  games: readonly RatedGame[],
  toleranceMinutes = 90,
): Promise<TemplateResult> {
  const previous = await readFile(path, 'utf8').catch(() => '');
  const entries = parseRatings(previous);
  const matches = matchRatings(games, entries, toleranceMinutes);

  const byGame = new Map(matches.map((match) => [match.gameId, match.rating]));
  // Par horodatage d'origine : deux parties peuvent porter la meme cote.
  const placed = new Set(matches.map((match) => match.datetime));

  const lines: string[] = [HEADER];
  let added = 0;
  let kept = 0;

  for (const game of games) {
    const rating = byGame.get(game.id);
    if (rating === undefined) added += 1;
    else kept += 1;
    lines.push(`${game.datetime},${rating ?? ''},${quote(game.label)}`);
  }

  for (const entry of entries) {
    if (placed.has(entry.datetime)) continue;
    kept += 1;
    lines.push(`${entry.datetime},${entry.rating},${quote('sans partie correspondante')}`);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  return { added, kept };
}

export interface RatingMatch {
  gameId: string;
  rating: number;
  /** Horodatage de la ligne d'origine, pour la retrouver dans le fichier. */
  datetime: string;
  /** Ecart entre la cote saisie et la fin de la partie, en minutes. */
  gapMinutes: number;
}

/**
 * Rattache chaque cote a la partie la plus proche dans le temps.
 *
 * Une partie ne recoit qu'une cote et une cote ne va qu'a une partie : on traite
 * les couples du plus serre au plus large. Au-dela de `toleranceMinutes`, la
 * cote est laissee de cote plutot que rattachee au hasard.
 */
export function matchRatings(
  games: readonly RatedGame[],
  ratings: readonly RatingEntry[],
  toleranceMinutes = 90,
): RatingMatch[] {
  const tolerance = toleranceMinutes * 60_000;

  const pairs: {
    gameId: string;
    rating: number;
    datetime: string;
    gap: number;
    index: number;
  }[] = [];
  ratings.forEach((entry, index) => {
    for (const game of games) {
      const gap = Math.abs(Date.parse(game.datetime) - entry.time);
      if (gap <= tolerance) {
        pairs.push({ gameId: game.id, rating: entry.rating, datetime: entry.datetime, gap, index });
      }
    }
  });

  pairs.sort((a, b) => a.gap - b.gap);

  const takenGames = new Set<string>();
  const takenRatings = new Set<number>();
  const matches: RatingMatch[] = [];

  for (const pair of pairs) {
    if (takenGames.has(pair.gameId) || takenRatings.has(pair.index)) continue;
    takenGames.add(pair.gameId);
    takenRatings.add(pair.index);
    matches.push({
      gameId: pair.gameId,
      rating: pair.rating,
      datetime: pair.datetime,
      gapMinutes: Math.round(pair.gap / 60_000),
    });
  }

  return matches;
}
