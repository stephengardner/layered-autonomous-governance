import { TrigramEmbedder } from '../../src/retrieval/trigram-embedder.js';
import { runEmbedderSpec } from './shared/embedder-spec.js';

runEmbedderSpec('trigram', () => new TrigramEmbedder());
