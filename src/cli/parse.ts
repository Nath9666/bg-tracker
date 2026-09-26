/**
 * CLI : `npm run parse -- <dossier> [--json]`
 *
 * Le dossier peut etre une session unique (contenant `Power.log` ou
 * `Power_old.log`, compresses ou non) ou un dossier qui en contient plusieurs,
 * comme `data/archive`.
 *
 * Les cartes sont affichees par leur nom des que l'index HearthstoneJSON est
 * present dans `data/cards/` (`npm run cards`). Sans lui, ou avec `--ids`, on
 * retombe sur les `cardId` bruts.
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadIndex, type CardIndex } from '../cards/card-database.js';
import { extractGames } from '../extract/game-extractor.js';
import { openSession, readSessionLines, resolveSessionDate } from '../reader/session-reader.js';
import type { GameSummary } from '../types.js';

export interface ParseCliOptions {
  folder: string;
  json: boolean;
  /** Affiche les `cardId` bruts au lieu des noms de cartes. */
  ids: boolean;
}

/** Lit les arguments de la ligne de commande. Fonction pure, testable. */
export function parseCliArgs(argv: readonly string[]): ParseCliOptions {
  const positional: string[] = [];
  let json = false;
  let ids = false;

  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg === '--ids') {
      ids = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Option inconnue : ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const folder = positional[0];
  if (folder === undefined) {
    throw new Error('Usage : npm run parse -- <dossier> [--json] [--ids]');
  }
  if (positional.length > 1) {
    throw new Error('Un seul dossier peut etre analyse a la fois.');
  }

  return { folder, json, ids };
}

/**
 * Dossiers de session a lire sous `root`.
 *
 * Si `root` contient lui-meme des fichiers de log, c'est une session unique.
 * Sinon on descend d'un niveau : c'est un dossier d'archive.
 */
export async function findSessions(root: string): Promise<string[]> {
  const stats = await stat(root).catch(() => null);
  if (stats === null || !stats.isDirectory()) {
    throw new Error(`Dossier introuvable : ${root}`);
  }

  if ((await openSession(root)).files.length > 0) return [root];

  const entries = await readdir(root, { withFileTypes: true });
  const sessions: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if ((await openSession(path)).files.length > 0) sessions.push(path);
  }

  return sessions.sort();
}

function shortTime(iso: string | null): string {
  return iso === null ? '—' : iso.slice(11, 16);
}

function shortDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

/** Duree de la partie, en minutes. */
function duration(summary: GameSummary): string {
  if (summary.endedAt === null) return 'en cours';
  const minutes = Math.round(
    (Date.parse(summary.endedAt) - Date.parse(summary.startedAt)) / 60_000,
  );
  return `${minutes} min`;
}

const RESULT_LABEL: Record<string, string> = {
  win: 'victoire',
  loss: 'défaite',
  tie: 'égalité',
  none: '—',
};

function ordinal(place: number): string {
  return place === 1 ? '1re' : `${place}e`;
}

/**
 * Bloc lisible pour une partie.
 *
 * `cards` absent (pas d'index HearthstoneJSON, ou option `--ids`) : les cartes
 * restent affichees sous leur `cardId`.
 */
