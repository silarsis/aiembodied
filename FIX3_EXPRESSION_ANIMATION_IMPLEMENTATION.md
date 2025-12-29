# Fix 3: Expression Animation via VRMC Metadata (Complete Implementation Guide)

## Problem Statement

The VRMA encoder currently outputs facial expression animations as fake bone nodes with translation channels in the GLB. This creates spurious `translation` animation channels that conflict with the real `hips` bone animation, causing the model to flip upside-down when an animation plays.

**Root cause (lines 268–277 in `vrma-converter.ts`):**
```typescript
// WRONG: Expression values [0.5, 0, 0] encoded as 3D bone movement
values.flatMap((frame) => [frame.v, 0, 0]);
addSamplerChannel(nodeIndex, 'translation', times, values, 'VEC3');
```

This mixes two animation systems:
- **Bone animation** → applies quaternion rotations to skeleton
- **Expression animation** → should apply scalar weights (0–1) to morph targets

When both animate the same node, the system becomes unstable.

## Solution Overview

Move expression keyframe data **out of GLB animation channels** and **into the VRMC_vrm_animation extension metadata** as samplers. The renderer applies expressions post-animation via the keyframe data stored in the extension.

**Result:** 
- GLB only animates bones (rotation + hips translation)
- Expressions live in metadata, applied separately
- No conflicting channels, no model flipping

## Detailed Changes Required

### 1. VRMA Schema Changes (`app/main/src/avatar/vrma-schema.ts`)

**Add new schema for expression samplers (in metadata):**

```typescript
// Add this new type for expression samplers in the VRMC extension
const vrmaExpressionSamplerSchema = z.object({
  preset: z.array(z.object({
    name: z.string().min(1),
    keyframes: z.array(vrmaExpressionKeyframeSchema).min(1),
  })).min(0),
  custom: z.array(z.object({
    name: z.string().min(1),
    keyframes: z.array(vrmaExpressionKeyframeSchema).min(1),
  })).min(0),
});
```

This represents expressions as **samplers in the VRMC extension**, not as animation channels.

**Rationale:** Expressions have discrete keyframe times and values (0–1 weights). Unlike bones, they don't need node indices; they're metadata-only. Storing them here clarifies their semantic role.

### 2. Encoder Changes (`app/main/src/avatar/vrma-converter.ts`)

**Modify `encodeVrmaGlb()` to skip expression channels:**

Replace the entire expression handling block (lines 268–277) with:

```typescript
// OLD CODE (DELETE lines 268-277):
// if (definition.expressions && definition.expressions.length > 0) {
//   for (const track of definition.expressions) {
//     const ordered = [...track.keyframes].sort((a, b) => a.t - b.t);
//     const times = ordered.map((frame) => frame.t);
//     const values = ordered.flatMap((frame) => [frame.v, 0, 0]);
//     const nodeIndex = expressionNodeMap.get(track.name);
//     if (nodeIndex === undefined) continue;
//     addSamplerChannel(nodeIndex, 'translation', times, values, 'VEC3');
//   }
// }

// NEW CODE: Don't output expression nodes to GLB animation channels
// Expressions are stored in VRMC metadata instead (see below)
```

**Remove expression node creation from scene graph (lines 179–186):**

```typescript
// OLD: Create fake nodes for each expression
// if (definition.expressions && definition.expressions.length > 0) {
//   for (const track of definition.expressions) {
//     if (expressionNodeMap.has(track.name)) continue;
//     const index = nodes.length;
//     nodes.push({ name: `expression_${track.name}` });
//     expressionNodeMap.set(track.name, index);
//   }
// }

// NEW: Don't create expression nodes at all
// (Keep this block deleted—no nodes needed for metadata-only expressions)
```

**Modify VRMC extension to include expression samplers (lines 295–310):**

