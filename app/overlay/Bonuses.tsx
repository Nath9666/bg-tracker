import { useLive } from './commun.js';

/**
 * Bande des bonus cumules, en bas de l'ecran.
 *
 * Ce sont les effets permanents qui ne se lisent nulle part sur le plateau :
 * la valeur des gemmes de sang, l'or supplementaire du prochain tour, les
 * rales d'agonie qui se declenchent deux fois. Sans eux on oublie ce qu'on a
 * accumule, et on joue comme si on ne l'avait pas.
 *
 * En bas parce que c'est la seule bande libre : le plateau occupe le centre,
 * la main le bas-centre du jeu, et les deux panneaux les cotes. Tant qu'aucun
 * bonus n'est actif, la fenetre reste entierement transparente.
 */
export default function Bonuses(): JSX.Element | null {
  const payload = useLive();
  if (payload === null) return null;

  const { bonuses } = payload.state;
  if (!payload.state.inGame || bonuses.length === 0) return null;

  return (
    <div className="bonus">
      {bonuses.map((bonus) => (
        <div key={bonus.key} className={`bonus-jeton ${bonus.key}`}>
          <span className="bonus-valeur">{bonus.value}</span>
          <span className="bonus-libelle">{bonus.label}</span>
        </div>
      ))}
    </div>
  );
}
