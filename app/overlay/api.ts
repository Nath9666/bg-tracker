/** Acces aux donnees depuis l'overlay, via le pont du preload. */
import type { OverlayPayload, RatingPrompt } from '../main/overlay-main.js';

interface Bridge {
  current: () => Promise<OverlayPayload | null>;
  onLive: (handler: (payload: OverlayPayload) => void) => () => void;
  onPrompt: (handler: (game: RatingPrompt) => void) => () => void;
  setRating: (gameId: string, rating: number | null) => Promise<void>;
  closePrompt: () => void;
}

declare global {
  interface Window {
    bgOverlay: Bridge;
  }
}

export type { OverlayPayload, RatingPrompt };

export const bridge = (): Bridge => window.bgOverlay;
