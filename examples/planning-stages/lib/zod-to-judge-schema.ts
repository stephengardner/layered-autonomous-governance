/**
 * Bounded JSON-schema builder for planning-pipeline stage adapters.
 *
 * Each stage adapter (brainstorm, spec, plan) ships a zod schema as
 * the source-of-truth runtime validator and a JSON-schema as the
 * derivative passed to host.llm.judge that constrains the LLM at
 * generation time. This module derives the JSON-schema mechanically
 * from the zod schema so the two cannot drift: a new bounded field
 * added to the zod schema automatically produces a bounded JSON
 * schema field, no second edit required.
 *
 * The supported zod surface is intentionally narrow -- exactly the
 * shapes the planning-pipeline stage schemas use today:
 *
 *   - z.object with property-bag shape
 *   - z.string with .min() / .max() bounds (and .refine wrapper)
 *   - z.number with .min() / .max() bounds (including .nonnegative)
 *   - z.array of any supported element schema, with .min() / .max() bounds
 *   - z.enum<readonly string[]>
 *   - z.boolean
 *   - z.optional / z.nullable (unwrapped during the walk)
 *   - z.effects (.refine / .transform; unwrapped to inner)
 *
 * Anything outside that surface throws. The throw is a substrate
 * signal, not a silent fallthrough: a stage that adopts a new zod
 * type unsupported by the builder MUST extend the builder before
 * shipping, not work around it. Silent fallthrough is the failure
 * mode this whole module exists to prevent.
 *
 * Lower-bound mirroring: the builder emits minLength, minItems, and
 * minimum/maximum keywords whenever the zod schema declares them.
 * The Claude CLI's --json-schema flag honors these JSON Schema
 * Draft-2020-12 keywords, so the LLM is constrained on BOTH ends of
 * the range at generation time. Without this, an empty-string output
 * (zod-rejected by .min(1)) or a confidence > 1 (zod-rejected by
 * .max(1)) would clear the JSON-schema and fail post-generation.
 */

import { z } from 'zod';
import type { JsonSchema } from '../../../src/types.js';

/**
 * Zod internal shape used by the builder. zod does not export these
 * type names but pins them on `_def.typeName`; the type aliases here
 * narrow the unknown shape so the switch below has named branches.
 */
type ZodAnyDef = {
  readonly typeName?: string;
  readonly checks?: ReadonlyArray<{
    readonly kind: string;
    readonly value?: number;
    readonly inclusive?: boolean;
  }>;
  readonly minLength?: { readonly value: number } | null;
  readonly maxLength?: { readonly value: number } | null;
  readonly innerType?: z.ZodTypeAny;
  readonly schema?: z.ZodTypeAny;
  readonly type?: z.ZodTypeAny;
  readonly shape?: () => Record<string, z.ZodTypeAny>;
  readonly values?: ReadonlyArray<string>;
};

function defOf(schema: z.ZodTypeAny): ZodAnyDef {
  return schema._def as ZodAnyDef;
}

/**
 * Unwrap zod wrapper types so the builder reaches the load-bearing
 * underlying type. Optional and nullable are wrappers; effects is
 * the .refine / .transform wrapper. The reference stage schemas use
 * .refine to enforce INJECTION_TOKEN guards on body fields, so the
 * walker MUST unwrap effects to see the underlying ZodString.
 */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cursor = schema;
  for (;;) {
    const def = defOf(cursor);
    if (def.typeName === 'ZodOptional' || def.typeName === 'ZodNullable') {
      if (def.innerType === undefined) return cursor;
      cursor = def.innerType;
      continue;
    }
    if (def.typeName === 'ZodEffects') {
      if (def.schema === undefined) return cursor;
      cursor = def.schema;
      continue;
    }
    return cursor;
  }
}

/**
 * Read a string-bound check from a ZodString. zod stores .min()/.max()
 * checks on `_def.checks` array entries with kind === 'min'/'max' and
 * a numeric `value`.
 */
function stringBound(
  schema: z.ZodTypeAny,
  kind: 'min' | 'max',
): number | null {
  const def = defOf(schema);
  if (def.typeName !== 'ZodString') return null;
  for (const check of def.checks ?? []) {
    if (check.kind === kind && typeof check.value === 'number') {
      return check.value;
    }
  }
  return null;
}

/**
 * Read a number-bound check from a ZodNumber. zod stores .min()/.max()
 * (and .nonnegative which is .min(0)) on `_def.checks` array entries
 * with kind === 'min'/'max' and a numeric `value`. Inclusive bounds
 * map to JSON Schema's `minimum`/`maximum`; exclusive bounds (zod's
 * .gt() / .lt()) would map to `exclusiveMinimum`/`exclusiveMaximum`,
 * but no current planning-stage schema uses exclusive bounds, so the
 * builder rejects them rather than guessing.
 */
