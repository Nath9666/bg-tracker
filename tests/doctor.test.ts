import { describe, expect, it } from 'vitest';
import { checkLogConfig, runChecks } from '../src/cli/doctor.js';

const BON = `[Achievements]
LogLevel=1
FilePrinting=True
[Power]
LogLevel=1
FilePrinting=True
ConsolePrinting=False
ScreenPrinting=False
Verbose=True
`;

describe('checkLogConfig', () => {
  it('accepte la configuration de reference', () => {
    expect(checkLogConfig(BON).verdict).toBe('ok');
  });

  it('refuse un fichier absent', () => {
    expect(checkLogConfig(null)).toMatchObject({ verdict: 'fail', detail: 'fichier absent' });
  });

  it('refuse sans section [Power]', () => {
    expect(checkLogConfig('[Arena]\nFilePrinting=True\n').detail).toBe('section [Power] absente');
  });

  it('refuse sans Verbose, meme si le jeu ecrit le fichier', () => {
    // Le jeu ecrit alors Power.log, mais sans les tags dont le parseur a besoin.
    expect(checkLogConfig(BON.replace('Verbose=True', 'Verbose=False')).verdict).toBe('fail');
  });

  it('ne se laisse pas tromper par le Verbose d’une autre section', () => {
    const piege = '[Power]\nFilePrinting=True\nVerbose=False\n[Arena]\nVerbose=True\n';
    expect(checkLogConfig(piege).verdict).toBe('fail');
  });

  it('accepte des fins de ligne Windows', () => {
    expect(checkLogConfig(BON.replace(/\n/g, '\r\n')).verdict).toBe('ok');
  });
});

describe('runChecks', () => {
  it('donne un correctif a chaque point', () => {
    const checks = runChecks();
    expect(checks.length).toBeGreaterThanOrEqual(6);
    expect(checks.every((c) => c.verdict === 'ok' || c.fix !== undefined)).toBe(true);
  });
});
