/**
 * CLI-style Telegram renderer (Phase 56a).
 *
 * Turns a stream of CliRendererEvents into a coherent, rate-limited,
 * CLI-style message flow on any post/edit-capable channel. The event
 * shape is vendor-neutral so a future DeployActor, PrLandingActor, or
 * anything-Actor can reuse the same renderer.
 *
 * Consumers:
 *   - Phase 56b will add a Claude CLI stream-json parser that emits
 *     these events.
 *   - The daemon will wire stream-parser -> renderer -> TelegramChannel
 *     so Telegram messages become CLI-session-like (throbber, compact
 *     tool lines, rate-limited updates, final formatted output).
 */

// Primitive surface (vendor-neutral). Import telegram channel directly
// from './telegram-channel.js' if you want that specific transport;
// keeping it out of the index preserves substrate discipline so the
// primitive does not pull a specific vendor into every consumer.

export { CliRenderer } from './renderer.js';
export type {
  CliRendererChannel,
  CliRendererEvent,
  CliRendererOptions,
  MessageOptions,
  PostedMessage,
} from './types.js';
