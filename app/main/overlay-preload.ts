/**
 * Pont de l'overlay et de la saisie de cote.
 *
 * Surface minuscule, comme pour le tableau de bord : aucun acces a Node ni a
 * la base depuis le rendu.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bgOverlay', {
  /** Etat courant, pour l'affichage initial. */
  current: () => ipcRenderer.invoke('live:current'),
  /** S'abonne aux mises a jour de l'etat. */
  onLive: (handler: (payload: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown): void => handler(payload);
    ipcRenderer.on('live', listener);
    return () => ipcRenderer.removeListener('live', listener);
  },
  /** Partie a noter, envoyee a l'ouverture de la fenetre de saisie. */
  onPrompt: (handler: (game: unknown) => void) => {
    const listener = (_event: unknown, game: unknown): void => handler(game);
    ipcRenderer.on('prompt', listener);
    return () => ipcRenderer.removeListener('prompt', listener);
  },
  setRating: (gameId: string, rating: number | null) =>
    ipcRenderer.invoke('live:setRating', gameId, rating),
  closePrompt: () => ipcRenderer.send('live:closePrompt'),
});
