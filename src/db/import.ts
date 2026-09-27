/**
 * Import des resumes de partie en base.
 *
 * L'import est **idempotent** : reimporter le meme dossier ne cree pas de
 * doublon. La clef d'une partie est son `GAME_SEED` et son jour de debut, ce
 * qui reste stable qu'on relise le log d'origine ou sa copie archivee.
 */
import { createHeroBaseResolver, stripSkinSuffix, type HeroBaseResolver } from './hero-base.js';
import type { Db } from './database.js';
import type { GameSummary } from '../types.js';

/** Sources de choix connues, pour classer un `pick`. */
const PICK_KINDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^TB_BaconShop_Triples_/, 'triple'],
  [/^BG\d+_Trinket_/, 'trinket'],
];

/**
 * Identifiant stable d'une partie.
 *
 * `GAME_SEED` suffirait presque : il est unique sur toutes les parties
 * observees. Le jour de debut le complete, comme prevu dans
 * docs/ARCHITECTURE.md, pour ecarter toute collision a long terme.
 *
 * Sans seed, on se rabat sur l'horodatage complet, qui reste reproductible.
 */
export function gameId(summary: GameSummary): string {
  const day = summary.startedAt.slice(0, 10);
  return summary.gameSeed === null ? `noseed-${summary.startedAt}` : `${summary.gameSeed}-${day}`;
}

/**
 * Heros normalise par retrait du suffixe de skin.
 *
 * Conserve pour les cas ou la base de cartes n'est pas disponible. Voir
 * `src/db/hero-base.ts` : cette forme est faillible, elle n'est qu'un recours.
 */
export const heroBaseId = stripSkinSuffix;

/**
 * Heros de base d'une partie.
 *
 * Le log donne `BACON_SKIN_PARENT_ID`, la base de cartes
 * `battlegroundsSkinParentId` : les deux menent au meme heros.
 */
export function resolveHeroBaseId(summary: GameSummary, resolve: HeroBaseResolver): string {
  return resolve(summary.heroChosen, summary.heroSkinParentDbfId);
}

/** Classe un choix d'apres la carte qui l'a declenche. */
export function pickKind(sourceCardId: string): string {
  if (sourceCardId.length === 0) return 'other';
  for (const [pattern, kind] of PICK_KINDS) {
    if (pattern.test(sourceCardId)) return kind;
  }
  return 'discover';
}

export interface ImportResult {
  /** Parties ecrites pour la premiere fois. */
  inserted: number;
  /** Parties deja connues, dont la ligne a ete mise a jour. */
  updated: number;
}

/**
 * Ecrit des resumes en base.
 *
 * Une partie deja presente est remplacee : une partie importee alors qu'elle
 * etait encore en cours se completera d'elle-meme au prochain import.
 */
