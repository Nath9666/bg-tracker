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
import { readCareer } from '../../src/memory/career-reader.js';
import { saveSnapshot, saveWarbands } from '../../src/career/career.js';
import { DEFAULT_DB_PATH, openDatabase } from '../../src/db/database.js';
import { toLocalIso } from '../../src/extract/log-clock.js';

type Task = 'sync' | 'cards' | 'sim-cards' | 'career';

/**
 * Statistiques de carriere : ~2 s de balayage du tas du jeu, d'ou ce
 * processus a part. Sans ecran de statistiques ouvert dans la session du
 * jeu, il n'y a rien a lire, et rien n'est ecrit.
 */
async function releverCarriere(): Promise<void> {
  const lecture = readCareer();
  if (lecture === null) return;

  const db = openDatabase(DEFAULT_DB_PATH);
  try {
    const maintenant = toLocalIso(new Date());
    saveSnapshot(db, maintenant, lecture.stats);
    saveWarbands(db, maintenant, lecture.warbands);
  } finally {
    db.close();
  }
}

const TASKS: Record<Task, () => Promise<unknown>> = {
  sync: () => runSync(),
  cards: () => runCards(),
  'sim-cards': () => downloadSimCards(),
  career: releverCarriere,
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
