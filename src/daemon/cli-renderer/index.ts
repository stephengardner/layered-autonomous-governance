/**
 * CLI-style Telegram renderer (Phase 56a + 56b).
 *
 * Turns a stream of CliRendererEvents into a coherent, rate-limited,
 * CLI-session-like message flow on any post/edit-capable channel.
 *
 * 56b adds a Claude CLI stream-json parser + a streaming invoke so
 * Claude's output can be piped through the renderer end-to-end.
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

// Claude CLI stream-json parser + streaming invoke. Kept on the same
// subpath for discoverability; callers who want the generic renderer
// without the Claude-specific bits can import directly from
// './renderer.js' + './types.js'.
export {
  emptyAccumulator,
  parseClaudeStreamLine,
  summarizeToolUse,
} from './claude-stream-parser.js';
export type { ParseAccumulator } from './claude-stream-parser.js';
export {
  defaultClaudeStreamingExecutor,
  invokeClaudeStreaming,
  makeStubStreamingExecutor,
  runSpawnedJsonl,
} from './claude-streaming.js';
export type {
  InvokeClaudeStreamingOptions,
  InvokeClaudeStreamingResult,
  StreamingExecResult,
  StreamingExecutor,
} from './claude-streaming.js';
