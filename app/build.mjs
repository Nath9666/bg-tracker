/**
 * Compilation de l'application Electron.
 *
 * esbuild pour le processus principal et le preload (CommonJS, ce qu'Electron
 * charge le plus simplement), Vite pour le rendu React.
 */
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';

const OUT = 'dist/app';

await rm(OUT, { recursive: true, force: true });

await build({
  entryPoints: { main: 'app/main/main.ts', preload: 'app/main/preload.ts' },
  outdir: OUT,
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  // Electron fournit son propre runtime ; better-sqlite3 est un module natif,
  // il doit rester charge depuis node_modules.
  external: ['electron', 'better-sqlite3'],
  logLevel: 'info',
});
