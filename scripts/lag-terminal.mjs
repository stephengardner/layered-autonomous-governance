#!/usr/bin/env node
/**
 * LAG terminal wrapper (Phase 51a).
 *
 * Launches an interactive Claude Code session as a PTY child AND
 * simultaneously long-polls Telegram. Incoming Telegram messages
 * are injected directly into the child's stdin, so the agent sees
 * them as if you typed them in the terminal. Result: real-time
 * bidirectional sessions where you can be at the computer OR on
 * your phone, same flow, same session, same jsonl.
 *
 * What this gives you that the daemon+hook setup does not:
 *   - No turn-boundary wait. As soon as the daemon reads a TG
 *     message, it is injected into the live Claude Code stdin
 *     within one tick. No waiting for a prior Stop hook to fire.
 *   - The agent's response streams to the real terminal output
 *     AS it is generated. You see progress live.
 *   - Same terminal is the primary; Telegram is a remote mouth.
 *
 * Usage:
 *   node scripts/lag-terminal.mjs [--resume-session <id>] [--no-mirror]
 *                                 [--claude-args "..."]
 *
 * Options:
 *   --resume-session <id>   Resume a specific Claude Code session id.
 *                           Default: launches a fresh session.
 *   --no-mirror             Do not mirror Claude's responses to
 *                           Telegram. (Default: mirror on.)
 *   --claude-args "<args>"  Extra args passed to the claude command
 *                           (space-separated, single-quoted).
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN      Required.
 *   TELEGRAM_CHAT_ID        Required. Operator's chat id.
 *   LAG_OPERATOR_ID         Optional; defaults to 'stephen-human'.
 *
 * Prereqs:
 *   - Claude CLI installed and authenticated (claude /login).
 *   - node-pty installed (npm i node-pty; already a LAG dep).
 *
 * Stop: Ctrl-C in the wrapper terminal. The child claude process is
 * killed cleanly; the Telegram poller is stopped.
 */

import { spawn as ptySpawn } from 'node-pty';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// .env loader (shared shape with other scripts).
// ---------------------------------------------------------------------------

