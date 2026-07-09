/**
 * Signal filters — cut proven leak categories while staying on the board.
 */

import { isSoccer } from "./research-extra.mjs";

export function recoveryPhase(stats, strategy) {
  const roi = (stats.roiPct ?? 0) / 100;
  if (roi <= (strategy.survivalRoiThreshold ?? -0.25)) return "survival";
  if (roi < (strategy.climbRoiThreshold ?? 0)) return "climb";
  return "press";
}

function hoursUntil(gameTime) {
  if (!gameTime) return 0;
  return (new Date(gameTime).getTime() - Date.now()) / 3_600_000;
}

/**
 * Returns skip reason string, or null if the signal should be played.
 */
export function shouldSkipSignal(propSignal, research, stats, strategy, openCount) {
  const phase = recoveryPhase(stats, strategy);
  const roi = (stats.roiPct ?? 0) / 100;
  const sport = propSignal.sport;
  const strength = propSignal.edgeStrength;
  const conf = propSignal.confidence ?? 0;
  const suggested = propSignal.suggestedAction ?? propSignal.agentHints?.suggestedAction;

  if (isSoccer(sport)) {
    if (strength === "STRONG") return "soccer_strong_banned";
    if (phase !== "press") return "soccer_banned_recovery";
    if (conf < (strategy.soccerMinConfidence ?? 45)) return "soccer_low_confidence";
    if (suggested === "skip") return "edge_suggested_skip";
  }

  if (sport === "nhl") {
    const maxHours = strategy.nhlMaxHoursAhead ?? 72;
    if (hoursUntil(propSignal.gameTime) > maxHours) return "nhl_too_far_ahead";
  }

  if (sport === "nba" && phase === "survival" && strength !== "STRONG") {
    return "nba_moderate_banned_survival";
  }

  if (phase === "survival" && strength === "MODERATE") {
    if (suggested === "skip") return "edge_suggested_skip";
    if (conf < (strategy.survivalModerateMinConfidence ?? 52)) return "moderate_low_conf_survival";
    if (sport !== "mlb" && sport !== "nba") return "non_core_sport_survival";
  }

  if (phase === "climb" && strength === "MODERATE" && suggested === "skip" && conf < 50) {
    return "edge_suggested_skip";
  }

  const maxOpen = strategy.maxOpenPositions ?? 14;
  if (openCount >= maxOpen && hoursUntil(propSignal.gameTime) > 24) {
    return "max_open_far_games";
  }

  if (research?.espn?.skip) return "espn_game_final";

  if (
    phase === "survival" &&
    strength === "STRONG" &&
    research?.espn &&
    sport === "mlb"
  ) {
    const edgeSide = propSignal.side;
    const home = research.espn.homeProjection ?? 0;
    const away = research.espn.awayProjection ?? 0;
    const edgeProj = edgeSide === "home" ? home : away;
    const oppProj = edgeSide === "home" ? away : home;
    if (edgeProj > 0 && oppProj - edgeProj >= (strategy.espnContraSkipGap ?? 18)) {
      return "espn_contra_strong_skip";
    }
  }

  return null;
}

export function espnContraFade(research, propSignal, strategy) {
  if (!research?.espn || propSignal.sport !== "mlb") return null;
  const gap = strategy.espnContraFadeGap ?? 15;
  const home = research.espn.homeProjection ?? 0;
  const away = research.espn.awayProjection ?? 0;
  if (home < 40 && away < 40) return null;

  const edgeSide = propSignal.side;
  if (edgeSide === "home" && away - home >= gap) return "away";
  if (edgeSide === "away" && home - away >= gap) return "home";
  return null;
}