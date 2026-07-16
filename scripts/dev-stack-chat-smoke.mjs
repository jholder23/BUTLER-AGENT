/**
 * Smoke test: Knowledge POST /chat should finish within 60s for a trivial local-only message
 * (after dev stack is up). Does not cover /sd/* video paths.
 *
 * Usage: wait until `npm run dev` is healthy, then `npm run dev:smoke-chat`
 */
import net from 'node:net';

const KNOWLEDGE = 'http://127.0.0.1:8765';
// One DDG + optional Wikipedia ladder can spike on cold networks; typical dev is much faster.
const BUDGET_MS = 75_000;

function waitTcp(port, host = '127.0.0.1', deadline = Date.now() + 120_000) {
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (Date.now() > deadline) {
        reject(new Error(`timeout waiting for ${host}:${port}`));
        return;
      }
      const s = net.createConnection({ host, port }, () => {
        try {
          s.destroy();
        } catch {
          /* */
        }
        resolve();
      });
      s.on('error', () => {
        setTimeout(tryOnce, 400);
      });
    };
    tryOnce();
  });
}

async function main() {
  await waitTcp(8765);
  const t0 = Date.now();
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), BUDGET_MS);
  let res;
  try {
    res = await fetch(`${KNOWLEDGE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        message: 'What is the capital of France? One short phrase only.',
        prior_messages: [],
        local_only: true,
        openai_api_key: '',
        project_root: '.',
        sample_files: [],
        known_answers: {},
      }),
    });
  } catch (e) {
    clearTimeout(kill);
    const elapsed = Date.now() - t0;
    console.error(`[smoke-chat] fetch failed after ${elapsed}ms:`, e?.message || e);
    process.exit(1);
    return;
  }
  clearTimeout(kill);
  const elapsed = Date.now() - t0;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[smoke-chat] HTTP ${res.status} in ${elapsed}ms`, data);
    process.exit(1);
    return;
  }
  const reply = String(data?.reply || '').trim();
  if (!reply) {
    console.error(`[smoke-chat] empty reply in ${elapsed}ms`, data);
    process.exit(1);
    return;
  }
  if (elapsed > BUDGET_MS) {
    console.error(`[smoke-chat] too slow: ${elapsed}ms > ${BUDGET_MS}ms`);
    process.exit(1);
    return;
  }
  console.log(`[smoke-chat] OK in ${elapsed}ms — mode=${data?.mode || '?'} reply_len=${reply.length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[smoke-chat]', e);
  process.exit(1);
});
