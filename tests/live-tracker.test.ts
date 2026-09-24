import { describe, expect, it } from 'vitest';
import { LiveTracker, emptyState } from '../src/live/live-tracker.js';
import { extractGames } from '../src/extract/game-extractor.js';
import { readSessionLines } from '../src/reader/session-reader.js';
import { sampleSessionFolder } from './helpers/sample-session.js';

function power(body: string, time = '02:48:30.3211164'): string {
  return `D ${time} GameState.DebugPrintPower() - ${body}`;
}

const OPENING = [
  power('CREATE_GAME'),
  power('    GameEntity EntityID=19'),
  power('    Player EntityID=20 PlayerID=7 GameAccountId=[hi=1 lo=1]'),
  power('    Player EntityID=21 PlayerID=15 GameAccountId=[hi=0 lo=0]'),
  'D 02:48:30.3211164 GameState.DebugPrintGame() - GameType=GT_BATTLEGROUNDS',
  'D 02:48:30.3211164 GameState.DebugPrintGame() - PlayerID=7, PlayerName=AkiLif#2498',
  power('TAG_CHANGE Entity=AkiLif#2498 tag=HERO_ENTITY value=89'),
  power('FULL_ENTITY - Creating ID=89 CardID=BG22_HERO_000_SKIN_A'),
  power('        tag=HEALTH value=30'),
  power('FULL_ENTITY - Creating ID=80 CardID=TB_BaconShopBob'),
  power('TAG_CHANGE Entity=Bob le barman tag=HERO_ENTITY value=80'),
];

/** Serviteur sur le plateau d'un joueur. */
function minion(id: number, cardId: string, controller: number, position: number): string[] {
  return [
    power(`FULL_ENTITY - Creating ID=${id} CardID=${cardId}`),
    power('        tag=CARDTYPE value=MINION'),
    power(`        tag=CONTROLLER value=${controller}`),
    power('        tag=ZONE value=PLAY'),
    power(`        tag=ZONE_POSITION value=${position}`),
    power('        tag=ATK value=3'),
    power('        tag=HEALTH value=2'),
  ];
}

function tracker(lines: string[]): LiveTracker {
  const live = new LiveTracker();
  for (const line of lines) live.pushLine(line);
  return live;
}

describe('etat initial', () => {
  it('ne pretend rien savoir avant la premiere partie', () => {
    expect(new LiveTracker().state).toEqual(emptyState());
    expect(new LiveTracker().state.inGame).toBe(false);
  });

  it('remet tout a zero en changeant de session', () => {
    const live = tracker([...OPENING, power('TAG_CHANGE Entity=GameEntity tag=TURN value=5')]);
    live.setSession('Hearthstone_2026_09_23_09_00_00');

    expect(live.state).toEqual({ ...emptyState(), session: 'Hearthstone_2026_09_23_09_00_00' });
  });
});

describe('suivi du joueur', () => {
  it('suit le tour, le palier, l’or et les points de vie', () => {
    const live = tracker([
      ...OPENING,
      power('TAG_CHANGE Entity=GameEntity tag=TURN value=9'),
      power('TAG_CHANGE Entity=AkiLif#2498 tag=RESOURCES value=8'),
      power('TAG_CHANGE Entity=89 tag=PLAYER_TECH_LEVEL value=3'),
      power('TAG_CHANGE Entity=89 tag=ARMOR value=5'),
      power('TAG_CHANGE Entity=89 tag=PLAYER_LEADERBOARD_PLACE value=2'),
    ]);

    expect(live.state).toMatchObject({
      inGame: true,
      turn: 5,
      gold: 8,
      tavernTier: 3,
      health: 35,
      place: 2,
      heroCardId: 'BG22_HERO_000_SKIN_A',
    });
  });

  it('tient le plateau du joueur, sans celui d’en face', () => {
    const live = tracker([
      ...OPENING,
      ...minion(301, 'BG28_300', 7, 1),
      ...minion(302, 'BG36_760', 15, 1),
      power('TAG_CHANGE Entity=89 tag=ARMOR value=0'),
    ]);

    expect(live.state.board.map((m) => m.cardId)).toEqual(['BG28_300']);
  });
});

