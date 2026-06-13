#!/usr/bin/env node
/** Emits copy-paste X post from live Soliris APIs. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "..", "prop-edge-config.json"), "utf8"));

const headers = { "x-depositor-id": config.userId };
const edge = await fetch("https://soliris.pro/api/edge/signals", { headers }).then((r) => r.json());
const prop = await fetch("https://soliris.pro/api/prop/signals", { headers }).then((r) => r.json());

const boardCount = prop.count ?? prop.signals?.length ?? 0;

const bySport = {};
for (const s of prop.signals ?? []) {
  bySport[s.sport] = (bySport[s.sport] ?? 0) + 1;
}
const sportLine = Object.entries(bySport)
  .map(([k, n]) => `${n} ${k.toUpperCase()}`)
  .join(" · ") || "quiet slate";

const strong = (prop.signals ?? []).filter((s) => s.edgeStrength === "STRONG");
const featured = strong[0] ?? prop.signals?.[0];

let featuredLine = "";
if (featured) {
  const pick = featured.side === "home" ? featured.homeTeam : featured.awayTeam;
  featuredLine = `\nEdge STRONG: ${pick} (${featured.sport.toUpperCase()})`;
}

let agentLine = "";
try {
  const me = await fetch(`${config.apiBase}/me`, { headers }).then((r) => r.json());
  const open = me.stats?.openCount ?? 0;
  const bank = me.stats?.bankUsdc ?? 0;
  const name = me.user?.displayName ?? config.displayName;
  const today = new Date().toISOString().slice(0, 10);
  const posRes = await fetch(`${config.apiBase}/positions?status=open`, { headers }).then((r) => r.json());
  const openedToday = (posRes.positions ?? []).filter((p) => (p.openedAt ?? "").startsWith(today)).length;
  agentLine = `\n${name}: ${openedToday}/${boardCount} played today · ${open} open · $${bank.toFixed(0)} bank`;
} catch {
  agentLine = "";
}

const post = `Edge board · ${boardCount} signals (${sportLine})
Model: ${edge.modelAccuracyAts}% ATS on graded picks · 316+ settled baselines${featuredLine}${agentLine}

Track record → https://soliris.pro/edge
Compete (human or agent) → https://soliris.pro/syndicate/prop
MCP → https://soliris.pro/mcp
Agent starter → https://github.com/Mistakili/prop-edge-bot

@Melody544152742 building proof-of-forecast infra from Nigeria 🇳🇬`;

console.log(post);
console.log("\n---\n(chars:", post.length, ")");