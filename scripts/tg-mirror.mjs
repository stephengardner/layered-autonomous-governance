#!/usr/bin/env node
/**
 * Toggle LAG's terminal-to-Telegram mirror mode.
 *
 * When enabled, the lag-tg-attached Stop hook pushes EVERY terminal
 * reply to Telegram, not just responses to Telegram-originated
 * messages. Useful for solo-dev visibility: walk away from the
 * terminal and still see what the agent is doing on your phone.
 *
 * Usage:
 *   node scripts/tg-mirror.mjs on [chatId]   enable; optional specific chat id
 *   node scripts/tg-mirror.mjs off           disable
 *   node scripts/tg-mirror.mjs status        report current state
 *
 * The sentinel file at .lag/tg-queue/mirror-all controls the behavior.
 * Its contents (when enabled) can be a chat id for the hook to target;
 * when empty, the daemon's configured chatId wins.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SENTINEL = join(REPO_ROOT, '.lag', 'tg-queue', 'mirror-all');
const QUEUE_DIR = dirname(SENTINEL);

function status() {
  if (!existsSync(SENTINEL)) {
    console.log('mirror: OFF');
    return;
  }
  const content = readFileSync(SENTINEL, 'utf8').trim();
  if (content) {
    console.log(`mirror: ON (chatId=${content})`);
  } else {
    console.log('mirror: ON (using daemon default chatId)');
  }
}

function enable(chatId) {
  mkdirSync(QUEUE_DIR, { recursive: true });
  writeFileSync(SENTINEL, chatId || '', 'utf8');
  console.log(`mirror: ON${chatId ? ` (chatId=${chatId})` : ''}`);
  console.log('Every terminal turn now mirrors to Telegram on the next Stop hook.');
}

function disable() {
  try {
    rmSync(SENTINEL, { force: true });
  } catch {
    // ignore
  }
  console.log('mirror: OFF');
  console.log('Telegram now only receives replies to TG-originated messages.');
}

const cmd = process.argv[2];
const arg = process.argv[3];

switch (cmd) {
  case 'on':
    enable(arg);
    break;
  case 'off':
    disable();
    break;
  case 'status':
  case undefined:
    status();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error('Usage: node scripts/tg-mirror.mjs on [chatId] | off | status');
    process.exit(1);
}
