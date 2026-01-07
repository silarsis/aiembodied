# Meshy API Integration Plan (Design Only)

## Goals
- Add support for the Meshy API to generate FBX avatars from plain-English prompts and rig them with a skeleton.
- Store a Meshy API key in the Local tab settings (alongside existing secrets) with secure main-process persistence.
- Present a preview image of the generated avatar for user acceptance before converting to VRM.
- Convert the accepted FBX to VRM using the in-development `Fbx2vrm` library and persist the VRM model for use.

## Non-Goals (for this phase)
- Implementing full Meshy job management UI (history, cancellation, retries, progress graphs).
- Shipping automated moderation or content policy enforcement beyond basic error display and opt-in acceptance.
- Advanced animation/retargeting tuning beyond the default skeleton provided by Meshy and the initial FBX→VRM conversion.

## Product & Architecture Alignment
- **PRD alignment**: The kiosk-ready workflow must be low-latency and simple for operators; plan prioritizes minimal UI friction while keeping assets local.
- **Architecture boundaries**: Meshy requests and binary asset handling live in the **main process**; renderer interacts via preload IPC bridges for security.

## User Flow
1. **Local tab**: User enters Meshy API key and saves/test-validates it.
2. **Character tab**: User enters a plain-English avatar description.
3. Renderer submits request to main process to kick off Meshy generation.
4. UI shows progress (queued → generating → rigging) and a generated preview image.
5. User accepts or rejects the preview:
   - Reject: discard files and keep current avatar.
   - Accept: run FBX→VRM conversion (via `Fbx2vrm`), persist VRM, and set as active.

## Meshy API (High-Level Design)
> **Note:** Confirm final endpoints and payloads against Meshy documentation before implementation.

### Proposed Operations
- **Create generation job**
  - Input: `{ prompt, style, model_format: 'fbx', rig: true }` (exact fields TBD)
  - Output: job id, status URL
- **Poll job status**
  - Output: status, progress, asset URLs (FBX, preview image)
- **Download assets**
  - FBX binary
  - Preview PNG/JPEG

### Error Handling
- Network and authentication failures yield actionable errors in UI.
- If rigging fails, prompt user to retry with adjusted prompt or settings.

## Data Model & Persistence
- **Secrets**
  - Extend config storage with `meshyApiKey`.
  - Use main-process secret validation APIs similar to existing key flows.
- **Avatar assets**
  - Store generated FBX in `userData/meshy-exports/<job-id>.fbx`.
  - Store preview image in `userData/meshy-exports/<job-id>.png`.
  - Store converted VRM in `userData/vrm-models` and register in `vrm_models` table.

## IPC / Preload Contract
- `config.saveMeshyKey(key)` / `config.testMeshyKey()`
- `avatar.generateMeshyModel({ prompt })`
  - returns `{ jobId }`
- `avatar.getMeshyStatus(jobId)`
  - returns `{ status, progress, previewPath?, fbxPath? }`
- `avatar.acceptMeshyModel(jobId)`
  - runs conversion + persists VRM, returns `{ vrmId }`
- `avatar.rejectMeshyModel(jobId)`
  - cleans up temporary assets

## Renderer UI Changes
- **Local tab**
  - Add Meshy API key input + “Save” and “Test” actions.
- **Character tab**
  - Add prompt input + “Generate” button.
  - Show progress steps and preview image.
  - “Accept” and “Reject” actions.

## Main Process Responsibilities
- Meshy client wrapper with:
  - request signing
  - job creation & polling
  - asset downloads
- Validation for Meshy API key during `testMeshyKey`.
- Asset persistence and cleanup.
- Orchestrate conversion using `Fbx2vrm`.

## FBX → VRM Conversion (Fbx2vrm)
- Use the library at `github.com/silarsis/Fbx2vrm` (in development).
- Wrap in a main-process service:
  - `convertFbxToVrm({ fbxPath, outputPath })`
  - Validate output VRM schema + thumbnail generation
- Capture logs and surface conversion errors with details.

## Observability
- Log Meshy job lifecycle events, status polling outcomes, and asset download sizes.
- Log conversion duration and any warnings from the converter.

## Testing Strategy
- **Renderer tests**
  - Local tab: verify Meshy key form saves/test actions.
  - Character tab: verify generate flow, preview rendering, accept/reject handling.
- **Main process tests**
  - Meshy client request validation and error handling.
  - Conversion service stub tests with mocked `Fbx2vrm`.

## Rollout Steps
1. Add Meshy key storage + validation in Local tab.
2. Add Meshy job orchestration in main process.
3. Add Character tab UI for prompt → preview → accept/reject.
4. Integrate FBX→VRM conversion and persist models.
5. Add tests and logging.

## Step-by-Step Build Plan
1. **Review specs & dependencies**
   - Re-read `prd.md`, `archspec.md`, and the relevant section in `plan.md` to confirm scope and architecture boundaries.
   - Verify the current Meshy API documentation for the latest endpoints, payloads, and rate limits.
   - Check the current status of `github.com/silarsis/Fbx2vrm` and note any API changes or platform constraints.
2. **Define data contracts**
   - Add a Meshy API key entry to the main-process config schema and secure storage.
   - Define IPC types for Meshy job creation, status polling, acceptance, and rejection.
3. **Main-process Meshy client**
   - Implement a Meshy API wrapper with typed request/response models.
   - Add request signing/auth handling and error normalization.
   - Implement asset downloads (FBX + preview image) and persistence under `userData/meshy-exports`.
4. **Job orchestration**
   - Implement a Meshy job service that creates jobs, polls status, and emits progress updates.
   - Store job metadata (status, timestamps, asset paths) to support resume/retry.
5. **FBX → VRM conversion**
   - Wrap the `Fbx2vrm` library in a main-process service with structured logging.
   - Validate output VRM files and generate a thumbnail.
   - Persist converted VRMs in `userData/vrm-models` and register in the `vrm_models` table.
6. **Preload bridge**
   - Add `config.saveMeshyKey`, `config.testMeshyKey`, and `avatar.*MeshyModel` APIs.
   - Ensure IPC channel whitelists and input validation match the existing security model.
7. **Renderer: Local tab**
   - Add Meshy API key input, Save, and Test actions.
   - Surface validation errors and success states without blocking other controls.
8. **Renderer: Character tab**
   - Add prompt input, Generate button, and progress UI.
   - Render preview image with Accept/Reject actions.
   - On acceptance, switch the active VRM model to the newly generated one.
9. **Testing**
   - Add renderer tests for Local/Character tab flows and state transitions.
   - Add main-process tests for Meshy client, job service, and converter wrapper.
   - Update any existing mocks or fixtures as needed.
10. **Observability & cleanup**
    - Add structured logs for Meshy job lifecycle and conversion timing.
    - Ensure temporary assets are cleaned up on rejection or failure.
11. **Documentation & rollout**
    - Update any user-facing docs or onboarding notes for the new flow.
    - Confirm the feature matches PRD/archspec requirements and adjust if needed.

## Open Questions
- Meshy API rate limits, pricing, and max asset sizes.
- Final payload format for rigging and output selection.
- Whether Meshy provides guaranteed T-pose or standardized skeleton naming.
