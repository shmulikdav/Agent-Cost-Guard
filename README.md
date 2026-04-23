# 🛡️ Agent Cost Guard

> Approval gateway + budget monitor for AI coding agents.
> Sits between your agent and OpenAI. Enforces a monthly budget.
> Requires human approval for expensive calls. Never lets the agent see its own balance.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Part of AI Agent Guards](https://img.shields.io/badge/part%20of-AI%20Agent%20Guards-blue)](#-related-projects)

Built because giving a coding agent "flexibility to manage its own budget"
works about as well as handing a teenager a credit card.

---

## 🧠 The problem

Your team wants to ship a coding agent. Someone suggests letting it manage
its own budget — "for flexibility." A week later the agent has asked for
budget increases six times with justifications like *"code is more complex
than expected."* None of them were justified.

## ✅ The fix

```
 ┌─────────┐   POST /agent/request    ┌──────────────┐    OpenAI API
 │  Agent  │ ───────────────────────► │  Cost Guard  │ ────────────►
 └─────────┘ ◄─── approved/denied ─── └──────┬───────┘
                                             │
                                     ≥ $10?  │
                                             ▼
                                      ┌─────────────┐
                                      │    Slack    │  approve / deny
                                      │  (buttons)  │
                                      └─────────────┘
```

- Agent sends its request here instead of calling OpenAI directly.
- Cost Guard estimates cost from model + input tokens + max output tokens.
- Estimated cost `< APPROVAL_THRESHOLD` → passes through automatically.
- `≥ threshold` → posts to Slack with Approve / Deny buttons. Agent waits.
- Actual spend is tracked. 80% → Slack alert. 100% → hard stop.

The agent never sees its balance — only approved or denied. That removes
the whole "trust me, I haven't exceeded the budget yet" dynamic.

## 📊 Real-world result

Deployed at a client running a coding agent on a development team.
**89% cost reduction.** Same code quality. Every budget-increase request
the agent made was denied — none of them were justified.

---

## 📦 Requirements

- **Node.js 18+**
- **OpenAI account** — also set a hard monthly limit in your OpenAI dashboard.
  This script is your first line of defense. The dashboard limit is your last.
- **A Slack workspace** where you can install an app
- **A way to expose this server publicly** for Slack's webhooks
  (ngrok, Cloudflare Tunnel, or a real deployment)

## 🚀 Quick start

```bash
git clone https://github.com/shmulikdav/agent-cost-guard.git
cd agent-cost-guard
npm install
cp .env.example .env
# edit .env with your keys
npm start
```

For local development, expose to Slack with ngrok:

```bash
ngrok http 3000
# paste the https URL into Slack's Interactivity Request URL
```

You should see:

```
[slack] authenticated as your-bot in your-workspace
Agent cost guard listening on :3000
Budget: $200 | approval threshold: $10
```

## ⚙️ Setup

### 1. Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. **OAuth & Permissions** → add Bot Token Scopes:
   - `chat:write`
   - `chat:write.public`
3. **Install to workspace** → copy the **Bot User OAuth Token** (starts with `xoxb-`)
4. **Basic Information** → copy the **Signing Secret**
5. **Interactivity & Shortcuts** → turn **ON**
   - Request URL: `https://<your-public-host>/slack/interactions`
6. Invite the bot into your alerts channel: `/invite @your-bot-name`

### 2. Configure

Edit `.env` with your keys. Generate a strong admin token:

```bash
openssl rand -hex 32
```

## 🔌 Using it from your agent

See [`examples/client.js`](examples/client.js) for a complete example.

```js
const response = await fetch('http://localhost:3000/agent/request', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    agentId: 'code-reviewer-v1',        // free-form identifier
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are a code reviewer.' },
      { role: 'user',   content: 'Review this PR...' }
    ],
    maxTokens: 4000,
    task: 'Review PR #1234 — auth refactor'  // shown to approvers in Slack
  })
});

const result = await response.json();
// { status: 'approved', response: {...openai response}, actualCost: 0.0234 }
// or
// { status: 'denied', reason: 'approval_timeout' }
```

**Denial reasons:**

- `monthly_budget_exceeded` — hard stop, reset needed
- `approval_timeout` — no human clicked within 5 min
- `client_disconnected` — agent gave up before Slack approval came in
- `missing_fields` — bad request

## 🔧 Configuration

All settings via env vars.

| Variable | Default | Description |
| --- | --- | --- |
| `OPENAI_API_KEY` | *required* | Your OpenAI API key |
| `SLACK_BOT_TOKEN` | *required* | `xoxb-...` from the Slack app |
| `SLACK_SIGNING_SECRET` | *required* | From the Slack app Basic Info page |
| `ADMIN_TOKEN` | *required* | Bearer token for admin endpoints |
| `SLACK_CHANNEL` | `#ai-costs` | Channel for approvals & alerts |
| `MONTHLY_BUDGET` | `200` | USD per month, hard stop |
| `APPROVAL_THRESHOLD` | `10` | USD, requests at or above this need approval |
| `APPROVAL_TIMEOUT_MS` | `300000` | Ms to wait for Slack response before denial |
| `PORT` | `3000` | HTTP port |

## 🩺 Operations

**Health check:**

```bash
curl http://localhost:3000/health
# { "status": "ok", "monthlySpend": 47.22, "budget": 200, "utilizationPct": 24, "pendingApprovals": 0 }
```

**Monthly reset** (run from cron on the 1st):

```bash
curl -X POST http://localhost:3000/admin/reset-monthly \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Logs:** every approval / denial / threshold event prints to stdout:

```
[approved:auto] code-reviewer-v1 cost=$0.0234
[pending] code-reviewer-v1 est=$12.50 id=abc-123
[approved:shmulik] code-reviewer-v1 cost=$11.80
[alert] 80% threshold crossed: $160.00
[denied] code-reviewer-v1 monthly_budget_exceeded est=$5.00
```

## ⚠️ Before production

This is a working reference implementation, not a drop-in for a critical
system. Before you put it in front of real agents:

- **Storage:** `monthlySpend`, `alertSent`, and `pendingApprovals` live in
  memory. Restart and they reset. Back them with Redis or Postgres.
- **Concurrency on approvals:** while a large request waits for Slack approval
  (up to 5 min), no budget is reserved for it. If many large requests pile up
  during one wait, all of them can pass the initial budget check and
  collectively over-book the cap. For low-traffic deployments this is a
  non-issue; for higher volume, reserve at the time of approval-request, not
  at execution.
- **Token estimation:** `JSON.stringify(messages).length / 4` is deliberately
  rough. Overestimates ~10–20% (errs safe). Swap in `tiktoken` for precision.
- **Cron:** `/admin/reset-monthly` exists but nothing calls it. Set up a cron
  or scheduled job in your infra.
- **Pricing:** the `PRICING` table is a snapshot. Update as OpenAI changes
  prices or as you add models.
- **Auth on `/agent/request`:** anyone who can reach the server can spend
  your money. Put it behind your VPN, add an API key check, or deploy so
  only your agents can reach it.
- **Observability:** ship logs somewhere. Add metrics (spend per agent,
  approval latency, denial rate).

## 🔗 Related projects

Part of a family of AI agent guardrails I'm building:

- **agent-circuit-breaker** *(coming soon)* — stop runaway agents
- **llm-output-guard** *(coming soon)* — validate structured LLM output

## 🤝 Contributing

Issues and PRs welcome. For larger changes, open an issue first so we can
discuss the direction.

## 📄 License

MIT — use it, modify it, ship it.

Built by [Shmulik Davar](https://www.linkedin.com/in/shmulikdavar/) at
[BrAIght Wave](https://www.braightwave.com/).
