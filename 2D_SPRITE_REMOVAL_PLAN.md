# 2D Sprite Avatar Removal Plan

## Overview
This document outlines all 2D sprite avatar support code that will be removed to consolidate on 3D VRM models only.

## Key Finding: No Shared Code Between 2D and 3D

The 2D sprite system and 3D VRM system are **completely independent**:
- 2D uses the `AvatarRenderer` (Canvas-based)
- 3D uses the `VrmAvatarRenderer` (Three.js/WebGL)
- They are swapped via a display mode toggle
- No code is shared between the two renderers

This means removal is safe and surgical—no 3D code depends on 2D code.

---

## Code to Remove

### 1. **Renderer Components & Logic**

#### Files to Delete:
- `app/renderer/src/avatar/avatar-renderer.tsx` (418 lines)
  - Canvas-based 2D sprite renderer with idle animations, blink logic, and viseme-driven mouth shapes
  - Completely standalone; VRM renderer doesn't depend on it

#### Files to Modify:
- `app/renderer/src/App.tsx`
  - Remove import: `import { AvatarRenderer } from './avatar/avatar-renderer.js';` (line ~1)
  - Remove toggle logic in `toggleAvatarDisplayMode` (lines 909-912)
  - Remove `avatarDisplayToggleLabel` computation (line ~2131)
  - Simplify avatar rendering section (lines 2225-2261): Remove conditional that switches between VRM and 2D, always render VrmAvatarRenderer
  - Remove display mode toggle button UI (lines 2246-2260)
  - Remove error message UI that shows VRM fallback errors (lines 2256-2260)
  - Simplify or remove the `handleVrmStatusChange` callback since fallback to sprites won't exist (lines 890-899)
  - Remove `avatarDisplayState` and `dispatchAvatarDisplay` reducer logic (lines ~650-770)
  - Keep the VRM model loading and status handling

### 2. **Avatar Display Mode System**

#### Files to Delete:
- `app/renderer/src/avatar/display-mode.ts` (84 lines)
  - Reducer and state machine for managing sprite/VRM mode switching
  - Handles fallback to sprites on VRM errors
  - Stores user preference
  - All functionality becomes unnecessary

#### Files to Modify:
- `app/renderer/src/avatar/types.ts`
  - Remove: `export type AvatarDisplayMode = 'sprites' | 'vrm';` (line 1)
  - This type is used in AvatarBridge, IPC, and storage

- `app/renderer/src/avatar/avatar-configurator.tsx`
  - Lines ~697-701: Remove 2D vs 3D panel description text
  - Change `panel` prop logic to always show '3d' tab content
  - Remove description: `'Upload and manage 2D sprite faces for your avatar.'`

### 3. **2D Face Management System** (AvatarFaceService)

#### Files to Delete (Main Process):
- `app/main/src/avatar/avatar-face-service.ts` (~630 lines)
  - Handles generation, application, and deletion of 2D faces
  - Manages face components (base, eyes-open, eyes-closed, mouth-0 to mouth-4)
  - Completely separate from VRM system

#### Files to Modify:
- `app/main/src/main.ts`
  - Remove import: `import { AvatarFaceService } from './avatar/avatar-face-service.js';` (line ~30)
  - Remove initialization (lines ~264-310)
  - Remove IPC handlers:
    - `avatar:list-faces` (lines ~840-847)
    - `avatar:get-active-face` (lines ~848-859)
    - `avatar:set-active-face` (lines ~860-871)
    - `avatar:generate-face` (lines ~872-880)
    - `avatar:apply-face` (lines ~881-????)
    - `avatar:delete-face` (lines ~???-???)

- `app/main/src/preload.ts`
  - Remove face-related IPC channel whitelist entries for avatar.face methods:
    - `listFaces`, `getActiveFace`, `setActiveFace`, `generateFace`, `applyGeneratedFace`, `deleteFace`

