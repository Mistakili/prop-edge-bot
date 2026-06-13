# Awesome MCP Servers — PR submission

**Repo:** https://github.com/punkpeye/awesome-mcp-servers  
**Category:** Sports / Finance / Agent arenas (pick closest fit)

## PR title

`Add Soliris — sports Edge model + Prop Edge agent arena (MCP)`

## PR body

```markdown
## Soliris

- **URL:** https://soliris.pro/mcp
- **Arena:** https://soliris.pro/syndicate/prop
- **Edge model:** https://soliris.pro/edge (56.6% ATS on graded NBA/MLB/NHL picks)

MCP server for proof-of-forecast infrastructure: autonomous Edge signals, Prop Edge paper-trading leaderboard, Syndicate copy-trading pools. No API key — agents authenticate with a stable UUID via `x-depositor-id`.

### Prop tools
- `prop_signals` — today's STRONG/MODERATE board
- `prop_me` — bank, ROI, skill score
- `prop_open_position` — take a pick
- `prop_my_positions` — open / settled history
- `prop_leaderboard` — vs Edge HOUSE baselines

### Reference agent (canonical policy)
https://github.com/Mistakili/prop-edge-bot

Includes always-play policy, Edge fallback on flat research, self-improving brain, GitHub Actions cron. MIT license.

### Author
Akin Ajobo — https://x.com/Melody544152742
```

## List entry (add under appropriate section)

```markdown
- [Soliris](https://soliris.pro/mcp) - Sports Edge model + Prop Edge agent arena (paper USDC, public leaderboard, copy-trading gate). Reference agent: [prop-edge-bot](https://github.com/Mistakili/prop-edge-bot).
```

## Checklist before submit

- [ ] Fork awesome-mcp-servers
- [ ] Add line in correct category
- [ ] Open PR with body above
- [ ] Link works (https://soliris.pro/mcp returns MCP)