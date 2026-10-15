# Project: OpenCreator Operations & Stability Hardening

## Architecture
OpenCreator is a desktop-and-web video creation and translation workspace consisting of:
- **Frontend (`apps/web`)**: Next.js / React application with specialized creation workspaces, notably `VideoTranslationWorkspace.tsx`.
- **Desktop Shell (`apps/desktop`)**: Electron-based shell binding local services and managing lifecycle with `OPENCREATOR_HOME`.
- **Daemon (`apps/daemon`)**: Fastify-based backend service managing download engines (`yt-dlp`), AI service orchestration (KrillinAI CLI), platform credentials, and job queues.
- **Protocol & Config (`packages/protocol`, `packages/config`)**: Shared types, RPC schemas, and environment configuration.
- **Runtime Engines**:
  - `apps/daemon/runtime/yt-dlp`: Bundled `yt-dlp` with OpenCreator plugins (`douyin.py`).
  - `.opencreator/runtime/krillinai`: KrillinAI Go engine backed by local `whisper.cpp` (`whisper-cli.exe` + `ggml-tiny.bin`) or external OpenAI/9router gateway (`http://localhost:20128/v1`).

---

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | Douyin extractor session initialization | Broaden cookie detection (UIFID, UIFID_TEMP, s_v_web_id, ttwid) and add visitor session initialization | M1 | ORIGINAL_REQUEST §R1 |
| F2 | Douyin local Chrome cookie auto-import | Auto-discover visitor cookies from local Chrome / portable Chrome (`D:\program\browsers\chrome-win64`) | M1 | ORIGINAL_REQUEST §R1 |
| F3 | Douyin captcha error classification | Provide actionable guidance for website verification challenges instead of raw platform_session_required | M1 | ORIGINAL_REQUEST §R1 |
| F4 | Video Translation source/target language defaults | Set initial source language to `zh_cn` (Tiếng Trung) and target language to `vi` (Tiếng Việt) | M2 | ORIGINAL_REQUEST §R2 |
| F5 | Video Translation subtitle mode defaults | Set bilingual to `false` and composeVideo to `true` | M2 | ORIGINAL_REQUEST §R2 |
| F6 | Video Translation font style defaults | Set subtitleFont to `'serif'`, subtitleWeight to `'medium'`, subtitleSize to `'medium'` | M2 | ORIGINAL_REQUEST §R2 |
| F7 | Video Translation upload retainment & presets | Ensure initial defaults are preserved on video upload and aligned in daemon schemas/templates | M2 | ORIGINAL_REQUEST §R2 |
| F8 | Transcription provider credential validation | Implement `resolveEffectiveTranscriptionProvider` to detect missing OpenAI credentials or placeholder 9router keys | M3 | ORIGINAL_REQUEST §R3 |
| F9 | Local ASR fallback to whisper.cpp | Automatically route transcription to local `whisper.cpp` (`ggml-tiny.bin`) on Windows when OpenAI credentials are absent | M3 | ORIGINAL_REQUEST §R3 |
| F10 | 9router OpenAI-compatible configuration | Support direct 9router transcription when valid credentials exist without crashing | M3 | ORIGINAL_REQUEST §R3 |
| F11 | Full Monorepo Build & Typecheck (0 errors) | Compile `@opencreator/daemon`, `@opencreator/web`, `@opencreator/desktop`, `@opencreator/protocol` cleanly | M4 | ORIGINAL_REQUEST §Acceptance |
| F12 | Regression & Integration Test Suite Verification | Pass `yt-dlp-douyin-regression.py`, `creator-yt-dlp-douyin.test.ts`, `VideoTranslationWorkspace.*.test.ts`, `creator-krillin-cli-protocol.test.ts` | M4 | ORIGINAL_REQUEST §Acceptance |
| F13 | C:\ drive isolation enforcement | Ensure all models, caches, cookies, and logs reside strictly within `D:\Program Files\OpenCreator` and `.opencreator` | M4 | ORIGINAL_REQUEST §Acceptance |

---

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Douyin Extractor & Platform Connection Fix | F1, F2, F3 (`douyin.py`, `service.ts`, `executor.ts`, connection tests) | None | DONE |
| M2 | Video Translation Workspace Defaults | F4, F5, F6, F7 (`VideoTranslationWorkspace.tsx`, `module-schemas.ts`, `video-translation.ts`, tests) | None | DONE |
| M3 | AudioToSubtitle 9router & Local ASR Fallback | F8, F9, F10 (`creator-services.ts`, `config-bridge.ts`, `cli-runner.ts`, `adapter.ts`, tests) | None | DONE |
| M4 | E2E Verification & Monorepo Compilation Pass | F11, F12, F13 (All packages typecheck/build, full test suite, C:\ audit) | M1, M2, M3 | DONE |

