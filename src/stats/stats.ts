/**
 * Statistiques de parties.
 *
 * Chaque fonction est une lecture seule de la base et rend des objets simples,
 * sans dependance a une interface : la CLI et l'application Electron s'en
 * servent toutes les deux.
 *
 * Les parties inachevees sont ecartees par defaut : leur place n'est que le
 * classement courant, pas un resultat.
 */
import { createHeroBaseResolver } from '../db/hero-base.js';
import type { Db } from '../db/database.js';

export interface StatsFilters {
  /** Borne basse, incluse, sur `started_at` (ISO ou `AAAA-MM-JJ`). */
  from?: string;
  /** Borne haute, exclue. */
  to?: string;
  /** Heros normalise, tel que `games.hero_base_id`. */
  heroBaseId?: string;
  /** `solo` ou `duo`. Toujours `NULL` en base pour l'instant. */
  mode?: string;
  /** Inclure les parties inachevees. Faux par defaut. */
  includeIncomplete?: boolean;
}

interface Where {
  clause: string;
  params: Record<string, string>;
}

/** Construit la clause `WHERE` commune, avec ses parametres nommes. */
function buildWhere(filters: StatsFilters, alias = 'g'): Where {
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (filters.includeIncomplete !== true) conditions.push(`${alias}.complete = 1`);
  if (filters.from !== undefined) {
    conditions.push(`${alias}.started_at >= @from`);
    params['from'] = filters.from;
  }
  if (filters.to !== undefined) {
    conditions.push(`${alias}.started_at < @to`);
    params['to'] = filters.to;
  }
  if (filters.heroBaseId !== undefined) {
    conditions.push(`${alias}.hero_base_id = @heroBaseId`);
    params['heroBaseId'] = filters.heroBaseId;
  }
  if (filters.mode !== undefined) {
    conditions.push(`${alias}.mode = @mode`);
    params['mode'] = filters.mode;
  }

  return {
    clause: conditions.length === 0 ? '1 = 1' : conditions.join(' AND '),
    params,
  };
}

export interface Overview {
  games: number;
  /** Place moyenne, `null` sans partie. */
  averagePlace: number | null;
  /** Part de tops 4, entre 0 et 1. */
  top4Rate: number | null;
  wins: number;
  /** Derniere cote saisie. */
  latestRating: number | null;
  firstGame: string | null;
  lastGame: string | null;
}

export function overview(db: Db, filters: StatsFilters = {}): Overview {
  const where = buildWhere(filters);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS games,
              AVG(final_place) AS averagePlace,
              AVG(CASE WHEN final_place <= 4 THEN 1.0 ELSE 0.0 END) AS top4Rate,
              SUM(CASE WHEN final_place = 1 THEN 1 ELSE 0 END) AS wins,
              MIN(started_at) AS firstGame,
              MAX(started_at) AS lastGame
       FROM games g
       WHERE ${where.clause} AND final_place IS NOT NULL`,
    )
    .get(where.params) as Omit<Overview, 'latestRating'>;

  const rating = db
    .prepare(
      `SELECT rating_after AS rating
       FROM games g
       WHERE ${where.clause} AND rating_after IS NOT NULL
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(where.params) as { rating: number } | undefined;

  return { ...row, latestRating: rating?.rating ?? null };
}

export interface TimelinePoint {
  gameId: string;
  startedAt: string;
  heroName: string;
  /** Heros joue, skin compris : c'est son illustration qu'on affiche. */
  heroCardId: string;
  /** Heros de base, illustration de secours si celle du skin manque. */
  heroBaseId: string;
  place: number | null;
  rating: number | null;
  /** Place moyenne glissante sur les parties precedentes, cette partie comprise. */
  rollingPlace: number | null;
}

/**
 * Suite des parties dans le temps, avec la cote et une place moyenne glissante.
 * La fenetre lisse le bruit : une partie isolee ne dit pas grand-chose.
 */
