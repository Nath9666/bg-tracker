import { nommeur, useLive } from './commun.js';
import { raceName } from './races.js';

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

  const { state, pace, pool, lobbyRaces } = payload;
  const nom = nommeur(payload.cards);

  if (!state.inGame) return null;

  // Pendant le choix du heros, les jauges n'ont pas encore de sens : le
  // panneau sert uniquement a comparer les heros proposes.
  if (payload.heroPicks.length > 0) {
    return (
      <div className="overlay">
        <section className="choix-heros">
          <h2>
            Choix du héros
            {lobbyRaces.length > 0 ? ` · ${lobbyRaces.map(raceName).join(', ')}` : ''}
          </h2>
          {payload.heroPicks.map((fiche) => (
            <article key={fiche.heroBaseId} className="fiche">
              <header>
                <span className="nom">{fiche.heroName}</span>
                <span className="meta">
                  {fiche.played === 0 ? 'jamais joué' : `${fiche.played} partie${fiche.played > 1 ? 's' : ''}`}
                </span>
              </header>
              {fiche.played > 0 && (
                <dl>
                  <div>
                    <dt>place</dt>
                    <dd>{fiche.averagePlace?.toFixed(1) ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>top 4</dt>
                    <dd>{fiche.top4Rate === null ? '—' : `${Math.round(fiche.top4Rate * 100)} %`}</dd>
                  </div>
                  <div>
                    <dt>choisi</dt>
                    <dd>{fiche.pickRate === null ? '—' : `${Math.round(fiche.pickRate * 100)} %`}</dd>
                  </div>
                </dl>
              )}
              {fiche.bestRace !== null && (
                <p className={fiche.bestRaceInLobby ? 'type' : 'type perime'}>
                  meilleur type : {raceName(fiche.bestRace.race)}
                  {` (${fiche.bestRace.averagePlace?.toFixed(1)}e sur ${fiche.bestRace.games})`}
                  {!fiche.bestRaceInLobby && lobbyRaces.length > 0 ? ' · absent de la partie' : ''}
                </p>
              )}
            </article>
          ))}
        </section>
      </div>
    );
  }

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
        {/* Lue dans la memoire du jeu ; absente plutot que fausse si la lecture echoue. */}
        {payload.rating !== null && <Pastille valeur={String(payload.rating.solo)} libelle="cote" />}
      </div>

      <section className="taverne">
        <h2>
          Taverne{lobbyRaces.length > 0 ? ` · ${lobbyRaces.map(raceName).join(', ')}` : ''}
        </h2>
        {lobbyRaces.length === 0 ? (
          // Rien vu encore : annoncer tout le pool serait exact mais inutile.
          <p className="perime">types du lobby pas encore identifiés</p>
        ) : (
          <ul className="paliers">
            {pool
              .filter(
                (palier) =>
                  state.tavernTier !== null &&
                  palier.tier >= state.tavernTier &&
                  palier.tier <= state.tavernTier + 1,
              )
              .map((palier) => (
                <li key={palier.tier}>
                  <span className="palier">T{palier.tier}</span>
                  <span className="combien">{palier.total}</span>
                  <span className="types">
                    {palier.byRace
                      .slice(0, 3)
                      .map((r) => `${raceName(r.race)} ${r.count}`)
                      .join(' · ')}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </section>

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
