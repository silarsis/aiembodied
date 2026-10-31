# Avatar studio review artifacts

- `emotion-pose-review-2026-10-31`: initial pose candidates, superseded by the corrected v2 set.
- `emotion-pose-review-2026-10-31-v2`: approved poses with the shoulder correction and verification evidence.
- `background-review-2026-10-31`: the five background scenes rendered with the avatar, including responsive layout checks.
- `avatar-restyle-review-2026-10-31`: review flow for the previous texture-only avatar pipeline.
- `new-avatar-mvp-2026-10-31`: live concept and textured mesh generation, the rigged VRM sample, expression/gesture renders and isolated app acceptance checks. See `docs/features/new-avatar-generation.md` for limitations.

- `avatar-image-review-2026-10-31`: compact image thumbnails, full-size popup, uploaded-reference validation and explicit approval before 3D generation.

These are development review outputs. Runtime defaults are shipped separately under `app/main/assets/` and `app/main/src/avatar/base-poses/`.
