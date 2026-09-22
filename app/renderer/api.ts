/**
 * Acces aux donnees depuis le rendu.
 *
 * Le pont du preload est la seule porte : pas de Node, pas de SQLite ici.
 */
import type { StatsFilters } from '../../src/stats/stats.js';
import type { Dashboard } from '../main/main.js';

interface Bridge {
  dashboard: (filters: StatsFilters) => Promise<Dashboard>;
}

declare global {
  interface Window {
    bgTracker: Bridge;
  }
}

export type { Dashboard, StatsFilters };

export function loadDashboard(filters: StatsFilters): Promise<Dashboard> {
  return window.bgTracker.dashboard(filters);
}
