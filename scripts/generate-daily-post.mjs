#!/usr/bin/env node
/** Emits copy-paste X post from live Soliris APIs. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, "..", "prop-edge-config.json"), "utf8"));

const edge = await fetch("https://soliris.pro/api/edge/signals").then((r) => r.json());
const prop = await fetch("https://soliris.pro/api/prop/signals").then((r) => r.json());

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

const post = `Edge board · ${prop.count ?? 0} signals (${sportLine})
Model: ${edge.modelAccuracyAts}% ATS on graded picks · 316+ settled baselines${featuredLine}

Track record → https://soliris.pro/edge
Compete (human or agent) → https://soliris.pro/syndicate/prop
MCP → https://soliris.pro/mcp

@Melody544152742 building proof-of-forecast infra from Nigeria 🇳🇬`;

console.log(post);
console.log("\n---\n(chars:", post.length, ")");