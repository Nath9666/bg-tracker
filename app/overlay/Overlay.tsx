import { force, nommeur, Plateau, useLive } from './commun.js';

/**
 * Panneau de gauche : les combats, passes et a venir.
 *
 * Il ne montre que ce que le joueur a deja vu — les plateaux des adversaires
 * qu'il a affrontes. Rien d'invisible en jeu.
 *
 * Le reste (rythme, jauges, bonus) est dans les autres fenetres : pendant une
 * partie on ne consulte pas les combats et son rythme de paliers au meme
 * moment.
 */
export default function Overlay(): JSX.Element | null {
  const payload = useLive();
  if (payload === null) return null;

  const { state, cards } = payload;
  const nom = nommeur(cards);

  if (!state.inGame) {
    return (
      <div className="overlay repos">
        <span className="titre">BG Tracker</span>
        <span className="attente">en attente d’une partie</span>
      </div>
    );
  }

  // La fenetre laisse passer les clics : **on ne peut pas y faire defiler**.
  // Tout ce qui depasse est invisible, donc tout doit tenir. D'ou ces limites,
  // et l'ordre des sections plus bas : le recapitulatif des combats, compact et
  // complet, passe avant la liste des adversaires, qui elle grandit a chaque
  // combat et absorbe le debordement.
  const AVEC_PLATEAU = 2;
  const DERNIERS_COMBATS = 6;
  const ADVERSAIRES = 4;

  // Le jeu annonce le prochain adversaire avant le combat. S'il a deja ete
  // affronte, on ressort son dernier plateau : c'est la meilleure estimation
  // de ce qui attend, et c'est une information deja vue.
  const suivant =
    state.nextOpponentHero === null
      ? undefined
      : state.opponents.find((o) => o.heroCardId === state.nextOpponentHero);
  const maForce = force(state.board);
  const saForce = force(suivant?.board ?? []);

  // Anciennete du plateau adverse. Comparer son plateau d'il y a sept tours au
  // notre d'aujourd'hui ne veut rien dire : au-dela de deux tours, on montre
  // l'age et on se garde de trancher.
  const anciennete =
    state.turn === null || suivant?.lastFoughtTurn == null
      ? null
      : state.turn - suivant.lastFoughtTurn;
  const comparable = anciennete !== null && anciennete <= 2;

  return (
    <div className="overlay">
      {suivant !== undefined && (
        <section className="suivant">
          <h2>Prochain adversaire</h2>
          <header>
            <span className="nom">{nom(suivant.heroCardId)}</span>
            <span className="meta">
              {suivant.place === null ? '' : `${suivant.place}e · `}
              {suivant.tier === null ? '' : `T${suivant.tier} · `}
              {suivant.health === null ? '' : `${suivant.health} pv`}
            </span>
          </header>
          <p className="comparaison">
            <span>
              toi {maForce.atk}/{maForce.health}
            </span>
            {comparable ? (
              <span className={maForce.atk >= saForce.atk ? 'avantage' : 'retard'}>
                {maForce.atk >= saForce.atk ? '▲' : '▼'}
              </span>
            ) : (
              <span className="perime">
                {anciennete === null ? 'jamais vu' : `vu il y a ${anciennete} tours`}
              </span>
            )}
            <span className={comparable ? undefined : 'perime'}>
              lui {saForce.atk}/{saForce.health}
            </span>
          </p>
          <Plateau board={suivant.board} nom={nom} />
        </section>
      )}

      {state.combats.length > 0 && (
        <section>
          <h2>Combats</h2>
          <ul className="combats">
            {[...state.combats]
              .reverse()
              .slice(0, DERNIERS_COMBATS)
              .map((combat) => (
                <li key={combat.turn} className={combat.result ?? undefined}>
                  <span className="tour">t{combat.turn}</span>
                  <span className="contre">{nom(combat.opponentHero)}</span>
                  <span className="degats">
                    {combat.damageTaken !== null && combat.damageTaken > 0
                      ? `-${combat.damageTaken}`
                      : ''}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}

      {state.opponents.length > 0 && (
        <section className="adversaires">
          <h2>Adversaires affrontés</h2>
          {state.opponents
            .filter((opponent) => opponent.heroCardId !== state.nextOpponentHero)
            .slice(0, ADVERSAIRES)
            .map((opponent, rang) => (
              <article key={opponent.heroCardId} className="adversaire">
                <header>
                  <span className="nom">{nom(opponent.heroCardId)}</span>
                  <span className="meta">
                    {opponent.place === null ? '' : `${opponent.place}e · `}
                    {opponent.tier === null ? '' : `T${opponent.tier} · `}
                    {opponent.health === null ? '' : `${opponent.health} pv`}
                    {` · t${opponent.lastFoughtTurn ?? '?'}`}
                  </span>
                </header>
                {/* Seuls les derniers affrontes montrent leur plateau : au-dela,
                    l'information est vieille et la place manque. */}
                {rang < AVEC_PLATEAU && <Plateau board={opponent.board} nom={nom} />}
              </article>
            ))}
        </section>
      )}
    </div>
  );
}