describe('combats', () => {
  const COMBAT = [
    power('TAG_CHANGE Entity=GameEntity tag=TURN value=4'),
    power('FULL_ENTITY - Creating ID=500 CardID=BG30_HERO_304'),
    power('TAG_CHANGE Entity=GameEntity tag=BACON_IN_COMBAT_PHASE value=1'),
    power('TAG_CHANGE Entity=Bob le barman tag=HERO_ENTITY value=500'),
  ];
  const FIN = [
    power('TAG_CHANGE Entity=Bob le barman tag=HERO_ENTITY value=80'),
    power('TAG_CHANGE Entity=GameEntity tag=BACON_IN_COMBAT_PHASE value=0'),
  ];

  it('signale la phase en cours', () => {
    expect(tracker([...OPENING, ...COMBAT]).state.phase).toBe('combat');
    expect(tracker([...OPENING, ...COMBAT, ...FIN]).state.phase).toBe('recruit');
  });

  it('retient l’adversaire, l’issue et les degats', () => {
    const live = tracker([
      ...OPENING,
      ...COMBAT,
      power('TAG_CHANGE Entity=89 tag=DAMAGE value=6'),
      ...FIN,
    ]);

    expect(live.state.combats).toEqual([
      { turn: 2, opponentHero: 'BG30_HERO_304', result: 'loss', damageTaken: 6 },
    ]);
  });

  it('fige le plateau adverse a la premiere attaque', () => {
    // Le plateau d'en face se remplit pendant la phase : avant la premiere
    // attaque il est encore incomplet.
    const live = tracker([
      ...OPENING,
      ...COMBAT,
      ...minion(600, 'BG35_143', 15, 1),
      ...minion(601, 'BG25_016', 15, 2),
      power('TAG_CHANGE Entity=600 tag=ATTACKING value=1'),
      // Arrive apres l'attaque : ne doit pas entrer dans le plateau retenu.
      ...minion(602, 'BG27_080', 15, 3),
      ...FIN,
    ]);

    expect(live.state.opponents).toHaveLength(1);
    expect(live.state.opponents[0]?.board.map((m) => m.cardId)).toEqual(['BG35_143', 'BG25_016']);
  });

  it('publie les deux plateaux du combat, figes a la premiere attaque', () => {
    const live = tracker([
      ...OPENING,
      ...minion(700, 'BG26_888', 7, 1),
      ...COMBAT,
      ...minion(600, 'BG35_143', 15, 1),
      power('TAG_CHANGE Entity=600 tag=ATTACKING value=1'),
    ]);

    const combat = live.state.currentCombat;
    expect(combat).not.toBeNull();
    expect(combat?.opponentHero).toBe('BG30_HERO_304');
    expect(combat?.opponentBoard.map((m) => m.cardId)).toEqual(['BG35_143']);
    expect(combat?.playerBoard.map((m) => m.cardId)).toEqual(['BG26_888']);
  });

  it('ne publie rien avant que le plateau adverse soit revele', () => {
    // Au tout debut du combat, le plateau d'en face n'existe pas encore :
    // estimer a ce moment-la donnerait un combat contre du vide.
    const live = tracker([...OPENING, ...minion(700, 'BG26_888', 7, 1), ...COMBAT]);

    expect(live.state.phase).toBe('combat');
    expect(live.state.currentCombat).toBeNull();
  });

  it('ne laisse pas le combat degrader les plateaux publies', () => {
    const live = tracker([
      ...OPENING,
      ...minion(700, 'BG26_888', 7, 1),
      ...COMBAT,
      ...minion(600, 'BG35_143', 15, 1),
      power('TAG_CHANGE Entity=600 tag=ATTACKING value=1'),
      // Le combat se deroule : les serviteurs encaissent puis disparaissent.
      power('TAG_CHANGE Entity=700 tag=DAMAGE value=2'),
      power('TAG_CHANGE Entity=700 tag=ZONE value=GRAVEYARD'),
    ]);

    const combat = live.state.currentCombat;
    expect(combat?.playerBoard.map((m) => m.cardId)).toEqual(['BG26_888']);
    expect(combat?.playerBoard[0]?.damage).toBe(0);
  });

  it('garde le combat affichable apres sa fin', () => {
    // Un combat dure une dizaine de secondes. Effacer les plateaux a la fin
    // ferait disparaitre l'estimation avant qu'elle soit lue.
    const live = tracker([
      ...OPENING,
      ...COMBAT,
      ...minion(600, 'BG35_143', 15, 1),
      power('TAG_CHANGE Entity=600 tag=ATTACKING value=1'),
      ...FIN,
    ]);

    expect(live.state.phase).toBe('recruit');
    expect(live.state.currentCombat?.opponentBoard.map((m) => m.cardId)).toEqual(['BG35_143']);
  });

  it('efface le combat precedent des que le suivant commence', () => {
    const suivant = [
      power('TAG_CHANGE Entity=GameEntity tag=TURN value=6'),
      power('FULL_ENTITY - Creating ID=501 CardID=BG34_HERO_001'),
      power('TAG_CHANGE Entity=GameEntity tag=BACON_IN_COMBAT_PHASE value=1'),
      power('TAG_CHANGE Entity=Bob le barman tag=HERO_ENTITY value=501'),
    ];
    const live = tracker([
      ...OPENING,
      ...COMBAT,
      ...minion(600, 'BG35_143', 15, 1),
      power('TAG_CHANGE Entity=600 tag=ATTACKING value=1'),
      ...FIN,
      ...suivant,
    ]);

    // Le plateau d'en face n'est pas encore revele : ne rien montrer plutot
    // que de montrer celui du combat precedent.
    expect(live.state.currentCombat).toBeNull();
  });

  it('ne prend pas Bob pour un adversaire', () => {
    const live = tracker([...OPENING, ...COMBAT, ...FIN]);
    expect(live.state.opponents[0]?.heroCardId).toBe('BG30_HERO_304');
  });

  it('remonte l’adversaire le plus recemment affronte en tete', () => {
    const autre = [
      power('TAG_CHANGE Entity=GameEntity tag=TURN value=6'),
      power('FULL_ENTITY - Creating ID=501 CardID=BG34_HERO_001'),
      power('TAG_CHANGE Entity=GameEntity tag=BACON_IN_COMBAT_PHASE value=1'),
      power('TAG_CHANGE Entity=Bob le barman tag=HERO_ENTITY value=501'),
    ];
    const live = tracker([...OPENING, ...COMBAT, ...FIN, ...autre, ...FIN]);

    expect(live.state.opponents.map((o) => o.heroCardId)).toEqual([
      'BG34_HERO_001',
      'BG30_HERO_304',
    ]);
  });

  it('ne garde qu’une fiche par adversaire, mise a jour', () => {
    const encore = [
      power('TAG_CHANGE Entity=GameEntity tag=TURN value=8'),
      power('TAG_CHANGE Entity=GameEntity tag=BACON_IN_COMBAT_PHASE value=1'),
      power('TAG_CHANGE Entity=Bob le barman tag=HERO_ENTITY value=500'),
    ];
    const live = tracker([...OPENING, ...COMBAT, ...FIN, ...encore, ...FIN]);

    expect(live.state.opponents).toHaveLength(1);
    expect(live.state.opponents[0]?.lastFoughtTurn).toBe(4);
  });

  it('cloture le dernier combat quand le joueur est elimine', () => {
    const live = tracker([
      ...OPENING,
      ...COMBAT,
      power('TAG_CHANGE Entity=89 tag=DAMAGE value=30'),
      power('TAG_CHANGE Entity=GameEntity tag=STATE value=COMPLETE'),
    ]);

    expect(live.state.inGame).toBe(false);
    expect(live.state.combats).toHaveLength(1);
    expect(live.state.combats[0]).toMatchObject({ result: 'loss', damageTaken: 30 });
  });
});

