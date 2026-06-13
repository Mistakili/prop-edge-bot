#!/usr/bin/env node
/** Verifies live board decisions match AGENT-POLICY.md (dry run, no bets). */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBrain, applyFactor, FACTOR_BASE } from "../brain.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "..", "prop-edge-config.json"), "utf8"));
const brain = loadBrain(join(__dirname, "..", "brain-state.json"));
const { userId, edgeApi, mcpUrl, strategy } = config;

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function factorWeightInline(key, brain) {
  const f = brain.factors[key] ?? { wins: 0, losses: 0 };
  const n = f.wins + f.losses;
  if (n < 3) return 1.0;
  const wr = f.wins / n;
  return clamp(0.5 + (wr - 0.5) * 1.5, 0.35, 1.65);
}

function researchFromPropOnly(propSignal, brain) {
  const home = { score: 0, reasons: [], weights: [] };
  const away = { score: 0, reasons: [], weights: [] };
  const edgeSide = propSignal.side;
  const add = (side, baseKey, reason) => {
    const base = FACTOR_BASE[baseKey] ?? 0;
    if (!base) return;
    const w = 1.0;
    side.score += base * w;
    side.reasons.push(reason);
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
      home.score += FACTOR_BASE.edge_strength_strong_home;
      home.reasons.push("edge_strength_strong_home");
    } else {
      away.score += FACTOR_BASE.edge_strength_strong_away;
      away.reasons.push("edge_strength_strong_away");
    }
  } else if (propSignal.edgeStrength === "MODERATE") {
    if (edgeSide === "home") add(home, "edge_strength_moderate_home", "edge_strength_moderate_home");
    else add(away, "edge_strength_moderate_away", "edge_strength_moderate_away");
  }
  const researchPick = home.score >= away.score ? "home" : "away";
  return {
    source: "prop_only",
    researchPick,
    edgePick: edgeSide,
    fadedEdge: researchPick !== edgeSide,
    confidence: Math.abs(home.score - away.score),
    homeScore: home.score,
    awayScore: away.score,
  };
}

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

function resolveBetDecision(research, propSignal, signalCount, brain) {
  const edgeSide = propSignal.side;
  const minConfidence = minConfidenceFor(research, signalCount, brain);
  const strongTie =
    propSignal.edgeStrength === "STRONG" &&
    research.confidence === 0 &&
    research.homeScore === research.awayScore;

  if (!strongTie && research.confidence >= minConfidence) {
    return {
      pickSide: research.researchPick,
      action: research.fadedEdge ? "FADE" : "AGREE",
      decisionMode: "independent",
      minConfidence,
    };
  }
  return {
    pickSide: edgeSide,
    action: "FOLLOW_EDGE",
    decisionMode: "follow_edge",
    minConfidence,
  };
}

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
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: { userId, ...args } },
    }),
  });
  const line = (await res.text()).split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(JSON.parse(line.slice(6)).result.content[0].text);
}

const headers = { "x-depositor-id": userId };
const edge = await fetch(edgeApi, { headers }).then((r) => r.json());
const { signals = [] } = await mcpCall("prop_signals");
const { positions: open = [] } = await mcpCall("prop_my_positions", { status: "open" });
const openRefs = new Set(open.map((p) => p.signalRef));
const gamesById = new Map((edge.signals ?? []).map((g) => [g.gameId, g]));

console.log("=== Policy check (dry run) ===");
console.log(`Board: ${signals.length} signals · Open: ${open.length} · brain minConf: ${brain.meta.minConfidenceToBet}`);
console.log(`alwaysPlaySignals config: ${strategy.alwaysPlaySignals}`);

let wouldPlay = 0;
let wouldSkip = 0;

for (const s of signals) {
  const game = gamesById.get(s.gameId);
  const research = game
    ? { source: "edge_api", researchPick: s.side, edgePick: s.side, fadedEdge: false, confidence: 99, homeScore: 99, awayScore: 0 }
    : researchFromPropOnly(s, brain);
  if (game) {
    // re-run prop only for display when no game - edge path needs full researchGame; flag separately
    Object.assign(research, researchFromPropOnly(s, brain));
    research.source = "edge_api_available";
  }

  if (openRefs.has(s.signalRef)) {
    console.log(`\n${s.signalRef} ${s.sport} — SKIP already_open`);
    wouldSkip++;
    continue;
  }

  const decision = resolveBetDecision(research, s, signals.length, brain);
  const plays = strategy.alwaysPlaySignals !== false;
  console.log(`\n${s.signalRef} ${s.sport} ${s.edgeStrength} edge=${s.side}`);
  console.log(`  research: home ${research.homeScore} away ${research.awayScore} conf ${research.confidence}`);
  console.log(`  decision: ${decision.action} → ${decision.pickSide} (${decision.decisionMode}, bar ${decision.minConfidence})`);
  if (plays) wouldPlay++;
}

console.log(`\n=== Summary ===`);
console.log(`Would play: ${wouldPlay} · Skip (open only): ${wouldSkip}`);
console.log(`Policy OK: ${wouldPlay === signals.length - wouldSkip ? "YES — every new signal gets a pick" : "CHECK"}`);

// Static scenario checks
const nhlStrong = { sport: "nhl", side: "home", edgeStrength: "STRONG", recommendedStakePct: 0.05 };
const r = researchFromPropOnly(nhlStrong, brain);
const d = resolveBetDecision(r, nhlStrong, 1, brain);
console.log(`\nSTRONG NHL tie scenario: conf ${r.confidence} → ${d.action} ${d.pickSide} (expect FOLLOW_EDGE home)`);
console.log(`Static tie OK: ${d.action === "FOLLOW_EDGE" && d.pickSide === "home" ? "YES" : "NO"}`);