### Milestone 1 Key Outputs:
- Files modified: `douyin.py`, `service.ts`, `browser-login.ts`, `routes.platform-connections.ts`, `executor.ts`, `issue-catalog.ts`, `douyin-connection.test.ts`.
- Tests passing: Python regression (8/8), Vitest integration (105/105), adversarial stress suite (22/22).
- Gate status: PASS.

### Milestone 2 Key Outputs:
- Files modified: `VideoTranslationWorkspace.tsx`, `module-schemas.ts`, `video-translation.ts`, `VideoTranslationWorkspace.control.test.tsx`, `creator-template-registry.test.ts`.
- Tests passing: Web control (38/38), Web artifacts (14/14), Daemon template registry (19/19), Web adversarial suite (8/8), Daemon schema assertions (62/62).
- Gate status: PASS.

### Milestone 3 Key Outputs:
- Files modified: `creator-services.ts`, `config/src/index.ts`, `config-bridge.ts`, `remotion-component.ts`.
- Tests passing: `creator-krillin-cli-protocol.test.ts` (31/31), `creator-preflight.test.ts` (26/26), `creator-video-translation-workflow.test.ts` (29/29), `creator-services-config-store.test.ts` (24/24), `creator-services-api.test.ts` (11/11), `creator-api.test.ts` (18/18), `creator-krillin-dependency-loader.test.ts` (11/11), `douyin-connection.test.ts` (29/29), `VideoTranslationWorkspace.control.test.tsx` (38/38).
- Full monorepo typecheck: 10/10 workspace projects PASS (0 errors).
- Full monorepo build: 100% SUCCESS.
- Gate status: PASS.

### Milestone 4 Key Outputs:
- Full monorepo typecheck: 10/10 packages (0 errors).
- Full monorepo build: 100% SUCCESS across all packages.
- Full verification matrix: 200+ unit, integration, and adversarial tests PASS (100%).
- C:\ drive isolation audit: 0 writes to C:\, 100% data, models, and caches isolated to `D:\Program Files\OpenCreator` and `.opencreator`.
- Gate status: PASS.

---

## Interface Contracts

### M1: `douyin.py` ↔ Daemon Executor
- **Status**: IMPLEMENTED & VERIFIED (Passes all 8 regression tests, 105 daemon tests).

### M2: Frontend UI ↔ Daemon Presets
- **Status**: IMPLEMENTED & VERIFIED.
- Source Language: `'zh_cn'`, Target Language: `'vi'`, Bilingual: `false`, Compose Video: `true`.
- Subtitle Font: `'serif'`, Weight: `'medium'`, Size: `'medium'`.
- Upload & URL switches strictly preserve all 7 defaults.

### M3: Protocol ↔ Krillin Config Bridge ↔ ASR Engine
- **Status**: IMPLEMENTED & VERIFIED.
- `createDefaultCreatorServicesConfig()` defaults to clean unconfigured keys.
- `resolveEffectiveTranscriptionProvider(config)` dynamically routes missing OpenAI credentials to local `whisper.cpp` (`ggml-tiny.bin`) on Windows without breaking preflight checks.
- `createKrillinConfigToml()` writes effective provider and config cleanly.
- `resolveOpenCreatorPaths()` strictly respects `input.homeDir` in test harnesses while defaulting to `D:\Program Files\OpenCreator\.opencreator` in production.

---

## Code Layout
- `apps/daemon/runtime/yt-dlp/opencreator/yt_dlp_plugins/extractor/douyin.py`: Douyin extractor plugin
- `apps/daemon/src/platform-connections/service.ts`: Platform connection service
- `apps/daemon/src/creator/download/executor.ts`: Download executor and error mapping
- `apps/web/src/features/dashboard/VideoTranslationWorkspace.tsx`: Frontend video translation workspace
- `apps/daemon/src/creator/presets/module-schemas.ts`: Preset schemas for translation & styles
- `apps/daemon/src/creator/templates/video-translation.ts`: Workspace template defaults
- `packages/protocol/src/creator-services.ts`: Protocol definitions & credential validation
- `packages/config/src/index.ts`: Path resolution & environment isolation
- `apps/daemon/src/creator/krillin/config-bridge.ts`: Krillin TOML generation
- `apps/daemon/src/creator/krillin/cli-runner.ts`: Krillin runtime setup & resource mounting
- `apps/daemon/src/creator/krillin/adapter.ts`: Krillin task adapter
- `apps/daemon/src/creator/preflight.ts`: Preflight dependency checks