function numberBound(
  schema: z.ZodTypeAny,
  kind: 'min' | 'max',
): number | null {
  const def = defOf(schema);
  if (def.typeName !== 'ZodNumber') return null;
  for (const check of def.checks ?? []) {
    if (check.kind === kind && typeof check.value === 'number') {
      // Inclusive defaults to true in zod's representation; reject
      // exclusive bounds so a future schema author who adds .gt() /
      // .lt() sees the failure rather than a silently-loose JSON-schema.
      if (check.inclusive === false) {
        throw new Error(
          'zod-to-judge-schema: exclusive number bound (.gt/.lt) not supported; '
          + 'extend the builder when a stage adopts exclusive bounds.',
        );
      }
      return check.value;
    }
  }
  return null;
}

/**
 * Build a JSON-schema property node for the given zod schema. Returns
 * a Record (mutable so the caller can compose). The result is a
 * JSON-schema value the caller embeds into a `properties` map or an
 * array `items` slot.
 *
 * Throws on unsupported zod shapes (the substrate signal mentioned in
 * the file-header). Recursive: a zod object inside an array inside an
 * object emits nested JSON-schemas.
 */
export function buildJudgeSchema(schema: z.ZodTypeAny): JsonSchema {
  const inner = unwrap(schema);
  const def = defOf(inner);
  switch (def.typeName) {
    case 'ZodString': {
      const node: Record<string, unknown> = { type: 'string' };
      const min = stringBound(inner, 'min');
      const max = stringBound(inner, 'max');
      if (min !== null) node.minLength = min;
      if (max !== null) node.maxLength = max;
      return node;
    }
    case 'ZodNumber': {
      const node: Record<string, unknown> = { type: 'number' };
      const min = numberBound(inner, 'min');
      const max = numberBound(inner, 'max');
      if (min !== null) node.minimum = min;
      if (max !== null) node.maximum = max;
      return node;
    }
    case 'ZodBoolean': {
      return { type: 'boolean' };
    }
    case 'ZodEnum': {
      const values = def.values;
      if (values === undefined) {
        throw new Error('zod-to-judge-schema: ZodEnum has no values');
      }
      return { type: 'string', enum: [...values] };
    }
    case 'ZodArray': {
      const itemSchema = def.type;
      if (itemSchema === undefined) {
        throw new Error('zod-to-judge-schema: ZodArray has no element type');
      }
      const node: Record<string, unknown> = {
        type: 'array',
        items: buildJudgeSchema(itemSchema),
      };
      const minItems = def.minLength?.value;
      const maxItems = def.maxLength?.value;
      if (typeof minItems === 'number') node.minItems = minItems;
      if (typeof maxItems === 'number') node.maxItems = maxItems;
      return node;
    }
    case 'ZodObject': {
      if (typeof def.shape !== 'function') {
        throw new Error(
          'zod-to-judge-schema: ZodObject missing shape() accessor',
        );
      }
      const shape = def.shape();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, fieldSchema] of Object.entries(shape)) {
        properties[key] = buildJudgeSchema(fieldSchema);
        // A zod field is required unless wrapped in z.optional. Walk
        // the wrappers WITHOUT going through unwrap() (which strips
        // optional unconditionally) to detect optional-ness.
        if (!isOptional(fieldSchema)) {
          required.push(key);
        }
      }
      const node: Record<string, unknown> = {
        type: 'object',
        properties,
      };
      if (required.length > 0) node.required = required;
      return node;
    }
    default: {
      throw new Error(
        `zod-to-judge-schema: unsupported zod type '${String(def.typeName)}'. `
        + 'Extend buildJudgeSchema before shipping a stage that uses this type.',
      );
    }
  }
}

/**
 * Detect if a zod schema is wrapped in z.optional (or a chain that
 * includes z.optional). z.nullable alone is NOT optional -- the field
 * is still required, just allowed to be null. This distinction
 * matches JSON-schema's `required` semantics: a key whose value may be
 * null is still in `required`; a key whose value may be missing is
 * not.
 */
function isOptional(schema: z.ZodTypeAny): boolean {
  let cursor = schema;
  for (;;) {
    const def = defOf(cursor);
    if (def.typeName === 'ZodOptional') return true;
    if (def.typeName === 'ZodEffects') {
      if (def.schema === undefined) return false;
      cursor = def.schema;
      continue;
    }
    if (def.typeName === 'ZodNullable') {
      if (def.innerType === undefined) return false;
      cursor = def.innerType;
      continue;
    }
    return false;
  }
}
