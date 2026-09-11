# media_gen

Use OpenRouter, Atlas Cloud, Fireworks, or other APIs to generate and preview images & video.

## Current build

A local-first Electron + React + TypeScript desktop workbench. **Settings → Generation models** lists every Atlas Cloud text-to-image and text-to-video model from the live catalog, with separate saved defaults for images and video; each model's controls are generated from its published schema. FLUX Schnell/Dev and Wan 2.5 Fast/standard are built in and work offline. OpenRouter, Fireworks, image-to-video, and video extension/editing are later work; they are not selectable integrations yet.

The app includes separate image/video prompt drafts, model-specific controls, durable jobs, a local library, image zoom, video playback, recipe reuse, and original-file export. No app account, hosted backend, telemetry, or automatic provider fallback.

**Live Atlas generation is not yet verified.** Local tests use explicitly labelled fixtures, not purported AI-generated output. The user elected to finish local verification and add their Atlas key later. No generation credits have been spent during development.

## Run

Development prerequisites: Node.js 24 or newer, npm, a Linux desktop session, and `ffprobe` (provided by FFmpeg) for media validation/metadata. `ffmpeg` itself is also used to create the local test clips. Keep these system binaries updated.

```sh
npm ci
npm start
```

For the XWayland path visually verified on the development machine:

```sh
npm start -- --ozone-platform=x11
```

Native Wayland DOM/playback checks worked, but Chromium screenshot capture returned black; XWayland was used for visual acceptance. No compositor or system configuration is changed.

Build a standalone Linux directory bundle (Node/npm not needed to launch the bundle; `ffprobe` remains a runtime dependency):

```sh
npm run package
./release/linux-unpacked/media-gen --ozone-platform=x11
```

Keep the entire `linux-unpacked` directory together. This is an unpacked development distribution, not a signed installer or published release.

## First generation

1. Open Settings and enter an Atlas Cloud API key in the app—not in a prompt or source file.
2. The key is saved and restored on the next launch. It is encrypted through your OS keyring when one is available (on desktops Chromium does not recognize, such as Hyprland or sway, the app asks for the libsecret backend itself; `MEDIA_GEN_PASSWORD_STORE` overrides the choice). Without any keyring it is written to a file beside the library that only your user account can read, and Settings says which of the two is in use. Saving a key does not validate its balance or submit a paid request.
3. Optionally choose your default image and video models in Settings. The list comes from Atlas Cloud's public catalog (refreshed daily or on demand); picking a model for the first time downloads its settings schema. Selections save automatically across restarts, without sending a generation request. Changing a default resets that mode’s draft parameters but keeps its prompt; existing jobs and recipes remain unchanged. Reuse settings restores a saved recipe’s original model for the current draft without changing your defaults. Then choose Image or Video, write a prompt, and review the supported settings.
4. Click Generate only when you want to spend provider credits. The UI currently says **Cost unknown** rather than promising an exact charge.
5. Completed files are downloaded into the local library and displayed. Use Reuse settings to edit a recipe without submitting it; Export original copies the downloaded bytes unchanged.

An optional `ATLASCLOUD_API_KEY` environment variable is read by the main process. Avoid putting secret values in shell history. Environment configuration is not needed when using Settings.

## Local data and recovery

The default library is Electron's user-data directory for Media Gen. `MEDIA_GEN_HOME` can select a different library directory (use a private directory outside the source checkout). One running app instance owns the library. Back up the entire library while the app is closed, including the SQLite database and `assets/` directory.

Queued work is saved before submission. Submission timeouts are **unknown**, not automatically retried: check the Atlas dashboard before generating again. Known remote jobs can resume tracking after restart. A failed download is distinct from failed generation; retrying it must not submit another paid job.

Closing the window pauses local tracking, not remote billing. Remote result URLs are delivery links, not an archive; preserve local files and backups. Expired provider assets may ultimately be unrecoverable without a new generation.

## Verification

```sh
npm test
npm run typecheck
npm run build
npm run smoke
npm run smoke:generation
npm run package
MEDIA_GEN_EXECUTABLE=release/linux-unpacked/media-gen npm run smoke
npm audit
```

- Unit/integration tests use temporary SQLite libraries and explicit transport fixtures.
- `smoke` launches real Electron windows with locally made PNG/MP4 fixtures; checks preview, playback/seeking/mute, byte-identical exports, renderer isolation, and reopening saved media with networking blocked for the playback checks. On Linux with `DISPLAY`, it selects X11 for reliable captures; set `MEDIA_GEN_SMOKE_WAYLAND=1` to test the native Wayland capture path explicitly.
- `smoke:generation` drives the actual composer through the adapter, job service, media download, and automatic preview. Its test-only bootstrap replaces DNS/HTTPS before app startup, so it cannot spend provider credits. This fixture bootstrap is not packaged into the app.
- Smoke reports and screenshots go to ignored `artifacts/`; fixture libraries stay under `/tmp` for inspection.
- No passing fixture test proves live provider compatibility, account access, pricing, or service availability.

See [the product plan](docs/PRODUCT_PLAN.md) and [Atlas contract notes](docs/ATLAS_API.md). Final verification details are recorded in `docs/VERIFICATION.md` when the review gates complete.
