/**
 * Agent Cost Guard
 * ----------------
 * Proxy between your coding agent and OpenAI.
 * - Estimates cost before every call
 * - Requests < $APPROVAL_THRESHOLD: pass through
 * - Requests >= $APPROVAL_THRESHOLD: Slack approval with buttons
 * - 80% budget alert, 100% hard stop
 *
 * The agent never sees its balance. Only gets: approved / denied.
 *
 * See README.md for setup.
 */

import express from 'express';
import OpenAI from 'openai';
import { WebClient } from '@slack/web-api';
import crypto from 'crypto';

// ============================================================
// Config & startup validation
// ============================================================
const REQUIRED_ENV = [
  'OPENAI_API_KEY',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'ADMIN_TOKEN',
];

const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  console.error('See .env.example');
  process.exit(1);
}

const CONFIG = {
  monthlyBudget:      Number(process.env.MONTHLY_BUDGET || 200),
  alertThreshold:     0.8,
  approvalThreshold:  Number(process.env.APPROVAL_THRESHOLD || 10),
  slackChannel:       process.env.SLACK_CHANNEL || '#ai-costs',
  approvalTimeoutMs:  Number(process.env.APPROVAL_TIMEOUT_MS || 5 * 60 * 1000),
  port:               Number(process.env.PORT || 3000),
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const slack  = new WebClient(process.env.SLACK_BOT_TOKEN);

// ============================================================
// State — use Redis/Postgres in production
// ============================================================
const pendingApprovals = new Map(); // requestId -> { resolve, timeout, slackRef }
let monthlySpend = 0;
let alertSent    = false;

// ============================================================
// Pricing (USD per 1M tokens) — update as OpenAI changes prices
// https://openai.com/api/pricing/
// ============================================================
const PRICING = {
  'gpt-4o':        { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':   { input: 0.15,  output: 0.60  },
  'gpt-4-turbo':   { input: 10.00, output: 30.00 },
  'o1':            { input: 15.00, output: 60.00 },
  'o1-mini':       { input: 3.00,  output: 12.00 },
};

const estimateCost = (model, inputTokens, maxOutputTokens) => {
  const p = PRICING[model] || PRICING['gpt-4o'];
  return (inputTokens * p.input + maxOutputTokens * p.output) / 1_000_000;
};

const actualCostOf = (model, usage) => {
  const p = PRICING[model] || PRICING['gpt-4o'];
  return (usage.prompt_tokens * p.input + usage.completion_tokens * p.output) / 1_000_000;
};

// Rough: ~4 chars = 1 token. Swap for `tiktoken` if you want precision.
const estimateInputTokens = (messages) =>
  Math.ceil(JSON.stringify(messages).length / 4);

// ============================================================
// Express setup
// ============================================================
const app = express();

// Raw body is needed for Slack signature verification.
function rawBodySaver(req, _res, buf) { req.rawBody = buf; }

app.use('/slack/interactions', express.urlencoded({ extended: true, verify: rawBodySaver }));
app.use(express.json({ verify: rawBodySaver }));

// ============================================================
// Slack: post approval request with buttons
// ============================================================
async function postApprovalRequest(requestId, details) {
  return slack.chat.postMessage({
    channel: CONFIG.slackChannel,
    text: `Agent budget approval needed: $${details.estimatedCost.toFixed(2)}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🚨 Budget Approval Required' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Agent:*\n${details.agentId}` },
          { type: 'mrkdwn', text: `*Model:*\n${details.model}` },
          { type: 'mrkdwn', text: `*Estimated cost:*\n$${details.estimatedCost.toFixed(2)}` },
          { type: 'mrkdwn', text: `*Monthly spend:*\n$${monthlySpend.toFixed(2)} / $${CONFIG.monthlyBudget}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Task:*\n\`\`\`${(details.task || 'n/a').slice(0, 500)}\`\`\`` },
      },
      {
        type: 'actions',
        elements: [
          { type: 'button', style: 'primary', text: { type: 'plain_text', text: '✅ Approve' }, value: requestId, action_id: 'approve_request' },
          { type: 'button', style: 'danger',  text: { type: 'plain_text', text: '❌ Deny'    }, value: requestId, action_id: 'deny_request' },
        ],
      },
    ],
  });
}

