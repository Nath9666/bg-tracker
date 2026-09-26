/**
 * Lance une tache longue dans un processus a part (voir worker.ts).
 *
 * `utilityProcess` plutot que `child_process` : c'est le Node embarque par
 * Electron, qui existe donc aussi une fois l'application installee, sans
 * Node ni `npm` sur la machine.
 */
import { utilityProcess } from 'electron';
import { join } from 'node:path';

export type Task = 'sync' | 'cards' | 'sim-cards';

/** Plafond : un sync normal prend quelques secondes, un telechargement une minute. */
const DELAI_MAX = 10 * 60_000;

const enCours = new Map<Task, Promise<boolean>>();

/**
 * Rend vrai si la tache a reussi. Une meme tache ne tourne qu'une fois a la
 * fois : un second appel pendant la premiere recoit la meme promesse.
 */
export function runTask(task: Task): Promise<boolean> {
  const existante = enCours.get(task);
  if (existante !== undefined) return existante;

  const promesse = new Promise<boolean>((resolve) => {
    const enfant = utilityProcess.fork(join(__dirname, 'worker.cjs'), [task], {
      cwd: process.cwd(),
      stdio: 'ignore',
      serviceName: `BG Tracker — ${task}`,
    });

    let fini = false;
    const terminer = (ok: boolean, raison?: string): void => {
      if (fini) return;
      fini = true;
      clearTimeout(minuteur);
      if (!ok) console.warn(`${task} : ${raison ?? 'échec'}`);
      enfant.kill();
      resolve(ok);
    };

    const minuteur = setTimeout(() => terminer(false, 'trop long, abandonné'), DELAI_MAX);
    enfant.on('message', (message: { ok: boolean; error?: string }) => terminer(message.ok, message.error));
    enfant.on('exit', (code) => terminer(false, `processus terminé (code ${code})`));
  }).finally(() => enCours.delete(task));

  enCours.set(task, promesse);
  return promesse;
}
