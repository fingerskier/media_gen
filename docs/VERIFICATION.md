# Local build verification

Date: 2026-09-11. Status: local implementation, spec gate and independent security/quality gate passed. Live Atlas generation is deliberately deferred by the user, not reported as successful.

## Artifact

- Linux x64 executable: `../release/linux-unpacked/media-gen` (keep the entire directory together).
- Verified launch backend on this workstation: `--ozone-platform=x11`.
- Electron 44.3.0. Runtime media inspection: system `ffprobe` (tested with 9.0.1).
- Source remains uncommitted. No API credits spent and no real credentials inspected.

## Executed checks

| Command / check                                                       | Observed result                                                                                                                                                                         |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                            | 50 passing tests across 7 files                                                                                                                                                         |
| `npm run typecheck`                                                   | Passed                                                                                                                                                                                  |
| `npm run format:check`                                                | Passed                                                                                                                                                                                  |
| `npm run smoke`                                                       | Actual Electron window, isolated/sandboxed renderer, separate drafts, cancel-unsent, stop/resume tracking, PNG preview, MP4 play/seek/mute, image and video export, local reopen passed |
| `npm run smoke:generation`                                            | Actual UI Generate → adapter → durable job → local download → automatic image/video preview passed against explicitly labelled HTTP fixtures                                            |
| `npm run package`                                                     | Linux unpacked application built                                                                                                                                                        |
| `MEDIA_GEN_EXECUTABLE=release/linux-unpacked/media-gen npm run smoke` | Same desktop checks passed on the packaged executable                                                                                                                                   |
| `npm audit --json`                                                    | Zero reported vulnerabilities, including development dependencies                                                                                                                       |
| Independent spec review                                               | Passed after fixes for cancellation, recovery, media validation, credential binding, and Retry-After                                                                                    |

The generation harness replaces DNS/HTTPS before loading the application and rejects unexpected hosts. It observed exactly one image POST and one video POST, followed by same-ID polling and fixture downloads. Those are simulated transport responses, not real Atlas generations.

Exports were compared byte-for-byte for both PNG and MP4. Reopen tests use the same temporary library, set renderer offline mode and install main-process request/fetch blockers before local playback checks. This establishes saved-media behavior; it is not a system-level network-namespace test or a test of real in-flight provider jobs during an outage.

## Settings model selector verification

Separate image/video defaults now offer FLUX Schnell/Dev and Wan 2.5 Fast/standard. `preferences.json` persists validated mode-specific IDs using atomic replacement; absent/corrupt/retired choices fall back safely. Unit tests cover independent persistence, mode/ID rejection, defensive copies and refusal to follow a symlink. Main-process validation is behind the existing trusted-frame IPC guard.

Real Electron smoke tests verify selector changes, restart persistence, unchanged queued/saved recipes, prompt preservation and incompatible parameter reset, plus image AND video recipe reuse without changing defaults. The generation fixture test verifies that choosing Dev/standard Wan actually changes the submitted model and its fixed payload. No real provider requests or credits were used. Independent scoped spec and security/logic reviews passed; `artifacts/model-settings.png` was visually inspected and `artifacts/model-selector-review.json` contains the final verdict.

The test harness now gives each run its own temporary `--user-data-dir` in addition to its media library. This avoids the single-instance lock collision discovered while the user's own app was running; that instance and its data were left untouched. Restart the actual app to load the new controls.

## Regression coverage

