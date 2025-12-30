# 2D Sprite Removal - Quick Reference

## Files to Delete (8 files, ~1,255 lines)

### Renderer (Client-side)
```
app/renderer/src/avatar/avatar-renderer.tsx          (418 lines - 2D canvas renderer)
app/renderer/tests/avatar/avatar-renderer.test.tsx   (45 lines - 2D tests)
app/renderer/src/avatar/display-mode.ts              (84 lines - mode switching)
app/renderer/tests/avatar/display-mode.test.ts       (78 lines - mode tests)
```

### Main Process (Server-side)  
```
app/main/src/avatar/avatar-face-service.ts           (~630 lines - 2D face service)
app/main/tests/avatar-face-service.test.ts           (unknown lines - face tests)
```

---

## Files to Modify (7 files)

### Primary Changes
```
app/renderer/src/App.tsx                             (remove toggle, simplify rendering)
  └─ Remove: import AvatarRenderer
  └─ Remove: avatarDisplayState reducer & effects
  └─ Remove: toggleAvatarDisplayMode callback
  └─ Remove: display mode toggle button
  └─ Change: Always render VrmAvatarRenderer
  └─ Remove: Fallback to sprites on VRM error

app/main/src/main.ts                                 (remove face service initialization)
  └─ Remove: AvatarFaceService import & init
  └─ Remove: IPC handlers (avatar:list-faces, avatar:generate-face, etc.)

app/renderer/src/avatar/avatar-configurator.tsx      (remove 2D panel)
  └─ Remove: 2D face upload/generation UI
  └─ Remove: Face selection and deletion UI
  └─ Keep: 3D model management
  └─ Keep: VRMA animation generation
```

### Type Definitions
```
app/renderer/src/avatar/types.ts                     (remove 2D-specific types)
  └─ Remove: AvatarDisplayMode = 'sprites' | 'vrm'
  └─ Remove: AvatarComponentSlot (base, mouth-*, eyes-*)
  └─ Remove: AvatarFaceSummary, AvatarFaceDetail
  └─ Remove: AvatarComponentAsset, AvatarUploadRequest/Result
  └─ Remove: AvatarGenerationStrategy, AvatarGenerationResult
  └─ Simplify: AvatarBridge interface (remove face methods)
```

### Infrastructure
```
app/main/src/preload.ts                              (remove face IPC channels)
  └─ Remove: All avatar.face.* channel registrations

app/main/src/memory/memory-store.ts                  (remove face tables)
  └─ Remove: faces table definition
  └─ Remove: face_components table definition
  └─ Remove: Face CRUD methods & types

app/renderer/src/index.css                           (optional - remove sprite styles)
  └─ Remove: .avatar__canvas styling
  └─ Remove: .kiosk__avatarModeToggle styling
```

### Tests to Update
```
app/renderer/tests/avatar/avatar-configurator.test.tsx  (remove 2D test cases)
  └─ Remove: Lines 119-219 (face tests)
  └─ Keep: Lines 286-430 (VRM tests)

app/renderer/tests/App.test.tsx                         (remove display mode tests)
  └─ Remove: Display toggle tests
  └─ Remove: 2D face API mocks
  └─ Keep: VRM tests

app/main/tests/main.test.ts                             (remove face IPC tests)
app/main/tests/memory-store.test.ts                     (remove face CRUD tests)
```

---

## What STAYS (No Changes Needed)

### 3D VRM System ✅
```
app/renderer/src/avatar/vrm-avatar-renderer.tsx      (unchanged)
app/main/src/avatar/avatar-model-service.ts          (unchanged)
app/main/src/avatar/avatar-animation-service.ts      (unchanged)
```

### Shared Infrastructure ✅
```
VisemeFrame interface                                 (used by both 2D & 3D)
AvatarAnimationService                                (3D animations only)
Behavior cue system                                   (triggers 3D animations)
Idle animation scheduler                              (3D only)
```

---

## Impact Analysis

### Breaking Changes: 0 ❌
No 3D code depends on 2D code.

### Type Changes: Several ✅
- `AvatarDisplayMode` removed or becomes constant
- `AvatarBridge` loses face methods
- App.tsx state simplified

### Database Changes: Safe ✅
- Drop `faces` and `face_components` tables
- No foreign key constraints to worry about
- VRM models and animations unchanged

### UI Changes: Visible ✅
- No "Use sprite avatar" / "Use 3D avatar" toggle
- Only 3D model management panel visible
- Avatar tab simplified

---

## Removal Sequence

```
1. Delete tests
   └─ avatar-renderer.test.tsx
   └─ display-mode.test.ts

2. Delete services
   └─ avatar-face-service.ts (renderer + main)

3. Delete display mode
   └─ display-mode.ts

4. Delete renderer
   └─ avatar-renderer.tsx

5. Update App.tsx
   └─ Remove toggle, always render VRM

6. Update types.ts
   └─ Remove 2D-specific types

7. Update configurator
   └─ Remove 2D panel

8. Update memory store
   └─ Drop face tables

9. Update main.ts & preload.ts
   └─ Remove IPC handlers

10. Update remaining tests
    └─ Remove face-related mocks
```

---

## Testing After Removal

```bash
# Type check
pnpm typecheck

# Lint for dead imports
pnpm lint

# Run tests (should all pass)
pnpm test

# Manual testing
pnpm dev:run
  → App launches
  → Avatar tab shows only 3D models
  → VRM model loads and renders
  → Viseme animation works
  → VRMA animations play
```

---

## Key Stats

| Metric | Count |
|--------|-------|
| Files deleted | 6 |
| Files modified | 7 |
| Lines removed | ~1,255 |
| Lines added | ~50 (cleanup) |
| Breaking changes | 0 |
| Tests to rewrite | ~50 lines |

**Net Result**: Codebase simplified, 3D system unaffected, all functionality consolidated to VRM.
