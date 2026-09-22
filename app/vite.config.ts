import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'app/renderer',
  // Chemins relatifs : la fenetre charge les fichiers par file://.
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/app/renderer',
    emptyOutDir: true,
  },
});
