#!/usr/bin/env node
/**
 * Prop Edge autonomous runner — Edge is insight, not gospel.
 * Researches each game independently, may agree or fade Edge.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "prop-edge-config.json"), "utf8"));
const logDir = process.env.PROP_EDGE_LOG_DIR ?? join(__dirname, "logs");

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

// ─── Research engine (Edge = one input, not the decision) ────────────────────

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

/**
 * Independent game analysis. Returns scores for home/away and a research narrative.
 * Edge signal is compared but does NOT dictate the pick.
 */
function researchGame(game, propSignal) {
  const home = { score: 0, reasons: [] };
  const away = { score: 0, reasons: [] };
  const edgeSide = propSignal.side;

  // 1. Season record — who's actually the better team?
  const homeRec = parseRecord(game.homeRecord);
  const awayRec = parseRecord(game.awayRecord);
  if (homeRec && awayRec) {
    const diff = homeRec.pct - awayRec.pct;
    if (diff > 0.08) {
      home.score += 8;
      home.reasons.push(`record_edge_home_${(diff * 100).toFixed(0)}pp`);
    } else if (diff < -0.08) {
      away.score += 8;
      away.reasons.push(`record_edge_away_${(-diff * 100).toFixed(0)}pp`);
    }
  }

  // 2. Rest / B2B — fatigue matters
  if (game.homeIsB2B) {
    away.score += 6;
    away.reasons.push("home_b2b");
  }
  if (game.awayIsB2B) {
    home.score += 6;
    home.reasons.push("away_b2b");
  }
  if (game.homeRestDays > game.awayRestDays + 1) {
    home.score += 4;
    home.reasons.push("home_rest_advantage");
  }
  if (game.awayRestDays > game.homeRestDays + 1) {
    away.score += 4;
    away.reasons.push("away_rest_advantage");
  }

  // 3. Line value — model vs market (is Edge's number justified?)
  if (game.modelSpread != null && game.lineSpread != null) {
    const model = Number(game.modelSpread);
    const line = Number(game.lineSpread);
    const value = model - line; // negative favours home cover
    if (value < -0.5) {
      home.score += 10;
      home.reasons.push(`line_value_home_${value.toFixed(1)}`);
    } else if (value > 0.5) {
      away.score += 10;
      away.reasons.push(`line_value_away_${value.toFixed(1)}`);
    }
  }

  // 4. Line movement — steam / sharp action since open
  if (game.openSpread != null && game.lineSpread != null) {
    const move = Number(game.lineSpread) - Number(game.openSpread);
    if (move < -0.5) {
      home.score += 5;
      home.reasons.push("line_steam_home");
    } else if (move > 0.5) {
      away.score += 5;
      away.reasons.push("line_steam_away");
    }
  }

  // 5. Edge model sanity check — STRONG with zero edge is a red flag
  const edgeVal = Number(game.edge ?? 0);
  const edgeSideDeclared = game.edgeSide;
  if (propSignal.edgeStrength === "STRONG" && edgeVal === 0 && edgeSideDeclared === "NONE") {
    // Edge label looks inflated — discount Edge side, boost opposite
    if (edgeSide === "home") {
      away.score += 12;
      away.reasons.push("edge_label_skeptic_fade_home");
    } else {
      home.score += 12;
      home.reasons.push("edge_label_skeptic_fade_away");
    }
  } else if (edgeSideDeclared === "home") {
    home.score += 6;
    home.reasons.push("edge_model_lean_home");
  } else if (edgeSideDeclared === "away") {
    away.score += 6;
    away.reasons.push("edge_model_lean_away");
  }

  // 6. Edge strength as soft signal only (not a command)
  if (propSignal.edgeStrength === "STRONG" && edgeSide === "home") home.score += 4;
  if (propSignal.edgeStrength === "STRONG" && edgeSide === "away") away.score += 4;
  if (propSignal.edgeStrength === "MODERATE" && edgeSide === "home") home.score += 2;
  if (propSignal.edgeStrength === "MODERATE" && edgeSide === "away") away.score += 2;

  // 7. Playoff flag — tighter games, home court slightly more
  if (game.isPlayoff) {
    home.score += 3;
    home.reasons.push("playoff_home_court");
  }

  const researchPick = home.score >= away.score ? "home" : "away";
  const confidence = Math.abs(home.score - away.score);
  const agreesWithEdge = researchPick === edgeSide;

  return {
    researchPick,
    edgePick: edgeSide,
    agreesWithEdge,
    fadedEdge: !agreesWithEdge,
    confidence,
    homeScore: home.score,
    awayScore: away.score,
    reasons: researchPick === "home" ? home.reasons : away.reasons,
    edgeInsight: {
      strength: propSignal.edgeStrength,
      modelSpread: game.modelSpread,
      lineSpread: game.lineSpread,
      edge: game.edge,
      edgeSide: game.edgeSide,
    },
  };
}

function computeStakePct(propSignal, stats, research) {
  const isStrong = propSignal.edgeStrength === "STRONG";
  const tier = isStrong ? strategy.strongStakePct : strategy.moderateStakePct;
  let pct = tier.default;

  const settled = stats.settledCount ?? 0;
  const roi = (stats.roiPct ?? 0) / 100;

  // Confidence scaling
  if (research.confidence >= 20) pct += 0.01;
  if (research.confidence < 15) pct -= 0.01;

  // Fading Edge is higher conviction required but smaller size
  if (research.fadedEdge) pct *= strategy.fadeStakeMultiplier;
  else pct *= strategy.agreeStakeMultiplier;

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
  const summary = {
    startedAt,
    displayName,
    mode: strategy.mode,
    picks: [],
    skipped: [],
    errors: [],
  };

  console.log(`[prop-edge] ${startedAt} — ${displayName} (independent research mode)`);

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
    if (!ref || openRefs.has(ref)) {
      summary.skipped.push({ signalRef: ref, reason: "already_open" });
      continue;
    }

    const game = gamesById.get(propSignal.gameId);
    if (!game) {
      summary.skipped.push({ signalRef: ref, reason: "no_edge_research_data" });
      continue;
    }

    const research = researchGame(game, propSignal);
    candidates.push({ propSignal, research });
  }

  candidates.sort((a, b) => b.research.confidence - a.research.confidence);
  summary.research = candidates.map(({ propSignal, research }) => ({
    signalRef: propSignal.signalRef,
    match: `${propSignal.awayTeam} @ ${propSignal.homeTeam}`,
    edgePick: research.edgePick,
    researchPick: research.researchPick,
    fadedEdge: research.fadedEdge,
    confidence: research.confidence,
    reasons: research.reasons,
    edgeInsight: research.edgeInsight,
  }));

  for (const { propSignal, research } of candidates) {
    const ref = propSignal.signalRef;

    if (research.confidence < strategy.minConfidenceToBet) {
      summary.skipped.push({
        signalRef: ref,
        reason: "low_confidence",
        confidence: research.confidence,
        researchPick: research.researchPick,
        edgePick: research.edgePick,
      });
      continue;
    }

    const pct = computeStakePct(propSignal, stats, research);
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
      summary.picks.push({
        signalRef: ref,
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
      });

      console.log(
        `[prop-edge] ${action} ${ref} → ${research.researchPick} ${(pct * 100).toFixed(1)}% $${result.stakeUsdc ?? stake} (conf ${research.confidence})`,
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

  summary.finishedAt = new Date().toISOString();
  summary.picksPlaced = summary.picks.length;

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