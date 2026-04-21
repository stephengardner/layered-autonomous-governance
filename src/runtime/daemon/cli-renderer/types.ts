/**
 * Re-export of the generic cli-renderer channel contract.
 *
 * The canonical type definitions live in
 * src/adapters/notifier/cli-renderer-types.ts so an adapter implementing
 * the channel (e.g. telegram/channel.ts) can name them without reaching
 * into runtime/. The runtime cli-renderer re-exports here so existing
 * imports from './types.js' keep working and consumers who think of
 * these as "renderer types" do not need to change their import path.
 */

export type {
  CliRendererEvent,
  PostedMessage,
  InlineAction,
  MessageOptions,
  CliRendererChannel,
  CliRendererOptions,
} from '../../../adapters/notifier/cli-renderer-types.js';