async function updateSlackMessage(slackRef, text, status) {
  try {
    await slack.chat.update({
      channel: slackRef.channel,
      ts:      slackRef.ts,
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: status }] },
      ],
    });
  } catch (err) {
    console.error('[slack.update]', err.message);
  }
}

// ============================================================
// Budget threshold alert
// ============================================================
async function checkBudgetThreshold() {
  const pct = monthlySpend / CONFIG.monthlyBudget;
  if (pct >= CONFIG.alertThreshold && !alertSent) {
    alertSent = true;
    await slack.chat.postMessage({
      channel: CONFIG.slackChannel,
      text: `⚠️ *Budget alert:* ${Math.round(pct * 100)}% of monthly budget used ` +
            `($${monthlySpend.toFixed(2)} / $${CONFIG.monthlyBudget})`,
    });
    console.log(`[alert] 80% threshold crossed: $${monthlySpend.toFixed(2)}`);
  }
}

// ============================================================
// Execute the call with reserve-then-adjust pattern.
// Because Node.js is single-threaded, the budget check + reservation
// is atomic within this synchronous block.
// ============================================================
async function executeAndCharge({ model, messages, maxTokens, estimatedCost }) {
  if (monthlySpend + estimatedCost > CONFIG.monthlyBudget) {
    return { ok: false, reason: 'monthly_budget_exceeded' };
  }

  // Reserve the estimated amount up front so concurrent requests see it.
  const reservation = estimatedCost;
  monthlySpend += reservation;

  try {
    const response   = await openai.chat.completions.create({ model, messages, max_tokens: maxTokens });
    const actualCost = actualCostOf(model, response.usage);
    // Adjust from reservation to actual.
    monthlySpend += (actualCost - reservation);
    await checkBudgetThreshold();
    return { ok: true, response, actualCost };
  } catch (err) {
    // Release the reservation on failure.
    monthlySpend -= reservation;
    throw err;
  }
}

