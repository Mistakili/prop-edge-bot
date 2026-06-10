/**
 * Self-improving brain — grades settled picks, learns factor weights, tunes meta.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const FACTOR_BASE = {
  record_edge_home: 8,
  record_edge_away: 8,
  home_b2b: 6,
  away_b2b: 6,
  home_rest_advantage: 4,
  away_rest_advantage: 4,
  line_value_home: 10,
  line_value_away: 10,
  line_steam_home: 5,
  line_steam_away: 5,
  edge_label_skeptic_fade_home: 12,
  edge_label_skeptic_fade_away: 12,
  edge_model_lean_home: 6,
  edge_model_lean_away: 6,
  playoff_home_court: 3,
  edge_strength_strong_home: 4,
  edge_strength_strong_away: 4,
  edge_strength_moderate_home: 2,
  edge_strength_moderate_away: 2,
  home_field_mlb: 6,
  home_field_nhl: 5,
  prop_stake_conviction: 3,
};

export function normalizeFactor(reason) {
  if (reason.startsWith("record_edge_home")) return "record_edge_home";
  if (reason.startsWith("record_edge_away")) return "record_edge_away";
  if (reason.startsWith("line_value_home")) return "line_value_home";
  if (reason.startsWith("line_value_away")) return "line_value_away";
  return reason;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function loadBrain(path) {
  if (!existsSync(path)) {
    return {
      version: 1,
      updatedAt: null,
      runs: 0,
      meta: { minConfidenceToBet: 12, fadeStakeMultiplier: 0.7, agreeStakeMultiplier: 1.0 },
      factors: {},
      decisions: {
        agree: { wins: 0, losses: 0, pushes: 0 },
        fade: { wins: 0, losses: 0, pushes: 0 },
      },
      positions: {},
    };
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveBrain(path, brain) {
  brain.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(brain, null, 2) + "\n");
}

/** Weight from rolling win rate; 1.0 until 3+ samples. */
export function factorWeight(factorKey, brain) {
  const key = normalizeFactor(factorKey);
  const f = brain.factors[key] ?? { wins: 0, losses: 0, pushes: 0 };
  const decisive = f.wins + f.losses;
  if (decisive < 3) return 1.0;
  const wr = f.wins / decisive;
  return clamp(0.5 + (wr - 0.5) * 1.5, 0.35, 1.65);
}

export function applyFactor(side, basePoints, reason, brain) {
  const w = factorWeight(reason, brain);
  side.score += basePoints * w;
  side.reasons.push(reason);
  return { basePoints, weight: w, effective: basePoints * w };
}

function bump(bucket, outcome) {
  if (outcome === "win") bucket.wins += 1;
  else if (outcome === "loss") bucket.losses += 1;
  else bucket.pushes += 1;
}

function outcomeFromPnl(pnl) {
  if (pnl == null || pnl === 0) return "push";
  return pnl > 0 ? "win" : "loss";
}

function ensureFactor(brain, key) {
  if (!brain.factors[key]) {
    brain.factors[key] = { wins: 0, losses: 0, pushes: 0 };
  }
  return brain.factors[key];
}

/** Grade newly settled positions tracked in brain. */
export function gradeSettlements(brain, settledPositions) {
  const graded = [];

  for (const pos of settledPositions) {
    const id = String(pos.id);
    const tracked = brain.positions[id];
    if (!tracked || tracked.graded) continue;

    const outcome = outcomeFromPnl(pos.pnlUsdc);
    tracked.graded = true;
    tracked.outcome = outcome;
    tracked.pnlUsdc = pos.pnlUsdc;
    tracked.settledAt = pos.settledAt ?? new Date().toISOString();

    const decisionKey = tracked.fadedEdge ? "fade" : "agree";
    bump(brain.decisions[decisionKey], outcome);

    for (const reason of tracked.reasons ?? []) {
      const key = normalizeFactor(reason);
      if (!(key in FACTOR_BASE)) continue;
      bump(ensureFactor(brain, key), outcome);
    }

    graded.push({
      positionId: id,
      signalRef: tracked.signalRef,
      outcome,
      pnlUsdc: pos.pnlUsdc,
      fadedEdge: tracked.fadedEdge,
      reasons: tracked.reasons,
    });
  }

  return graded;
}

/** Tune meta thresholds from decision track records. */
export function tuneMeta(brain, configDefaults) {
  const meta = brain.meta;
  let minConf = meta.minConfidenceToBet ?? configDefaults.minConfidenceToBet ?? 12;

  const fade = brain.decisions.fade;
  const agree = brain.decisions.agree;
  const fadeN = fade.wins + fade.losses;
  const agreeN = agree.wins + agree.losses;

  if (fadeN >= 5) {
    const fadeWr = fade.wins / fadeN;
    if (fadeWr > 0.58) minConf -= 1;
    if (fadeWr < 0.42) minConf += 1;
    meta.fadeStakeMultiplier = clamp(0.45 + fadeWr * 0.55, 0.45, 1.0);
  }

  if (agreeN >= 5) {
    const agreeWr = agree.wins / agreeN;
    if (agreeWr < 0.42) minConf += 1;
    if (agreeWr > 0.58) minConf -= 0.5;
    meta.agreeStakeMultiplier = clamp(0.7 + agreeWr * 0.5, 0.7, 1.15);
  }

  meta.minConfidenceToBet = clamp(Math.round(minConf * 2) / 2, 8, 18);
  brain.meta = meta;
  return meta;
}

export function registerPosition(brain, pick) {
  const id = String(pick.positionId);
  brain.positions[id] = {
    positionId: id,
    signalRef: pick.signalRef,
    sport: pick.sport,
    match: pick.match,
    edgePick: pick.edgePick,
    ourPick: pick.ourPick,
    fadedEdge: pick.fadedEdge,
    confidence: pick.confidence,
    reasons: pick.reasons ?? [],
    stakeUsdc: pick.stakeUsdc,
    openedAt: new Date().toISOString(),
    graded: false,
  };
}

export function brainSummary(brain) {
  const topFactors = Object.entries(brain.factors)
    .map(([k, v]) => ({
      factor: k,
      wins: v.wins,
      losses: v.losses,
      weight: factorWeight(k, brain),
    }))
    .filter((f) => f.wins + f.losses >= 1)
    .sort((a, b) => b.weight - a.weight);

  return {
    runs: brain.runs,
    meta: brain.meta,
    decisions: brain.decisions,
    topFactors: topFactors.slice(0, 8),
    openTracked: Object.values(brain.positions).filter((p) => !p.graded).length,
    gradedTotal: Object.values(brain.positions).filter((p) => p.graded).length,
  };
}