```typescript
// OLD:
// const extensions: Record<string, unknown> = {
//   VRMC_vrm_animation: {
//     specVersion: '1.0',
//     humanoid: {
//       humanBones: humanoidBones,
//     },
//     meta: { ... },
//     ...(Object.keys(expressions).length > 0 ? { expressions } : {}),
//   },
// };

// NEW:
const expressionSamplers = {
  preset: [] as Array<{ name: string; keyframes: Array<{ t: number; v: number }> }>,
  custom: [] as Array<{ name: string; keyframes: Array<{ t: number; v: number }> }>,
};

if (definition.expressions && definition.expressions.length > 0) {
  for (const track of definition.expressions) {
    const sampler = {
      name: track.name,
      keyframes: track.keyframes,
    };

    const PRESET_EXPRESSIONS_SET = new Set<string>([
      'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight',
      'happy', 'angry', 'sad', 'relaxed', 'surprised',
      'lookUp', 'lookDown', 'lookLeft', 'lookRight', 'neutral',
    ]);

    if (PRESET_EXPRESSIONS_SET.has(track.name)) {
      expressionSamplers.preset.push(sampler);
    } else {
      expressionSamplers.custom.push(sampler);
    }
  }
}

const extensions: Record<string, unknown> = {
  VRMC_vrm_animation: {
    specVersion: '1.0',
    humanoid: {
      humanBones: humanoidBones,
    },
    meta: {
      name: definition.meta.name,
      fps: definition.meta.fps,
      loop: definition.meta.loop,
      ...(typeof definition.meta.duration === 'number' ? { duration: definition.meta.duration } : {}),
      ...(definition.meta.kind ? { kind: definition.meta.kind } : {}),
    },
    // Store expressions as samplers in metadata, not as animation channels
    ...(expressionSamplers.preset.length > 0 || expressionSamplers.custom.length > 0 
      ? { 
          expressionSamplers: {
            ...(expressionSamplers.preset.length > 0 ? { preset: expressionSamplers.preset } : {}),
            ...(expressionSamplers.custom.length > 0 ? { custom: expressionSamplers.custom } : {}),
          }
        }
      : {}),
  },
};
```

**Rationale:** This removes the conflicting translation channels while preserving all expression data in the extension metadata. The GLB becomes "clean"—only bones animate. Expressions are applied separately by the renderer.

### 3. Renderer Changes (`app/renderer/src/avatar/vrm-avatar-renderer.tsx`)

**Add expression sampler playback after animation finishes:**

In the animation frame loop (around line 650–750 where `mixer.update()` is called), after bone animation is applied, add:

```typescript
// After mixer.update(delta) applies bone animations,
// apply expression keyframes from VRMC metadata

function applyExpressionFrameAtTime(vrm: VRM, vrmaData: any, currentTime: number) {
  if (!vrmaData?.extensions?.VRMC_vrm_animation?.expressionSamplers) {
    return;
  }

  const samplers = vrmaData.extensions.VRMC_vrm_animation.expressionSamplers;
  const expressionManager = vrm.expressionManager;

  if (!expressionManager) return;

  // Process preset expressions
  const presetSamplers = samplers.preset || [];
  for (const sampler of presetSamplers) {
    const value = evaluateKeyframes(sampler.keyframes, currentTime);
    if (value !== null) {
      expressionManager.setValue(sampler.name, value);
    }
  }

  // Process custom expressions
  const customSamplers = samplers.custom || [];
  for (const sampler of customSamplers) {
    const value = evaluateKeyframes(sampler.keyframes, currentTime);
    if (value !== null) {
      expressionManager.setValue(sampler.name, value);
    }
  }
}

// Helper: Linear interpolation between keyframes
function evaluateKeyframes(keyframes: Array<{ t: number; v: number }>, time: number): number | null {
  if (!keyframes || keyframes.length === 0) return null;

  // Clamp to bounds
  if (time < keyframes[0].t) return keyframes[0].v;
  if (time > keyframes[keyframes.length - 1].t) return keyframes[keyframes.length - 1].v;

  // Find surrounding keyframes
  for (let i = 0; i < keyframes.length - 1; i++) {
    const current = keyframes[i];
    const next = keyframes[i + 1];
    if (time >= current.t && time <= next.t) {
      // Linear interpolation
      const progress = (time - current.t) / (next.t - current.t);
      return current.v + (next.v - current.v) * progress;
    }
  }

  return keyframes[keyframes.length - 1].v;
}
```

**Store VRMA metadata in renderer state:**

When loading a VRMA clip, also store the parsed gltf data:

```typescript
// In loadVrmaClips() around line 171-203:
async function loadVrmaClips(vrm: VRM): Promise<Map<string, { clip: THREE.AnimationClip; vrmaData?: any }>> {
  const registry = new Map<string, { clip: THREE.AnimationClip; vrmaData?: any }>();
  // ... existing code ...
  
  const vrma = await loadVrmaAnimation(binary);
  if (!vrma) continue;
  
  const name = animation.name?.trim() || animation.id;
  const slug = toAnimationSlug(name) || `animation-${index}`;
  const clip = createClipFromVrma(vrm, vrma, name);
  
  // Store both clip AND the gltf data for expression samplers
  registry.set(slug, { 
    clip,
    vrmaData: gltf  // Store parsed GLB metadata
  });
}
```

