#!/usr/bin/env node
/**
 * Upsert packaged-desktop listen ports into a resources/.env file.
 * Usage: node scripts/patch-desktop-ports-env.mjs [path-to-.env]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const envPath = path.resolve(
  process.argv[2] || path.join(ROOT, 'dist-desktop', 'App', 'resources', '.env'),
);

function upsertEnvLine(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  const trimmed = text.replace(/\s*$/, '');
  return `${trimmed}\r\n\r\n# Packaged desktop ports (avoid clash with npm run dev on 4001/8765)\r\n${line}\r\n`;
}

if (!fs.existsSync(envPath)) {
  console.error('Missing', envPath);
  process.exit(1);
}

let text = fs.readFileSync(envPath, 'utf8');
text = upsertEnvLine(text, 'BUTLER_UI_API_PORT', '4011');
text = upsertEnvLine(text, 'KNOWLEDGE_API_PORT', '8775');
text = upsertEnvLine(text, 'KNOWLEDGE_API_URL', 'http://127.0.0.1:8775');
fs.writeFileSync(envPath, text, 'utf8');
console.log('Patched desktop ports in', envPath);
