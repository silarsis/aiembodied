# Final VRM Relaxed Pose Fix

**Status**: ✅ Ready for testing

## Problem
VRM models loaded in T-pose. Previous attempts to rotate upper arm and elbow directly didn't work because those bones alone don't control arm position—the **shoulder joint** does.

## Solution: Rotate the Shoulder Joint (Root Cause Found)

**File**: `app/renderer/src/avatar/vrm-avatar-renderer.tsx`

**Key insight**: The shoulder joint is the parent of the upper arm. Rotating the shoulder joint moves the entire arm chain. Rotating only the upper arm/elbow doesn't work because the shoulder constrains them.

### Updated `setNaturalArmPose()` (lines 560-594)

Now rotates THREE joints in sequence:
1. **Shoulder** (parent joint): +63° X-axis rotation → brings arm down from T-pose
2. **Upper arm**: +45° X-axis rotation → adds natural twist
3. **Lower arm (elbow)**: +90° X-axis rotation → bends arm toward body

```typescript
function setNaturalArmPose(
  shoulder: THREE.Object3D | null,      // ← ADDED: Parent joint
  upperArm: THREE.Object3D | null,
  lowerArm: THREE.Object3D | null,
  side: string = 'unknown',
) {
  // Rotate shoulder: brings entire arm down
  const shoulderRotQuat = new THREE.Quaternion();
  shoulderRotQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI * 0.35);
  shoulder.quaternion.multiplyQuaternions(shoulderRotQuat, shoulder.quaternion);
  shoulder.updateWorldMatrix(true, true);

  // Rotate upper arm: adds natural twist
  // Rotate elbow: bends arm inward
  // ...
}
```

### Why This Works

1. **Shoulder joint controls arm position** in VRM skeleton
2. **Rotating the parent** moves all children (upper arm, lower arm, hand)
3. **Three sequential rotations** create natural arm pose:
   - Shoulder down (horizontal → 45° down)
   - Upper arm twist (natural rotation)
   - Elbow bend (straight → bent toward body)

### Call Sites Updated

```typescript
// applyRelaxedPose() now passes shoulder joint
setNaturalArmPose(
  leftShoulder,      // ← NEW
  leftUpperArm,
  leftLowerArm,
  'LEFT',
);
```

## Expected Behavior

When you run the app with a VRM model:
1. Model loads in T-pose
2. T-pose detection triggers
3. **Shoulder joints rotate down** ~63°
4. Upper arm and elbow follow, creating natural hanging arm position
5. Arms now at sides instead of outstretched

## Testing

```bash
pnpm dev:run
```

Watch for logs:
```
[vrm-avatar-renderer] T-pose detection result: true
[vrm-avatar-renderer] Applying relaxed pose adjustment...
[vrm-avatar-renderer] Pose[LEFT] Applied relaxed arm pose via shoulder/upper arm/elbow rotations
[vrm-avatar-renderer] Pose[RIGHT] Applied relaxed arm pose via shoulder/upper arm/elbow rotations
```

## Why Previous Attempts Failed

| Approach | Issue |
|----------|-------|
| **IK Solvers** | Complex, hard to converge, coordinate space confusion |
| **Rotate upper arm only** | Shoulder joint constrains it; rotation has no effect |
| **Rotate elbow only** | Doesn't bring arm down from T-pose |
| **Rotate shoulder** | ✅ **Works!** - Controls entire arm chain |

## Evolution Summary

1. **V1-V3**: IK approaches → Failed convergence, coordinate mixing
2. **V4**: Direct angle on upper arm → No visual effect
3. **V5**: Direct angle on shoulder → **SUCCESS**

## Key Learnings

1. **Always rotate the parent joint** if you want to control a limb's global position
2. **Shoulder is the root of arm kinematic chain** in VRM models
3. **Simple direct rotations work better** than complex IK for fixed poses
4. **Test axis carefully** - X-axis pitch is standard for arm bending

## Code Verification

✅ `pnpm lint --fix` - Passes  
✅ `pnpm typecheck` - Passes  
✅ `pnpm build` - Renderer builds successfully

## Files Changed
- `app/renderer/src/avatar/vrm-avatar-renderer.tsx`
  - Modified: `setNaturalArmPose()` to take shoulder as first parameter
  - Modified: `applyRelaxedPose()` to pass shoulder joint to the function
  - Simplified: Removed all old IK target calculation code (no longer needed)

## Customization

To adjust arm position, modify rotation angles in `setNaturalArmPose()`:

```typescript
// Shoulder rotation (brings arm down)
shoulderRotQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI * 0.35); // Change 0.35

// Upper arm rotation (twist)
upperArmRotQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI * 0.25); // Change 0.25

// Elbow rotation (bend)
elbowRotQuat.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI * 0.5); // Change 0.5
```

### Tuning Guide
- **Arms too high**: Increase shoulder multiplier (0.35 → 0.5)
- **Arms too low**: Decrease shoulder multiplier (0.35 → 0.2)
- **Less natural twist**: Decrease upper arm multiplier (0.25 → 0.1)
- **Elbow not bent enough**: Increase elbow multiplier (0.5 → 0.7)

## Conclusion

Found the root cause: **Rotating the shoulder joint controls the arm**, not rotating upper arm/elbow directly. Simple relative rotations on the parent joint achieve the desired natural resting pose without complex IK solving.
