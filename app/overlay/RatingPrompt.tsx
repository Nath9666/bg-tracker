import { useEffect, useState } from 'react';
import { bridge, type RatingPrompt as Game } from './api.js';

/**
 * Saisie de la cote en fin de partie.
 *
 * La cote n'est nulle part dans les logs : c'est le seul moment ou le joueur
 * l'a sous les yeux. Cette fenetre-ci est normale, pas traversante : on doit
 * pouvoir y taper.
 */
export default function RatingPrompt(): JSX.Element {
  const [game, setGame] = useState<Game | null>(null);
  const [texte, setTexte] = useState('');
  const [etat, setEtat] = useState<'saisie' | 'enregistre'>('saisie');

  useEffect(
    () =>
      bridge().onPrompt((recu) => {
        setGame(recu);
        setTexte('');
        setEtat('saisie');
      }),
    [],
  );

  const enregistrer = (): void => {
    if (game === null) return;
    const nettoye = texte.trim();
    const cote = nettoye === '' ? null : Number(nettoye);
    if (cote !== null && !Number.isFinite(cote)) return;

    void bridge()
      .setRating(game.gameId, cote === null ? null : Math.round(cote))
      .then(() => {
        setEtat('enregistre');
        setTimeout(() => bridge().closePrompt(), 700);
      });
  };

  if (game === null)
    return (
      <div className="saisie">
        <p>…</p>
      </div>
    );

  return (
    <div className="saisie">
      <h1>Partie terminée</h1>
      <p className="partie">{game.label}</p>

      {etat === 'enregistre' ? (
        <p className="confirme">Cote enregistrée.</p>
      ) : (
        <>
          <label htmlFor="cote">Ta cote après cette partie</label>
          <input
            id="cote"
            type="text"
            inputMode="numeric"
            autoFocus
            placeholder="par ex. 4605"
            value={texte}
            onChange={(event) => setTexte(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') enregistrer();
              if (event.key === 'Escape') bridge().closePrompt();
            }}
          />
          <div className="boutons">
            <button type="button" onClick={() => bridge().closePrompt()}>
              Plus tard
            </button>
            <button type="button" className="principal" onClick={enregistrer}>
              Enregistrer
            </button>
          </div>
        </>
      )}
    </div>
  );
}