export function timeline(db: Db, filters: StatsFilters = {}, window = 10): TimelinePoint[] {
  const where = buildWhere(filters);
  const rows = db
    .prepare(
      `SELECT g.id AS gameId, g.started_at AS startedAt,
              COALESCE(c.name, g.hero_card_id) AS heroName,
              g.hero_card_id AS heroCardId, g.hero_base_id AS heroBaseId,
              g.final_place AS place, g.rating_after AS rating
       FROM games g
       LEFT JOIN cards c ON c.card_id = g.hero_card_id
       WHERE ${where.clause}
       ORDER BY g.started_at`,
    )
    .all(where.params) as Omit<TimelinePoint, 'rollingPlace'>[];

  const places: number[] = [];
  return rows.map((row) => {
    if (row.place !== null) places.push(row.place);
    const recent = places.slice(-window);
    const rollingPlace =
      recent.length === 0 ? null : recent.reduce((total, p) => total + p, 0) / recent.length;
    return { ...row, rollingPlace };
  });
}

/** Finesse du graphique de cote : une partie, un jour, un mois ou une annee. */
export type TimelineGranularity = 'game' | 'day' | 'month' | 'year';

export interface TimelineBucket {
  /** Cle de regroupement : `2026-09-20`, `2026-09`, `2026`, ou l'id de partie. */
  key: string;
  /** Horodatage de la premiere partie de la periode, pour l'axe des abscisses. */
  startedAt: string;
  games: number;
  /**
   * Cote a la fin de la periode.
   *
   * La derniere connue, pas la moyenne : une cote est un solde, pas une mesure.
   * Moyenner un solde n'a pas de sens, et c'est ce que fait un cours de bourse.
   */
  rating: number | null;
  /** Place moyenne de la periode. */
  averagePlace: number | null;
}

/** Longueur du prefixe ISO qui identifie la periode. */
const PREFIX: Record<Exclude<TimelineGranularity, 'game'>, number> = {
  day: 10,
  month: 7,
  year: 4,
};

/**
 * Regroupe la suite des parties par periode.
 *
 * Sans ca, le graphique finit par aligner des milliers de points illisibles.
 * En `game`, rien n'est regroupe et la place reste la moyenne glissante, qui
 * lisse deja le bruit d'une partie isolee.
 */
export function aggregateTimeline(
  points: readonly TimelinePoint[],
  granularity: TimelineGranularity,
): TimelineBucket[] {
  if (granularity === 'game') {
    return points.map((point) => ({
      key: point.gameId,
      startedAt: point.startedAt,
      games: 1,
      rating: point.rating,
      averagePlace: point.rollingPlace,
    }));
  }

  const taille = PREFIX[granularity];
  const paquets = new Map<string, TimelinePoint[]>();

  for (const point of points) {
    const key = point.startedAt.slice(0, taille);
    const paquet = paquets.get(key);
    if (paquet === undefined) paquets.set(key, [point]);
    else paquet.push(point);
  }

  return [...paquets.entries()].map(([key, paquet]) => {
    const places = paquet
      .map((point) => point.place)
      .filter((place): place is number => place !== null);
    const cotes = paquet
      .map((point) => point.rating)
      .filter((cote): cote is number => cote !== null);

    return {
      key,
      startedAt: paquet[0]!.startedAt,
      games: paquet.length,
      rating: cotes.length === 0 ? null : cotes[cotes.length - 1]!,
      averagePlace:
        places.length === 0
          ? null
          : places.reduce((total, place) => total + place, 0) / places.length,
    };
  });
}

export interface HeroStat {
  heroBaseId: string;
  heroName: string;
  /** Parties jouees avec ce heros. */
  played: number;
  /** Parties ou il a ete propose au mulligan. */
  offered: number;
  /** `played / offered`, entre 0 et 1. */
  pickRate: number | null;
  averagePlace: number | null;
  top4Rate: number | null;
}

/**
 * Un ligne par heros : combien de fois joue, combien de fois propose, et ce
 * qu'il rapporte. Le taux de selection dit si un heros est choisi quand il se
 * presente, ce que la seule place moyenne ne montre pas.
 */