async function loadDotEnv() {
  try {
    const text = await readFile(resolve(REPO_ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* optional */
  }
}

// ---------------------------------------------------------------------------
// Argument parsing.
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    resumeSessionId: null,
    mirror: true,
    claudeArgs: [],
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume-session' && i + 1 < argv.length) {
      args.resumeSessionId = argv[++i];
    } else if (a === '--no-mirror') {
      args.mirror = false;
    } else if (a === '--claude-args' && i + 1 < argv.length) {
      args.claudeArgs = argv[++i].split(/\s+/).filter(Boolean);
    } else if (a === '--verbose') {
      args.verbose = true;
    } else if (a === '-h' || a === '--help') {
      console.log(`Usage: node scripts/lag-terminal.mjs [options]

Launches Claude Code as a PTY child with embedded Telegram polling.
Incoming Telegram messages inject directly into the Claude Code stdin.

Options:
  --resume-session <id>   Resume a specific session (passes --resume to claude)
  --no-mirror             Do not mirror Claude responses to Telegram (default: on)
  --claude-args "..."     Extra args for claude (space-separated)
  --verbose               Log Telegram poll activity + injection events
  -h, --help              This help`);
      process.exit(0);
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Telegram long-poller.
// ---------------------------------------------------------------------------

class TelegramInjector {
  constructor({ botToken, chatId, onMessage, onError, verbose }) {
    this.botToken = botToken;
    this.chatId = String(chatId);
    this.onMessage = onMessage;
    this.onError = onError ?? ((err, ctx) => console.error(`[tg] ${ctx}:`, err.message || err));
    this.verbose = !!verbose;
    this.updateOffset = 0;
    this.running = false;
    this.pollTimer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.pollOnce();
      } catch (err) {
        this.onError(err, 'pollOnce');
      }
      if (!this.running) return;
      this.pollTimer = setTimeout(loop, 2000);
    };
    void loop();
  }

  stop() {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollOnce() {
    const url = `https://api.telegram.org/bot${this.botToken}/getUpdates?offset=${this.updateOffset}&timeout=0&limit=50`;
    const res = await fetch(url);
    const json = await res.json();
    if (!json.ok) {
      throw new Error(`getUpdates: ${json.description ?? 'unknown'}`);
    }
    const updates = json.result ?? [];
    for (const update of updates) {
      if (update.update_id >= this.updateOffset) {
        this.updateOffset = update.update_id + 1;
      }
      const m = update.message;
      if (!m || typeof m.text !== 'string' || m.text.length === 0) continue;
      if (String(m.chat.id) !== this.chatId) continue;
      if (this.verbose) {
        console.error(`[tg] inbound #${m.message_id}: ${m.text.slice(0, 60)}`);
      }
      try {
        await this.onMessage({
          text: m.text,
          messageId: m.message_id,
          date: m.date,
          replyTo: m.reply_to_message?.message_id ?? null,
          fromUsername: m.from?.username ?? null,
        });
      } catch (err) {
        this.onError(err, 'onMessage');
      }
    }
  }

  async sendMessage(text) {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const body = {
      chat_id: this.chatId,
      text,
      disable_web_page_preview: true,
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      throw new Error(`sendMessage: ${json.description ?? 'unknown'}`);
    }
    return json.result;
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main() {
  await loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing in .env. Aborting.');
    process.exit(1);
  }

  const claudeCmd = process.platform === 'win32' ? 'claude.cmd' : 'claude';
  const claudeArgs = [];
  if (args.resumeSessionId) {
    claudeArgs.push('--resume', args.resumeSessionId);
  }
  claudeArgs.push(...args.claudeArgs);

  console.log(`LAG terminal wrapper starting`);
  console.log(`  Claude command:  ${claudeCmd} ${claudeArgs.join(' ') || '(interactive, new session)'}`);
  console.log(`  Telegram chat:   ${chatId}`);
  console.log(`  Mirror responses:${args.mirror ? ' ON' : ' OFF'}`);
  console.log(`  Stop:            Ctrl-C (both claude and the poller unwind)`);
  console.log('');

  // Start Claude Code inside a PTY so its TUI renders correctly.
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 30;
  const child = ptySpawn(claudeCmd, claudeArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: REPO_ROOT,
    env: process.env,
  });

  // Pipe PTY output to real stdout so the user sees everything.
  child.onData((data) => {
    process.stdout.write(data);
  });
  child.onExit(({ exitCode }) => {
    injector.stop();
    process.exit(exitCode ?? 0);
  });

  // Pipe real stdin (user's keystrokes) into PTY. Raw mode so arrow
  // keys / ctrl sequences pass through.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.on('data', (data) => {
    child.write(data.toString());
  });

  // Resize the PTY when the real terminal resizes.
  process.stdout.on('resize', () => {
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 30;
    try { child.resize(cols, rows); } catch { /* ignore */ }
  });

  // Mirror: keep a simple buffer of child output; periodically send
  // accumulated Claude responses back to Telegram. Cheap heuristic:
  // flush every 2s if the buffer looks like a complete-ish chunk.
  const mirrorBuffer = { text: '' };
  const mirrorTimer = args.mirror
    ? setInterval(async () => {
        const text = stripAnsi(mirrorBuffer.text).trim();
        if (text.length === 0) return;
        mirrorBuffer.text = '';
        try {
          await injector.sendMessage(chunkForTelegram(text));
        } catch (err) {
          if (args.verbose) console.error('[tg] mirror send failed:', err.message);
        }
      }, 2_000)
    : null;

  if (args.mirror) {
    child.onData((data) => {
      mirrorBuffer.text += data;
      if (mirrorBuffer.text.length > 12_000) {
        mirrorBuffer.text = mirrorBuffer.text.slice(-12_000);
      }
    });
  }

  // The injector: on each Telegram message, write it to the PTY.
  // Newline makes Claude Code treat it as a submitted prompt.
  const injector = new TelegramInjector({
    botToken,
    chatId,
    verbose: args.verbose,
    onMessage: async ({ text }) => {
      // Write text followed by carriage return so Claude Code accepts it.
      // Use '\r' not '\n' since Claude Code's TUI expects Enter/CR on TTY.
      child.write(text + '\r');
    },
    onError: (err, ctx) => {
      if (args.verbose) console.error(`[tg] ${ctx}:`, err.message);
    },
  });
  injector.start();

  const shutdown = () => {
    injector.stop();
    if (mirrorTimer) clearInterval(mirrorTimer);
    try { child.kill(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive via the child + stdin streams.
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function stripAnsi(s) {
  // Minimal ANSI escape stripper for the mirror. Not exhaustive; enough
  // to produce readable Telegram text from typical claude TUI output.
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

function chunkForTelegram(text, max = 4000) {
  if (text.length <= max) return text;
  return text.slice(0, max - 40) + '\n\n…[truncated in mirror]';
}

main().catch((err) => {
  console.error('lag-terminal failed:', err);
  process.exit(1);
});
