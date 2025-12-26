import { z } from 'zod';

export const VRMA_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const vrmaQuaternionSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const vrmaVec3Schema = z.tuple([z.number(), z.number(), z.number()]);

const vrmaRotationKeyframeSchema = z.object({
  t: z.number().nonnegative(),
  q: vrmaQuaternionSchema,
});

const vrmaPositionKeyframeSchema = z.object({
  t: z.number().nonnegative(),
  p: vrmaVec3Schema,
});

const vrmaExpressionKeyframeSchema = z.object({
  t: z.number().nonnegative(),
  v: z.number(),
});

const vrmaTrackSchema = z.object({
  bone: z.string().min(1),
  keyframes: z.array(vrmaRotationKeyframeSchema).min(1),
});

const vrmaHipsSchema = z.object({
  position: z.object({
    keyframes: z.array(vrmaPositionKeyframeSchema).min(1),
  }),
});

const vrmaExpressionTrackSchema = z.object({
  name: z.string().min(1),
  keyframes: z.array(vrmaExpressionKeyframeSchema).min(1),
});

const vrmaMetaSchema = z.object({
  name: z.string().regex(VRMA_SLUG_PATTERN, 'meta.name must be a slug'),
  fps: z.number().positive(),
  loop: z.boolean(),
  duration: z.number().nonnegative().optional(),
  kind: z.string().min(1).optional(),
});

export const vrmaSchema = z.object({
  meta: vrmaMetaSchema,
  tracks: z.array(vrmaTrackSchema).min(1),
  hips: vrmaHipsSchema.optional(),
  expressions: z.array(vrmaExpressionTrackSchema).min(1).optional(),
});

export type VrmaSchema = z.infer<typeof vrmaSchema>;

export const VRMA_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['meta', 'tracks'],
  properties: {
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'fps', 'loop', 'duration', 'kind'],
      properties: {
        name: {
          type: 'string',
          pattern: VRMA_SLUG_PATTERN.source,
        },
        fps: { type: 'number', minimum: 1 },
        loop: { type: 'boolean' },
        duration: { type: 'number', minimum: 0 },
        kind: { type: 'string' },
      },
    },
    tracks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['bone', 'keyframes'],
        properties: {
          bone: { type: 'string', minLength: 1 },
          keyframes: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['t', 'q'],
              properties: {
                t: { type: 'number', minimum: 0 },
                q: {
                  type: 'array',
                  minItems: 4,
                  maxItems: 4,
                  items: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
    hips: {
      type: 'object',
      additionalProperties: false,
      required: ['position'],
      properties: {
        position: {
          type: 'object',
          additionalProperties: false,
          required: ['keyframes'],
          properties: {
            keyframes: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['t', 'p'],
                properties: {
                  t: { type: 'number', minimum: 0 },
                  p: {
                    type: 'array',
                    minItems: 3,
                    maxItems: 3,
                    items: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    },
    expressions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'keyframes'],
        properties: {
          name: { type: 'string', minLength: 1 },
          keyframes: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['t', 'v'],
              properties: {
                t: { type: 'number', minimum: 0 },
                v: { type: 'number' },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function parseVrmaSchema(input: unknown): VrmaSchema {
  return vrmaSchema.parse(input);
}