describe('rythme de paliers', () => {
  it('retient le tour de chaque montee', () => {
    const live = tracker([
      ...OPENING,
      power('TAG_CHANGE Entity=GameEntity tag=TURN value=3'),
      power('TAG_CHANGE Entity=89 tag=PLAYER_TECH_LEVEL value=2'),
      power('TAG_CHANGE Entity=GameEntity tag=TURN value=9'),
      power('TAG_CHANGE Entity=89 tag=PLAYER_TECH_LEVEL value=3'),
    ]);

    expect(live.state.tierUps).toEqual([
      { tier: 2, turn: 2 },
      { tier: 3, turn: 5 },
    ]);
  });

  it('ne compte pas le palier 1 de depart', () => {
    const live = tracker([
      ...OPENING,
      power('TAG_CHANGE Entity=GameEntity tag=TURN value=1'),
      power('TAG_CHANGE Entity=89 tag=PLAYER_TECH_LEVEL value=1'),
    ]);

    expect(live.state.tierUps).toEqual([]);
  });

  it('ignore le PLAYER_TECH_LEVEL des autres entites', () => {
    // Piege connu : les copies de heros adverses recoivent aussi ce tag.
    const live = tracker([
      ...OPENING,
      power('TAG_CHANGE Entity=GameEntity tag=TURN value=3'),
      power('FULL_ENTITY - Creating ID=444 CardID=TB_BaconShop_HERO_16'),
      power('TAG_CHANGE Entity=444 tag=PLAYER_TECH_LEVEL value=6'),
    ]);

    expect(live.state.tierUps).toEqual([]);
  });
});

