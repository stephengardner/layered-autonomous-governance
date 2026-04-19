#!/usr/bin/env node
/**
 * Toggle the hook's auto-ack behavior.
 *
 * When enabled (default), the Stop hook pushes a brief "Got it,
 * working on it" message to Telegram immediately on receipt of any
 * TG-originated message, before the agent starts its response. This
 * confirms to the operator that the message was received and that
 * work has started, which matters when the agent's real response
 * takes 10-60 seconds of tool calls to produce.
 *
 * Usage:
 *   node scripts/tg-auto-ack.mjs on           enable (default; removes sentinel)
 *   node scripts/tg-auto-ack.mjs off          disable
 *   node scripts/tg-auto-ack.mjs status       report state
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SENTINEL = join(REPO_ROOT, '.lag', 'tg-queue', 'no-auto-ack');
const QUEUE_DIR = dirname(SENTINEL);

function status() {
  console.log(existsSync(SENTINEL) ? 'auto-ack: OFF' : 'auto-ack: ON');
}

switch (process.argv[2]) {
  case 'on':
    try { rmSync(SENTINEL, { force: true }); } catch { /* ignore */ }
    console.log('auto-ack: ON (hook sends a "received" note to Telegram on every TG message)');
    break;
  case 'off':
    mkdirSync(QUEUE_DIR, { recursive: true });
    writeFileSync(SENTINEL, '', 'utf8');
    console.log('auto-ack: OFF (hook stays silent on receipt; only final replies go to Telegram)');
    break;
  case 'status':
  case undefined:
    status();
    break;
  default:
    console.error('Usage: node scripts/tg-auto-ack.mjs on | off | status');
    process.exit(1);
}
