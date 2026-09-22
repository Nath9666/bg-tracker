/**
 * Pont entre le processus principal et le rendu.
 *
 * Le rendu n'a ni Node ni acces direct a la base : il ne voit que cette
 * surface, volontairement minuscule.
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bgTracker', {
  dashboard: (filters: unknown) => ipcRenderer.invoke('dashboard', filters),
});