describe('prochain adversaire', () => {
  /** Le jeu annonce le prochain adversaire par son PLAYER_ID. */
  const ANNONCE = (playerId: number): string =>
    power(`TAG_CHANGE Entity=89 tag=NEXT_OPPONENT_PLAYER_ID value=${playerId}`);

  /** Une entite heros portant son PLAYER_ID : c'est ce qui permet de le nommer. */
  const HEROS_ADVERSE = (id: number, cardId: string, playerId: number): string[] => [
    power(`FULL_ENTITY - Creating ID=${id} CardID=${cardId}`),
    power('        tag=CARDTYPE value=HERO'),
    power(`TAG_CHANGE Entity=${id} tag=PLAYER_ID value=${playerId}`),
  ];

  it('nomme l’adversaire annonce', () => {
    const live = tracker([
      ...OPENING,
      ...HEROS_ADVERSE(500, 'BG30_HERO_304', 6),
      ANNONCE(6),
    ]);

    expect(live.state.nextOpponentHero).toBe('BG30_HERO_304');
  });

  it('reste muet tant que le heros de ce joueur est inconnu', () => {
    // Debut de partie : le lobby n'est decouvert qu'au fil des combats.
    expect(tracker([...OPENING, ANNONCE(6)]).state.nextOpponentHero).toBeNull();
  });

  it('resout l’annonce des que le heros devient connu', () => {
    const live = tracker([
      ...OPENING,
      ANNONCE(6),
      ...HEROS_ADVERSE(500, 'BG30_HERO_304', 6),
    ]);

    expect(live.state.nextOpponentHero).toBe('BG30_HERO_304');
  });

  it('ne se designe jamais soi-meme', () => {
    const live = tracker([
      ...OPENING,
      power('TAG_CHANGE Entity=89 tag=PLAYER_ID value=7'),
      ANNONCE(7),
    ]);

    expect(live.state.nextOpponentHero).toBeNull();
  });

  it('suit les annonces successives', () => {
    const lignes = [
      ...OPENING,
      ...HEROS_ADVERSE(500, 'BG30_HERO_304', 6),
      ...HEROS_ADVERSE(501, 'BG34_HERO_001', 5),
      ANNONCE(6),
    ];
    expect(tracker(lignes).state.nextOpponentHero).toBe('BG30_HERO_304');
    expect(tracker([...lignes, ANNONCE(5)]).state.nextOpponentHero).toBe('BG34_HERO_001');
  });
});

