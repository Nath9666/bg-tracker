/**
 * Base de cartes du simulateur de combat.
 *
 * Le simulateur de Firestone a besoin de sa propre base : il y lit les effets
 * propres a chaque carte (rales d'agonie, cris de guerre, invocations), que
 * rien dans les logs ne declare. C'est une base differente de celle de
 * `src/cards/` (HearthstoneJSON), qui ne sert qu'a afficher des noms.
 *
 * Elle est **mise en cache sur disque** : sans ca, chaque lancement de
 * l'overlay irait chercher 42 Mo sur un CDN tiers, et l'overlay ne
 * fonctionnerait pas hors ligne.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { AllCardsService } from '@firestone-hs/reference-data';
import { CardsData } from '@firestone-hs/simulate-bgs-battle/dist/cards/cards-data.js';

/** Cache local de la base de cartes du simulateur. `data/` est ignore par Git. */
export const SIM_CARDS_PATH = 'data/cards/firestone-cards.json';

const SOURCE = 'https://static.zerotoheroes.com/data/cards/cards_enUS.gz.json';

export interface SimCards {
  cards: AllCardsService;
  cardsData: CardsData;
}

/**
 * Telecharge la base et l'ecrit dans le cache.
 *
 * `fetch` decompresse deja la reponse quand le serveur annonce
 * `Content-Encoding: gzip`, malgre le `.gz` du nom : on essaie les deux.
 */
export async function downloadSimCards(path: string = SIM_CARDS_PATH): Promise<number> {
  const response = await fetch(SOURCE);
  if (!response.ok) {
    throw new Error(`Base de cartes du simulateur : HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  let texte: string;
  try {
    texte = gunzipSync(buffer).toString('utf8');
  } catch {
    texte = buffer.toString('utf8');
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, texte, 'utf8');
  return (JSON.parse(texte) as unknown[]).length;
}

/**
 * Charge la base depuis le cache, en la telechargeant si elle manque.
 *
 * Le chargement prend environ 350 ms pour 36 000 cartes : a faire une fois au
 * demarrage, jamais dans une boucle.
 */
export async function loadSimCards(path: string = SIM_CARDS_PATH): Promise<SimCards> {
  let texte = await readFile(path, 'utf8').catch(() => null);
  if (texte === null) {
    await downloadSimCards(path);
    texte = await readFile(path, 'utf8');
  }

  const cards = new AllCardsService();
  cards.initializeCardsDbFromCards(JSON.parse(texte) as never);

  const cardsData = new CardsData(cards, false);
  cardsData.inititialize();

  return { cards, cardsData };
}