// ============================================================
// Main endpoint: the agent calls this instead of OpenAI directly
// ============================================================
app.post('/agent/request', async (req, res) => {
  try {
    const { agentId, model, messages, maxTokens = 4000, task } = req.body;

    if (!agentId || !model || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ status: 'denied', reason: 'missing_fields' });
    }

    const inputTokens   = estimateInputTokens(messages);
    const estimatedCost = estimateCost(model, inputTokens, maxTokens);

    // Hard stop: cannot fit in monthly budget even at estimated cost
    if (monthlySpend + estimatedCost > CONFIG.monthlyBudget) {
      console.log(`[denied] ${agentId} monthly_budget_exceeded est=$${estimatedCost.toFixed(2)}`);
      return res.status(402).json({
        status: 'denied',
        reason: 'monthly_budget_exceeded',
        monthlySpend,
        budget: CONFIG.monthlyBudget,
      });
    }

    // Small request — pass through
    if (estimatedCost < CONFIG.approvalThreshold) {
      const result = await executeAndCharge({ model, messages, maxTokens, estimatedCost });
      if (!result.ok) return res.status(402).json({ status: 'denied', reason: result.reason });
      console.log(`[approved:auto] ${agentId} cost=$${result.actualCost.toFixed(4)}`);
      return res.json({ status: 'approved', response: result.response, actualCost: result.actualCost });
    }

    // Large request — human approval needed
    const requestId = crypto.randomUUID();
    const slackMsg  = await postApprovalRequest(requestId, { agentId, model, estimatedCost, task });
    const slackRef  = { channel: slackMsg.channel, ts: slackMsg.ts };

    const approvalPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingApprovals.delete(requestId);
        updateSlackMessage(slackRef,
          `⏱️ Request expired (no response within ${CONFIG.approvalTimeoutMs / 60000} min)`,
          'Timed out');
        resolve({ approved: false, reason: 'approval_timeout' });
      }, CONFIG.approvalTimeoutMs);
      pendingApprovals.set(requestId, { resolve, timeout, slackRef });
    });

    req.on('close', () => {
      const entry = pendingApprovals.get(requestId);
      if (!entry) return;
      clearTimeout(entry.timeout);
      pendingApprovals.delete(requestId);
      updateSlackMessage(slackRef, '🔌 Request abandoned (client disconnected)', 'Cancelled');
      entry.resolve({ approved: false, reason: 'client_disconnected' });
    });

    console.log(`[pending] ${agentId} est=$${estimatedCost.toFixed(2)} id=${requestId}`);
    const approval = await approvalPromise;

    if (!approval.approved) {
      console.log(`[denied:${approval.reason}] ${agentId} est=$${estimatedCost.toFixed(2)}`);
      return res.status(403).json({ status: 'denied', reason: approval.reason });
    }

    const result = await executeAndCharge({ model, messages, maxTokens, estimatedCost });
    if (!result.ok) return res.status(402).json({ status: 'denied', reason: result.reason });

    console.log(`[approved:${approval.approver}] ${agentId} cost=$${result.actualCost.toFixed(4)}`);
    return res.json({
      status:     'approved',
      approvedBy: approval.approver,
      response:   result.response,
      actualCost: result.actualCost,
    });
  } catch (err) {
    console.error('[agent/request]', err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ============================================================
// Slack interactions — approve/deny button clicks
// ============================================================
app.post('/slack/interactions', async (req, res) => {
  if (!verifySlackSignature(req)) {
    return res.status(401).send('Invalid signature');
  }

  // Ack fast — Slack has a 3s timeout.
  res.status(200).send();

  const payload = JSON.parse(req.body.payload);
  const action  = payload.actions[0];
  const pending = pendingApprovals.get(action.value);

  if (!pending) {
    await slack.chat.update({
      channel: payload.channel.id,
      ts:      payload.message.ts,
      text:    'Request expired or already processed',
      blocks:  [{ type: 'section', text: { type: 'mrkdwn', text: '_Request expired or already processed._' } }],
    });
    return;
  }

  clearTimeout(pending.timeout);
  pendingApprovals.delete(action.value);

  const approved = action.action_id === 'approve_request';
  pending.resolve({ approved, approver: payload.user.name });

  await slack.chat.update({
    channel: payload.channel.id,
    ts:      payload.message.ts,
    text:    approved ? 'Approved' : 'Denied',
    blocks: [
      ...payload.message.blocks.slice(0, -1), // drop the buttons row
      {
        type:     'context',
        elements: [{
          type: 'mrkdwn',
          text: `${approved ? '✅ *Approved*' : '❌ *Denied*'} by <@${payload.user.id}>`,
        }],
      },
    ],
  });
});

function verifySlackSignature(req) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  if (!timestamp || !signature || !req.rawBody) return false;

  // Replay protection
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const base     = `v0:${timestamp}:${req.rawBody.toString()}`;
  const expected = 'v0=' + crypto.createHmac('sha256', signingSecret).update(base).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ============================================================
// Admin / ops endpoints
// ============================================================
function requireAdminToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.post('/admin/reset-monthly', requireAdminToken, (_req, res) => {
  monthlySpend = 0;
  alertSent    = false;
  console.log('[admin] monthly budget reset');
  res.json({ status: 'reset' });
});

app.get('/health', (_req, res) => {
  res.json({
    status:           'ok',
    monthlySpend:     Number(monthlySpend.toFixed(2)),
    budget:           CONFIG.monthlyBudget,
    utilizationPct:   Math.round((monthlySpend / CONFIG.monthlyBudget) * 100),
    pendingApprovals: pendingApprovals.size,
  });
});

// ============================================================
// Start up — verify Slack before accepting traffic
// ============================================================
async function start() {
  try {
    const auth = await slack.auth.test();
    console.log(`[slack] authenticated as ${auth.user} in ${auth.team}`);
  } catch (err) {
    console.error('[slack] auth failed:', err.message);
    process.exit(1);
  }

  const server = app.listen(CONFIG.port, () => {
    console.log(`Agent cost guard listening on :${CONFIG.port}`);
    console.log(`Budget: $${CONFIG.monthlyBudget} | approval threshold: $${CONFIG.approvalThreshold}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
