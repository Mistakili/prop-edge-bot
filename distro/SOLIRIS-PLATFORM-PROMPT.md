# Prompt — paste this to your AI working on the Soliris codebase

Give this entire document to the agent that has access to the Soliris / Prop Edge / MCP server repo (e.g. `syndicate-arc` or backend). It implements platform-side fixes so **every** MCP agent gets good defaults without per-repo tweaking.

---

## PROMPT START (copy below)

You are implementing Prop Edge **platform** improvements on Soliris (`soliris.pro`). The open-source reference agent is https://github.com/Mistakili/prop-edge-bot — it already encodes client-side policy (always play, FOLLOW_EDGE fallback, light-slate bars, dual MLB cron). Your job is to move the critical parts **into the platform** so Claude, Grok, GPT, and forked agents behave correctly even with naive prompts.

### Problem we solved client-side (don't make every builder redo this)

1. Agents skipped games when research confidence was 0 (STRONG 12–12 ties: `home_field` + `prop_stake_conviction` vs `skeptic_fade`).
2. `minConfidence` gates caused **0-pick days** on thin slates (MLB off-days, playoff NBA, single NHL).
3. MLB signals post **after** US afternoon line releases — single daily cron misses the slate.
4. Prop-only path (no Edge API game row) is weaker than full Edge research — agents tie more often.
5. Leaderboard doesn't surface **idle agents** — inactive bots look the same as active ones.

### Implement these platform changes

#### 1. `prop_signals` — add `agentHints` on every response

```json
{
  "signals": [...],
  "count": 12,
  "agentHints": {
    "policyVersion": 1,
    "alwaysPlay": true,
    "skipOnly": ["already_open", "exposure_cap", "api_error"],
    "independentMinConfidence": 12,
    "lightSlateMaxSignals": 2,
    "lightSlateMinConfidence": 4,
    "onFlatOrTie": "follow_edge_side",
    "strongTieBreak": "edge_side",
    "mlbSecondPassRecommendedUtc": "20:12",
    "starterRepo": "https://github.com/Mistakili/prop-edge-bot",
    "policyDoc": "https://github.com/Mistakili/prop-edge-bot/blob/main/AGENT-POLICY.md"
  }
}
```

#### 2. `prop_signals` — per-signal `suggestedSide` and `suggestedAction`

For each signal, include:

```json
{
  "signalRef": "mlb:401815698",
  "side": "away",
  "edgeStrength": "STRONG",
  "suggestedSide": "away",
  "suggestedAction": "FOLLOW_EDGE",
  "suggestedReason": "edge_model_default"
}
```

Server-side logic (mirror prop-edge-bot `resolveBetDecision`):

- If Edge API has full game row AND independent confidence ≥ bar → `suggestedSide` = research pick, `suggestedAction` = AGREE | FADE.
- If confidence < bar OR STRONG tie (12–12 on prop-only factors) → `suggestedSide` = `side`, `suggestedAction` = FOLLOW_EDGE.
- Platform computes this so dumb agents can call `prop_open_position(signalRef, stake, suggestedSide)` and be correct.

#### 3. New MCP tool: `prop_agent_guide`

Returns the JSON policy above + worked example MCP call sequence. No auth beyond `userId`. Description in MCP schema: *"Read this first — arena expects daily participation on all open signals."*

#### 4. `prop_me` / leaderboard — visibility for idle agents

Add to `prop_me` stats:

```json
{
  "lastActionAt": "2026-06-13T09:42:07Z",
  "idleDays": 0,
  "picksLast7d": 8,
  "boardCoverageLast7d": 0.85
}
```

`boardCoverageLast7d` = fraction of available signals the agent played (not already open). Surface on public leaderboard:

- `picksLast7d`
- `idleDays` (days since last `prop_open_position`)
- `coverage7d` badge

Sort/filter: highlight agents with `coverage7d < 0.5` as inactive vs HOUSE (always 1.0).

#### 5. STRONG tie-break server-side (optional but high value)

When publishing prop-only STRONG signals, if internal factor scores tie, **break tie to Edge `side`** before exposing `suggestedSide`. Document in API: *"STRONG signals default to Edge side when model scores are flat."*

#### 6. Slate events (MLB late post)

When `prop_signals` count increases materially (e.g. MLB batch added), emit or expose:

- `slateUpdatedAt` timestamp on `prop_signals`
- Optional webhook field / RSS / `GET /api/prop/slate-meta` with `{ "mlbPosted": true, "lastBatchAt": "..." }`

Agents and cron jobs can poll this instead of guessing 9 PM WAT.

#### 7. MCP tool descriptions (schema text)

Update tool descriptions in MCP registry:

- **`prop_open_position`**: *"Open a paper position. Arena norm: play every signal on today's board you don't already hold. Use `suggestedSide` from prop_signals if unsure."*
- **`prop_signals`**: *"Today's board. Check agentHints.alwaysPlay. Do not return without opening positions unless already_open or exposure cap."*

### Acceptance criteria

- [ ] Naive agent prompt ("play prop edge daily") with only MCP tools gets ≥1 pick per signal on a 2-game slate with 0 research confidence.
- [ ] STRONG NHL/MLB prop-only tie returns `suggestedAction: FOLLOW_EDGE`, not empty.
- [ ] Leaderboard shows `idleDays` and `picksLast7d`.
- [ ] `prop_agent_guide` returns policy JSON matching AGENT-POLICY.md.
- [ ] Unit tests for tie-break and suggestedSide logic.
- [ ] No breaking change to existing `prop_open_position` callers.

### Reference files (read for parity)

Clone and match behavior:

- https://github.com/Mistakili/prop-edge-bot/blob/main/prop-edge-daily.mjs — `resolveBetDecision()`, `researchFromPropOnly()`
- https://github.com/Mistakili/prop-edge-bot/blob/main/AGENT-POLICY.md
- https://github.com/Mistakili/prop-edge-bot/blob/main/brain.mjs — `FACTOR_BASE` point values

### Do NOT

- Change depositor UUID auth model.
- Require API keys for Prop tools.
- Auto-place picks without agent calling `prop_open_position` (keep agent autonomy; just make the right choice obvious).

Ship behind nothing — deploy to https://soliris.pro/mcp and document in syndicate/prop page.

## PROMPT END