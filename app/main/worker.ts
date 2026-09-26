/**
 * Travaux longs, lances par l'application dans un processus a part
 * (`utilityProcess`) : synchronisation et telechargement des cartes.
 *
 * Un processus a part pour deux raisons. L'import ecrit en base de facon
 * synchrone et gelerait l'overlay le temps qu'il dure. Et une fois installee,
 * l'application n'a ni `npm` ni le code source : `npm run sync` n'existe pas.
 *
 * La tache arrive en argument, le resultat repart par `parentPort` :
 * `{ ok: true }` ou `{ ok: false, error }`.
 */
import { runCards } from '../../src/cli/cards.js';
import { runSync } from '../../src/cli/sync.js';
import { downloadSimCards } from '../../src/sim/sim-cards.js';

type Task = 'sync' | 'cards' | 'sim-cards';

const TASKS: Record<Task, () => Promise<unknown>> = {
  sync: () => runSync(),
  cards: () => runCards(),
  'sim-cards': () => downloadSimCards(),
};

const task = process.argv.at(-1) as Task;
const port = (process as unknown as { parentPort?: { postMessage(message: unknown): void } }).parentPort;

const run = TASKS[task];
void (run === undefined ? Promise.reject(new Error(`Tâche inconnue : ${task}`)) : run())
  .then(() => port?.postMessage({ ok: true }))
  .catch((error: unknown) =>
    port?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
// Pas de `process.exit` ici : il pourrait couper le message avant son envoi.
// Le processus principal ferme celui-ci des qu'il a recu la reponse.
