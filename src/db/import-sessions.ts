/**
 * Import d'un ensemble de sessions, partage par `npm run import` et
 * `npm run sync`.
 *
 * Une session dont les fichiers n'ont pas bouge depuis le dernier import est
 * **sautee** : c'est ce qui rend la commande assez rapide pour etre planifiee.
 */
import { importGames } from './import.js';
import {
  isSessionImported,
  markSessionImported,
  sessionFingerprint,
} from './session-state.js';
import { extractGames } from '../extract/game-extractor.js';
import { openSession, readSessionLines, resolveSessionDate } from '../reader/session-reader.js';
import type { Db } from './database.js';
import type { GameSummary } from '../types.js';

export interface SessionOutcome {
  folder: string;
  /** Vrai si la session a ete sautee, inchangee depuis le dernier import. */
  skipped: boolean;
  games: number;
  inserted: number;
  updated: number;
}

export interface ImportSessionsResult {
  inserted: number;
  updated: number;
  /** Nombre de sessions sautees. */
  skipped: number;
  sessions: SessionOutcome[];
}

export interface ImportSessionsOptions {
  /** Relire toutes les sessions, meme inchangees. */
  force?: boolean;
}

export async function importSessions(
  db: Db,
  folders: readonly string[],
  options: ImportSessionsOptions = {},
): Promise<ImportSessionsResult> {
  const result: ImportSessionsResult = { inserted: 0, updated: 0, skipped: 0, sessions: [] };

  for (const folder of folders) {
    // Empreinte prise **avant** la lecture : si le fichier grossit pendant
    // qu'on le lit, on retient l'ancienne valeur et la session sera relue.
    const fingerprint = await sessionFingerprint(db, folder);

    if (options.force !== true && isSessionImported(db, folder, fingerprint)) {
      result.skipped += 1;
      result.sessions.push({ folder, skipped: true, games: 0, inserted: 0, updated: 0 });
      continue;
    }

    const sessionDate = await resolveSessionDate(await openSession(folder));
    const summaries: GameSummary[] = [];
    for await (const summary of extractGames(readSessionLines(folder), { sessionDate })) {
      summaries.push(summary);
    }

    const imported = importGames(db, summaries, folder);
    markSessionImported(db, folder, fingerprint);

    result.inserted += imported.inserted;
    result.updated += imported.updated;
    result.sessions.push({
      folder,
      skipped: false,
      games: summaries.length,
      inserted: imported.inserted,
      updated: imported.updated,
    });
  }

  return result;
}
