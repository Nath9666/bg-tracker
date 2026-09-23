import { nommeur, useLive } from './commun.js';

function Pastille({ valeur, libelle }: { valeur: string; libelle: string }): JSX.Element {
  return (
    <div className="pastille">
      <span className="valeur">{valeur}</span>
      <span className="libelle">{libelle}</span>
    </div>
  );
}

/**
 * Panneau de droite : ou en est la partie, et a quel rythme elle avance.
 *
 * Separe des combats, a gauche : ce sont deux questions qu'on ne se pose pas
 * au meme moment. Les combats se consultent avant d'acheter, le rythme se
 * consulte quand on hesite a monter de palier.
 */
export default function Side(): JSX.Element | null {
  const payload = useLive();
  if (payload === null) return null;

  const { state, pace } = payload;
  const nom = nommeur(payload.cards);

  if (!state.inGame) return null;

  return (
    <div className="overlay">
      <div className="entete">
        <span className="titre">{nom(state.heroCardId)}</span>
        <span className="phase">
          {state.phase === 'combat' ? 'combat' : 'recrutement'} · tour {state.turn ?? '—'}
        </span>
      </div>

      <div className="pastilles">
        <Pastille valeur={state.place === null ? '—' : `${state.place}e`} libelle="place" />
        <Pastille valeur={state.health === null ? '—' : String(state.health)} libelle="pv" />
        <Pastille
          valeur={state.tavernTier === null ? '—' : `T${state.tavernTier}`}
          libelle="palier"
        />
        <Pastille valeur={state.gold === null ? '—' : String(state.gold)} libelle="or" />
      </div>

      {state.tierUps.length > 0 && (
        <section className="rythme">
          <h2>Rythme de paliers</h2>
          <ul>
            {state.tierUps.map((montee) => {
              const reference = pace.find((point) => point.tier === montee.tier);
              // Sans reference, ou sur un historique trop mince, on affiche la
              // montee sans la juger.
              const fiable =
                reference !== undefined && reference.top4Turn !== null && reference.top4Games >= 3;
              const ecart = fiable ? montee.turn - (reference.top4Turn ?? 0) : null;

              return (
                <li key={montee.tier}>
                  <span className="palier">T{montee.tier}</span>
                  <span className="quand">tour {montee.turn}</span>
                  {ecart === null ? (
                    <span className="perime">pas assez de parties</span>
                  ) : (
                    // Volontairement sans vert ni rouge : « plus tot » n'est pas
                    // toujours mieux. Sur l'historique du joueur, T4 arrive plus
                    // tot dans les tops 4, mais T5 et T6 plus tard. On montre
                    // l'ecart, on ne le juge pas.
                    <span className="ecart">
                      {Math.abs(ecart) < 0.5
                        ? 'comme tes tops 4'
                        : `${Math.round(Math.abs(ecart))} tour${Math.round(Math.abs(ecart)) > 1 ? 's' : ''} ${ecart < 0 ? 'plus tôt' : 'plus tard'}`}
                      {` (${reference?.top4Turn?.toFixed(1)})`}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