**Call expression applier during animation playback:**

In the render loop, after `mixer.update(delta)` and before rendering:

```typescript
// Apply expressions from VRMA metadata at current animation time
const activeAnimation = activeAnimationRef.current;
if (activeAnimation?.vrmaData && currentVrmRef.current) {
  const animationTime = activeAnimation.action.time;
  applyExpressionFrameAtTime(currentVrmRef.current, activeAnimation.vrmaData, animationTime);
}
```

**Rationale:** Expressions are sampled independently from bone animation. This allows smooth blending without interfering with skeletal transforms.

### 4. Testing

**Unit test for encoder** (`app/main/tests/vrma-converter.test.ts`):

```typescript
it('encodes expressions as VRMC metadata, not animation channels', async () => {
  const definition: VrmaSchema = {
    meta: { name: 'test', fps: 30, loop: false, duration: 1 },
    tracks: [{ bone: 'hips', keyframes: [{ t: 0, q: [0, 0, 0, 1] }] }],
    hips: {},
    expressions: [
      {
        name: 'happy',
        keyframes: [
          { t: 0, v: 0 },
          { t: 0.5, v: 0.8 },
          { t: 1, v: 0 },
        ],
      },
    ],
  };

  const buffer = encodeVrmaGlb(definition);
  const gltf = extractGltfJson(buffer); // Use extraction helper

  // Assert: No translation channels in animations
  const channels = gltf.animations?.[0]?.channels || [];
  const translationChannels = channels.filter((c: any) => c.target.path === 'translation');
  expect(translationChannels).toHaveLength(0);

  // Assert: Expressions in VRMC metadata
  const vrmaExt = gltf.extensions?.VRMC_vrm_animation;
  expect(vrmaExt?.expressionSamplers?.preset?.[0]?.name).toBe('happy');
  expect(vrmaExt?.expressionSamplers?.preset?.[0]?.keyframes).toEqual([
    { t: 0, v: 0 },
    { t: 0.5, v: 0.8 },
    { t: 1, v: 0 },
  ]);
});
```

**Integration test for renderer** (`app/renderer/tests/avatar/vrm-avatar-renderer.test.tsx`):

```typescript
it('applies expression keyframes during animation playback', async () => {
  // Setup: Mock VRM with expression manager
  const expressionManager = {
    setValue: vi.fn(),
    resetValues: vi.fn(),
  };
  const vrm = {
    expressionManager,
    scene: new THREE.Scene(),
  } as unknown as VRM;

  // Load animation with expression samplers
  const vrmaData = {
    extensions: {
      VRMC_vrm_animation: {
        expressionSamplers: {
          preset: [
            {
              name: 'happy',
              keyframes: [
                { t: 0, v: 0 },
                { t: 0.5, v: 0.8 },
                { t: 1, v: 0 },
              ],
            },
          ],
        },
      },
    },
  };

  // Simulate animation playback at t=0.5
  applyExpressionFrameAtTime(vrm, vrmaData, 0.5);

  expect(expressionManager.setValue).toHaveBeenCalledWith('happy', 0.8);
});
```

## Implementation Order

1. **Encoder (vrma-converter.ts):** Remove expression channels, add expressionSamplers to metadata
2. **Schema (vrma-schema.ts):** Document expressionSamplers structure (optional, for type safety)
3. **Renderer (vrm-avatar-renderer.tsx):** Load vrmaData, apply expression samplers in frame loop
4. **Tests:** Verify no translation channels, verify expressions apply correctly

## Verification Checklist

- [ ] `pnpm lint` passes (no style issues)
- [ ] `pnpm typecheck` passes (no TS errors)
- [ ] `pnpm test` passes (especially vrma-converter and avatar renderer tests)
- [ ] Generated VRMA files have no `translation` channels (only `rotation` and hips)
- [ ] Facial expressions animate smoothly during playback
- [ ] Model no longer flips when animation starts

## Rollback Plan

If issues arise, revert to the simple Fix 1 (delete lines 268–277 only) to get stable animations without expressions until this full implementation is complete.
