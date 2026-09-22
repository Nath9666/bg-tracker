import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Les fixtures de log font plusieurs Mo : laisser de la marge au test de reference.
    testTimeout: 60_000,
  },
});
