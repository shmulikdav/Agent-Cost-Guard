/**
 * Example: calling Agent Cost Guard from your coding agent.
 *
 * Replace your direct OpenAI calls with POSTs to /agent/request.
 * The agent never sees its own budget — just gets approved or denied.
 */

const GUARD_URL = process.env.GUARD_URL || 'http://localhost:3000';

async function askAgent({ agentId, model, messages, maxTokens = 4000, task }) {
  const res = await fetch(`${GUARD_URL}/agent/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId, model, messages, maxTokens, task }),
  });

  const result = await res.json();

  if (result.status !== 'approved') {
    // Denied. Could be timeout, budget, or missing fields.
    // Handle it — retry with a smaller request, escalate, or give up.
    throw new Error(`Request denied: ${result.reason}`);
  }

  return result.response;
}

// ────────────────────────────────────────────────────────────
// Example usage
// ────────────────────────────────────────────────────────────
async function main() {
  const response = await askAgent({
    agentId: 'code-reviewer-v1',
    model:   'gpt-4o',
    messages: [
      { role: 'system', content: 'You are a senior code reviewer.' },
      { role: 'user',   content: 'Review this function:\n\nfunction add(a,b){return a+b}' },
    ],
    maxTokens: 1000,
    task: 'Review a small utility function',
  });

  console.log(response.choices[0].message.content);
  console.log(`\nTokens: ${response.usage.total_tokens}`);
}

main().catch(console.error);
