/**
 * Compilation de l'application Electron.
 *
 * esbuild pour les processus principaux et les preloads (CommonJS, ce
 * qu'Electron charge le plus simplement), Vite pour les interfaces React.
 */
import { build } from 'esbuild';
import { cp, rm } from 'node:fs/promises';

const OUT = 'dist/app';

await rm(OUT, { recursive: true, force: true });

await build({
  entryPoints: {
    // Un seul programme : overlay, tableau de bord et icone pres de l'horloge.
    app: 'app/main/app-main.ts',
    preload: 'app/main/preload.ts',
    'overlay-preload': 'app/main/overlay-preload.ts',
    // Taches longues (sync, telechargements), dans un processus a part.
    worker: 'app/main/worker.ts',
  },
  outdir: OUT,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  // Electron fournit son propre runtime ; better-sqlite3 et koffi sont natifs,
  // il doit rester charge depuis node_modules.
  external: ['electron', 'better-sqlite3', 'koffi'],
  logLevel: 'info',
});

// Icones de la zone de notification et de l'installateur.
await cp('app/assets', `${OUT}/assets`, { recursive: true });
