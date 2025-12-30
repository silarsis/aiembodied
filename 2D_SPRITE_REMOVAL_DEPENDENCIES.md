# 2D Sprite Removal - Dependency Analysis

## Safe Removal Confirmed

### No Dependencies From 3D → 2D ✅

The 3D VRM system has **zero dependencies** on 2D sprite code:

#### VrmAvatarRenderer.tsx
```
- Depends on: AvatarModelService (VRM models only)
- Depends on: VisemeFrame (shared interface, used by both)
- Depends on: AvatarAnimationService (3D animations)
- Does NOT depend on: AvatarFaceService, AvatarRenderer, display-mode.ts
```

#### AvatarModelService
```
- Depends on: MemoryStore (for VRM models table only)
- Does NOT depend on: AvatarFaceService, face data
```

#### AvatarAnimationService
```
- Depends on: MemoryStore (for VRMA animations table only)
- Does NOT depend on: AvatarFaceService, 2D rendering
```

---

## Isolated 2D Systems

### AvatarFaceService (Complete Isolation)
```
Dependencies:
  - MemoryStore (faces & face_components tables)
  - OpenAI API (for face generation)
  
Used by:
  - App.tsx (IPC handler registration only)
  - AvatarConfigurator.tsx (2D panel only)
  
NOT used by:
  - VrmAvatarRenderer ❌
  - AvatarModelService ❌
  - AvatarAnimationService ❌
  - VrmAvatarRenderer lifecycle ❌
```

### AvatarRenderer (Complete Isolation)
```
Dependencies:
  - VisemeFrame interface (shared; used by VRM too)
  - AvatarComponentAsset (2D-specific type)
  - Canvas 2D API
  
Used by:
  - App.tsx (conditional rendering only)
  
NOT used by:
  - Any 3D code ❌
  - Any model management ❌
  - Any animation system ❌
```

### display-mode.ts (Switching Only)
```
Dependencies:
  - AvatarDisplayState (local state type)
  - AvatarModelSummary (to check if VRM is available)
  
Used by:
  - App.tsx (reducer for display preference)
  
Purpose:
  - Toggles between AvatarRenderer and VrmAvatarRenderer
  - Falls back to sprites on VRM error
  
Removal effect:
  - Always render VrmAvatarRenderer
  - Remove fallback logic
  - VRM errors are displayed but don't change renderer
```

---

## Shared Interfaces (Safe to Keep / Modify)

### VisemeFrame
```typescript
interface VisemeFrame {
  t: number;              // timestamp
  index: number;          // viseme index 0-4
  intensity: number;      // 0-1
  blink?: boolean;        // optional
}
```
- Used by: AvatarRenderer (2D), VrmAvatarRenderer (3D), VisemeDriver
- Safe to keep: Yes, needed by 3D system
- Action: Keep unchanged

### AvatarDisplayMode
```typescript
type AvatarDisplayMode = 'sprites' | 'vrm';
```
- Currently stored in MemoryStore
- Action options:
  1. Delete entirely (simplest)
  2. Change to `type AvatarDisplayMode = 'vrm';` (constant)
  3. Keep but always return 'vrm' from getter

---

## Test Dependencies

### Tests Importing AvatarRenderer
```
app/renderer/tests/avatar/avatar-renderer.test.tsx
  ├─ Tests canvas rendering
  ├─ Tests viseme telemetry
  └─ Tests aria labels
  
Status: Safe to delete (standalone tests)
```

### Tests Importing display-mode.ts
```
app/renderer/tests/avatar/display-mode.test.ts
  ├─ Tests mode switching logic
  ├─ Tests VRM error fallback
  └─ Tests parseAvatarDisplayMode()
  
Status: Safe to delete (no other code depends on reducer)
```

### Tests Importing AvatarFaceService
```
app/main/tests/avatar-face-service.test.ts
  ├─ Tests face generation
  ├─ Tests component extraction
  └─ Tests face deletion
  
Status: Safe to delete (service will be removed)
```

### Tests Affected (Need Updates)
```
app/renderer/tests/avatar/avatar-configurator.test.tsx
  ├─ Lines 119-219: 2D face tests (DELETE)
  ├─ Lines 286-430: 3D model tests (KEEP)
  └─ Lines 286-320: VRMA animation tests (KEEP)

app/renderer/tests/App.test.tsx
  ├─ Display mode toggle tests (DELETE)
  ├─ 2D face API mocks (DELETE)
  └─ VRM rendering tests (KEEP)

app/main/tests/main.test.ts
  ├─ Face IPC handler tests (DELETE)
  ├─ Display mode IPC tests (EVALUATE)
  └─ VRM model IPC tests (KEEP)

app/main/tests/memory-store.test.ts
  ├─ Face CRUD tests (DELETE)
  ├─ Face component tests (DELETE)
  └─ VRM model tests (KEEP)
```

---