export function importGames(
  db: Db,
  summaries: readonly GameSummary[],
  sourceFolder: string,
): ImportResult {
  const exists = db.prepare('SELECT 1 FROM games WHERE id = ?');
  const resolveHeroBase = createHeroBaseResolver(db);

  const upsertGame = db.prepare(`
    INSERT INTO games (
      id, started_at, ended_at, complete, build_number, game_type, mode,
      player_name, game_seed, hero_card_id, hero_base_id, final_place,
      final_turn, rating_after, source_folder, imported_at
    ) VALUES (
      @id, @startedAt, @endedAt, @complete, @buildNumber, @gameType, NULL,
      @playerName, @gameSeed, @heroCardId, @heroBaseId, @finalPlace,
      @finalTurn, NULL, @sourceFolder, @importedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      started_at    = excluded.started_at,
      ended_at      = excluded.ended_at,
      complete      = excluded.complete,
      build_number  = excluded.build_number,
      game_type     = excluded.game_type,
      player_name   = excluded.player_name,
      game_seed     = excluded.game_seed,
      hero_card_id  = excluded.hero_card_id,
      hero_base_id  = excluded.hero_base_id,
      final_place   = excluded.final_place,
      final_turn    = excluded.final_turn,
      source_folder = excluded.source_folder,
      imported_at   = excluded.imported_at
    -- mode et rating_after ne sont volontairement pas touches : ils ne viennent
    -- pas du log, et un reimport ne doit pas effacer une saisie de l'utilisateur.
  `);

  const clear = {
    heroOffers: db.prepare('DELETE FROM hero_offers WHERE game_id = ?'),
    tierUps: db.prepare('DELETE FROM tier_ups WHERE game_id = ?'),
    picks: db.prepare('DELETE FROM picks WHERE game_id = ?'),
    turns: db.prepare('DELETE FROM turns WHERE game_id = ?'),
    boards: db.prepare('DELETE FROM boards WHERE game_id = ?'),
    decisions: db.prepare('DELETE FROM decisions WHERE game_id = ?'),
    decisionCards: db.prepare('DELETE FROM decision_cards WHERE game_id = ?'),
  };

  // OR REPLACE : un meme cardId propose deux fois au mulligan ne doit pas faire
  // echouer tout l'import.
  const insertHeroOffer = db.prepare(
    'INSERT OR REPLACE INTO hero_offers (game_id, card_id, position, chosen, locked) VALUES (?, ?, ?, ?, ?)',
  );
  const insertTierUp = db.prepare('INSERT INTO tier_ups (game_id, tier, turn) VALUES (?, ?, ?)');
  const insertPick = db.prepare(`
    INSERT INTO picks (game_id, choice_id, turn, source_card, kind, option_card, position, chosen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_id, choice_id, option_card) DO UPDATE SET chosen = MAX(picks.chosen, excluded.chosen)
  `);

  const insertTurn = db.prepare(`
    INSERT INTO turns (game_id, turn, tavern_tier, gold, health, opponent_hero, combat_result, damage_taken)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // OR REPLACE : deux serviteurs ne devraient pas partager une position, mais
  // un plateau incoherent ne doit pas faire echouer tout l'import.
  const insertBoard = db.prepare(`
    INSERT OR REPLACE INTO boards (game_id, turn, position, card_id, atk, health, golden)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertDecision = db.prepare(`
    INSERT INTO decisions (
      game_id, sequence, turn, action, card_id, target_card_id, position,
      gold, tavern_tier, health
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // OR REPLACE : deux cartes ne devraient pas partager une position dans une
  // meme zone, mais un etat incoherent ne doit pas faire echouer l'import.
  const insertDecisionCard = db.prepare(`
    INSERT OR REPLACE INTO decision_cards
      (game_id, sequence, zone, position, card_id, atk, health, golden)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result: ImportResult = { inserted: 0, updated: 0 };

  db.transaction(() => {
    for (const summary of summaries) {
      const id = gameId(summary);
      if (exists.get(id) === undefined) result.inserted += 1;
      else result.updated += 1;

      upsertGame.run({
        id,
        startedAt: summary.startedAt,
        endedAt: summary.endedAt,
        complete: summary.endedAt === null ? 0 : 1,
        buildNumber: summary.buildNumber,
        gameType: summary.gameType,
        playerName: summary.playerName,
        gameSeed: summary.gameSeed,
        heroCardId: summary.heroChosen,
        heroBaseId: resolveHeroBaseId(summary, resolveHeroBase),
        finalPlace: summary.finalPlace,
        finalTurn: summary.finalTurn,
        sourceFolder,
        importedAt: new Date().toISOString(),
      });

      // Les lignes filles sont reecrites entierement : c'est le plus simple
      // pour qu'un reimport plus complet remplace un import partiel.
      clear.heroOffers.run(id);
      clear.tierUps.run(id);
      clear.picks.run(id);
      clear.turns.run(id);
      clear.boards.run(id);
      clear.decisionCards.run(id);
      clear.decisions.run(id);

      summary.heroOffered.forEach((cardId, position) => {
        insertHeroOffer.run(
          id,
          cardId,
          position,
          cardId === summary.heroChosen ? 1 : 0,
          summary.heroLocked.includes(cardId) ? 1 : 0,
        );
      });

      for (const tierUp of summary.tierUps) {
        insertTierUp.run(id, tierUp.tier, tierUp.turn);
      }

      for (const decision of summary.decisions) {
        insertDecision.run(
          id,
          decision.sequence,
          decision.turn,
          decision.action,
          decision.cardId,
          decision.targetCardId,
          decision.position,
          decision.gold,
          decision.tavernTier,
          decision.health,
        );

        for (const [zone, cartes] of [
          ['board', decision.board],
          ['hand', decision.hand],
          ['shop', decision.shop],
        ] as const) {
          for (const minion of cartes) {
            insertDecisionCard.run(
              id,
              decision.sequence,
              zone,
              minion.position,
              minion.cardId,
              minion.atk,
              minion.health,
              minion.golden ? 1 : 0,
            );
          }
        }
      }

      for (const turn of summary.turns) {
        insertTurn.run(
          id,
          turn.turn,
          turn.tavernTier,
          turn.gold,
          turn.health,
          turn.opponentHero,
          turn.combatResult,
          turn.damageTaken,
        );

        for (const minion of turn.board) {
          insertBoard.run(
            id,
            turn.turn,
            minion.position,
            minion.cardId,
            minion.atk,
            minion.health,
            minion.golden ? 1 : 0,
          );
        }
      }

      for (const pick of summary.picks) {
        const kind = pickKind(pick.sourceCardId);
        pick.options.forEach((option, position) => {
          insertPick.run(
            id,
            pick.choiceId,
            pick.turn,
            pick.sourceCardId,
            kind,
            option,
            position,
            option === pick.chosen ? 1 : 0,
          );
        });

        // Le choix retenu n'est pas toujours dans les options listees : une
        // decouverte peut porter sur une carte que le log n'a pas enumeree.
        if (!pick.options.includes(pick.chosen)) {
          insertPick.run(id, pick.choiceId, pick.turn, pick.sourceCardId, kind, pick.chosen, -1, 1);
        }
      }
    }
  })();

  return result;
}