- `app/main/src/memory/memory-store.ts`
  - Remove face and face component database tables:
    - `CREATE TABLE faces(...)`
    - `CREATE TABLE face_components(...)`
  - Remove methods:
    - `createFace()`, `getFace()`, `deleteFace()`, `listFaces()`
    - `createFaceComponent()`, `getFaceComponent()`, `listFaceComponents()`, `deleteComponentsByFaceId()`
  - Remove type definitions:
    - `FaceRecord`
    - `FaceComponentRecord`
    - `SerializedFaceComponent`

### 4. **Type Definitions & Bridge**

#### Files to Modify:
- `app/renderer/src/avatar/types.ts`
  - Remove:
    - `AvatarComponentSlot` type (lines 3-12) — only used for 2D sprites
    - `AvatarFaceSummary` interface
    - `AvatarComponentAsset` interface
    - `AvatarFaceDetail` interface
    - `AvatarUploadRequest` interface (2D-specific)
    - `AvatarUploadResult` interface (2D-specific)
    - `AvatarGenerationStrategy` type (used for face generation only)
    - `AvatarGenerationCandidateSummary` interface
    - `AvatarGenerationResult` interface
    - Lines 1, 3-57 (everything related to 2D faces and components)
  
  - Keep:
    - `AvatarModelSummary`, `AvatarModelUploadRequest`, `AvatarModelUploadResult`
    - `AvatarAnimationSummary`, `AvatarAnimationUploadRequest`, `AvatarAnimationUploadResult`, `AvatarAnimationGenerationRequest`
    - VRM-specific interfaces

- `app/renderer/src/avatar/types.ts` - Simplify `AvatarBridge`
  - Remove methods:
    - `listFaces()`, `getActiveFace()`, `setActiveFace()` 
    - `generateFace()`, `applyGeneratedFace()`, `deleteFace()`
    - `getDisplayModePreference()`, `setDisplayModePreference()`
  - Keep:
    - VRM model methods: `listModels()`, `getActiveModel()`, `setActiveModel()`, etc.
    - Animation methods: `listAnimations()`, `uploadAnimation()`, `generateAnimation()`, etc.
    - `triggerBehaviorCue()` (used by 3D animations/behaviors)

### 5. **Avatar Configurator UI**

#### Files to Modify:
- `app/renderer/src/avatar/avatar-configurator.tsx`
  - Remove the 2D panel/tab structure
  - Type `PanelId = '2d' | '3d'` becomes unnecessary; only '3d' remains
  - Remove all 2D face generation UI:
    - Face image upload form
    - Face generation workflow
    - Face selection and deletion
    - Face component preview logic
  - Keep:
    - 3D VRM model management (upload, select, delete)
    - VRMA animation generation
    - Display mode toggle (if keeping it) or remove if always using VRM
    - Model description and thumbnail editing

### 6. **Tests to Delete**

#### Files to Delete:
- `app/renderer/tests/avatar/avatar-renderer.test.tsx` (45 lines)
  - Tests sprite canvas rendering, viseme telemetry, aria labels
  - Completely specific to 2D sprite renderer

- `app/renderer/tests/avatar/display-mode.test.ts` (78 lines)
  - Tests display mode reducer, mode switching logic, VRM fallback behavior
  - Tests `parseAvatarDisplayMode`, `avatarDisplayReducer`, `shouldRenderVrm`

- `app/main/tests/avatar-face-service.test.ts` (if exists)
  - Tests face generation, component extraction, face deletion logic

#### Files to Modify:
- `app/renderer/tests/avatar/avatar-configurator.test.tsx`
  - Remove test cases for 2D face operations (lines ~119-219):
    - "renders stored faces and supports selection and deletion"
    - "uploads a new face image and refreshes the listing"
    - "shows uploading state while generation is pending..."
  - Keep test cases for:
    - VRM model management (lines ~286-430)
    - VRMA animation generation (lines ~286-320)
    - VRM upload validation (lines ~432-447)

