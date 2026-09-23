import { useEffect, useState } from 'react';
import { bridge, type OverlayPayload } from './api.js';

/** Force brute d'un plateau : attaque et vie cumulees. */
function force(board: { atk: number | null; health: number | null }[]): {
  atk: number;
  health: number;
} {
  return board.reduce(
    (total, minion) => ({
      atk: total.atk + (minion.atk ?? 0),
      health: total.health + (minion.health ?? 0),
    }),
    { atk: 0, health: 0 },
  );
}

/**
 * Overlay affiche pendant les parties.
 *
 * Il ne montre que ce que le joueur a deja vu : les plateaux des adversaires
 * qu'il a affrontes, leur palier et l'historique des combats. Rien d'invisible
 * en jeu.
 *
 * Le bandeau d'estimation rejoue ce combat quelques centaines de fois a partir
 * de ces memes informations. Il n'ajoute donc aucune donnee cachee, mais il
 * sort du « papier-crayon » : certains tournois l'interdisent (voir CLAUDE.md).
 */

function Pastille({ valeur, libelle }: { valeur: string; libelle: string }): JSX.Element {
  return (
    <div className="pastille">
      <span className="valeur">{valeur}</span>
      <span className="libelle">{libelle}</span>
    </div>
  );
}

export default function Overlay(): JSX.Element | null {
  const [payload, setPayload] = useState<OverlayPayload | null>(null);

  useEffect(() => {
    void bridge().current().then((initial) => {
      if (initial !== null) setPayload(initial);
    });
    return bridge().onLive(setPayload);
  }, []);

  if (payload === null) return null;

  const { state, cards, pace } = payload;
  const nom = (cardId: string | null): string =>
    cardId === null ? '—' : (cards[cardId]?.name ?? cardId);

  if (!state.inGame) {
    return (
      <div className="overlay repos">
        <span className="titre">BG Tracker</span>
        <span className="attente">en attente d’une partie</span>
      </div>
    );
  }

  // La fenetre laisse passer les clics : on ne peut donc pas y faire defiler.
  // Tout doit tenir a l'ecran, d'ou ces limites.
  const AVEC_PLATEAU = 2;
  const DERNIERS_COMBATS = 6;

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
      <div className="entete">
        <span className="titre">{nom(state.heroCardId)}</span>
        <span className="phase">
          {state.phase === 'combat' ? 'combat' : 'recrutement'} · tour {state.turn ?? '—'}
        </span>
      </div>

      <div className="pastilles">
        <Pastille valeur={state.place === null ? '—' : `${state.place}e`} libelle="place" />
        <Pastille valeur={state.health === null ? '—' : String(state.health)} libelle="pv" />
        <Pastille valeur={state.tavernTier === null ? '—' : `T${state.tavernTier}`} libelle="palier" />
        <Pastille valeur={state.gold === null ? '—' : String(state.gold)} libelle="or" />
      </div>

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
          <ul className="plateau">
            {suivant.board.map((minion) => (
              <li key={minion.position} className={minion.golden ? 'doré' : undefined}>
                <span className="serviteur">{nom(minion.cardId)}</span>
                <span className="stats">
                  {minion.atk ?? '?'}/{minion.health ?? '?'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {state.opponents.length > 0 && (
        <section>
          <h2>Adversaires affrontés</h2>
          {state.opponents
            .filter((opponent) => opponent.heroCardId !== state.nextOpponentHero)
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
              {rang < AVEC_PLATEAU && (
                <ul className="plateau">
                  {opponent.board.map((minion) => (
                    <li key={minion.position} className={minion.golden ? 'doré' : undefined}>
                      <span className="serviteur">{nom(minion.cardId)}</span>
                      <span className="stats">
                        {minion.atk ?? '?'}/{minion.health ?? '?'}
                      </span>
                    </li>
                  ))}
                  {opponent.board.length === 0 && <li className="rien">plateau non relevé</li>}
                </ul>
              )}
              </article>
            ))}
        </section>
      )}

      {state.tierUps.length > 0 && (
        <section className="rythme">
          <h2>Rythme de paliers</h2>
          <ul>
            {state.tierUps.map((montee) => {
              const reference = pace.find((point) => point.tier === montee.tier);
              // Sans reference, ou sur un historique trop mince, on affiche la
              // montee sans la juger.
              const fiable =
                reference !== undefined &&
                reference.top4Turn !== null &&
                reference.top4Games >= 3;
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

      {state.combats.length > 0 && (
        <section>
          <h2>Combats</h2>
          <ul className="combats">
            {[...state.combats].reverse().slice(0, DERNIERS_COMBATS).map((combat) => (
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
    </div>
  );
}