export function formatSummary(
  summary: GameSummary,
  index: number,
  cards: CardIndex | null = null,
): string[] {
  const lines: string[] = [];
  const pad = (label: string): string => `    ${label.padEnd(12)}`;
  /** Nom seul, pour les enumerations. */
  const name = (cardId: string): string => cards?.name(cardId) ?? cardId;
  /** Nom detaille (palier, types), pour une carte mise en avant. */
  const label = (cardId: string): string => cards?.label(cardId) ?? cardId;

  lines.push(
    `  Partie ${index}  ${shortDate(summary.startedAt)} ${shortTime(summary.startedAt)} → ` +
      `${shortTime(summary.endedAt)}  (${duration(summary)})`,
  );
  lines.push(
    `${pad('Joueur')}${summary.playerName} · build ${summary.buildNumber} · seed ${summary.gameSeed ?? '—'}`,
  );
  lines.push(`${pad('Héros')}${name(summary.heroChosen)}`);
  if (summary.heroOffered.length > 0) {
    lines.push(`${pad('')}proposés : ${summary.heroOffered.map(name).join(', ')}`);
  }

  const place =
    summary.finalPlace === null ? 'place inconnue' : `${ordinal(summary.finalPlace)} place`;
  const turn = summary.finalTurn === null ? '' : ` au tour ${summary.finalTurn}`;
  lines.push(
    `${pad('Résultat')}${place}${turn}${summary.endedAt === null ? ' (partie inachevée)' : ''}`,
  );

  lines.push(
    `${pad('Paliers')}${
      summary.tierUps.length === 0
        ? 'aucune montée'
        : summary.tierUps.map((tier) => `T${tier.tier} au tour ${tier.turn}`).join(' · ')
    }`,
  );

  if (summary.turns.length > 0) {
    lines.push(`${pad('Tours')}${summary.turns.length}`);
    for (const turn of summary.turns) {
      const cell = (value: number | null, unit = ''): string =>
        value === null ? '—' : `${value}${unit}`;
      lines.push(
        `      t${String(turn.turn).padEnd(3)}` +
          `T${cell(turn.tavernTier).padEnd(2)}` +
          `${cell(turn.gold, ' or').padStart(6)}` +
          `${cell(turn.health, ' pv').padStart(7)}` +
          `  ${(RESULT_LABEL[turn.combatResult ?? 'none'] ?? '—').padEnd(8)}` +
          `${turn.damageTaken !== null && turn.damageTaken > 0 ? `-${turn.damageTaken}` : '  '}`.padStart(
            5,
          ) +
          `  ${String(turn.board.length).padStart(1)} serv.` +
          `  vs ${turn.opponentHero === null ? '—' : name(turn.opponentHero)}`,
      );
    }
  }

  lines.push(`${pad('Choix')}${summary.picks.length}`);
  for (const pick of summary.picks) {
    const source = pick.sourceCardId === '' ? '—' : name(pick.sourceCardId);
    const turn = pick.turn === null ? '' : ` t${pick.turn}`;
    lines.push(
      `      #${String(pick.choiceId).padEnd(3)}${turn.padEnd(5)}${source} → ${label(pick.chosen)}`,
    );
    if (pick.options.length > 0) {
      lines.push(`           parmi ${pick.options.map(name).join(', ')}`);
    }
  }

  lines.push(`${pad('Adversaires')}${summary.opponents.map(name).join(', ') || '—'}`);
  return lines;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const sessions = await findSessions(options.folder);

  if (sessions.length === 0) {
    throw new Error(
      `Aucun Power.log trouvé dans ${options.folder}, ni directement ni dans ses sous-dossiers.`,
    );
  }

  // Sans index de cartes, l'affichage retombe sur les cardId : c'est une aide,
  // pas une dependance.
  const cards = options.ids ? null : await loadIndex();

  const all: GameSummary[] = [];
  const blocks: string[] = [];

  for (const session of sessions) {
    const sessionDate = await resolveSessionDate(await openSession(session));
    const summaries: GameSummary[] = [];

    for await (const summary of extractGames(readSessionLines(session), { sessionDate })) {
      summaries.push(summary);
      all.push(summary);
    }

    if (options.json) continue;

    blocks.push(`=== ${session} ===`);
    if (summaries.length === 0) {
      blocks.push('  Aucune partie de Champs de bataille.');
    }
    summaries.forEach((summary, index) => {
      blocks.push(...formatSummary(summary, index + 1, cards), '');
    });
  }

  if (options.json) {
    console.log(JSON.stringify(all, null, 2));
    return;
  }

  console.log(blocks.join('\n'));
  const sessionCount = `${sessions.length} session${sessions.length > 1 ? 's' : ''}`;
  const gameCount = `${all.length} partie${all.length > 1 ? 's' : ''}`;
  console.log(`${gameCount} de Champs de bataille dans ${sessionCount}.`);
}

// Ne s'execute que lorsque le fichier est lance directement, pas a l'import.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
