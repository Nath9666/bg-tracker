import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Deux interfaces partagent cette compilation :
 *  - `renderer/` : le tableau de bord ;
 *  - `overlay/`  : la fenetre transparente affichee pendant les parties.
 */
export default defineConfig({
  root: 'app',
  // Chemins relatifs : les fenetres chargent les fichiers par file://.
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/app/ui',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        dashboard: resolve('app/renderer/index.html'),
        overlay: resolve('app/overlay/index.html'),
      },
    },
  },
});
