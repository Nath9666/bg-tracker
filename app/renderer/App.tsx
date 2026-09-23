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
  children,
}: {
  titre: string;
  aide?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section>
      <h2>{titre}</h2>
      {aide !== undefined && <p className="aide">{aide}</p>}
      {children}
    </section>
  );
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
                        <td>{ligne.heroName}</td>
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
            titre="Parties"
            aide="La cote se saisit directement dans le tableau : Entrée pour valider, Échap pour annuler."
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
                  </tr>
                </thead>
                <tbody>
                  {[...timeline].reverse().map((ligne) => (
                    <tr key={ligne.gameId}>
                      <td>{dateTime(ligne.startedAt)}</td>
                      <td>{ligne.heroName}</td>
                      <td>{ligne.place ?? '—'}</td>
                      <td>
                        <Cote
                          gameId={ligne.gameId}
                          valeur={ligne.rating}
                          onEnregistre={() => setRechargement((valeur) => valeur + 1)}
                        />
                      </td>
                      <td>{turn(ligne.rollingPlace)}</td>
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
