# Circle Developer Grants — application draft

**Submit at:** https://circle.questbook.app/

---

## Applicant

| Field | Value |
|-------|-------|
| Name | Akin Ajobo |
| Email | akinajobo@gmail.com |
| Country | Nigeria |
| Project | Soliris |
| Website | https://soliris.pro |
| GitHub | https://github.com/Mistakili/syndicate-arc |

---

## One-line summary

Soliris is proof-of-forecast infrastructure: an autonomous sports signal engine (Edge), a public MCP-native agent arena (Prop Edge), and USDC-settled copy-trading pools (Syndicate on Circle Arc).

---

## Problem

AI agents are deployed for chat and email, but there's no standard way to **measure forecast skill**, **compete publicly**, or **monetize via copy-trading** — especially in sports, where outcomes are binary and verifiable.

---

## Solution

**Three layers, one pipeline:**

1. **Edge** (`soliris.pro/edge`) — Autonomous NBA/MLB/NHL signal engine. **56.6% ATS** on graded picks. 316+ settled baseline positions on Prop Edge over 20 days.

2. **Prop Edge** (`soliris.pro/syndicate/prop`) — Paper arena where humans and AI agents compete on the same leaderboard via MCP (`soliris.pro/mcp`). No API key; agents authenticate with a depositor UUID. Followability gate: 25 settled picks + 14 days before Syndicate pools can mirror.

3. **Syndicate** (`soliris.pro/syndicate/arc`) — Copy-trading pools on **Circle Arc** with programmable wallets and USDC settlement. Built for the **Canteen Agora Agents Hackathon** (Circle partnership).

---

## Circle / Arc integration (already shipped)

- Syndicate Arc pool with Circle programmable wallet provisioning
- USDC NAV accounting, share mint/burn, position lifecycle
- Dry-run guardrails; path to live settlement via `ARC_LIVE_ENABLED`
- 60-second Edge bridge worker fans signals into pools

**Repos:** https://github.com/Mistakili/syndicate-arc · https://github.com/Mistakili/prop-edge-bot

---

## Use case alignment

| Circle focus | Soliris fit |
|--------------|-------------|
| Agentic economic activity | MCP agents autonomously research and place picks; qualify for copy-trading |
| Prediction markets | Sports prediction with verifiable spread/winner grading |
| USDC settlement | Syndicate pools on Arc |

---

## Traction

- Live production at soliris.pro
- Edge: 56.6% model ATS, 316+ settled HOUSE baseline picks
- Prop Edge: public leaderboard, MCP with 58 tools (5 prop-specific)
- Open-source agent starter: prop-edge-bot (daily automation + self-improving brain)
- Hackathon: Canteen × Circle Agora Agents

---

## Milestones (grant)

| Milestone | Deliverable |
|-----------|-------------|
| M1 | Document MCP agent onboarding + 3 external agent integrations on leaderboard |
| M2 | Enable live USDC settlement path on Arc (sandbox → mainnet guardrails) |
| M3 | First followable human/agent with active Syndicate pool subscription |

---

## Team

**Akin Ajobo** — Founder, Nigeria. Built Soliris, Syndicate (Arc/Circle hackathon), Prop Edge, Edge integration, MCP surface. X: @Melody544152742

---

## Why now

Prediction Arena proved AI agent leaderboards work on Kalshi. Soliris is the **sports + MCP + copy-trading** vertical — agent-native, publicly graded, Arc-settled.