- `app/renderer/tests/App.test.tsx`
  - Remove any tests for display mode toggle or sprite rendering
  - Simplify to remove mocks for face-related APIs
  - Keep VRM model and animation tests

- `app/main/tests/main.test.ts`
  - Remove tests for face-related IPC handlers:
    - `avatar:list-faces`
    - `avatar:get-active-face`
    - `avatar:set-active-face`
    - `avatar:generate-face`
    - `avatar:apply-face`
    - `avatar:delete-face`
  - Keep tests for display mode IPC (or remove if not needed once display mode is simplified)
  - Keep VRM model and animation tests

- `app/main/tests/memory-store.test.ts`
  - Remove tests for face and face component CRUD operations
  - Keep VRM model and animation tests

### 7. **IPC Preload Bridge**

#### Files to Modify:
- `app/main/src/preload.ts`
  - Remove all face-related IPC channel registrations
  - Remove the entire `avatar.face` property from contextBridge if it exists
  - Keep:
    - `avatar.models` methods
    - `avatar.animations` methods
    - `avatar.triggerBehaviorCue()`
    - `avatar.loadModelBinary()` (needed by VRM renderer)

### 8. **Memory Store / Database**

#### Files to Modify:
- `app/main/src/memory/memory-store.ts`
  - Remove migration for face and face_component tables (if versioning exists)
  - Remove constants: `FACE_TABLE`, `FACE_COMPONENTS_TABLE`, etc.
  - Remove face-related getters/setters from MemoryStore class

### 9. **UI Styling**

#### Files to Modify:
- `app/renderer/src/index.css`
  - Lines with `.avatar__canvas` styling can be removed (sprite canvas styles)
  - Lines with `.kiosk__avatarModeToggle` and toggle-related styles can be removed if toggle is deleted
  - Keep styles for:
    - `.kiosk__avatar` (container now only holds VRM canvas/WebGL)
    - `.kiosk__avatarDetails`

---

## Changes That Are Safe

✅ **VRM avatar system has NO dependencies on 2D code:**
- `VrmAvatarRenderer` only uses VRM models from `AvatarModelService`
- Viseme driving works the same for both renderers (via shared `VisemeFrame` interface)
- Behavior cues work independently
- VRMA animation system only interacts with VRM

✅ **Display mode system only affects switching logic:**
- Once removed, only VRM is ever rendered
- No cascading failures to other systems

✅ **Face generation only affects 2D rendering:**
- Completely isolated to `AvatarFaceService`
- No references from 3D code

---

## Summary of Changes

| Category | Files to Delete | Lines Deleted |
|----------|-----------------|---------------|
| 2D Sprite Renderer | `avatar-renderer.tsx` | 418 |
| Display Mode | `display-mode.ts` | 84 |
| 2D Face Service | `avatar-face-service.ts` | ~630 |
| Tests | `avatar-renderer.test.tsx`, `display-mode.test.ts` | ~123 |
| **Total** | **~4 files** | **~1,255 lines** |

| Category | Files to Modify | Scope |
|----------|-----------------|-------|
| Main App UI | `App.tsx` | Remove toggle, simplify rendering |
| Configurator UI | `avatar-configurator.tsx` | Remove 2D panel, simplify to 3D only |
| Type Definitions | `types.ts` | Remove 2D-specific types |
| Preload Bridge | `preload.ts` | Remove face-related IPC |
| Memory Store | `memory-store.ts` | Remove face tables & methods |
| Tests | 4 test files | Remove 2D-specific test cases |
| Styling | `index.css` | Remove sprite canvas styles |

---

## Verification Strategy

After removal:
1. `pnpm typecheck` — Should pass (no broken type references)
2. `pnpm lint` — Should pass (no dead imports)
3. `pnpm test` — Should pass (all tests pass after updating stubs)
4. `pnpm dev:run` — App should launch with only VRM rendering available
5. Avatar tab should show VRM model selector + configurator for 3D models only
