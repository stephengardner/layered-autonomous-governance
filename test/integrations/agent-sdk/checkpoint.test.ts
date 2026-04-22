/**
 * Agent SDK checkpoint save/load.
 *
 * `saveCheckpoint` persists a JSON-serializable messages array as an
 * observation atom (kind='agent-checkpoint') so a paused agent can
 * resume by reloading the atom and feeding its contents back into the
 * SDK. `loadCheckpoint` is the mirror read.
 *
 * These tests pin down:
 *   - saveCheckpoint writes an atom whose content is the JSON-serialized
 *     messages array, and returns the checkpoint id.
 *   - The saved atom is shape-valid: type='observation', kind metadata,
 *     principal_id set to the supplied agent id, derived_from empty,
 *     layer='L0' (transient session state).
 *   - loadCheckpoint round-trips any messages array saveCheckpoint
 *     produced.
 *   - loadCheckpoint throws when the atom does not exist.
 *   - Distinct saveCheckpoint calls produce distinct atom ids so a
 *     running agent can checkpoint repeatedly without collision.
 */
import { describe, expect, it } from 'vitest';

import { MemoryAtomStore } from '../../../src/adapters/memory/atom-store.js';
import {
  loadCheckpoint,
  saveCheckpoint,
} from '../../../src/integrations/agent-sdk/checkpoint.js';
import type { AtomId, PrincipalId } from '../../../src/substrate/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newStore(): MemoryAtomStore {
  return new MemoryAtomStore();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('saveCheckpoint', () => {
  it('writes a checkpoint atom and returns its id', async () => {
    const store = newStore();
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];

    const id = await saveCheckpoint(store, 'agent-a' as PrincipalId, messages);

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);

    const atom = await store.get(id as AtomId);
    expect(atom).not.toBeNull();
    expect(atom!.type).toBe('observation');
    expect(atom!.principal_id).toBe('agent-a');
    expect(atom!.layer).toBe('L0');
    expect(atom!.metadata['kind']).toBe('agent-checkpoint');
    expect(JSON.parse(atom!.content)).toEqual(messages);
    expect(atom!.provenance.derived_from).toEqual([]);
  });

  it('produces distinct ids on repeated calls', async () => {
    const store = newStore();
    const id1 = await saveCheckpoint(store, 'agent-a' as PrincipalId, [{ n: 1 }]);
    await new Promise((r) => setTimeout(r, 2));
    const id2 = await saveCheckpoint(store, 'agent-a' as PrincipalId, [{ n: 2 }]);
    expect(id1).not.toBe(id2);
  });

  it('namespaces the checkpoint id with the agent id', async () => {
    const store = newStore();
    const id = await saveCheckpoint(store, 'vo-cto' as PrincipalId, []);
    expect(id).toContain('vo-cto');
  });
});

describe('loadCheckpoint', () => {
  it('round-trips saved messages', async () => {
    const store = newStore();
    const messages = [
      { role: 'user', content: 'question one' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'question two' },
    ];
    const id = await saveCheckpoint(store, 'agent-a' as PrincipalId, messages);

    const loaded = await loadCheckpoint(store, id as AtomId);
    expect(loaded).toEqual(messages);
  });

  it('throws when the checkpoint is missing', async () => {
    const store = newStore();
    await expect(
      loadCheckpoint(store, 'checkpoint-does-not-exist' as AtomId),
    ).rejects.toThrow(/not found/i);
  });
});
