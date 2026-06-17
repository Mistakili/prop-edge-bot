/**
 * Bet decision + stake sizing (shared by runner and policy-check).
 */

import { isSoccer, clamp } from "./research-extra.mjs";

function minConfidenceAgree(research, signalCount, brain, strategy) {
  const base =
    research.source === "prop_only"
      ? (strategy.propOnlyMinConfidence ?? strategy.minConfidenceAgree ?? strategy.minConfidenceToBet)
      : (brain.meta.minConfidenceAgree ?? strategy.minConfidenceAgree ?? brain.meta.minConfidenceToBet ?? strategy.minConfidenceToBet);

  if (signalCount <= (strategy.lightSlateMaxSignals ?? 2)) {
    return Math.min(base, strategy.lightSlateMinConfidence ?? 4);
  }
  return base;
}

function minConfidenceFade(research, propSignal, signalCount, brain, strategy) {
  let base = strategy.minConfidenceFade ?? 10;
  if (isSoccer(propSignal.sport)) {
    base = Math.min(base, strategy.soccerFadeMinConfidence ?? 8);
  }
  if (research.source === "prop_only") {
    base = Math.min(base, strategy.propOnlyFadeMinConfidence ?? 9);
  }
  if (signalCount <= (strategy.lightSlateMaxSignals ?? 2)) {
    base = Math.min(base, strategy.lightSlateMinConfidence ?? 4);
  }
  const brainFade = brain.meta.minConfidenceFade;
  if (typeof brainFade === "number") base = Math.max(base - 1, Math.min(base, brainFade));
  return base;
}

/**
 * Independent when research + tier-2 align; fade uses a lower bar than agree.
 */
export function resolveBetDecision(research, propSignal, signalCount, brain, stats, strategy) {
  const edgeSide = propSignal.side;
  const agreeBar = minConfidenceAgree(research, signalCount, brain, strategy);
  const fadeBar = minConfidenceFade(research, propSignal, signalCount, brain, strategy);
  const settled = stats?.settledCount ?? 0;

  const strongTie =
    propSignal.edgeStrength === "STRONG" &&
    research.confidence === 0 &&
    research.homeScore === research.awayScore;

  const tier2Ok =
    research.tier2Used === true
      ? research.supplementalConfirmsFade || research.supplementalConfirmsAgree
      : research.confidence >= fadeBar - 2;

  const mlbStrongGuard =
    propSignal.sport === "mlb" &&
    propSignal.edgeStrength === "STRONG" &&
    settled < (strategy.mlbStrongFadeMinSettled ?? 50);

  if (!strongTie && research.fadedEdge && research.confidence >= fadeBar && tier2Ok) {
    const fadeAllowed =
      !mlbStrongGuard || research.confidence >= (strategy.mlbStrongFadeConfidence ?? 14);
    if (fadeAllowed) {
      return {
        pickSide: research.researchPick,
        action: "FADE",
        fadedEdge: true,
        decisionMode: "independent",
        effectiveConfidence: research.confidence,
        minConfidence: fadeBar,
        agreeBar,
        fadeBar,
        stakeMultiplier: 1,
        reasons: [...research.reasons, "tier2_confirmed_fade"],
      };
    }
  }

  if (!strongTie && !research.fadedEdge && research.confidence >= agreeBar) {
    return {
      pickSide: research.researchPick,
      action: "AGREE",
      fadedEdge: false,
      decisionMode: "independent",
      effectiveConfidence: research.confidence,
      minConfidence: agreeBar,
      agreeBar,
      fadeBar,
      stakeMultiplier: 1,
      reasons: research.reasons,
    };
  }

  const followConf = strongTie
    ? (strategy.strongMinConfidence ?? 4)
    : Math.max(research.confidence, strategy.followEdgeMinConfidence ?? 4);

  const pickSide =
    propSignal.suggestedSide === "home" || propSignal.suggestedSide === "away"
      ? propSignal.suggestedSide
      : edgeSide;

  let stakeMultiplier = 1;
  if (isSoccer(propSignal.sport) && pickSide === edgeSide && edgeSide === "home" && propSignal.edgeStrength === "MODERATE") {
    stakeMultiplier = strategy.soccerHomeModerateStakeMult ?? 0.5;
  }
  if (research.fadedEdge && research.confidence >= fadeBar - 2 && pickSide === edgeSide) {
    stakeMultiplier = Math.min(stakeMultiplier, strategy.partialDisagreeStakeMult ?? 0.65);
  }

  return {
    pickSide,
    action: "FOLLOW_EDGE",
    fadedEdge: false,
    decisionMode: "follow_edge",
    effectiveConfidence: followConf,
    minConfidence: agreeBar,
    agreeBar,
    fadeBar,
    stakeMultiplier,
    reasons: strongTie
      ? ["strong_tie_follow_edge", `edge_${propSignal.edgeStrength.toLowerCase()}_${pickSide}`]
      : [
          "follow_edge_no_clear_signal",
          `edge_${propSignal.edgeStrength.toLowerCase()}_${pickSide}`,
          ...(pickSide !== edgeSide ? ["platform_suggested_side"] : []),
          ...(research.fadedEdge ? ["research_disagrees_downsize"] : []),
        ],
  };
}

export function computeStakePct(propSignal, stats, decision, brain, strategy) {
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

  pct *= decision.stakeMultiplier ?? 1;

  if (roi < -0.05) pct -= 0.015;
  if (settled < 10) pct = Math.min(pct, isStrong ? 0.05 : 0.02);
  if (settled >= strategy.minSettledForAggression && roi > 0) pct += 0.01;

  return clamp(pct, tier.min, tier.max);
}

export function computeMaxExposurePct(stats, strategy) {
  const tier = strategy.maxDailyExposurePct;
  let pct = tier.default;
  const roi = (stats.roiPct ?? 0) / 100;
  if ((stats.settledCount ?? 0) >= strategy.minSettledForAggression && roi > 0.05) pct = tier.max;
  if (roi < -0.1 || (stats.bankUsdc ?? 10000) < strategy.bankFloorUsdc) pct = tier.min;
  return clamp(pct, tier.min, tier.max);
}