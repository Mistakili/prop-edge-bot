/**
 * Tier-2 research: ESPN game summaries + sport skepticism overlays.
 */

import { applyFactor, FACTOR_BASE } from "./brain.mjs";

const ESPN_SPORT = {
  mlb: "baseball/mlb",
  nhl: "hockey/nhl",
  nba: "basketball/nba",
};

const fetchCache = new Map();

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isSoccer(sport) {
  return sport === "soccer" || sport === "fifa";
}

function addToResearch(research, sideName, baseKey, reason, brain) {
  const base = FACTOR_BASE[baseKey] ?? 0;
  if (!base) return null;

  const side = {
    score: sideName === "home" ? research.homeScore : research.awayScore,
    reasons: research.reasons,
    weights: research.factorWeights,
  };
  const applied = applyFactor(side, base, reason, brain);
  if (sideName === "home") research.homeScore = side.score;
  else research.awayScore = side.score;
  research.supplemental.push({ layer: "tier2", reason, side: sideName, effective: applied.effective });
  return applied;
}

async function fetchEspnSummary(sport, gameId, timeoutMs) {
  const path = ESPN_SPORT[sport];
  if (!path || !gameId || !/^\d+$/.test(String(gameId))) return null;

  const cacheKey = `${sport}:${gameId}`;
  if (fetchCache.has(cacheKey)) return fetchCache.get(cacheKey);

  const url = `https://site.api.espn.com/apis/site/v2/sports/${path}/summary?event=${gameId}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    fetchCache.set(cacheKey, data);
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function injuryCounts(espn) {
  const home = { out: 0, questionable: 0 };
  const away = { out: 0, questionable: 0 };
  for (const group of espn.injuries ?? []) {
    const side = group.homeAway === "home" ? home : away;
    for (const item of group.injuries ?? []) {
      const status = (item.status ?? item.type ?? "").toLowerCase();
      if (status.includes("out") || status.includes("injured")) side.out += 1;
      else if (status.includes("question") || status.includes("doubt")) side.questionable += 1;
    }
  }
  return { home, away };
}

function applyEspnFactors(research, espn, propSignal, brain) {
  const predictor = espn.predictor ?? {};
  const homePct = Number(predictor.homeTeam?.gameProjection ?? predictor.homeTeam?.percentage ?? 0);
  const awayPct = Number(predictor.awayTeam?.gameProjection ?? predictor.awayTeam?.percentage ?? 0);

  if (homePct >= 58) addToResearch(research, "home", "espn_predictor_home", "espn_predictor_home", brain);
  if (awayPct >= 58) addToResearch(research, "away", "espn_predictor_away", "espn_predictor_away", brain);

  const inj = injuryCounts(espn);
  const homeLoad = inj.home.out * 2 + inj.home.questionable;
  const awayLoad = inj.away.out * 2 + inj.away.questionable;
  if (homeLoad >= awayLoad + 3) addToResearch(research, "away", "espn_injury_edge_away", "espn_injury_edge_away", brain);
  if (awayLoad >= homeLoad + 3) addToResearch(research, "home", "espn_injury_edge_home", "espn_injury_edge_home", brain);

  const competition = espn.header?.competitions?.[0];
  if (competition?.status?.type?.state === "post" && competition.status.type.completed) {
    research.supplemental.push({ layer: "tier2", reason: "espn_game_already_final", skip: true });
  }

  research.espn = {
    homeProjection: homePct || null,
    awayProjection: awayPct || null,
    injuries: inj,
    status: competition?.status?.type?.description ?? null,
  };
}

function applySoccerSkepticism(research, propSignal, brain, strategy) {
  if (!isSoccer(propSignal.sport)) return;
  const edgeSide = propSignal.side;
  const lowConf = (propSignal.confidence ?? 0) < (strategy.soccerSkepticMaxConfidence ?? 35);

  if (edgeSide === "home" && lowConf && propSignal.edgeStrength === "MODERATE") {
    addToResearch(research, "away", "soccer_home_dog_skeptic", "soccer_home_dog_skeptic", brain);
  }
}

function finalizeResearch(research) {
  research.researchPick = research.homeScore >= research.awayScore ? "home" : "away";
  research.confidence = Math.abs(research.homeScore - research.awayScore);
  research.fadedEdge = research.researchPick !== research.edgePick;

  const tier2OnPick = research.supplemental.filter(
    (s) => s.layer === "tier2" && s.side === research.researchPick && (s.effective ?? 0) > 0,
  );
  const espnAligns =
    research.espn &&
    ((research.researchPick === "home" && (research.espn.homeProjection ?? 0) >= 58) ||
      (research.researchPick === "away" && (research.espn.awayProjection ?? 0) >= 58));

  research.supplementalConfirmsFade = research.fadedEdge && (tier2OnPick.length > 0 || espnAligns === true);
  research.supplementalConfirmsAgree = !research.fadedEdge && (tier2OnPick.length > 0 || espnAligns === true);
}

/**
 * Merge tier-1 research with ESPN + sport overlays. Mutates scores on a copy.
 */
export async function enrichResearch(baseResearch, ctx) {
  const { propSignal, brain, strategy, stats } = ctx;
  const research = {
    ...baseResearch,
    reasons: [...(baseResearch.reasons ?? [])],
    factorWeights: [...(baseResearch.factorWeights ?? [])],
    supplemental: [],
    edgePick: baseResearch.edgePick ?? propSignal.side,
  };

  applySoccerSkepticism(research, propSignal, brain, strategy);

  const enabled = strategy.supplementalResearch !== false;
  if (enabled) {
    const espn = await fetchEspnSummary(
      propSignal.sport,
      propSignal.gameId,
      strategy.espnResearchTimeoutMs ?? 8000,
    );
    if (espn) applyEspnFactors(research, espn, propSignal, brain);
  }

  finalizeResearch(research);
  research.tier2Used = research.supplemental.some((s) => s.layer === "tier2" && !s.skip);
  return research;
}

export function clearResearchCache() {
  fetchCache.clear();
}

export { isSoccer, clamp };