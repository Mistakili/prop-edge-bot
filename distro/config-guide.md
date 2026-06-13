# `prop-edge-config.json` — strategy knobs

## Identity

| Key | Description |
|-----|-------------|
| `userId` | UUID v4 — your permanent Prop Edge identity (`x-depositor-id`) |
| `displayName` | Leaderboard handle (max 40 chars) |

## Always-play policy

| Key | Default | Description |
|-----|---------|-------------|
| `alwaysPlaySignals` | `true` | When true, never skip for low confidence; use Edge fallback |
| `minConfidenceToBet` | `12` | Bar for **independent** picks (Edge API path) |
| `propOnlyMinConfidence` | `6` | Bar for independent picks when Edge API has no game row |
| `lightSlateMaxSignals` | `2` | Slate this size or smaller uses light-slate bar |
| `lightSlateMinConfidence` | `4` | Lower independent bar on thin slates |
| `strongMinConfidence` | `4` | Synthetic confidence when STRONG ties → follow Edge |
| `followEdgeMinConfidence` | `4` | Floor for FOLLOW_EDGE effective confidence / staking |

## Stakes & risk

| Key | Description |
|-----|-------------|
| `strongStakePct` | `{ min, max, default }` for STRONG signals (e.g. 4–8%) |
| `moderateStakePct` | `{ min, max, default }` for MODERATE (e.g. 1–3%) |
| `maxDailyExposurePct` | Cap on total stake per run (default 15%) |
| `bankFloorUsdc` | Below this bank, exposure tightens to min tier |
| `fadeStakeMultiplier` | Scale stake when fading Edge |
| `agreeStakeMultiplier` | Scale stake when agreeing / following Edge |

## Cron alignment (WAT = UTC+1)

| Pass | WAT | UTC | Where |
|------|-----|-----|-------|
| Primary | 18:12 | 17:12 | GitHub Actions + `Soliris-PropEdge-Daily` |
| MLB evening | 21:12 | 20:12 | GitHub Actions + `Soliris-PropEdge-MLB` |

Re-register Windows tasks: `powershell -ExecutionPolicy Bypass -File register-prop-edge-task.ps1`

## Brain state (`brain-state.json`)

Learned at runtime — commit from CI or local runs:

- `meta.minConfidenceToBet` — tuned from agree/fade record (only bumps agree gate after 8+ agree bets)
- `factors.*` — win/loss weights per research factor
- `positions.*` — open and graded pick history for the brain

Do not delete `brain-state.json` unless resetting the agent.