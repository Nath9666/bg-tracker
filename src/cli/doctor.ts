/**
 * CLI : `npm run doctor`
 *
 * Verifie qu'une installation est prete, en particulier sur une nouvelle
 * machine, et dit pour chaque point manquant la commande qui le corrige.
 * Ne modifie rien.
 */
import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { findLogsFolder } from '../reader/hearthstone-path.js';
import { DEFAULT_INDEX_PATH } from '../cards/card-database.js';
import { SIM_CARDS_PATH } from '../sim/sim-cards.js';
import { DEFAULT_DB_PATH } from '../db/database.js';

export type Verdict = 'ok' | 'warn' | 'fail';

export interface Check {
  label: string;
  verdict: Verdict;
  detail: string;
  /** Ce qu'il faut faire, quand ce n'est pas bon. */
  fix?: string;
}

/**
 * Vrai si `log.config` fait bien ecrire `Power.log` avec le detail necessaire.
 *
 * Sans `[Power]`, le jeu n'ecrit rien ; sans `Verbose=True`, il ecrit mais sans
 * les tags dont le parseur a besoin.
 */
export function checkLogConfig(contenu: string | null): Check {
  const label = 'Logs du jeu activés (log.config)';
  const fix =
    'Ajouter la section [Power] du README à %LocalAppData%\\Blizzard\\Hearthstone\\log.config, puis relancer Hearthstone';
  if (contenu === null) return { label, verdict: 'fail', detail: 'fichier absent', fix };

  const section = /\[Power\]([\s\S]*?)(?=\n\[|$)/.exec(contenu)?.[1];
  if (section === undefined) return { label, verdict: 'fail', detail: 'section [Power] absente', fix };

  const vrai = (cle: string): boolean => new RegExp(`^\\s*${cle}\\s*=\\s*True\\s*$`, 'mi').test(section);
  if (!vrai('FilePrinting')) return { label, verdict: 'fail', detail: 'FilePrinting n’est pas à True', fix };
  if (!vrai('Verbose')) return { label, verdict: 'fail', detail: 'Verbose n’est pas à True', fix };

  return { label, verdict: 'ok', detail: '[Power] avec FilePrinting et Verbose' };
}

function lire(chemin: string): string | null {
  try {
    return readFileSync(chemin, 'utf8');
  } catch {
    return null;
  }
}

export function runChecks(): Check[] {
  const checks: Check[] = [];

  const majeur = Number(process.versions.node.split('.')[0]);
  checks.push({
    label: 'Node.js 20 ou plus',
    verdict: majeur >= 20 ? 'ok' : 'fail',
    detail: `version ${process.versions.node}`,
    fix: 'Installer Node.js 20+ depuis https://nodejs.org',
  });

  const logs = findLogsFolder();
  const provenance = { env: 'BG_TRACKER_LOGS', registry: 'registre Windows', default: 'emplacement par défaut' }[
    logs.source
  ];
  checks.push({
    label: 'Dossier des logs de Hearthstone',
    verdict: logs.exists ? 'ok' : 'fail',
    detail: `${logs.path} (${provenance})`,
    fix: 'Lancer Hearthstone une fois, ou définir BG_TRACKER_LOGS vers son dossier Logs',
  });

  const localAppData = process.env['LOCALAPPDATA'];
  checks.push(
    checkLogConfig(
      localAppData === undefined ? null : lire(join(localAppData, 'Blizzard', 'Hearthstone', 'log.config')),
    ),
  );

  checks.push({
    label: 'Base de cartes (noms, paliers, types)',
    verdict: existsSync(DEFAULT_INDEX_PATH) ? 'ok' : 'fail',
    detail: DEFAULT_INDEX_PATH,
    fix: 'npm run cards',
  });

  checks.push({
    label: 'Cartes du simulateur de combat',
    // Optionnel : sans elles, seule l'estimation de combat manque.
    verdict: existsSync(SIM_CARDS_PATH) ? 'ok' : 'warn',
    detail: SIM_CARDS_PATH,
    fix: 'npm run sim-cards',
  });

  checks.push({
    label: 'Base de données',
    verdict: existsSync(DEFAULT_DB_PATH) ? 'ok' : 'warn',
    detail: existsSync(DEFAULT_DB_PATH) ? DEFAULT_DB_PATH : 'pas encore créée',
    fix: 'npm run sync (après au moins une partie jouée)',
  });

  checks.push({
    label: 'Windows',
    // La lecture memoire et le planificateur de taches sont propres a Windows.
    verdict: process.platform === 'win32' ? 'ok' : 'warn',
    detail: process.platform,
    fix: 'Hearthstone et la lecture de la cote supposent Windows',
  });

  return checks;
}

const SYMBOLE: Record<Verdict, string> = { ok: '✓', warn: '!', fail: '✗' };

function main(): void {
  const checks = runChecks();
  for (const check of checks) {
    console.log(`${SYMBOLE[check.verdict]} ${check.label} — ${check.detail}`);
    if (check.verdict !== 'ok' && check.fix !== undefined) console.log(`    → ${check.fix}`);
  }

  const echecs = checks.filter((c) => c.verdict === 'fail').length;
  console.log();
  console.log(echecs === 0 ? 'Prêt.' : `${echecs} point(s) à corriger avant de jouer.`);
  if (echecs > 0) process.exitCode = 1;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) main();
