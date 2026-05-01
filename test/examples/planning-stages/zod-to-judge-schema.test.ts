/**
 * Unit tests for the buildJudgeSchema helper.
 *
 * The helper is the single source of truth for the planning-pipeline
 * stage adapters' JSON-schema mirrors. The tests pin the surface
 * contract (which zod shapes are supported, how each maps to
 * JSON-schema, what fails closed) so a regression in the helper
 * produces a single-test failure with the file/line traced back.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildJudgeSchema } from '../../../examples/planning-stages/lib/zod-to-judge-schema.js';

describe('buildJudgeSchema', () => {
  it('emits type:string with min/max for a bounded ZodString', () => {
    const result = buildJudgeSchema(z.string().min(1).max(50));
    expect(result).toEqual({ type: 'string', minLength: 1, maxLength: 50 });
  });

  it('emits type:string with no bounds for an unbounded ZodString', () => {
    const result = buildJudgeSchema(z.string());
    expect(result).toEqual({ type: 'string' });
  });

  it('emits type:number with minimum/maximum for a bounded ZodNumber', () => {
    const result = buildJudgeSchema(z.number().min(0).max(1));
    expect(result).toEqual({ type: 'number', minimum: 0, maximum: 1 });
  });

  it('mirrors .nonnegative() to minimum:0', () => {
    const result = buildJudgeSchema(z.number().nonnegative());
    expect(result).toEqual({ type: 'number', minimum: 0 });
  });

  it('emits type:boolean for a ZodBoolean', () => {
    const result = buildJudgeSchema(z.boolean());
    expect(result).toEqual({ type: 'boolean' });
  });

  it('emits type:string with enum for a ZodEnum', () => {
    const result = buildJudgeSchema(z.enum(['a', 'b', 'c']));
    expect(result).toEqual({ type: 'string', enum: ['a', 'b', 'c'] });
  });

  it('emits type:array with items + minItems + maxItems for a bounded ZodArray', () => {
    const result = buildJudgeSchema(
      z.array(z.string().max(10)).min(1).max(5),
    );
    expect(result).toEqual({
      type: 'array',
      items: { type: 'string', maxLength: 10 },
      minItems: 1,
      maxItems: 5,
    });
  });

  it('emits type:object with properties + required for a ZodObject', () => {
    const result = buildJudgeSchema(
      z.object({
        title: z.string().min(1).max(100),
        confidence: z.number().min(0).max(1),
      }),
    );
    expect(result).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 100 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['title', 'confidence'],
    });
  });

  it('omits an optional field from required and unwraps to its inner type', () => {
    const result = buildJudgeSchema(
      z.object({
        a: z.string(),
        b: z.string().optional(),
      }),
    ) as { properties: Record<string, unknown>; required: ReadonlyArray<string> };
    expect(result.required).toEqual(['a']);
    expect(result.properties.b).toEqual({ type: 'string' });
  });

  it('keeps a nullable field in required (nullable != optional)', () => {
    const result = buildJudgeSchema(
      z.object({
        a: z.string().nullable(),
      }),
    ) as { required: ReadonlyArray<string> };
    expect(result.required).toEqual(['a']);
  });

  it('unwraps z.effects (.refine) to its inner schema', () => {
    const result = buildJudgeSchema(
      z.string().min(1).max(50).refine((s) => !s.includes('!'), {
        message: 'no exclamation',
      }),
    );
    expect(result).toEqual({ type: 'string', minLength: 1, maxLength: 50 });
  });

  it('throws on an unsupported zod type rather than silently emitting a loose schema', () => {
    // ZodAny / ZodUnknown carry no shape constraints; the helper rejects
    // them as a substrate signal that a stage adopted a new shape and
    // the helper must be extended.
    expect(() => buildJudgeSchema(z.any())).toThrow(/unsupported zod type/);
    expect(() => buildJudgeSchema(z.unknown())).toThrow(/unsupported zod type/);
  });

  it('throws on an exclusive number bound (.gt/.lt) rather than emitting a permissive minimum/maximum', () => {
    // zod's .gt/.lt produce check.inclusive=false; the helper rejects
    // them because the JSON-schema mirror would require
    // exclusiveMinimum/exclusiveMaximum keywords and the substrate has
    // no current consumer for exclusive bounds. Failing closed forces
    // the stage author to extend the helper rather than drift.
    expect(() => buildJudgeSchema(z.number().gt(0))).toThrow(
      /exclusive number bound/,
    );
    expect(() => buildJudgeSchema(z.number().lt(1))).toThrow(
      /exclusive number bound/,
    );
  });

  it('recurses through arrays of objects', () => {
    const result = buildJudgeSchema(
      z.array(
        z.object({
          option: z.string().max(20),
          weight: z.number().min(0).max(1),
        }),
      ).max(3),
    );
    expect(result).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          option: { type: 'string', maxLength: 20 },
          weight: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['option', 'weight'],
      },
      maxItems: 3,
    });
  });
});