export function heroStats(db: Db, filters: StatsFilters = {}): HeroStat[] {
  const where = buildWhere(filters);

  const played = db
    .prepare(
      `SELECT g.hero_base_id AS heroBaseId,
              COUNT(*) AS played,
              AVG(g.final_place) AS averagePlace,
              AVG(CASE WHEN g.final_place <= 4 THEN 1.0 ELSE 0.0 END) AS top4Rate
       FROM games g
       WHERE ${where.clause} AND g.final_place IS NOT NULL
       GROUP BY g.hero_base_id`,
    )
    .all(where.params) as {
    heroBaseId: string;
    played: number;
    averagePlace: number | null;
    top4Rate: number | null;
  }[];

  // `hero_offers` porte le cardId avec son skin. On le ramene au heros de base
  // par le meme chemin que l'import : le dbfId de `BACON_SKIN_PARENT_ID` n'est
  // pas ici, mais la base de cartes permet de reconnaitre un skin.
  const offers = db
    .prepare(
      `SELECT o.card_id AS cardId
       FROM hero_offers o
       JOIN games g ON g.id = o.game_id
       WHERE ${where.clause}`,
    )
    .all(where.params) as { cardId: string }[];

  // Les offres portent le cardId avec son skin : on les normalise par le meme
  // chemin que les parties, sinon un heros a skin apparaitrait joue mais
  // jamais propose.
  const resolveHeroBase = createHeroBaseResolver(db);
  const offered = new Map<string, number>();
  for (const offer of offers) {
    const base = resolveHeroBase(offer.cardId);
    offered.set(base, (offered.get(base) ?? 0) + 1);
  }

  const names = new Map(
    (
      db.prepare('SELECT card_id AS cardId, name FROM cards').all() as {
        cardId: string;
        name: string;
      }[]
    ).map((card) => [card.cardId, card.name]),
  );

  const byHero = new Map<string, HeroStat>();
  for (const row of played) {
    byHero.set(row.heroBaseId, {
      heroBaseId: row.heroBaseId,
      heroName: names.get(row.heroBaseId) ?? row.heroBaseId,
      played: row.played,
      offered: 0,
      pickRate: null,
      averagePlace: row.averagePlace,
      top4Rate: row.top4Rate,
    });
  }

  for (const [base, count] of offered) {
    const existing = byHero.get(base);
    if (existing === undefined) {
      byHero.set(base, {
        heroBaseId: base,
        heroName: names.get(base) ?? base,
        played: 0,
        offered: count,
        pickRate: 0,
        averagePlace: null,
        top4Rate: null,
      });
      continue;
    }
    existing.offered = count;
    existing.pickRate = count === 0 ? null : existing.played / count;
  }

  return [...byHero.values()].sort(
    (a, b) => b.played - a.played || (a.averagePlace ?? 9) - (b.averagePlace ?? 9),
  );
}

export interface PlaceCount {
  place: number;
  games: number;
  share: number;
}

/** Repartition des places finales, de la 1re a la 8e. */
export function placeDistribution(db: Db, filters: StatsFilters = {}): PlaceCount[] {
  const where = buildWhere(filters);
  const rows = db
    .prepare(
      `SELECT final_place AS place, COUNT(*) AS games
       FROM games g
       WHERE ${where.clause} AND final_place IS NOT NULL
       GROUP BY final_place`,
    )
    .all(where.params) as { place: number; games: number }[];

  const total = rows.reduce((sum, row) => sum + row.games, 0);
  const byPlace = new Map(rows.map((row) => [row.place, row.games]));

  return Array.from({ length: 8 }, (_unused, index) => {
    const place = index + 1;
    const games = byPlace.get(place) ?? 0;
    return { place, games, share: total === 0 ? 0 : games / total };
  });
}

