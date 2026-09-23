/** Ce que les quatre fenetres de l'overlay partagent. */
import { useEffect, useState } from 'react';
import { bridge, type OverlayPayload } from './api.js';

/** S'abonne a l'etat en direct. `null` tant que rien n'est arrive. */
export function useLive(): OverlayPayload | null {
  const [payload, setPayload] = useState<OverlayPayload | null>(null);

  useEffect(() => {
    void bridge()
      .current()
      .then((initial) => {
        if (initial !== null) setPayload(initial);
      });
    return bridge().onLive(setPayload);
  }, []);

  return payload;
}

/** Nom francais d'une carte, son `cardId` a defaut. */
export function nommeur(
  cards: OverlayPayload['cards'],
): (cardId: string | null) => string {
  return (cardId) => (cardId === null ? '—' : (cards[cardId]?.name ?? cardId));
}

/** Force brute d'un plateau : attaque et vie cumulees. */
export function force(board: { atk: number | null; health: number | null }[]): {
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

export interface MinionVu {
  position: number;
  cardId: string;
  atk: number | null;
  health: number | null;
  golden: boolean;
}

/** Liste de serviteurs, telle qu'affichee sous un adversaire. */
export function Plateau({
  board,
  nom,
}: {
  board: readonly MinionVu[];
  nom: (cardId: string | null) => string;
}): JSX.Element {
  return (
    <ul className="plateau">
      {board.map((minion) => (
        <li key={minion.position} className={minion.golden ? 'doré' : undefined}>
          <span className="serviteur">{nom(minion.cardId)}</span>
          <span className="stats">
            {minion.atk ?? '?'}/{minion.health ?? '?'}
          </span>
        </li>
      ))}
      {board.length === 0 && <li className="rien">plateau non relevé</li>}
    </ul>
  );
}
