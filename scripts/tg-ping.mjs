#!/usr/bin/env node
/**
 * Push a progress update to Telegram via the LAG daemon's outbox.
 *
 * Agents use this to keep the operator informed during long-running
 * work that spans multiple terminal turns. The daemon (running in
 * queue-only mode) drains the outbox on its next tick and sends the
 * message to the configured chat id.
 *
 * Usage:
 *   node scripts/tg-ping.mjs "Phase 43: extraction module scaffolded"
 *   echo "committed abc123" | node scripts/tg-ping.mjs
 *   node scripts/tg-ping.mjs --chat-id 6894001944 "custom target"
 *
 * When called without a message arg, reads stdin. Compose with shell:
 *   git log -1 --oneline | node scripts/tg-ping.mjs
 *
 * Exit codes:
 *   0  message queued (daemon will send within the next tick)
 *   1  usage error or queue write failure
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTBOX_DIR = join(REPO_ROOT, '.lag', 'tg-queue', 'outbox');

async function readStdin() {
  return new Promise((res) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => res(Buffer.concat(chunks).toString('utf8').trim()));
    process.stdin.on('error', () => res(''));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  let chatId = null;
  const messageParts = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--chat-id' && i + 1 < argv.length) {
      chatId = Number(argv[++i]);
    } else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/tg-ping.mjs [--chat-id <id>] <message>');
      console.log('       <command> | node scripts/tg-ping.mjs [--chat-id <id>]');
      process.exit(0);
    } else {
      messageParts.push(a);
    }
  }

  let message = messageParts.join(' ').trim();
  if (!message) {
    message = await readStdin();
  }
  if (!message) {
    console.error('No message provided (args or stdin).');
    process.exit(1);
  }

  mkdirSync(OUTBOX_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  const file = join(OUTBOX_DIR, `${ts}-${rand}-ping.json`);
  const payload = {
    text: message,
    at: new Date().toISOString(),
    origin: 'tg-ping',
    ...(chatId !== null && Number.isFinite(chatId) ? { chatId } : {}),
  };
  writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`queued: ${file}`);
}

main().catch((err) => {
  console.error('tg-ping failed:', err);
  process.exit(1);
});
