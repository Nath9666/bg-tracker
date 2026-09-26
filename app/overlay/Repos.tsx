import type { OverlayPayload } from './api.js';

type Vue = NonNullable<OverlayPayload['resting']>;

const LARGEUR = 280;
const HAUTEUR = 96;
/** Marge interieure : le point final et son anneau ne doivent pas etre rognes. */
const MARGE = 6;

/**
 * Courbe de la cote, une partie par pas.
 *
 * Une seule serie : pas de legende, le titre la nomme. Un seul marqueur, sur
 * la cote actuelle ; pas de chiffre sur chaque point, seulement le plus haut
 * et le plus bas, en encre attenuee. Pas de survol : la fenetre laisse passer
 * les clics, elle n'est pas faite pour etre manipulee.
 */
function Courbe({ points }: { points: Vue['history'] }): JSX.Element | null {
  if (points.length < 2) return null;

  const cotes = points.map((p) => p.rating);
  const min = Math.min(...cotes);
  const max = Math.max(...cotes);
  // Une cote qui n'a pas bouge donnerait une echelle nulle.
  const etendue = Math.max(max - min, 1);

  const x = (i: number): number => MARGE + (i / (points.length - 1)) * (LARGEUR - 2 * MARGE);
  const y = (v: number): number => MARGE + (1 - (v - min) / etendue) * (HAUTEUR - 2 * MARGE);

  const ligne = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.rating).toFixed(1)}`)
    .join(' ');
  const aire = `${ligne} L${x(points.length - 1).toFixed(1)},${HAUTEUR} L${x(0).toFixed(1)},${HAUTEUR} Z`;
  const fin = points.length - 1;

  return (
    <figure className="courbe">
      <svg
        viewBox={`0 0 ${LARGEUR} ${HAUTEUR}`}
        role="img"
        aria-label={`Cote sur les ${points.length} dernières parties, de ${min} à ${max}`}
      >
        <defs>
          <linearGradient id="remplissage" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line className="axe" x1="0" x2={LARGEUR} y1={HAUTEUR - 0.5} y2={HAUTEUR - 0.5} />
        <path d={aire} fill="url(#remplissage)" />
        <path className="trace" d={ligne} pathLength={1} />
        {/* Anneau de la couleur du fond : le point se detache de la ligne. */}
        <circle className="point" cx={x(fin)} cy={y(points[fin]!.rating)} r={4} />
      </svg>
      <figcaption>
        <span>{points.length} dernières parties</span>
        <span>
          {min} – {max}
        </span>
      </figcaption>
    </figure>
  );
}

function Ecart({ valeur }: { valeur: number }): JSX.Element {
  // Signe et fleche en plus de la couleur : l'ecart se lit meme sans la voir.
  if (valeur === 0) return <span className="ecart-cote nul">= 0</span>;
  return (
    <span className={`ecart-cote ${valeur > 0 ? 'hausse' : 'baisse'}`}>
      {valeur > 0 ? '▲ +' : '▼ −'}
      {Math.abs(valeur)}
    </span>
  );
}

/** Ecran affiche entre deux parties, a la place de « en attente ». */
export default function Repos({ vue }: { vue: Vue }): JSX.Element {
  if (vue.rating === null) {
    return (
      <div className="overlay repos">
        <span className="titre">BG Tracker</span>
        <span className="attente">en attente d’une partie</span>
      </div>
    );
  }

  const { session } = vue;

  return (
    <div className="overlay">
      <section className="accueil">
        <div className="accueil-tete">
          <span className="attente-point" aria-hidden="true" />
          <span className="accueil-titre">Entre deux parties</span>
        </div>

        <div className="cote-heros">
          {/* En attente, la valeur affichee est encore l'ancienne : on l'estompe. */}
          <span className={vue.pending ? 'cote-valeur ancienne' : 'cote-valeur'}>{vue.rating}</span>
          <span className="cote-libelle">cote</span>
        </div>

        {vue.pending && (
          <p className="derniere">
            <span className="en-attente">mise à jour de la cote…</span>
            <span className="attenue">
              partie terminée{vue.lastPlace === null ? '' : ` · ${vue.lastPlace}e`}
            </span>
          </p>
        )}

        {!vue.pending && vue.lastDelta !== null && (
          <p className="derniere">
            <Ecart valeur={vue.lastDelta} />
            <span className="attenue">
              dernière partie{vue.lastPlace === null ? '' : ` · ${vue.lastPlace}e`}
            </span>
          </p>
        )}

        <Courbe points={vue.history} />

        {session.games > 0 && (
          <dl className="session">
            <div>
              <dt>aujourd’hui</dt>
              <dd>
                {session.games} partie{session.games > 1 ? 's' : ''}
              </dd>
            </div>
            <div>
              <dt>bilan</dt>
              <dd>{session.delta === null ? '—' : <Ecart valeur={session.delta} />}</dd>
            </div>
            <div>
              <dt>place moy.</dt>
              <dd>{session.averagePlace?.toFixed(1) ?? '—'}</dd>
            </div>
          </dl>
        )}
      </section>
    </div>
  );
}
