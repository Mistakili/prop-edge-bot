# Distribution pack — what's ready

| File | Status | Who acts |
|------|--------|----------|
| [AGENT-POLICY.md](../AGENT-POLICY.md) | ✅ Live on GitHub | Forkers |
| [agent-system-prompt.md](./agent-system-prompt.md) | ✅ Ready to paste | Agent owners |
| [config-guide.md](./config-guide.md) | ✅ Ready | Agent owners |
| [awesome-mcp-pr.md](./awesome-mcp-pr.md) | 📝 Draft | **You** — submit PR |
| [SOLIRIS-PLATFORM-PROMPT.md](./SOLIRIS-PLATFORM-PROMPT.md) | 📝 Prompt | **Your AI** on Soliris repo |
| [circle-grants-application.md](./circle-grants-application.md) | 📝 Draft | **You** — submit |
| [outreach-badass-capital.md](./outreach-badass-capital.md) | 📝 Draft | **You** — send email |
| [POST-TODAY.md](./POST-TODAY.md) | 📝 Draft | **You** — post on X |
| [7-DAY-PLAN.md](./7-DAY-PLAN.md) | 📝 Plan | **You** — execute daily |
| [mcp-registry-entry.md](./mcp-registry-entry.md) | 📝 Draft | **You** — registry PRs |

## Automated (no you required)

- GitHub Actions cron 17:12 + 20:12 UTC
- Windows tasks 18:12 + 21:12 WAT
- `node prop-edge-daily.mjs` — always-play policy in code
- `node scripts/generate-daily-post.mjs` — receipt copy
- `node scripts/policy-check.mjs` — verify policy vs board