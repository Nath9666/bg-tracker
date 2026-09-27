import { useEffect, useState } from 'react';
import { bridge, type OverlayPayload } from './api.js';

/** Un pourcentage arrondi, jamais « 0% » pour une issue possible. */
function pourcent(valeur: number): string {
  if (valeur > 0 && valeur < 1) return '<1%';
  return `${Math.round(valeur)}%`;
}

/**
 * Bandeau d'estimation du combat, centre en haut de l'ecran.
 *
 * Fenetre a part du panneau, qui est colle en haut a gauche : pendant un
 * combat on regarde le milieu de l'ecran, pas le coin.
 *
 * Les deux plateaux sont ceux du debut du combat. L'estimation ne bouge donc
 * plus une fois calculee, et **reste affichee pendant le recrutement qui
 * suit** : le combat lui-meme ne dure qu'une dizaine de secondes, trop court
 * pour etre lu.
 */
export default function Combat(): JSX.Element | null {
  const [payload, setPayload] = useState<OverlayPayload | null>(null);

  useEffect(() => {
    void bridge().current().then(setPayload);
    return bridge().onLive(setPayload);
  }, []);

  const odds = payload?.odds;
  // Rien a dire : la fenetre reste entierement transparente.
  if (payload === undefined || odds === null || odds === undefined) return null;
  if (odds.kind !== 'odds') return null;
  // Le dernier combat reste lisible pendant le recrutement qui suit, pas
  // au-dela : partie finie, il n'y a plus de combat suivant a attendre.
  if (!payload.state.inGame) return null;

  const { state, cards } = payload;
  const { winPercent, tiePercent, lossPercent } = odds.odds;

  const nom = (cardId: string | null): string =>
    cardId === null ? '—' : (cards[cardId]?.name ?? cardId);

  const enCours = state.phase === 'combat';

  return (
    <div className="bandeau">
      <div className="bandeau-entete">
        <span className="bandeau-titre">
          {enCours ? 'Combat' : 'Dernier combat'}
          {odds.opponentHero === null ? '' : ` · ${nom(odds.opponentHero)}`}
        </span>
        <span className="bandeau-tour">
          tour {odds.turn}
          {/* Le plafond explique un letal absent malgre un plateau ecrasant. */}
          {odds.odds.damageCap !== null && ` · dégâts max ${odds.odds.damageCap}`}
        </span>
      </div>

      <div className="barre">
        <span className="part gagne" style={{ width: `${winPercent}%` }} />
        <span className="part nul" style={{ width: `${tiePercent}%` }} />
        <span className="part perd" style={{ width: `${lossPercent}%` }} />
      </div>

      <div className="issues">
        <span className="gagne">victoire {pourcent(winPercent)}</span>
        <span className="nul">nul {pourcent(tiePercent)}</span>
        <span className="perd">défaite {pourcent(lossPercent)}</span>
      </div>

      <div className="degats">
        <span>
          inflige <strong>~{Math.round(odds.odds.averageDamageDealt)}</strong>
          {odds.odds.lethalDealtPercent > 0 && (
            <em className="letal"> létal {pourcent(odds.odds.lethalDealtPercent)}</em>
          )}
        </span>
        <span>
          subit <strong>~{Math.round(odds.odds.averageDamageTaken)}</strong>
          {odds.odds.lethalTakenPercent > 0 && (
            <em className="letal danger"> létal {pourcent(odds.odds.lethalTakenPercent)}</em>
          )}
        </span>
      </div>
    </div>
  );
}