## Database Impact

### Current Schema
```sql
-- To Remove:
CREATE TABLE faces (id TEXT, name TEXT, ...);
CREATE TABLE face_components (id TEXT, face_id TEXT, slot TEXT, ...);

-- To Keep:
CREATE TABLE vrm_models (id TEXT, name TEXT, ...);
CREATE TABLE vrma_animations (id TEXT, name TEXT, ...);
```

### Migration Strategy
- Create a new migration version that drops `faces` and `face_components` tables
- Safe: No other tables reference these (no foreign keys)
- Safe: No other code queries these tables after removal

### Memory Store Changes
```typescript
// Remove from MemoryStore class:
- createFace()
- getFace()
- deleteFace()
- listFaces()
- createFaceComponent()
- deleteComponentsByFaceId()
- listFaceComponentsByFaceId()
- listAllFaceComponents()

// Remove from MemoryStore exports:
- FaceRecord interface
- FaceComponentRecord interface
- SerializedFaceComponent interface

// Remove constants:
- FACES_TABLE
- FACE_COMPONENTS_TABLE
```

---

## Import Graph Analysis

### Files Importing `avatar-renderer.tsx`
```
App.tsx:
  import { AvatarRenderer } from './avatar/avatar-renderer.js';
  (Only place using it)
```

### Files Importing `display-mode.ts`
```
App.tsx:
  import { avatarDisplayReducer, DEFAULT_AVATAR_DISPLAY_STATE, ... } from './avatar/display-mode.js';
  (Only place using it)
```

### Files Importing `avatar-face-service.ts`
```
main.ts:
  import { AvatarFaceService } from './avatar/avatar-face-service.js';
  (Only place instantiating it)
```

### Files Importing From `types.ts` (2D-Specific Types)
```
avatar-configurator.tsx:
  import type { AvatarFaceSummary, ... } from './types.js';

avatar-face-service.ts:
  import type { AvatarUploadRequest, ... } from './types.js';
  
avatar-renderer.tsx:
  import type { AvatarComponentAsset, ... } from './types.js';

app/main/src/avatar/avatar-face-service.ts:
  Uses 2D-related types exported from renderer (via types.ts)
```

---

## Removal Order (Recommended)

1. **Start with tests** (no other code depends on them)
   - Delete `avatar-renderer.test.tsx`
   - Delete `display-mode.test.ts`
   - Delete `avatar-face-service.test.ts` (if exists)
   - Update `avatar-configurator.test.tsx` (remove 2D cases)
   - Update `App.test.tsx` (remove display mode tests)

2. **Remove 2D service** (main process)
   - Delete `app/main/src/avatar/avatar-face-service.ts`
   - Update `main.ts` (remove imports, initialization, IPC handlers)
   - Update `preload.ts` (remove face IPC channels)
   - Update `memory-store.ts` (remove face tables, methods, types)

3. **Remove 2D display mode** (renderer)
   - Delete `app/renderer/src/avatar/display-mode.ts`
   - Update `App.tsx` (remove toggle logic, always render VRM)

4. **Remove 2D renderer** (renderer)
   - Delete `app/renderer/src/avatar/avatar-renderer.tsx`
   - Update `App.tsx` (remove import, conditional rendering)

5. **Simplify types** (renderer)
   - Update `app/renderer/src/avatar/types.ts`
   - Remove 2D-specific type definitions
   - Simplify `AvatarBridge` interface

6. **Simplify configurator** (renderer)
   - Update `avatar-configurator.tsx` (remove 2D panel, always show 3D)

7. **Update remaining tests**
   - Update `main.test.ts` (remove face IPC handler tests)
   - Update `memory-store.test.ts` (remove face CRUD tests)

8. **Styling** (optional, no functional impact)
   - Remove sprite canvas CSS rules from `index.css`
   - Remove avatar mode toggle styles

---

## Verification Checklist

After removal, verify:

- [ ] `pnpm typecheck` passes (no broken type references)
- [ ] `pnpm lint` passes (no dead imports or exports)
- [ ] `pnpm test` passes (all tests updated and passing)
- [ ] App launches successfully
- [ ] Avatar tab shows only 3D model management
- [ ] No "Use sprite avatar" toggle visible
- [ ] VRM model loads and renders correctly
- [ ] Viseme animation works with VRM
- [ ] VRMA animations play correctly
- [ ] No console errors or warnings about missing faces
- [ ] Display mode preference is always 'vrm' (or type removed entirely)

---

## Rollback Considerations

If needed to rollback:
- Git history preserves all removed code
- No database migration is destructive (faces table can be recreated)
- VRM system continues to work independently

---

## Conclusion

✅ **Safe to Remove**: All 2D sprite code is self-contained and isolated.
✅ **No Risk to 3D**: VRM system has zero dependencies on 2D code.
✅ **Clean Removal**: Removal is surgical with no cascading failures.
