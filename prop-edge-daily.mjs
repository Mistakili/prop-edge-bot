#!/usr/bin/env node
/**
 * Prop Edge autonomous runner — self-improving independent research.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadBrain,
  saveBrain,
  applyFactor,
  gradeSettlements,
  tuneMeta,
  registerPosition,
  brainSummary,
  FACTOR_BASE,
} from "./brain.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "prop-edge-config.json"), "utf8"));
const logDir = process.env.PROP_EDGE_LOG_DIR ?? join(__dirname, "logs");
const brainPath = process.env.BRAIN_STATE_PATH ?? join(__dirname, "brain-state.json");

const { userId, displayName, mcpUrl, apiBase, edgeApi, strategy } = config;
let rpcId = 0;

// ─── MCP ─────────────────────────────────────────────────────────────────────

async function mcpCall(toolName, args = {}) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "x-depositor-id": userId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name: toolName, arguments: { userId, ...args } },
    }),
  });

  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  if (!dataLine) throw new Error(`MCP ${toolName}: no SSE data`);

  const payload = JSON.parse(dataLine.slice(6));
  const raw = payload.result?.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(raw);
  if (payload.result?.isError || parsed.error) {
    throw new Error(`MCP ${toolName}: ${parsed.error ?? raw}`);
  }
  return parsed;
}

async function ensureDisplayName() {
  const me = await mcpCall("prop_me");
  if (me.user?.displayName === displayName) return me;
  const res = await fetch(`${apiBase}/me?displayName=${encodeURIComponent(displayName)}`, {
    headers: { "x-depositor-id": userId },
  });
  return res.ok ? res.json() : me;
}

async function fetchEdgeResearch() {
  const res = await fetch(edgeApi, { headers: { "x-depositor-id": userId } });
  if (!res.ok) throw new Error(`Edge API ${res.status}`);
  return res.json();
}

// ─── Research engine (learned weights from brain) ────────────────────────────

function parseRecord(rec) {
  if (!rec || typeof rec !== "string") return null;
  const m = rec.match(/(\d+)-(\d+)/);
  if (!m) return null;
  const w = Number(m[1]);
  const l = Number(m[2]);
  const t = w + l;
  return t > 0 ? { wins: w, losses: l, pct: w / t } : null;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function roundStake(n) {
  return Math.round(n * 100) / 100;
}

function researchFromPropOnly(propSignal, brain) {
  const home = { score: 0, reasons: [], weights: [] };
  const away = { score: 0, reasons: [], weights: [] };
  const edgeSide = propSignal.side;

  const add = (side, baseKey, reason) => {
    const base = FACTOR_BASE[baseKey] ?? FACTOR_BASE[normalizeFromReason(reason)] ?? 0;
    if (!base) return;
    const applied = applyFactor(side, base, reason, brain);
    side.weights.push({ reason, ...applied });
  };

  if (propSignal.sport === "mlb") add(home, "home_field_mlb", "home_field_mlb");
  else if (propSignal.sport === "nhl") add(home, "home_field_nhl", "home_field_nhl");
  else if (propSignal.sport === "fifa") add(home, "home_field_fifa", "home_field_fifa");

  if ((propSignal.recommendedStakePct ?? 0) >= 0.04) {
    const side = edgeSide === "home" ? home : away;
    add(side, "prop_stake_conviction", "prop_stake_conviction");
  }

  if (propSignal.edgeStrength === "STRONG") {
    if (edgeSide === "home") add(away, "edge_label_skeptic_fade_home", "edge_label_skeptic_fade_home");
    else add(away, "edge_label_skeptic_fade_away", "edge_label_skeptic_fade_away");
    if (edgeSide === "home") {
      home.score += FACTOR_BASE.edge_strength_strong_home * factorWeightInline("edge_strength_strong_home", brain);
      home.reasons.push("edge_strength_strong_home");
    } else {
      away.score += FACTOR_BASE.edge_strength_strong_away * factorWeightInline("edge_strength_strong_away", brain);
      away.reasons.push("edge_strength_strong_away");
    }
  } else if (propSignal.edgeStrength === "MODERATE") {
    if (edgeSide === "home") add(home, "edge_strength_moderate_home", "edge_strength_moderate_home");
    else add(away, "edge_strength_moderate_away", "edge_strength_moderate_away");
  }

  const researchPick = home.score >= away.score ? "home" : "away";
  const confidence = Math.abs(home.score - away.score);
  const agreesWithEdge = researchPick === edgeSide;
  const winningSide = researchPick === "home" ? home : away;

  return {
    source: "prop_only",
    researchPick,
    edgePick: edgeSide,
    agreesWithEdge,
    fadedEdge: !agreesWithEdge,
    confidence,
    homeScore: home.score,
    awayScore: away.score,
    reasons: winningSide.reasons,
    factorWeights: winningSide.weights,
    edgeInsight: {
      strength: propSignal.edgeStrength,
      modelSpread: null,
      lineSpread: propSignal.lineSpread,
      edge: null,
      edgeSide: edgeSide,
    },
  };
}

function researchGame(game, propSignal, brain) {
  const home = { score: 0, reasons: [], weights: [] };
  const away = { score: 0, reasons: [], weights: [] };
  const edgeSide = propSignal.side;

  const add = (side, baseKey, reason) => {
    const base = FACTOR_BASE[baseKey] ?? FACTOR_BASE[normalizeFromReason(reason)] ?? 0;
    if (!base) return;
    const applied = applyFactor(side, base, reason, brain);
    side.weights.push({ reason, ...applied });
  };

  const homeRec = parseRecord(game.homeRecord);
  const awayRec = parseRecord(game.awayRecord);
  if (homeRec && awayRec) {
    const diff = homeRec.pct - awayRec.pct;
    if (diff > 0.08) add(home, "record_edge_home", `record_edge_home_${(diff * 100).toFixed(0)}pp`);
    else if (diff < -0.08) add(away, "record_edge_away", `record_edge_away_${(-diff * 100).toFixed(0)}pp`);
  }

  if (game.homeIsB2B) add(away, "home_b2b", "home_b2b");
  if (game.awayIsB2B) add(home, "away_b2b", "away_b2b");
  if (game.homeRestDays > game.awayRestDays + 1) add(home, "home_rest_advantage", "home_rest_advantage");
  if (game.awayRestDays > game.homeRestDays + 1) add(away, "away_rest_advantage", "away_rest_advantage");

  if (game.modelSpread != null && game.lineSpread != null) {
    const value = Number(game.modelSpread) - Number(game.lineSpread);
    if (value < -0.5) add(home, "line_value_home", `line_value_home_${value.toFixed(1)}`);
    else if (value > 0.5) add(away, "line_value_away", `line_value_away_${value.toFixed(1)}`);
  }

  if (game.openSpread != null && game.lineSpread != null) {
    const move = Number(game.lineSpread) - Number(game.openSpread);
    if (move < -0.5) add(home, "line_steam_home", "line_steam_home");
    else if (move > 0.5) add(away, "line_steam_away", "line_steam_away");
  }

  const edgeVal = Number(game.edge ?? 0);
  const edgeSideDeclared = game.edgeSide;
  if (propSignal.edgeStrength === "STRONG" && edgeVal === 0 && edgeSideDeclared === "NONE") {
    if (edgeSide === "home") add(away, "edge_label_skeptic_fade_home", "edge_label_skeptic_fade_home");
    else add(home, "edge_label_skeptic_fade_away", "edge_label_skeptic_fade_away");
  } else if (edgeSideDeclared === "home") {
    add(home, "edge_model_lean_home", "edge_model_lean_home");
  } else if (edgeSideDeclared === "away") {
    add(away, "edge_model_lean_away", "edge_model_lean_away");
  }

  if (propSignal.edgeStrength === "STRONG" && edgeSide === "home") {
    home.score += FACTOR_BASE.edge_strength_strong_home * factorWeightInline("edge_strength_strong_home", brain);
    home.reasons.push("edge_strength_strong_home");
  }
  if (propSignal.edgeStrength === "STRONG" && edgeSide === "away") {
    away.score += FACTOR_BASE.edge_strength_strong_away * factorWeightInline("edge_strength_strong_away", brain);
    away.reasons.push("edge_strength_strong_away");
  }
  if (propSignal.edgeStrength === "MODERATE" && edgeSide === "home") {
    home.score += FACTOR_BASE.edge_strength_moderate_home * factorWeightInline("edge_strength_moderate_home", brain);
    home.reasons.push("edge_strength_moderate_home");
  }
  if (propSignal.edgeStrength === "MODERATE" && edgeSide === "away") {
    away.score += FACTOR_BASE.edge_strength_moderate_away * factorWeightInline("edge_strength_moderate_away", brain);
    away.reasons.push("edge_strength_moderate_away");
  }

  if (game.isPlayoff) add(home, "playoff_home_court", "playoff_home_court");

  const researchPick = home.score >= away.score ? "home" : "away";
  const confidence = Math.abs(home.score - away.score);
  const agreesWithEdge = researchPick === edgeSide;
  const winningSide = researchPick === "home" ? home : away;

  return {
    source: "edge_api",
    researchPick,
    edgePick: edgeSide,
    agreesWithEdge,
    fadedEdge: !agreesWithEdge,
    confidence,
    homeScore: home.score,
    awayScore: away.score,
    reasons: winningSide.reasons,
    factorWeights: winningSide.weights,
    edgeInsight: {
      strength: propSignal.edgeStrength,
      modelSpread: game.modelSpread,
      lineSpread: game.lineSpread,
      edge: game.edge,
      edgeSide: game.edgeSide,
    },
  };
}

function normalizeFromReason(reason) {
  if (reason.startsWith("record_edge_home")) return "record_edge_home";
  if (reason.startsWith("record_edge_away")) return "record_edge_away";
  if (reason.startsWith("line_value_home")) return "line_value_home";
  if (reason.startsWith("line_value_away")) return "line_value_away";
  return reason;
}

function factorWeightInline(key, brain) {
  const f = brain.factors[key] ?? { wins: 0, losses: 0 };
  const n = f.wins + f.losses;
  if (n < 3) return 1.0;
  const wr = f.wins / n;
  return clamp(0.5 + (wr - 0.5) * 1.5, 0.35, 1.65);
}

function computeStakePct(propSignal, stats, decision, brain) {
  const isStrong = propSignal.edgeStrength === "STRONG";
  const tier = isStrong ? strategy.strongStakePct : strategy.moderateStakePct;
  let pct = tier.default;

  const settled = stats.settledCount ?? 0;
  const roi = (stats.roiPct ?? 0) / 100;
  const meta = brain.meta;

  if (decision.effectiveConfidence >= 20) pct += 0.01;
  if (decision.effectiveConfidence < 15) pct -= 0.01;
  if (decision.decisionMode === "follow_edge") pct -= 0.005;

  if (decision.fadedEdge) pct *= meta.fadeStakeMultiplier ?? strategy.fadeStakeMultiplier;
  else pct *= meta.agreeStakeMultiplier ?? strategy.agreeStakeMultiplier;

  if (roi < -0.05) pct -= 0.015;
  if (settled < 10) pct = Math.min(pct, isStrong ? 0.05 : 0.02);
  if (settled >= strategy.minSettledForAggression && roi > 0) pct += 0.01;

  return clamp(pct, tier.min, tier.max);
}

function computeMaxExposurePct(stats) {
  const tier = strategy.maxDailyExposurePct;
  let pct = tier.default;
  const roi = (stats.roiPct ?? 0) / 100;
  if ((stats.settledCount ?? 0) >= strategy.minSettledForAggression && roi > 0.05) pct = tier.max;
  if (roi < -0.1 || (stats.bankUsdc ?? 10000) < strategy.bankFloorUsdc) pct = tier.min;
  return clamp(pct, tier.min, tier.max);
}

/** Minimum confidence to use independent research instead of Edge fallback. */
function minConfidenceFor(research, signalCount, brain) {
  const base =
    research.source === "prop_only"
      ? (strategy.propOnlyMinConfidence ?? strategy.minConfidenceToBet)
      : (brain.meta.minConfidenceToBet ?? strategy.minConfidenceToBet);

  if (signalCount <= (strategy.lightSlateMaxSignals ?? 2)) {
    return Math.min(base, strategy.lightSlateMinConfidence ?? 4);
  }
  return base;
}