export interface TierPoint {
  tier: number;
  /** Tour moyen d'arrivee a ce palier, parties de top 4. */
  top4Turn: number | null;
  /** Idem, parties hors top 4. */
  otherTurn: number | null;
  top4Games: number;
  otherGames: number;
}

/**
 * Courbe de montee de taverne, parties gagnantes contre perdantes.
 * « Gagnante » vaut ici top 4, le partage habituel aux Champs de bataille.
 */
export function tierCurve(db: Db, filters: StatsFilters = {}): TierPoint[] {
  const where = buildWhere(filters);
  const rows = db
    .prepare(
      `SELECT t.tier,
              AVG(CASE WHEN g.final_place <= 4 THEN t.turn END) AS top4Turn,
              AVG(CASE WHEN g.final_place >  4 THEN t.turn END) AS otherTurn,
              SUM(CASE WHEN g.final_place <= 4 THEN 1 ELSE 0 END) AS top4Games,
              SUM(CASE WHEN g.final_place >  4 THEN 1 ELSE 0 END) AS otherGames
       FROM tier_ups t
       JOIN games g ON g.id = t.game_id
       WHERE ${where.clause} AND g.final_place IS NOT NULL
       GROUP BY t.tier
       ORDER BY t.tier`,
    )
    .all(where.params) as TierPoint[];

  return rows;
}

export interface RaceStat {
  race: string;
  games: number;
  averagePlace: number | null;
  top4Rate: number | null;
}

/**
 * Type dominant du plateau final, et ce qu'il rapporte.
 *
 * Le plateau final est celui du dernier combat. Le type dominant est celui qui
 * revient le plus parmi ses serviteurs ; un serviteur sans type ne compte pas,
 * et un plateau sans aucun type est range sous `aucun`.
 */