describe('partie de reference', () => {
  it('reconstitue les 13 combats et les 7 adversaires', async () => {
    const live = new LiveTracker();
    for await (const line of readSessionLines(await sampleSessionFolder())) live.pushLine(line);

    const state = live.state;
    expect(state.inGame).toBe(false);
    expect(state.turn).toBe(13);
    expect(state.heroCardId).toBe('BG22_HERO_000_SKIN_A');
    expect(state.place).toBe(3);

    expect(state.combats).toHaveLength(13);
    expect(state.combats.at(-1)).toMatchObject({ turn: 13, result: 'loss' });

    // Les 7 adversaires du lobby, chacun avec son plateau et son palier.
    expect(state.opponents).toHaveLength(7);
    expect(state.opponents.every((o) => o.board.length > 0)).toBe(true);
    expect(state.opponents.every((o) => o.tier !== null)).toBe(true);
    expect(state.opponents.every((o) => o.place !== null)).toBe(true);

    // Le plus recemment affronte est celui du dernier combat.
    expect(state.opponents[0]?.heroCardId).toBe(state.combats.at(-1)?.opponentHero);
    expect(state.opponents[0]?.lastFoughtTurn).toBe(13);

    // Les memes montees que l'extraction hors ligne.
    expect(state.tierUps).toEqual([
      { tier: 2, turn: 2 },
      { tier: 3, turn: 5 },
      { tier: 4, turn: 7 },
      { tier: 5, turn: 10 },
    ]);
  });

  it('annonce le bon adversaire avant chaque combat', async () => {
    // Le jeu annonce le prochain adversaire par son PLAYER_ID ; on verifie que
    // la traduction en heros correspond bien au combat qui suit.
    const live = new LiveTracker();
    const annonces = new Map<number, string>();

    for await (const line of readSessionLines(await sampleSessionFolder())) {
      live.pushLine(line);
      const state = live.state;

      // On retient l'annonce faite pendant le recrutement du tour.
      if (state.phase === 'recruit' && state.nextOpponentHero !== null && state.turn !== null) {
        annonces.set(state.turn, state.nextOpponentHero);
      }
    }

    // Les annonces disponibles doivent toutes tomber juste.
    const verifiees = live.state.combats.filter((combat) => annonces.has(combat.turn));
    expect(verifiees.length).toBeGreaterThan(0);
    for (const combat of verifiees) {
      expect(annonces.get(combat.turn)).toBe(combat.opponentHero);
    }
  });
});

describe('bonus cumules', () => {
  const JOUEUR = 'AkiLif#2498';

  it('ne montre rien en debut de partie', () => {
    expect(tracker(OPENING).state.bonuses).toEqual([]);
  });

  it('releve les gemmes de sang, qui s’accumulent', () => {
    const live = tracker([
      ...OPENING,
      power(`TAG_CHANGE Entity=${JOUEUR} tag=BACON_BLOODGEMBUFFATKVALUE value=2`),
      power(`TAG_CHANGE Entity=${JOUEUR} tag=BACON_BLOODGEMBUFFHEALTHVALUE value=1`),
      power(`TAG_CHANGE Entity=${JOUEUR} tag=BACON_BLOODGEMBUFFATKVALUE value=3`),
    ]);

    expect(live.state.bonuses).toEqual([
      { key: 'bloodGem', label: 'Gemme de sang', value: '+3/+1' },
    ]);
  });

  it('releve l’or du tour suivant et les actualisations offertes', () => {
    const live = tracker([
      ...OPENING,
      power(`TAG_CHANGE Entity=${JOUEUR} tag=BACON_PLAYER_EXTRA_GOLD_NEXT_TURN value=2`),
      power(`TAG_CHANGE Entity=${JOUEUR} tag=BACON_FREE_REFRESH_COUNT value=1`),
    ]);

    expect(live.state.bonuses.map((b) => `${b.key} ${b.value}`)).toEqual([
      'extraGold +2',
      'freeRefresh 1',
    ]);
  });

  it('compte les rales d’agonie en declenchements, pas en supplements', () => {
    // `ADDITIONAL` vaut le nombre de declenchements **en plus** du premier.
    const live = tracker([
      ...OPENING,
      power(`TAG_CHANGE Entity=${JOUEUR} tag=EXTRA_DEATHRATTLES_ADDITIONAL value=1`),
    ]);

    expect(live.state.bonuses[0]).toEqual({
      key: 'deathrattles',
      label: 'Râles d’agonie',
      value: 'x2',
    });
  });

  it('retire un bonus retombe a zero', () => {
    // L'or supplementaire est consomme au tour suivant : le jeu remet le tag
    // a zero, la barre doit se vider.
    const live = tracker([
      ...OPENING,
      power(`TAG_CHANGE Entity=${JOUEUR} tag=BACON_PLAYER_EXTRA_GOLD_NEXT_TURN value=2`),
      power(`TAG_CHANGE Entity=${JOUEUR} tag=BACON_PLAYER_EXTRA_GOLD_NEXT_TURN value=0`),
    ]);

    expect(live.state.bonuses).toEqual([]);
  });

  it('ignore les bonus des adversaires', () => {
    // Les adversaires portent les memes tags : seuls les notres comptent.
    const live = tracker([
      ...OPENING,
      power('TAG_CHANGE Entity=Icenberg tag=BACON_BLOODGEMBUFFATKVALUE value=9'),
    ]);

    expect(live.state.bonuses).toEqual([]);
  });
});