/**
 * Independent pick when research clears the bar; otherwise follow Edge model side.
 * STRONG ties (confidence 0) always follow Edge.
 */
function resolveBetDecision(research, propSignal, signalCount, brain) {
  const edgeSide = propSignal.side;
  const minConfidence = minConfidenceFor(research, signalCount, brain);
  const strongTie =
    propSignal.edgeStrength === "STRONG" && research.confidence === 0 && research.homeScore === research.awayScore;

  if (!strongTie && research.confidence >= minConfidence) {
    return {
      pickSide: research.researchPick,
      action: research.fadedEdge ? "FADE" : "AGREE",
      fadedEdge: research.fadedEdge,
      decisionMode: "independent",
      effectiveConfidence: research.confidence,
      minConfidence,
      reasons: research.reasons,
    };
  }

  const followConf =
    strongTie
      ? (strategy.strongMinConfidence ?? 4)
      : Math.max(research.confidence, strategy.followEdgeMinConfidence ?? 4);

  const pickSide =
    propSignal.suggestedSide === "home" || propSignal.suggestedSide === "away"
      ? propSignal.suggestedSide
      : edgeSide;

  return {
    pickSide,
    action: "FOLLOW_EDGE",
    fadedEdge: false,
    decisionMode: "follow_edge",
    effectiveConfidence: followConf,
    minConfidence,
    reasons: strongTie
      ? ["strong_tie_follow_edge", `edge_${propSignal.edgeStrength.toLowerCase()}_${pickSide}`]
      : [
          "follow_edge_no_clear_signal",
          `edge_${propSignal.edgeStrength.toLowerCase()}_${pickSide}`,
          ...(pickSide !== edgeSide ? ["platform_suggested_side"] : []),
        ],
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(logDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const brain = loadBrain(brainPath);
  brain.runs += 1;

  const summary = {
    startedAt,
    displayName,
    mode: "self-improving",
    picks: [],
    skipped: [],
    errors: [],
    research: [],
  };

  console.log(`[prop-edge] ${startedAt} — ${displayName} (self-improving mode, run #${brain.runs})`);

  // ── Learn from settled picks first ──
  let settledPositions = [];
  try {
    const settled = await mcpCall("prop_my_positions", { status: "settled" });
    settledPositions = settled.positions ?? [];
    const graded = gradeSettlements(brain, settledPositions);
    if (graded.length) {
      console.log(`[brain] Graded ${graded.length} newly settled position(s)`);
      for (const g of graded) {
        console.log(`[brain]  #${g.positionId} ${g.outcome.toUpperCase()} ${g.fadedEdge ? "FADE" : "AGREE"} pnl=${g.pnlUsdc}`);
      }
    }
    tuneMeta(brain, strategy);
    console.log(`[brain] meta: minConf=${brain.meta.minConfidenceToBet} fadeMult=${brain.meta.fadeStakeMultiplier?.toFixed(2)}`);
  } catch (e) {
    console.warn(`[brain] Settlement grading skipped: ${e.message}`);
  }

  summary.brainBefore = brainSummary(brain);

  const me = await ensureDisplayName();
  const stats = me.stats ?? {};
  const bank = stats.bankUsdc ?? 10000;
  summary.bankBefore = bank;
  summary.statsBefore = stats;

  const [edgeData, { signals = [] }, { positions: openPositions = [] }] = await Promise.all([
    fetchEdgeResearch(),
    mcpCall("prop_signals"),
    mcpCall("prop_my_positions", { status: "open" }),
  ]);

  const gamesById = new Map((edgeData.signals ?? []).map((g) => [g.gameId, g]));
  const openRefs = new Set(openPositions.map((p) => p.signalRef));
  const maxExposure = bank * computeMaxExposurePct(stats);
  let exposureUsed = 0;
  const candidates = [];

  for (const propSignal of signals) {
    const ref = propSignal.signalRef;
    if (!ref) continue;

    const game = gamesById.get(propSignal.gameId);
    const research = game
      ? researchGame(game, propSignal, brain)
      : researchFromPropOnly(propSignal, brain);
    const decisionPreview = openRefs.has(ref)
      ? null
      : resolveBetDecision(research, propSignal, signals.length, brain);

    summary.research.push({
      signalRef: ref,
      source: research.source,
      match: `${propSignal.awayTeam} @ ${propSignal.homeTeam}`,
      edgePick: research.edgePick,
      researchPick: research.researchPick,
      fadedEdge: research.fadedEdge,
      confidence: research.confidence,
      decisionMode: decisionPreview?.decisionMode ?? null,
      finalPick: decisionPreview?.pickSide ?? null,
      reasons: research.reasons,
      factorWeights: research.factorWeights,
      edgeInsight: research.edgeInsight,
      alreadyOpen: openRefs.has(ref),
    });

    if (openRefs.has(ref)) {
      summary.skipped.push({ signalRef: ref, reason: "already_open" });
      continue;
    }

    const decision = resolveBetDecision(research, propSignal, signals.length, brain);
    candidates.push({ propSignal, research, decision });
  }

  const sportRank = new Map(strategy.sportPriority.map((s, i) => [s, i]));
  candidates.sort((a, b) => {
    const confDiff = b.decision.effectiveConfidence - a.decision.effectiveConfidence;
    if (confDiff !== 0) return confDiff;
    return (sportRank.get(a.propSignal.sport) ?? 99) - (sportRank.get(b.propSignal.sport) ?? 99);
  });

  const alwaysPlay = strategy.alwaysPlaySignals !== false;

  for (const { propSignal, research, decision } of candidates) {
    const ref = propSignal.signalRef;

    if (
      !alwaysPlay &&
      decision.decisionMode === "follow_edge" &&
      research.confidence < decision.minConfidence
    ) {
      summary.skipped.push({
        signalRef: ref,
        reason: "low_confidence",
        source: research.source,
        confidence: research.confidence,
        minRequired: decision.minConfidence,
      });
      continue;
    }

    const pct = computeStakePct(propSignal, stats, decision, brain);
    let stake = roundStake(bank * pct);
    if (stake < strategy.minStakeUsdc) stake = strategy.minStakeUsdc;

    const remaining = maxExposure - exposureUsed;
    if (remaining < strategy.minStakeUsdc) {
      summary.skipped.push({ signalRef: ref, reason: "daily_exposure_cap" });
      continue;
    }
    if (stake > remaining) stake = roundStake(remaining);

    try {
      const result = await mcpCall("prop_open_position", {
        signalRef: ref,
        stakeUsdc: stake,
        side: decision.pickSide,
      });

      exposureUsed += result.stakeUsdc ?? stake;
      const pick = {
        signalRef: ref,
        sport: propSignal.sport,
        action: decision.action,
        decisionMode: decision.decisionMode,
        match: `${propSignal.awayTeam} @ ${propSignal.homeTeam}`,
        edgePick: research.edgePick,
        ourPick: decision.pickSide,
        researchPick: research.researchPick,
        fadedEdge: result.fadedEdge ?? decision.fadedEdge,
        confidence: decision.effectiveConfidence,
        researchConfidence: research.confidence,
        reasons: decision.reasons,
        stakePct: pct,
        stakeUsdc: result.stakeUsdc ?? stake,
        positionId: result.positionId,
        bankAfter: result.bankAfter,
      };
      summary.picks.push(pick);
      registerPosition(brain, pick);

      console.log(
        `[prop-edge] ${decision.action} ${ref} → ${decision.pickSide} ${(pct * 100).toFixed(1)}% $${pick.stakeUsdc} (research ${research.confidence}, mode ${decision.decisionMode})`,
      );
    } catch (err) {
      summary.errors.push({ signalRef: ref, error: err.message });
      console.error(`[prop-edge] ERROR ${ref}: ${err.message}`);
    }
  }

  const meAfter = await mcpCall("prop_me");
  summary.bankAfter = meAfter.stats?.bankUsdc;
  summary.statsAfter = meAfter.stats;

  try {
    const board = await mcpCall("prop_leaderboard");
    const players = (board.leaderboard ?? []).filter(
      (r) => r.id !== "edge-house" && r.id !== "edge-fader",
    );
    players.sort((a, b) => b.bankUsdc - a.bankUsdc);
    const myRank = players.findIndex((r) => r.id === userId) + 1;
    summary.leaderboard = {
      rank: myRank || null,
      totalPlayers: players.length,
      topBank: players[0]?.bankUsdc,
      gapToLeader: players[0] ? roundStake(players[0].bankUsdc - (summary.bankAfter ?? 0)) : null,
    };
    if (myRank) console.log(`[prop-edge] Rank #${myRank}/${players.length}`);
  } catch (e) {
    summary.leaderboardError = e.message;
  }

  summary.brainAfter = brainSummary(brain);
  summary.finishedAt = new Date().toISOString();
  summary.picksPlaced = summary.picks.length;

  saveBrain(brainPath, brain);
  console.log(`[brain] Saved → ${brainPath}`);

  const logPath = join(logDir, `${startedAt.slice(0, 10)}.json`);
  let existing = [];
  if (existsSync(logPath)) {
    try {
      existing = JSON.parse(readFileSync(logPath, "utf8"));
      if (!Array.isArray(existing)) existing = [existing];
    } catch {
      existing = [];
    }
  }
  existing.push(summary);
  writeFileSync(logPath, JSON.stringify(existing, null, 2));

  console.log(`[prop-edge] Done — ${summary.picksPlaced} picks, ${summary.skipped.length} skipped`);
  if (summary.errors.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("[prop-edge] Fatal:", e);
  process.exit(1);
});