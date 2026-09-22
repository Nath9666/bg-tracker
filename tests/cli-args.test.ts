import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../src/cli/parse.js';

describe('parseCliArgs', () => {
  it('lit un dossier seul', () => {
    expect(parseCliArgs(['fixtures/sample-game-1'])).toEqual({
      folder: 'fixtures/sample-game-1',
      json: false,
    });
  });

  it('reconnait --json, quelle que soit sa position', () => {
    expect(parseCliArgs(['--json', 'fixtures/sample-game-1'])).toEqual({
      folder: 'fixtures/sample-game-1',
      json: true,
    });
  });

  it('refuse une ligne de commande sans dossier', () => {
    expect(() => parseCliArgs([])).toThrow(/Usage/);
  });

  it('refuse une option inconnue', () => {
    expect(() => parseCliArgs(['dossier', '--verbose'])).toThrow(/Option inconnue/);
  });

  it('refuse plusieurs dossiers', () => {
    expect(() => parseCliArgs(['a', 'b'])).toThrow(/un seul dossier/i);
  });
});