export function finalBoardRaces(db: Db, filters: StatsFilters = {}): RaceStat[] {
  const where = buildWhere(filters);

  const rows = db
    .prepare(
      `SELECT b.game_id AS gameId, g.final_place AS place, c.races AS races
       FROM boards b
       JOIN (SELECT game_id, MAX(turn) AS turn FROM boards GROUP BY game_id) dernier
         ON dernier.game_id = b.game_id AND dernier.turn = b.turn
       JOIN games g ON g.id = b.game_id
       LEFT JOIN cards c ON c.card_id = b.card_id
       WHERE ${where.clause} AND g.final_place IS NOT NULL`,
    )
    .all(where.params) as { gameId: string; place: number; races: string | null }[];

  const perGame = new Map<string, { place: number; counts: Map<string, number> }>();
  for (const row of rows) {
    const game = perGame.get(row.gameId) ?? { place: row.place, counts: new Map() };
    for (const race of (row.races ?? '').split(',')) {
      if (race.length === 0) continue;
      game.counts.set(race, (game.counts.get(race) ?? 0) + 1);
    }
    perGame.set(row.gameId, game);
  }

  const byRace = new Map<string, number[]>();
  for (const game of perGame.values()) {
    const dominant =
      [...game.counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'aucun';
    byRace.set(dominant, [...(byRace.get(dominant) ?? []), game.place]);
  }

  return [...byRace]
    .map(([race, places]) => ({
      race,
      games: places.length,
      averagePlace: places.reduce((sum, place) => sum + place, 0) / places.length,
      top4Rate: places.filter((place) => place <= 4).length / places.length,
    }))
    .sort((a, b) => b.games - a.games || a.race.localeCompare(b.race));
}

/** Heros disponibles pour le filtre, du plus joue au moins joue. */
export function playedHeroes(db: Db): { heroBaseId: string; heroName: string; games: number }[] {
  return db
    .prepare(
      `SELECT g.hero_base_id AS heroBaseId,
              COALESCE(c.name, g.hero_base_id) AS heroName,
              COUNT(*) AS games
       FROM games g
       LEFT JOIN cards c ON c.card_id = g.hero_base_id
       GROUP BY g.hero_base_id
       ORDER BY games DESC, heroName`,
    )
    .all() as { heroBaseId: string; heroName: string; games: number }[];
}

export interface HeroPickCard {
  heroBaseId: string;
  heroName: string;
  /** Parties jouees avec ce heros : a lire avant tout le reste, trois parties ne prouvent rien. */
  played: number;
  averagePlace: number | null;
  top4Rate: number | null;
  /** Part des fois ou il a ete choisi quand il etait propose. */
  pickRate: number | null;
  /**
   * Le type qui a mene le plus loin avec ce heros : meilleure place moyenne
   * du type dominant du plateau final. `null` sans partie jouee.
   */
  bestRace: RaceStat | null;
  /**
   * Vrai si `bestRace` est bien dans les types de la partie en cours. Faux
   * quand aucun type deja gagnant n'est disponible, ou quand les types ne sont
   * pas encore connus : on montre alors le meilleur type tout court.
   */
  bestRaceInLobby: boolean;
}

/**
 * Fiche d'aide au choix du heros, pour un heros propose.
 *
 * `lobbyRaces` restreint le type conseille a ceux tires pour la partie : un
 * type absent du lobby ne sert a rien. Un plateau final sans type dominant
 * (`aucun`) reste admis, il n'est pas lie au lobby.
 */
export function heroPickCard(
  db: Db,
  heroBaseId: string,
  lobbyRaces: ReadonlySet<string> = new Set(),
): HeroPickCard {
  const stat = heroStats(db).find((hero) => hero.heroBaseId === heroBaseId);
  const races = finalBoardRaces(db, { heroBaseId });

  const meilleur = (candidats: RaceStat[]): RaceStat | null =>
    [...candidats].sort(
      (a, b) => (a.averagePlace ?? 9) - (b.averagePlace ?? 9) || b.games - a.games,
    )[0] ?? null;

  const dansLeLobby = races.filter((r) => r.race === 'aucun' || lobbyRaces.has(r.race));
  const bestInLobby = lobbyRaces.size > 0 ? meilleur(dansLeLobby) : null;

  const name =
    stat?.heroName ??
    (
      db.prepare('SELECT name FROM cards WHERE card_id = ?').get(heroBaseId) as
        { name: string } | undefined
    )?.name ??
    heroBaseId;

  return {
    heroBaseId,
    heroName: name,
    played: stat?.played ?? 0,
    averagePlace: stat?.averagePlace ?? null,
    top4Rate: stat?.top4Rate ?? null,
    pickRate: stat?.pickRate ?? null,
    bestRace: bestInLobby ?? meilleur(races),
    bestRaceInLobby: bestInLobby !== null,
  };
}

/** Un point de la courbe de cote. */
export interface RatingPoint {
  startedAt: string;
  rating: number;
}

/** Ce que l'overlay montre entre deux parties. */
export interface RestingView {
  /** Cote actuelle : celle lue dans le jeu si elle est connue, sinon la derniere enregistree. */
  rating: number | null;
  /** Ecart apporte par la derniere partie. */
  lastDelta: number | null;
  lastPlace: number | null;
  /** Parties commencees le jour meme. */
  session: { games: number; delta: number | null; averagePlace: number | null };
  /** Les dernieres cotes, de la plus ancienne a la plus recente. */
  history: RatingPoint[];
  /**
   * Vrai entre la fin d'une partie et l'arrivee de sa cote : le serveur met
   * quelques secondes a l'envoyer. `rating` est alors encore l'ancienne, et
   * l'ecart de la derniere partie n'est pas connu.
   */
  pending: boolean;
}

/**
 * Resume de l'ecran de repos.
 *
 * `liveRating` est la cote lue dans le jeu. Elle peut etre plus recente que la
 * base : la partie qui vient de finir n'y entre qu'au sync suivant. Dans ce
 * cas elle s'ajoute a la courbe comme dernier point, et c'est elle qui donne
 * l'ecart de la derniere partie.
 */
export function restingView(
  points: readonly TimelinePoint[],
  today: string,
  live: { rating: number | null; place: number | null; pending?: boolean } = {
    rating: null,
    place: null,
  },
  historySize = 40,
): RestingView {
  const liveRating = live.rating;
  const pending = live.pending === true;
  const cotes: RatingPoint[] = points
    .filter((p): p is TimelinePoint & { rating: number } => p.rating !== null)
    .map((p) => ({ startedAt: p.startedAt, rating: p.rating }));

  const derniere = cotes.at(-1)?.rating ?? null;
  const enAvance = !pending && liveRating !== null && liveRating !== derniere;
  // La partie qui vient de finir n'est ni en base ni dans la cote : elle
  // compte dans la session, mais sans ecart tant que la cote n'est pas la.
  const horsBase = enAvance || pending;
  if (enAvance) cotes.push({ startedAt: `${today}T23:59:59`, rating: liveRating });

  const n = cotes.length;
  const lastDelta = pending ? null : n >= 2 ? cotes[n - 1]!.rating - cotes[n - 2]!.rating : null;

  // Session du jour : ecart entre la derniere cote et celle d'avant la session.
  const duJour = points.filter((p) => p.startedAt.startsWith(today));
  const avant = cotes.filter((c) => !c.startedAt.startsWith(today)).at(-1)?.rating ?? null;
  const finSession = cotes.filter((c) => c.startedAt.startsWith(today)).at(-1)?.rating ?? null;
  // La partie pas encore importee compte dans la session, avec sa place.
  const places = [...duJour.map((p) => p.place), ...(horsBase ? [live.place] : [])].filter(
    (p): p is number => p !== null,
  );

  return {
    rating: liveRating ?? derniere,
    lastDelta,
    lastPlace: horsBase ? live.place : (points.at(-1)?.place ?? null),
    session: {
      games: duJour.length + (horsBase ? 1 : 0),
      delta: avant !== null && finSession !== null ? finSession - avant : null,
      averagePlace: places.length === 0 ? null : places.reduce((a, b) => a + b, 0) / places.length,
    },
    history: cotes.slice(-historySize),
    pending,
  };
}

/** Un serviteur du plateau final, pret a afficher. */
export interface FinalMinion {
  position: number;
  cardId: string;
  name: string;
  atk: number | null;
  health: number | null;
  golden: boolean;
  techLevel: number | null;
  races: string[];
}

/**
 * Plateau final de chaque partie : celui du dernier combat, par partie.
 *
 * Une seule requete pour toutes les parties retenues par les filtres : le
 * tableau de bord les affiche toutes a la fois. Une partie sans plateau
 * releve (elimine avant le premier combat) est simplement absente.
 */
export function finalBoards(db: Db, filters: StatsFilters = {}): Record<string, FinalMinion[]> {
  const where = buildWhere(filters);
  const rows = db
    .prepare(
      `SELECT b.game_id AS gameId, b.position, b.card_id AS cardId, b.atk, b.health,
              b.golden, c.name, c.tech_level AS techLevel, c.races
       FROM boards b
       JOIN (SELECT game_id, MAX(turn) AS turn FROM boards GROUP BY game_id) dernier
         ON dernier.game_id = b.game_id AND dernier.turn = b.turn
       JOIN games g ON g.id = b.game_id
       LEFT JOIN cards c ON c.card_id = b.card_id
       WHERE ${where.clause}
       ORDER BY b.game_id, b.position`,
    )
    .all(where.params) as {
    gameId: string;
    position: number;
    cardId: string;
    atk: number | null;
    health: number | null;
    golden: number;
    name: string | null;
    techLevel: number | null;
    races: string | null;
  }[];

  const parPartie: Record<string, FinalMinion[]> = {};
  for (const row of rows) {
    (parPartie[row.gameId] ??= []).push({
      position: row.position,
      cardId: row.cardId,
      name: row.name ?? row.cardId,
      atk: row.atk,
      health: row.health,
      golden: row.golden === 1,
      techLevel: row.techLevel,
      races: row.races === null || row.races === '' ? [] : row.races.split(','),
    });
  }
  return parPartie;
}
