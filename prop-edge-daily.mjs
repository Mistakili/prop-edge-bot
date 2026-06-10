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

function computeStakePct(propSignal, stats, research, brain) {
  const isStrong = propSignal.edgeStrength === "STRONG";
  const tier = isStrong ? strategy.strongStakePct : strategy.moderateStakePct;
  let pct = tier.default;

  const settled = stats.settledCount ?? 0;
  const roi = (stats.roiPct ?? 0) / 100;
  const meta = brain.meta;

  if (research.confidence >= 20) pct += 0.01;
  if (research.confidence < 15) pct -= 0.01;

  if (research.fadedEdge) pct *= meta.fadeStakeMultiplier ?? strategy.fadeStakeMultiplier;
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

  const minConfidence = brain.meta.minConfidenceToBet ?? strategy.minConfidenceToBet;

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
    if (!game) {
      summary.skipped.push({ signalRef: ref, reason: "no_edge_research_data" });
      continue;
    }

    const research = researchGame(game, propSignal, brain);
    summary.research.push({
      signalRef: ref,
      match: `${propSignal.awayTeam} @ ${propSignal.homeTeam}`,
      edgePick: research.edgePick,
      researchPick: research.researchPick,
      fadedEdge: research.fadedEdge,
      confidence: research.confidence,
      reasons: research.reasons,
      factorWeights: research.factorWeights,
      edgeInsight: research.edgeInsight,
      alreadyOpen: openRefs.has(ref),
    });

    if (openRefs.has(ref)) {
      summary.skipped.push({ signalRef: ref, reason: "already_open" });
      continue;
    }

    candidates.push({ propSignal, research });
  }

  candidates.sort((a, b) => b.research.confidence - a.research.confidence);

  for (const { propSignal, research } of candidates) {
    const ref = propSignal.signalRef;

    if (research.confidence < minConfidence) {
      summary.skipped.push({
        signalRef: ref,
        reason: "low_confidence",
        confidence: research.confidence,
        minRequired: minConfidence,
        researchPick: research.researchPick,
        edgePick: research.edgePick,
      });
      continue;
    }

    const pct = computeStakePct(propSignal, stats, research, brain);
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
        side: research.researchPick,
      });

      exposureUsed += result.stakeUsdc ?? stake;
      const action = research.fadedEdge ? "FADE" : "AGREE";
      const pick = {
        signalRef: ref,
        sport: propSignal.sport,
        action,
        match: `${propSignal.awayTeam} @ ${propSignal.homeTeam}`,
        edgePick: research.edgePick,
        ourPick: research.researchPick,
        fadedEdge: result.fadedEdge ?? research.fadedEdge,
        confidence: research.confidence,
        reasons: research.reasons,
        stakePct: pct,
        stakeUsdc: result.stakeUsdc ?? stake,
        positionId: result.positionId,
        bankAfter: result.bankAfter,
      };
      summary.picks.push(pick);
      registerPosition(brain, pick);

      console.log(
        `[prop-edge] ${action} ${ref} → ${research.researchPick} ${(pct * 100).toFixed(1)}% $${pick.stakeUsdc} (conf ${research.confidence})`,
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