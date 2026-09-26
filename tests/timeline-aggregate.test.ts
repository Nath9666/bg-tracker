import { describe, expect, it } from 'vitest';
import { aggregateTimeline, type TimelinePoint } from '../src/stats/stats.js';

function point(over: Partial<TimelinePoint> & { startedAt: string }): TimelinePoint {
  return {
    gameId: over.startedAt,
    heroName: 'Cariel Roame',
    heroCardId: 'BG21_HERO_000',
    heroBaseId: 'BG21_HERO_000',
    place: 4,
    rating: 8000,
    rollingPlace: 4,
    ...over,
  };
}

const PARTIES: TimelinePoint[] = [
  point({ startedAt: '2026-08-31T22:00:00.000+02:00', place: 2, rating: 7900 }),
  point({ startedAt: '2026-09-20T01:00:00.000+02:00', place: 1, rating: 8000 }),
  point({ startedAt: '2026-09-20T23:30:00.000+02:00', place: 5, rating: 7950 }),
  point({ startedAt: '2026-09-21T01:00:00.000+02:00', place: 3, rating: 8100 }),
];

describe('aggregateTimeline', () => {
  it('ne regroupe rien par partie, et garde la moyenne glissante', () => {
    const points = aggregateTimeline(PARTIES, 'game');

    expect(points).toHaveLength(4);
    expect(points[0]).toMatchObject({ games: 1, rating: 7900, averagePlace: 4 });
    expect(points.map((p) => p.key)).toEqual(PARTIES.map((p) => p.gameId));
  });

  it('regroupe par jour', () => {
    const jours = aggregateTimeline(PARTIES, 'day');

    expect(jours.map((j) => j.key)).toEqual(['2026-08-31', '2026-09-20', '2026-09-21']);
    expect(jours[1]).toMatchObject({ games: 2, averagePlace: 3 });
  });

  it('regroupe par mois et par annee', () => {
    expect(aggregateTimeline(PARTIES, 'month').map((m) => m.key)).toEqual(['2026-08', '2026-09']);
    expect(aggregateTimeline(PARTIES, 'year').map((a) => a.key)).toEqual(['2026']);
    expect(aggregateTimeline(PARTIES, 'year')[0]?.games).toBe(4);
  });

  it('retient la derniere cote de la periode, pas la moyenne', () => {
    // Une cote est un solde : la moyenner n'aurait pas de sens.
    const [septembre] = aggregateTimeline(PARTIES.slice(1), 'month');
    expect(septembre?.rating).toBe(8100);
  });

  it('garde le fuseau local pour decider du jour', () => {
    // 22h00 le 31/08 en heure locale reste le 31/08, meme si c'est deja le
    // 1er septembre en UTC.
    expect(aggregateTimeline([PARTIES[0]!], 'day')[0]?.key).toBe('2026-08-31');
  });

  it('accepte une periode sans cote saisie', () => {
    const sansCote = aggregateTimeline(
      [point({ startedAt: '2026-09-22T01:00:00.000+02:00', rating: null })],
      'day',
    );

    expect(sansCote[0]).toMatchObject({ rating: null, averagePlace: 4 });
  });

  it('accepte une periode sans place, partie inachevee', () => {
    const inachevee = aggregateTimeline(
      [point({ startedAt: '2026-09-22T01:00:00.000+02:00', place: null })],
      'day',
    );

    expect(inachevee[0]).toMatchObject({ averagePlace: null, games: 1 });
  });

  it('prend la cote de la derniere partie notee, meme suivie d’une sans cote', () => {
    const jour = aggregateTimeline(
      [
        point({ startedAt: '2026-09-22T01:00:00.000+02:00', rating: 8200 }),
        point({ startedAt: '2026-09-22T02:00:00.000+02:00', rating: null }),
      ],
      'day',
    );

    expect(jour[0]?.rating).toBe(8200);
  });

  it('rend une liste vide sans partie', () => {
    expect(aggregateTimeline([], 'day')).toEqual([]);
    expect(aggregateTimeline([], 'game')).toEqual([]);
  });
});
