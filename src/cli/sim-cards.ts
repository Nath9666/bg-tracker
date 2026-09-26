/**
 * CLI : `npm run sim-cards`
 *
 * Telecharge la base de cartes du simulateur de combat et la met en cache.
 * Sans elle, l'overlay ne peut pas estimer un combat.
 *
 * A relancer apres une extension de Hearthstone : un patch change les effets
 * des cartes, et une base perimee donne des estimations fausses sans le dire.
 */
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SIM_CARDS_PATH, downloadSimCards } from '../sim/sim-cards.js';

async function main(): Promise<void> {
  console.log('Téléchargement de la base de cartes du simulateur…');
  const cartes = await downloadSimCards();
  console.log(`${cartes} cartes écrites dans ${resolve(SIM_CARDS_PATH)}`);
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