describe('serviteurs vus', () => {
  // L'or bouge a chaque achat et a chaque debut de tour : c'est ce qui
  // declenche le releve de la taverne.
  const OR = power('TAG_CHANGE Entity=AkiLif#2498 tag=RESOURCES value=3');

  it('retient la taverne de Bob, hors combat', () => {
    // La zone du mandataire est la taverne hors combat : c'est la meilleure
    // source de types, cinq a sept serviteurs renouveles par tour.
    const live = tracker([...OPENING, ...minion(800, 'BG31_149', 15, 1), OR]);
    expect(live.state.seenCardIds).toContain('BG31_149');
  });

  it('ne prend pas le plateau adverse pour la taverne', () => {
    // Pendant un combat, la meme zone porte le plateau d'en face : ses
    // serviteurs ne disent rien du pool de la taverne.
    const live = tracker([
      ...OPENING,
      power('TAG_CHANGE Entity=GameEntity tag=BACON_IN_COMBAT_PHASE value=1'),
      ...minion(801, 'BG30_155', 15, 1),
      OR,
    ]);

    expect(live.state.seenCardIds).not.toContain('BG30_155');
  });

  it('oublie tout a la partie suivante', () => {
    // Sans ca, les types s'accumuleraient de partie en partie et le lobby
    // finirait par sembler contenir les onze types.
    const live = new LiveTracker();
    for (const ligne of [...OPENING, ...minion(800, 'BG31_149', 15, 1), OR]) live.pushLine(ligne);
    expect(live.state.seenCardIds).toContain('BG31_149');

    for (const ligne of OPENING) live.pushLine(ligne);
    expect(live.state.seenCardIds).toEqual([]);
  });

  it('oublie tout en changeant de session', () => {
    const live = new LiveTracker();
    for (const ligne of [...OPENING, ...minion(800, 'BG31_149', 15, 1), OR]) live.pushLine(ligne);

    live.setSession('autre');
    expect(live.state.seenCardIds).toEqual([]);
  });
});

describe('heros proposes', () => {
  it('releve les memes heros que l’extraction hors ligne, puis s’efface au choix', async () => {
    const dossier = await sampleSessionFolder();

    const [partie] = await (async () => {
      const parties = [];
      for await (const s of extractGames(readSessionLines(dossier), {
        sessionDate: new Date(2026, 8, 19, 2, 47, 25),
      })) {
        parties.push(s);
      }
      return parties;
    })();

    const live = new LiveTracker();
    let vus: string[] = [];
    for await (const line of readSessionLines(dossier)) {
      live.pushLine(line);
      if (live.state.heroOffers.length > vus.length) vus = live.state.heroOffers;
    }

    expect(vus.length).toBeGreaterThanOrEqual(2);
    expect([...vus].sort()).toEqual([...(partie?.heroOffered ?? [])].sort());
    // Une fois le heros choisi, le panneau d'aide n'a plus lieu d'etre.
    expect(live.state.heroOffers).toEqual([]);
  });

  it('ignore les decouvertes, qui ne sont pas un choix de heros', () => {
    const live = tracker([
      ...OPENING,
      power('Player=AkiLif#2498 id=5 ChoiceType=GENERAL'),
    ]);
    expect(live.state.heroOffers).toEqual([]);
  });
});
