import { describe, expect, it } from 'vitest';
import { parseVrmaSchema, VRMA_JSON_SCHEMA, VRMA_PLAN_JSON_SCHEMA } from '../src/avatar/vrma-schema.js';

type JsonSchemaObject = {
  type: 'object';
  required?: string[];
  properties?: Record<string, unknown>;
  additionalProperties?: boolean;
};

type JsonSchemaArray = {
  type: 'array';
  items?: unknown;
};

type JsonSchema = JsonSchemaObject | JsonSchemaArray | { type: string };

function collectSchemaViolations(
  schema: unknown,
  path: string = '',
  allowOptional: string[] = [],
): string[] {
  if (typeof schema !== 'object' || schema === null) {
    return [];
  }

  const violations: string[] = [];
  const obj = schema as Record<string, unknown>;

  if (obj.type === 'object' && obj.properties) {
    const props = obj.properties as Record<string, unknown>;
    const required = Array.isArray(obj.required) ? obj.required : [];
    const propKeys = Object.keys(props);

    for (const key of propKeys) {
      const fullPath = `${path}.${key}`;
      const isAllowedOptional = allowOptional.some((p) => fullPath.endsWith(p));
      if (!required.includes(key) && !isAllowedOptional) {
        violations.push(`${fullPath} is a property but not in required`);
      }
    }

    for (const key of propKeys) {
      violations.push(...collectSchemaViolations(props[key], `${path}.${key}`, allowOptional));
    }
  }

  if (obj.type === 'array' && obj.items) {
    violations.push(...collectSchemaViolations(obj.items, `${path}[]`, allowOptional));
  }

  return violations;
}

describe('vrma schema', () => {
  it('accepts a valid VRMA payload', () => {
    const parsed = parseVrmaSchema({
      meta: {
        name: 'friendly-wave',
        fps: 30,
        loop: true,
        duration: 1.2,
        kind: 'gesture',
      },
      tracks: [
        {
          bone: 'hips',
          keyframes: [
            { t: 0, q: [0, 0, 0, 1] },
            { t: 1, q: [0, 0.1, 0, 0.99] },
          ],
        },
      ],
      hips: {
        position: {
          keyframes: [
            { t: 0, p: [0, 0, 0] },
            { t: 1, p: [0, 0.02, 0] },
          ],
        },
      },
      expressions: [
        {
          name: 'happy',
          keyframes: [
            { t: 0, v: 0 },
            { t: 1, v: 0.5 },
          ],
        },
      ],
    });

    expect(parsed.meta.name).toBe('friendly-wave');
    expect(parsed.tracks[0]?.bone).toBe('hips');
  });

  it('rejects non-slug meta names', () => {
    expect(() =>
      parseVrmaSchema({
        meta: { name: 'Friendly Wave', fps: 30, loop: false },
        tracks: [
          {
            bone: 'hips',
            keyframes: [{ t: 0, q: [0, 0, 0, 1] }],
          },
        ],
      }),
    ).toThrow(/slug/i);
  });

  it('includes all properties in required arrays for OpenAI Responses API compatibility', () => {
    const vrmaViolations = collectSchemaViolations(VRMA_JSON_SCHEMA, 'VRMA_JSON_SCHEMA', ['.hips', '.expressions']);
    expect(vrmaViolations).toEqual([]);

    const planAllowedOptional = [
      '.globalStyle',
      '.energy',
      '.keyframeDensity',
      '.hipsMovement',
      '.usesExpressions',
      '.description',
      '.expressions',
      '.peakTime',
      '.overlapWithPreviousMs',
      '.peakAnglesDeg',
      '.easingHint',
      '.x',
      '.y',
      '.z',
    ];
    const planViolations = collectSchemaViolations(VRMA_PLAN_JSON_SCHEMA, 'VRMA_PLAN_JSON_SCHEMA', planAllowedOptional);
    expect(planViolations).toEqual([]);
  });
});
