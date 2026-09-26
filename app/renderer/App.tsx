import { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { loadDashboard, saveRating, type Dashboard, type StatsFilters } from './api.js';
import { dateTime, percent, periodLabel, place, raceName, turn } from './format.js';
import { aggregateTimeline, type TimelineGranularity } from '../../src/stats/stats.js';

const COULEURS = {
  accent: '#c9a227',
  bon: '#5ec27a',
  mauvais: '#d1636b',
  grille: '#2e2a3f',
  attenue: '#9a93b3',
};

/**
 * Finesse du graphique de cote.
 *
 * Au bout de quelques centaines de parties, un point par partie devient
 * illisible : regrouper par jour ou par mois donne la meme lecture qu'un cours
 * de bourse.
 */
const FINESSES: { libelle: string; valeur: TimelineGranularity }[] = [
  { libelle: 'Par partie', valeur: 'game' },
  { libelle: 'Par jour', valeur: 'day' },
  { libelle: 'Par mois', valeur: 'month' },
  { libelle: 'Par année', valeur: 'year' },
];

/** Periodes proposees, en jours. `null` = tout l'historique. */
const PERIODES: { libelle: string; jours: number | null }[] = [
  { libelle: 'Tout', jours: null },
  { libelle: '7 jours', jours: 7 },
  { libelle: '30 jours', jours: 30 },
  { libelle: '90 jours', jours: 90 },
];

const axe = { stroke: COULEURS.attenue, fontSize: 12 };
const infobulle = {
  contentStyle: { background: '#1d1a29', border: '1px solid #2e2a3f', borderRadius: 8 },
  labelStyle: { color: '#9a93b3' },
};

function Indicateur({ valeur, libelle }: { valeur: string; libelle: string }): JSX.Element {
  return (
    <div className="indicateur">
      <div className="valeur">{valeur}</div>
      <div className="libelle">{libelle}</div>
    </div>
  );
}

function Section({
  titre,
  aide,
  action,
  children,
}: {
  titre: string;
  aide?: string;
  /** Commande placee a droite du titre. */
  action?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section>
      <div className="section-tete">
        <h2>{titre}</h2>
        {action}
      </div>
      {aide !== undefined && <p className="aide">{aide}</p>}
      {children}
    </section>
  );
}

type Minion = Dashboard['finalBoards'][string][number];

/**
 * Illustration d'une carte, servie par HearthstoneJSON (la meme source que la
 * base de cartes). Le cadrage 256x existe pour tous les serviteurs des Champs
 * de bataille, dores et cartes recentes compris ; les cartes completes rendues,
 * non (verifie le 26/09/2026). Chromium les garde en cache disque.
 */
function artUrl(cardId: string): string {
  return `https://art.hearthstonejson.com/v1/256x/${encodeURIComponent(cardId)}.jpg`;
}

/** Identifiant de la version normale d'un dore, pour une illustration de secours. */
function versionNormale(cardId: string): string | null {
  return cardId.endsWith('_G') ? cardId.slice(0, -2) : null;
}

function initiales(nom: string): string {
  return nom
    .split(/[\s’'-]+/)
    .filter((mot) => mot.length > 2)
    .slice(0, 2)
    .map((mot) => mot[0]!.toUpperCase())
    .join('');
}

/**
 * Un serviteur, comme sur le plateau du jeu : l'illustration en ovale,
 * l'attaque en bas a gauche, la vie en bas a droite. Le nom, le palier et
 * les types sont dans l'infobulle.
 */
function Serviteur({ minion }: { minion: Minion }): JSX.Element {
  // Sans image : un dore essaie sa version normale, puis on affiche les initiales.
  const [source, setSource] = useState<string | null>(artUrl(minion.cardId));

  const infobulle = [
    minion.name,
    minion.golden ? 'Doré' : null,
    minion.techLevel === null ? null : `Palier ${minion.techLevel}`,
    minion.races.length === 0 ? null : minion.races.map(raceName).join(', '),
    `${minion.atk ?? '?'}/${minion.health ?? '?'}`,
  ]
    .filter((x) => x !== null)
    .join(' · ');

  return (
    <div className={minion.golden ? 'serviteur dore' : 'serviteur'} title={infobulle}>
      <div className="portrait">
        {source === null ? (
          <span className="initiales">{initiales(minion.name)}</span>
        ) : (
          <img
            src={source}
            alt={minion.name}
            loading="lazy"
            draggable={false}
            onError={() => {
              const normale = versionNormale(minion.cardId);
              setSource(normale !== null && source === artUrl(minion.cardId) ? artUrl(normale) : null);
            }}
          />
        )}
      </div>
      <span className="stat-atk">{minion.atk ?? '?'}</span>
      <span className="stat-pv">{minion.health ?? '?'}</span>
    </div>
  );
}

/**
 * Portrait de heros, rond comme au choix du heros en jeu, suivi de son nom.
 *
 * Le skin joue d'abord : c'est lui que le joueur a vu. A defaut d'image, le
 * heros de base, puis les initiales.
 */
function Heros({
  cardId,
  baseId,
  nom,
  taille = 'petit',
}: {
  cardId: string | null;
  baseId?: string | null;
  nom: string | null;
  taille?: 'petit' | 'grand';
}): JSX.Element {
  const candidats = [cardId, baseId].filter((id): id is string => id !== null && id !== undefined && id !== '');
  const [essai, setEssai] = useState(0);
  const source = candidats[essai];

  return (
    <span className="heros">
      <span className={`portrait-heros ${taille}`}>
        {source === undefined ? (
          <span className="initiales">{initiales(nom ?? '?')}</span>
        ) : (
          <img
            src={artUrl(source)}
            alt=""
            loading="lazy"
            draggable={false}
            onError={() => setEssai((i) => i + 1)}
          />
        )}
      </span>
      <span className="heros-nom">{nom ?? '—'}</span>
    </span>
  );
}

/** Plateau final d'une partie, de gauche a droite comme en jeu. */
function PlateauFinal({ board }: { board: Minion[] | undefined }): JSX.Element {
  if (board === undefined || board.length === 0) return <span className="attenue">—</span>;
  return (
    <div className="plateau-final">
      {board.map((minion) => (
        <Serviteur key={`${minion.position}-${minion.cardId}`} minion={minion} />
      ))}
    </div>
  );
}

type Carriere = NonNullable<Dashboard['career']>;

/** Un grand nombre lisible : 145916 devient « 145 916 ». */
function milliers(valeur: number): string {
  return valeur.toLocaleString('fr-FR');
}

/**
 * Statistiques de carriere, lues dans le jeu.
 *
 * Le plus puissant serviteur tient en deux compteurs (attaque, vie) : on les
 * reunit sur une seule carte, comme le fait le jeu.
 */
function Carriere({
  carriere,
  troupes,
}: {
  carriere: Carriere;
  troupes: Dashboard['warbands'];
}): JSX.Element {
  const lignes = carriere.lines
    .filter((l) => l.key !== 'strongestMinionAtk' && l.key !== 'strongestMinionHealth')
    // Le jeu compte en secondes ; on affiche des heures, comme lui.
    .map((l) =>
      l.key === 'secondsPlayed'
        ? { ...l, value: Math.floor(l.value / 3600), delta: l.delta === null ? null : Math.floor(l.delta / 3600) }
        : l,
    );
  const atk = carriere.lines.find((l) => l.key === 'strongestMinionAtk');
  const vie = carriere.lines.find((l) => l.key === 'strongestMinionHealth');

  return (
    <div className="carriere">
      {lignes.map((ligne) => (
        <div key={ligne.key} className="stat">
          <span className="stat-valeur">{milliers(ligne.value)}</span>
          <span className="stat-libelle">{ligne.label}</span>
          {ligne.delta !== null && ligne.delta !== 0 && (
            <span className="stat-delta">+{milliers(ligne.delta)} en 7 jours</span>
          )}
        </div>
      ))}
      {atk !== undefined && vie !== undefined && (
        <div className="stat">
          <span className="stat-valeur">
            {milliers(atk.value)}/{milliers(vie.value)}
          </span>
          <span className="stat-libelle">Plus puissant serviteur</span>
        </div>
      )}
      {troupes.length > 0 && (
        <div className="troupes">
          <h3>{troupes.length} dernières troupes</h3>
          {troupes.map((troupe, i) => (
            <div key={i} className="troupe">
              <span className={troupe.place <= 4 ? 'troupe-place top4' : 'troupe-place'}>
                {troupe.place}e
              </span>
              <span className="troupe-heros">
                <Heros cardId={troupe.heroCardId} nom={troupe.heroName} taille="grand" />
              </span>
              <PlateauFinal
                board={troupe.minions.map((m, position) => ({ ...m, position: position + 1 }))}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Lecture sure d'une preference : le stockage peut etre indisponible. */
function preference(clef: string, defaut: boolean): boolean {
  try {
    const valeur = window.localStorage.getItem(clef);
    return valeur === null ? defaut : valeur === '1';
  } catch {
    return defaut;
  }
}

function retenir(clef: string, valeur: boolean): void {
  try {
    window.localStorage.setItem(clef, valeur ? '1' : '0');
  } catch {
    // Sans stockage, le choix vaut pour la session : ce n'est pas grave.
  }
}

/**
 * Cote d'une partie, modifiable sur place.
 *
 * L'enregistrement se fait a la sortie du champ ou sur Entree, jamais a chaque
 * frappe : saisir « 4605 » ecrirait sinon 4, 46, 460 puis 4605.
 */
function Cote({
  gameId,
  valeur,
  onEnregistre,
}: {
  gameId: string;
  valeur: number | null;
  onEnregistre: () => void;
}): JSX.Element {
  const [texte, setTexte] = useState(valeur === null ? '' : String(valeur));
  const [etat, setEtat] = useState<'repos' | 'enregistre' | 'erreur'>('repos');

  // La partie peut changer sous le composant (rafraichissement, filtre).
  useEffect(() => {
    setTexte(valeur === null ? '' : String(valeur));
    setEtat('repos');
  }, [gameId, valeur]);

  const enregistrer = (): void => {
    const nettoye = texte.trim();
    const nombre = nettoye === '' ? null : Number(nettoye);
    if (nombre !== null && !Number.isFinite(nombre)) {
      setEtat('erreur');
      return;
    }
    if (nombre === valeur) return;

    saveRating(gameId, nombre === null ? null : Math.round(nombre))
      .then(() => {
        setEtat('enregistre');
        onEnregistre();
      })
      .catch(() => setEtat('erreur'));
  };

  return (
    <input
      className={`cote ${etat}`}
      type="text"
      inputMode="numeric"
      placeholder="—"
      aria-label="Cote après cette partie"
      value={texte}
      onChange={(event) => {
        setTexte(event.target.value);
        setEtat('repos');
      }}
      onBlur={enregistrer}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') setTexte(valeur === null ? '' : String(valeur));
      }}
    />
  );
}

export default function App(): JSX.Element {
  const [jours, setJours] = useState<number | null>(null);
  const [finesse, setFinesse] = useState<TimelineGranularity>('game');
  const [plateaux, setPlateaux] = useState(() => preference('plateaux-finaux', true));
  const [hero, setHero] = useState<string>('');
  const [donnees, setDonnees] = useState<Dashboard | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  /** Incremente pour forcer une relecture de la base. */
  const [rechargement, setRechargement] = useState(0);

  const filtres = useMemo<StatsFilters>(() => {
    const valeur: StatsFilters = {};
    if (jours !== null) {
      valeur.from = new Date(Date.now() - jours * 86_400_000).toISOString().slice(0, 10);
    }
    if (hero !== '') valeur.heroBaseId = hero;
    return valeur;
  }, [jours, hero]);

  useEffect(() => {
    let annule = false;
    loadDashboard(filtres)
      .then((resultat) => {
        if (!annule) setDonnees(resultat);
      })
      .catch((cause: unknown) => {
        if (!annule) setErreur(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      annule = true;
    };
  }, [filtres, rechargement]);

  // La base change sous les pieds de la fenetre : chaque `npm run sync` y ajoute
  // des parties. On relit en revenant sur la fenetre, ce qui couvre le cas
  // courant : lancer la commande, puis revenir ici.
  useEffect(() => {
    const relire = (): void => setRechargement((valeur) => valeur + 1);
    window.addEventListener('focus', relire);
    return () => window.removeEventListener('focus', relire);
  }, []);

  // Avant les retours anticipes : un hook ne peut pas etre appele par
  // intermittence. Le regroupement se fait ici plutot qu'en base, pour que
  // changer de finesse soit instantane, sans aller-retour.
  const courbe = useMemo(
    () => aggregateTimeline(donnees?.timeline ?? [], finesse),
    [donnees, finesse],
  );

  if (erreur !== null) {
    return (
      <div className="app">
        <p className="vide">Impossible de lire la base : {erreur}</p>
      </div>
    );
  }

  if (donnees === null) {
    return (
      <div className="app">
        <p className="vide">Chargement…</p>
      </div>
    );
  }

  const { overview: vue, places, timeline, heroes, tiers, races, playedHeroes } = donnees;

  return (
    <div className="app">
      <header>
        <h1>BG Tracker</h1>
        <p>
          {vue.games === 0
            ? 'Aucune partie sur cette période.'
            : `${vue.games} parties, du ${vue.firstGame?.slice(0, 10)} au ${vue.lastGame?.slice(0, 10)}`}
        </p>
      </header>

      <div className="filtres">
        {PERIODES.map((periode) => (
          <button
            key={periode.libelle}
            type="button"
            aria-pressed={jours === periode.jours}
            onClick={() => setJours(periode.jours)}
          >
            {periode.libelle}
          </button>
        ))}
        <span className="ecart" />
        <button type="button" onClick={() => setRechargement((valeur) => valeur + 1)}>
          Rafraîchir
        </button>
        <select value={hero} onChange={(event) => setHero(event.target.value)}>
          <option value="">Tous les héros</option>
          {playedHeroes.map((option) => (
            <option key={option.heroBaseId} value={option.heroBaseId}>
              {option.heroName} ({option.games})
            </option>
          ))}
        </select>
      </div>

      {vue.games === 0 ? (
        <p className="vide">Rien à afficher. Essayer une période plus large.</p>
      ) : (
        <>
          <div className="indicateurs">
            <Indicateur valeur={String(vue.games)} libelle="parties" />
            <Indicateur valeur={place(vue.averagePlace)} libelle="place moyenne" />
            <Indicateur valeur={percent(vue.top4Rate)} libelle="top 4" />
            <Indicateur valeur={String(vue.wins)} libelle="victoires" />
            <Indicateur valeur={vue.latestRating === null ? '—' : String(vue.latestRating)} libelle="dernière cote" />
          </div>

          <Section
            titre="Cote et place moyenne dans le temps"
            aide={
              finesse === 'game'
                ? 'La place moyenne est glissante sur 10 parties : une partie isolée ne dit rien.'
                : 'Regroupé par période : la cote est celle de fin de période, la place sa moyenne.'
            }
          >
            <div className="finesses">
              {FINESSES.map((option) => (
                <button
                  key={option.valeur}
                  type="button"
                  aria-pressed={finesse === option.valeur}
                  onClick={() => setFinesse(option.valeur)}
                >
                  {option.libelle}
                </button>
              ))}
            </div>

            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={courbe} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid stroke={COULEURS.grille} vertical={false} />
                <XAxis dataKey="key" tickFormatter={periodLabel} {...axe} />
                <YAxis yAxisId="cote" {...axe} domain={['auto', 'auto']} />
                {/* Place inversee : la 1re place en haut, comme on la lit. */}
                <YAxis yAxisId="place" orientation="right" domain={[1, 8]} reversed {...axe} />
                <Tooltip
                  {...infobulle}
                  labelFormatter={(value: string, charge) => {
                    // Par partie, la cle est un id : on montre la date exacte.
                    const point = charge?.[0]?.payload as { startedAt: string; games: number } | undefined;
                    if (point === undefined) return periodLabel(value);
                    if (finesse === 'game') return dateTime(point.startedAt);
                    return `${periodLabel(value)} · ${point.games} partie${point.games > 1 ? 's' : ''}`;
                  }}
                  formatter={(value: number, name: string) => [
                    name === 'Place moyenne' ? value.toFixed(2) : value,
                    name,
                  ]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  yAxisId="cote"
                  type="monotone"
                  dataKey="rating"
                  name="Cote"
                  stroke={COULEURS.accent}
                  strokeWidth={2}
                  connectNulls
                  // Au-dela d'une centaine de points, les pastilles se
                  // chevauchent et noircissent la courbe.
                  dot={courbe.length <= 100 ? { r: 3 } : false}
                />
                <Line
                  yAxisId="place"
                  type="monotone"
                  dataKey="averagePlace"
                  name="Place moyenne"
                  stroke={COULEURS.bon}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </Section>

          <div className="grille">
            <Section titre="Répartition des places finales">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={places} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke={COULEURS.grille} vertical={false} />
                  <XAxis dataKey="place" tickFormatter={(value: number) => `${value}e`} {...axe} />
                  <YAxis allowDecimals={false} {...axe} />
                  <Tooltip
                    {...infobulle}
                    labelFormatter={(value: number) => `${value}e place`}
                    formatter={(value: number) => [`${value} parties`, '']}
                  />
                  <Bar dataKey="games" radius={[4, 4, 0, 0]}>
                    {places.map((ligne) => (
                      <Cell
                        key={ligne.place}
                        fill={ligne.place <= 4 ? COULEURS.bon : COULEURS.mauvais}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Section>

            <Section
              titre="Montée de taverne"
              aide="Tour moyen d'arrivée à chaque palier, parties de top 4 contre le reste."
            >
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={tiers} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid stroke={COULEURS.grille} vertical={false} />
                  <XAxis dataKey="tier" tickFormatter={(value: number) => `T${value}`} {...axe} />
                  <YAxis {...axe} />
                  <Tooltip
                    {...infobulle}
                    labelFormatter={(value: number) => `Palier ${value}`}
                    formatter={(value: number, name: string) => [`tour ${value.toFixed(1)}`, name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="top4Turn"
                    name="Top 4"
                    stroke={COULEURS.bon}
                    strokeWidth={2}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="otherTurn"
                    name="5e à 8e"
                    stroke={COULEURS.mauvais}
                    strokeWidth={2}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </Section>
          </div>

          <Section
            titre="Héros"
            aide="Le taux de sélection dit si un héros est choisi quand il se présente."
          >
            <div className="defile">
              <table>
                <thead>
                  <tr>
                    <th>Héros</th>
                    <th>Joué</th>
                    <th>Proposé</th>
                    <th>Sélection</th>
                    <th>Place moy.</th>
                    <th>Top 4</th>
                  </tr>
                </thead>
                <tbody>
                  {heroes
                    .filter((ligne) => ligne.played > 0)
                    .map((ligne) => (
                      <tr key={ligne.heroBaseId}>
                        <td>
                          <Heros cardId={ligne.heroBaseId} nom={ligne.heroName} />
                        </td>
                        <td>{ligne.played}</td>
                        <td>{ligne.offered}</td>
                        <td>{percent(ligne.pickRate)}</td>
                        <td>{place(ligne.averagePlace)}</td>
                        <td>{percent(ligne.top4Rate)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            titre="Type dominant du plateau final"
            aide="Le type le plus représenté sur le plateau du dernier combat."
          >
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Parties</th>
                  <th>Place moy.</th>
                  <th>Top 4</th>
                </tr>
              </thead>
              <tbody>
                {races.map((ligne) => (
                  <tr key={ligne.race}>
                    <td>{raceName(ligne.race)}</td>
                    <td>{ligne.games}</td>
                    <td>{place(ligne.averagePlace)}</td>
                    <td>{percent(ligne.top4Rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section
            titre="Carrière"
            aide={
              donnees.career === null
                ? 'Lance BG Tracker, puis ouvre l’écran de statistiques des Champs de bataille dans Hearthstone : les chiffres de toute ta carrière s’afficheront ici.'
                : `Toute ta carrière, lue dans le jeu le ${dateTime(donnees.career.takenAt)}. Indépendant des filtres.`
            }
          >
            {donnees.career !== null && <Carriere carriere={donnees.career} troupes={donnees.warbands} />}
          </Section>

          <Section
            titre="Parties"
            aide="La cote se saisit directement dans le tableau : Entrée pour valider, Échap pour annuler."
            action={
              <button
                type="button"
                className="bascule"
                aria-pressed={plateaux}
                onClick={() => {
                  setPlateaux(!plateaux);
                  retenir('plateaux-finaux', !plateaux);
                }}
              >
                {plateaux ? 'Masquer les plateaux' : 'Afficher les plateaux'}
              </button>
            }
          >
            <div className="defile">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Héros</th>
                    <th>Place</th>
                    <th>Cote</th>
                    <th>Moy. glissante</th>
                    {plateaux && <th className="a-gauche">Plateau final</th>}
                  </tr>
                </thead>
                <tbody>
                  {[...timeline].reverse().map((ligne) => (
                    <tr key={ligne.gameId}>
                      <td>{dateTime(ligne.startedAt)}</td>
                      <td>
                        <Heros cardId={ligne.heroCardId} baseId={ligne.heroBaseId} nom={ligne.heroName} />
                      </td>
                      <td>{ligne.place ?? '—'}</td>
                      <td>
                        <Cote
                          gameId={ligne.gameId}
                          valeur={ligne.rating}
                          onEnregistre={() => setRechargement((valeur) => valeur + 1)}
                        />
                      </td>
                      <td>{turn(ligne.rollingPlace)}</td>
                      {plateaux && (
                        <td>
                          <PlateauFinal board={donnees.finalBoards[ligne.gameId]} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