- Documented response envelopes/statuses and model-specific valid parameters; unknown responses fail closed.
- Effective request defaults stored with recipes, including safety and asynchronous-output settings.
- Submit timeout/unknown outcome does not automatically create another paid request.
- Known request IDs survive restart; download recovery refreshes the same request rather than resubmitting generation.
- Atomic initial schema creation, multi-column updates and asset commits; interrupted bootstrap rolls back and reopens cleanly without dropping unknown user data; backup before v1 metadata migration.
- Resume labels distinguish an unsent request that can incur its first charge from tracking an existing remote job; only a boolean submission flag is exposed.
- Temporary and unreferenced app-owned media reconciliation; referenced files retained.
- Queued cancellation and stop/resume races do not overwrite paused state with late completion.
- Credential-reference mismatch pauses existing jobs; retained key/reference/signed URLs do not enter renderer snapshots.
- Public HTTPS destination validation, pinned DNS lookup, private/credential-bearing redirects rejected, bounded requests.
- Retry-After is retained beyond two minutes for both status and download paths; long waits pause tracking, and Resume preserves the persisted wait. Only local exponential backoff is capped.
- Readable media frames, dimensions and duration checked by bounded ffprobe before acceptance; malformed media rejected.

## Platform observations and limitations

The smoke runtime reported `safeStorage` backend `basic_text`. The app correctly refused persistent storage in that backend and used session-only credentials. A functioning encrypted OS keyring was not tested here; the app checks availability at runtime rather than assuming one.

Native-Wayland capture produced an entirely black screenshot despite passing DOM/media assertions. XWayland produced a nonblank screenshot and was visually inspected: controls, preview, navigation and result cards were legible and coherent. No compositor configuration or Electron sandbox setting was weakened. Use the verified XWayland launch command on this workstation; native-Wayland visual capture remains a platform follow-up.

No live account, billing, model availability, provider latency, provider-generated codec, real audio generation, or current price was verified. Estimated cost remains Unknown in the UI. Video extension/editing, image-to-video/reference inputs, other providers, and an installable AppImage/desktop launcher are not part of this build.

## Local evidence

Regenerated by the smoke commands (ignored build artifacts):

- `../artifacts/smoke-report.json`
- `../artifacts/desktop-smoke.png`
- `../artifacts/generation-fixture-report.json`
- `../artifacts/generation-fixture.png`
- `../artifacts/security-static.json`
- `../artifacts/quality-review.json`
- `../artifacts/diff-check.json`

All media in those screenshots is labelled test-fixture content. The user's actual library is never seeded by the smoke scripts.

## Live model catalog verification

Date: 2026-09-11. The curated four-model list is now a built-in fallback; Settings lists every Atlas text-to-image and text-to-video model from the public listing, and each model's controls are generated from its published OpenAPI schema (`docs/ATLAS_API.md`, "Live catalog").

| Command / check                                               | Observed result                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                    | 57 passing tests across 8 files (new `tests/catalog.test.ts` covers listing filtering, schema-to-control mapping, validation of schema-derived recipes, cache persistence/restart, corrupt cache, and the catalog fetch allowlist)                                                                                          |
| `npm run typecheck`, `npm run format:check`                   | Passed                                                                                                                                                                                                                                                                                                                      |
| `npm run smoke`, `npm run smoke:generation`                   | Passed unchanged with `MEDIA_GEN_CATALOG=off`, so the fixture harnesses never touch the live catalog                                                                                                                                                                                                                        |
| Parser over all 119 live schemas (scratch script)             | 118 usable; `alibaba/wan-2.5/video-extend` correctly marked unavailable because it requires a video input                                                                                                                                                                                                                   |
| Live catalog through the app's network layer (scratch script) | Listing fetched in about 0.8 s, 119 entries, 49 KB cache; `kwaivgi/kling-v3.0-std/text-to-video` resolved, saved as default, and reloaded offline; payload contained only schema-derived parameters                                                                                                                         |
| Real Electron window against the live catalog                 | Settings listed 59 video models grouped by organization with base prices; selecting Kling v3.0 Std downloaded its schema; the composer rendered negative prompt, multi-shot toggle, shot type, duration, aspect ratio and cfg scale controls; no page errors (`artifacts/live-settings.png`, `artifacts/live-composer.png`) |

No generation was submitted and no credits were spent. Atlas's server-side validation of dynamically built payloads remains unverified until a live generation is run.
