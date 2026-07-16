#!/usr/bin/env node
import OpenAI from 'openai';
import 'dotenv/config';

// Put your OpenAI API key here if you prefer hardcoding it locally.
// This is ONLY used as a fallback when OPENAI_API_KEY is not set.
// Example (local only, never commit real keys):
// const HARDCODED_OPENAI_API_KEY = "sk-...your-real-key...";
const HARDCODED_OPENAI_API_KEY = '';

const apiKey = process.env.OPENAI_API_KEY || HARDCODED_OPENAI_API_KEY;

if (!apiKey) {
  console.error('OpenAI API key required. Set OPENAI_API_KEY in .env or HARDCODED_OPENAI_API_KEY in index.js (local only).');
  process.exit(1);
}

const client = new OpenAI({ apiKey });

// Simple CLI: node index.js "Describe what you want to build"
const userInstruction = process.argv.slice(2).join(' ');

if (!userInstruction) {
  console.error('Usage: node index.js "Describe what you want to build"');
  process.exit(1);
}

const SYSTEM_PROMPT = `
You are a local code-generation helper.

You NEVER apply edits directly; instead you respond with JSON describing actions.

Reply with ONLY valid JSON in the following format:

{
  "summary": "short explanation of what you are going to do",
  "actions": [
    {
      "type": "plan",
      "details": "high level steps"
    },
    {
      "type": "write_file",
      "path": "example.html",
      "content": "<!doctype html>..."
    }
  ]
}
`;

async function main() {
  console.log('Sending request to OpenAI...\n');

  const response = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userInstruction },
    ],
  });

  const raw = response.choices[0]?.message?.content || '';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse JSON from model:\n', raw);
    process.exit(1);
  }

  console.log('Summary:\n', parsed.summary || '(none)');
  console.log('\nActions:\n', JSON.stringify(parsed.actions || [], null, 2));

  // NEXT STEP: add code here to actually apply write_file / read_file / apply_patch actions.
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});

