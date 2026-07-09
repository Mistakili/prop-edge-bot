/**
 * Bet decision + stake sizing (climb-mode: cut leaks, press winners).
 */

import { isSoccer, clamp } from "./research-extra.mjs";
import { recoveryPhase, espnContraFade } from "./filters.mjs";

function minConfidenceAgree(research, signalCount, brain, strategy, phase) {
  let base =
    research.source === "prop_only"
      ? (strategy.propOnlyMinConfidence ?? strategy.minConfidenceAgree ?? 12)
      : (brain.meta.minConfidenceAgree ?? strategy.minConfidenceAgree ?? 12);

  if (phase === "survival") base = Math.max(base, strategy.survivalAgreeMinConfidence ?? 10);
  if (signalCount <= (strategy.lightSlateMaxSignals ?? 2)) {
    return Math.min(base, strategy.lightSlateMinConfidence ?? 4);
  }
  return base;
}

function minConfidenceFade(research, propSignal, signalCount, brain, strategy, phase) {
  let base = strategy.minConfidenceFade ?? 8;
  if (phase === "survival" || phase === "climb") base = Math.min(base, 7);
  if (isSoccer(propSignal.sport)) base = Math.min(base, strategy.soccerFadeMinConfidence ?? 6);
  if (research.source === "prop_only") base = Math.min(base, strategy.propOnlyFadeMinConfidence ?? 7);
  if (signalCount <= (strategy.lightSlateMaxSignals ?? 2)) {
    base = Math.min(base, strategy.lightSlateMinConfidence ?? 4);
  }
  return base;
}

export function resolveBetDecision(research, propSignal, signalCount, brain, stats, strategy) {
  const edgeSide = propSignal.side;
  const phase = recoveryPhase(stats, strategy);
  const agreeBar = minConfidenceAgree(research, signalCount, brain, strategy, phase);
  const fadeBar = minConfidenceFade(research, propSignal, signalCount, brain, strategy, phase);

  const contraSide = espnContraFade(research, propSignal, strategy);
  if (contraSide && contraSide !== edgeSide) {
    return {
      pickSide: contraSide,
      action: "FADE",
      fadedEdge: true,
      decisionMode: "espn_contra_fade",
      effectiveConfidence: Math.max(research.confidence, 12),
      minConfidence: fadeBar,
      agreeBar,
      fadeBar,
      stakeMultiplier: phase === "survival" ? 0.85 : 1,
      reasons: ["espn_contra_fade", `espn_favors_${contraSide}`],
    };
  }

  const strongTie =
    propSignal.edgeStrength === "STRONG" &&
    research.confidence === 0 &&
    research.homeScore === research.awayScore;

  const tier2Ok =
    research.tier2Used === true
      ? research.supplementalConfirmsFade || research.supplementalConfirmsAgree
      : research.confidence >= fadeBar - 2 || contraSide != null;

  if (!strongTie && research.fadedEdge && research.confidence >= fadeBar && tier2Ok) {
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

  if (isSoccer(propSignal.sport)) {
    stakeMultiplier = strategy.soccerStakeMult ?? 0.35;
  }

  if (
    propSignal.sport === "mlb" &&
    propSignal.edgeStrength === "STRONG" &&
    research.supplementalConfirmsAgree
  ) {
    stakeMultiplier = Math.max(stakeMultiplier, strategy.mlbStrongEspnBoost ?? 1.15);
  }

  if (research.fadedEdge && research.confidence >= fadeBar - 2 && pickSide === edgeSide) {
    stakeMultiplier = Math.min(stakeMultiplier, strategy.partialDisagreeStakeMult ?? 0.5);
  }

  if (phase === "survival" && propSignal.edgeStrength === "STRONG") {
    stakeMultiplier *= strategy.survivalStrongMult ?? 0.55;
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
          "follow_edge",
          `edge_${propSignal.edgeStrength.toLowerCase()}_${pickSide}`,
          ...(pickSide !== edgeSide ? ["platform_suggested_side"] : []),
          ...(research.fadedEdge ? ["research_disagrees_downsize"] : []),
          ...(phase === "survival" ? ["survival_sizing"] : []),
        ],
  };
}

export function computeStakePct(propSignal, stats, decision, brain, strategy) {
  const phase = recoveryPhase(stats, strategy);
  const isStrong = propSignal.edgeStrength === "STRONG";
  const tier = isStrong ? strategy.strongStakePct : strategy.moderateStakePct;
  const roi = (stats.roiPct ?? 0) / 100;
  const settled = stats.settledCount ?? 0;
  const meta = brain.meta;

  let pct = tier.default;

  if (phase === "survival") {
    pct = isStrong ? (strategy.survivalStrongPct ?? 0.022) : (strategy.survivalModeratePct ?? 0.012);
  } else if (phase === "climb") {
    pct = isStrong ? Math.min(pct, 0.035) : Math.min(pct, 0.018);
  }

  if (decision.decisionMode === "espn_contra_fade") {
    pct = Math.min(pct, strategy.contraFadeMaxPct ?? 0.028);
  }

  if (decision.effectiveConfidence >= 20) pct += 0.008;
  if (decision.effectiveConfidence < 12) pct -= 0.008;
  if (decision.decisionMode === "follow_edge") pct -= 0.004;

  if (decision.fadedEdge) pct *= meta.fadeStakeMultiplier ?? strategy.fadeStakeMultiplier;
  else pct *= meta.agreeStakeMultiplier ?? strategy.agreeStakeMultiplier;

  pct *= decision.stakeMultiplier ?? 1;

  if (propSignal.confidence >= 65 && isStrong) pct += 0.006;
  if (roi < -0.35) pct *= 0.85;
  if (roi > 0.05 && settled >= 30) pct += 0.008;
  if (roi > 0.15 && phase === "press") pct = Math.min(pct + 0.012, tier.max);

  const floor = tier.min;
  let ceiling = tier.max;
  if (phase === "survival") ceiling = isStrong ? 0.03 : 0.015;
  if (phase === "climb") ceiling = isStrong ? 0.04 : 0.02;

  return clamp(pct, floor, ceiling);
}

export function computeMaxExposurePct(stats, strategy) {
  const phase = recoveryPhase(stats, strategy);
  const tier = strategy.maxDailyExposurePct;
  const roi = (stats.roiPct ?? 0) / 100;

  let pct = tier.default;
  if (phase === "survival") pct = strategy.survivalMaxExposurePct ?? 0.08;
  else if (phase === "climb") pct = Math.min(pct, 0.12);
  else if (roi > 0.1) pct = tier.max;

  if (roi < -0.35) pct = Math.min(pct, 0.06);
  return clamp(pct, tier.min, tier.max);
}