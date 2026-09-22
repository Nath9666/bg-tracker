/**
 * Acces aux donnees depuis le rendu.
 *
 * Le pont du preload est la seule porte : pas de Node, pas de SQLite ici.
 */
import type { StatsFilters } from '../../src/stats/stats.js';
import type { Dashboard } from '../main/main.js';

interface Bridge {
  dashboard: (filters: StatsFilters) => Promise<Dashboard>;
  setRating: (gameId: string, rating: number | null) => Promise<void>;
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

/** Enregistre la cote d'une partie. `null` l'efface. */
export function saveRating(gameId: string, rating: number | null): Promise<void> {
  return window.bgTracker.setRating(gameId, rating);
}
