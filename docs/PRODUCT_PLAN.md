# Media Gen — desktop generation workbench

Status: approved direction; implementation authorized by the user's "The plan sounds good. Please proceed." Initial work targets slices 1 and 2. The user subsequently chose "Finish local verification; I’ll add my Atlas key in the app later." Live provider testing is therefore explicitly deferred, not represented as completed. Later roadmap items remain sequenced follow-ons, with video extension/editing deferred. Acceptance evidence is recorded separately in VERIFICATION.md.

## 1. Baseline and decision status

At planning time the repository contained only [README.md](../README.md) and [LICENSE](../LICENSE); there was no application, package manifest, provider adapter, database, or test suite. The existing uncommitted README edit names OpenRouter, Atlas Cloud, Fireworks, and other APIs. Preserve that user-authored description when adding usage documentation. Reqall's initial project record listing returned no existing intent; the approved implementation is now tracked by spec #5568.

### Established by the user

- A desktop app for generating and previewing images and video through external APIs.
- Multiple provider candidates, rather than a product tied permanently to one service.
- Extending an existing video / adding content is desirable but can come later.

### Accepted direction

- A local-first, single-user creative workbench. No app account, hosted backend, or cloud library sync.
- Linux first, with desktop portability kept possible; other OS releases are not first-release acceptance criteria.
- Electron + React + TypeScript, with SQLite metadata and ordinary media files.
- Start with one verified image model and one verified video model on Atlas Cloud, subject to account access and a small approved paid smoke test. Add OpenRouter images next. Fireworks remains a candidate pending current API/model verification.
- Treat image-to-video as the first follow-on to text generation, before extending video.

### Unresolved before paid verification

- Linux-first/Electron is accepted. Tauri remains an alternative only if a later decision revisits the footprint tradeoff.
- The user will configure an Atlas account/key later. Real provider verification and a test-spend ceiling are deferred; they do not block the current local build. Do not infer permission to spend from existing credentials.

## 2. Product promise

One place to turn a prompt into media, inspect the result, iterate without losing the recipe, and keep the files you want.

The unit of work is a **generation**, not a chat conversation. A generation records its prompt, provider, model, effective settings, job state, outputs, and optional source asset. The library remains usable without internet; generation does not.

This is not initially a timeline editor, node graph, model-training tool, or local GPU runner. Avoid spending the first release on a marketplace of integrations: finish the entire creative loop with a small verified model set.

## 3. Main workspace

```text
+--------------------------------------------------------------------------+
| Media Gen                  Create | Library | Jobs              Settings |
+-----------------------+--------------------------------------------------+
| Image / Video         |                                                  |
|                       |                 Result preview                   |
| Provider   [Atlas v]  |       image: fit / zoom / pan                     |
| Model      [ ... v]   |       video: play / pause / scrub / mute          |
|                       |                                                  |
| Prompt                |                                                  |
| [                  ]  |                                                  |
| [                  ]  +--------------------------------------------------+
|                       | Reuse settings | Export | Show in folder         |
| Aspect     [16:9 v]    +--------------------------------------------------+
| Quality    [ ... v]    | Recent results: thumbnails + job states          |
| Duration*  [ ... v]    |                                                  |
| Advanced settings     |                                                  |
|                       |                                                  |
| Estimate: ... / unknown|                                                  |
| [Generate image/video]|                                                  |
+-----------------------+--------------------------------------------------+
* Video only, and only when supported by the selected model.
```

The preview gets most of the space. Use a restrained dark interface so the media, not decoration, dominates. Preserve separate image/video drafts when switching modes. Empty states explain the next action: configure a provider, choose a supported model, or enter a prompt. Do not display demo media as generated results.

### Compose

- Choose Image or Video before choosing a model; show compatible models only.
- Display provider and model together so the destination and billing account are unambiguous.
- Always show prompt and aspect/size controls supported by that model. Video duration, resolution, seed, negative prompt, audio, and reference inputs appear only where verified supported. Advanced controls start collapsed.
- On model changes, flag incompatible settings rather than silently substituting values.
- Show a provider-backed price estimate when available, including its source/freshness and limitations. Otherwise say "Cost unknown"; never invent a price or imply a hard cap.
- Generate is an explicit paid action. No auto-generation on prompt edits or model changes. Disable repeated submission while a click is being accepted.

### Preview and iterate

- Show images at fit or actual size, with zoom/pan; videos have playback, seeking, mute/volume, and fullscreen.
- Reuse settings loads an editable copy of the original recipe. It does not start another paid request, and a seed is not a guarantee of identical output.
- Export copies original downloaded bytes to a user-chosen destination; a recipe sidecar is opt-in and warns that prompts may be sensitive. Reveal the local output in the file manager.
- Basic side-by-side comparison and image-to-video actions are follow-ons, not prerequisites for initial generation.

### Library and jobs

- Automatically save successful outputs locally before calling them ready. Thumbnails are derived conveniences, not the only saved copy.
- Filter/search the library by prompt, media type, provider/model, and date. Favorite results. Empty, missing-file, and failed-preview states are explicit.
- Jobs show queued/submitting/running/downloading/ready/failed/unknown states. Show real provider progress only; otherwise use an indeterminate indicator and elapsed time.
- Users can remove an unsent queued job. For submitted work, distinguish "stop tracking" from provider-confirmed cancellation; stopping tracking or closing the window may not stop billing.
- A failed download offers "Retry download," not "Generate again." A failed or ambiguous submission never automatically creates another paid request.
- Removing a library item goes through confirmation and a recoverable trash step; it must never delete an externally imported original.

## 4. Core contracts

### Desktop trust boundary

```text
React renderer
    -> narrow, validated IPC commands
Electron main process
    -> job service -> provider adapters -> remote API
    -> SQLite repository
    -> media store + OS credential store
```

The main process is the sole authority for provider requests, secrets, metadata mutations, and media writes. The renderer has no Node integration and receives neither API keys nor general-purpose filesystem/network access. Use context isolation, sandboxing, a restrictive CSP, escaped provider errors, and navigation restrictions. API documentation or model output is never executable UI content.

Use the OS credential store, testing its actual availability on the target desktop. If secure storage is unavailable or resolves to insecure plaintext fallback, offer session-only keys and explain the limitation; do not silently persist plaintext. Redact authorization headers and signed output URLs from routine logs. Keep credentials out of SQLite, sidecars, Git, and analytics. No telemetry by default.

### Capability-driven provider boundary

An adapter exposes model capabilities, parameter validation, optional cost estimation, submission, status lookup where available, and optional cancellation. Normalize job outcomes, not all provider settings into a fictional universal API. Support both synchronous image responses and asynchronous video tasks.

Each verified model descriptor includes exact provider/model IDs, input/output modalities, allowed sizes/aspects/durations, optional features, delivery format, and the provenance of those constraints. Preserve validated provider-specific options in the recipe. Start with a curated, tested catalog; discovery can enrich it later. Unknown or removed models are unavailable, not guessed replacements.

No generic "OpenAI-compatible" assumption for media: chat compatibility does not prove matching image/video endpoints, polling, parameter names, or output formats.

### Local persistence and request safety

- `Generation`: local ID; creation time; operation; original prompt; provider/model; effective validated settings; credential reference, never secret; optional source asset; state; provider request ID; estimate and provider-reported actual cost as separate optional fields; safe diagnostic details.
- `Asset`: local ID; generating job or import origin; local relative path; MIME type; dimensions; optional duration; content hash; optional parent asset and transformation metadata. Jobs may produce multiple assets. Copy explicitly imported sources into managed storage before depending on them.
- Persist queued intent before submission; limit initial concurrency to one active submission/job per provider. A local transaction claims queued work so concurrent UI events cannot dispatch it twice. Enforce a single active app instance for the same library.
- Use provider idempotency keys only when documented. Persist the provider job ID immediately upon receipt. A timeout or crash between provider acceptance and local recording is `unknown`, not automatically retryable. Explain that a manual resubmission can incur another charge.
- Retry safe status reads/downloads with bounded backoff and respect rate-limit guidance. Polling exhaustion is a recoverable tracking problem, not proof the remote job failed.
- Download output promptly because remote URLs can expire. Restrict downloads to validated HTTPS destinations; reject loopback/private/link-local targets and revalidate redirects. Do not forward API credentials to arbitrary output hosts. Apply file-size limits, MIME/content validation, and safe filenames.
- Write downloads to temporary files, then atomically rename; commit asset metadata before announcing ready. Recovery reconciles orphaned files and incomplete metadata. A download failure preserves the successful remote job and its recovery information rather than triggering regeneration.
- On launch, reconcile in-flight jobs with stored provider IDs, resume downloads, and surface ambiguous submissions. Never promise exactly-once remote billing where the provider cannot guarantee it.
- Closing the app pauses local tracking; persisted jobs resume on next launch. No hidden daemon in the first release. Explain this when closing with outstanding work.
- Keep original media independent of SQLite. Version the schema, back up metadata before migrations, and avoid destructive migration changes in the first slice. A library backup consists of the database and managed asset directory, not a provider URL list.

## 5. Implementation slices and exit evidence

These are dependency-ordered slices. Implementation of the initial image/video workflow is authorized; later features follow only after the core is verified. Record actual runtime/test evidence separately and keep any unmet acceptance criteria explicit.

### Slice 1 — Image generation end to end

Dependencies: accepted stack and a verified model/API contract. Credentials and an approved paid test budget gate live requests, not local implementation and fixture-backed desktop verification.

Proposed areas: `src/main/providers`, `src/main/jobs`, `src/main/storage`, `src/preload`, `src/renderer`, and `tests`.

Deliver the desktop shell, session-only/secure credentials, one image model, prompt/settings validation, explicit submission, local download, image preview, saved recipe, minimal history, and export. Implement the durable job envelope now even if the first model responds synchronously.

Exit evidence:

- A packaged development build opens as a real desktop window on the target Linux session.
- One authorized real request creates a decodable local image, displayed by the app and exported unchanged; the provider job/request reference is retained when available.
- Restart with networking disabled still shows the saved image and recipe.
- Automated adapter fixtures cover success, bad credentials, rate limits, malformed output, and unsupported parameters. Fixture tests are labelled as such, not evidence of live provider compatibility.
- Integration tests use temporary databases/media directories and verify duplicate-click suppression, ambiguous submission handling, download-only retry, crash recovery, and renderer secret isolation.

### Slice 2 — Video generation end to end

Depends on Slice 1's job/storage/credential contracts and verified video capability data.

Add one text-to-video model, supported duration/resolution controls, asynchronous status tracking, local video download, and native in-app playback. Exercise real packaged-build codec support rather than assuming MP4 implies playable video. Atlas is a candidate for both slices, not a claim that account access or either exact model has been verified.

Exit evidence: one authorized real clip plays/seeks/mutes in the desktop app, exports unchanged, and plays offline after restart. Tests cover persisted-job recovery, provider terminal errors, tracking timeouts, expired output URLs, interrupted downloads, and unsupported codec diagnostics. Show unknown progress honestly.

At the end of this slice the app satisfies the core image-and-video loop; video extension is not required.

### Slice 3 — Useful multi-provider workbench

Depends on both media paths working.

Add OpenRouter image generation as the second adapter, model-aware controls, library search/favorites, recoverable trash, and side-by-side image comparison. Add image-to-video where the chosen API explicitly supports it. Request explicit consent before uploading a local reference; no hidden public bucket or automatic cross-provider transfer.

Exit evidence: switching providers preserves old recipes, rejects unsupported options before network submission, routes to the selected account, and never silently falls back to a different billable service. A verified reference-image workflow records its source and output relationship.

Fireworks and additional providers enter only after current endpoints, access, output delivery, and supported models have been verified. Each adapter needs contract fixtures and its own authorized live smoke test.

### Slice 4 — Extend or transform existing video (deferred)

Depends on stable assets, source lineage, a verified provider capability, and explicit upload behavior.

Keep two operations distinct:

- **Extend:** continue the clip in time from its ending, with a prompt describing what happens next.
- **Edit video:** add/change content within existing footage. This is a different capability and must not be implied by an Extend button.

Recommended UX: select a saved or imported clip -> Extend -> describe the next action -> review extra duration/cost/upload destination -> generate a child result. Keep the source untouched and allow branches. Hide the action for unsupported providers/models.

Store source asset ID, operation, requested segment, and extension prompt. Check whether a provider returns only a continuation or the whole extended clip before composing or exporting anything. Use temporary uploads with a defined retention/cleanup policy if URLs are required. Do not promise extension duration, seamless continuity, audio continuity, or native extension availability until the actual API is verified.

A last-frame image-to-video continuation plus local concatenation is only a possible fallback. Label it "Continue from last frame," not native extension; it can jump visually or lose audio continuity. Timeline composition/transcoding remains deferred. Implementation review established an earlier, narrower media-tool dependency: the first build uses `ffprobe` to validate readable frames and save dimensions/duration before accepting downloaded media. `ffmpeg` is used by the test harness to create explicitly labelled local clips, not to simulate provider generation.

Exit evidence when this later slice is authorized: a real input clip yields a longer, playable output; the original remains byte-identical; lineage and billing are recorded; unsupported formats, upload cleanup, codec mismatch, and audio-boundary behavior are tested. Actual video edits need their own acceptance criteria.

## 6. Technology recommendation and tradeoff

Electron + React + TypeScript keeps the interface and provider adapters in one language, offers a consistent Chromium rendering runtime, and supports a conventional desktop development workflow. The costs are a larger bundle and higher baseline resource use. Its bundled runtime is not a guarantee of every video codec: verify representative downloaded files in the actual package.

Tauri + React is the alternative if a smaller footprint becomes a priority. It brings Rust/backend integration and platform webview/media dependencies that need an early Linux playback spike. The approved initial implementation uses Electron; a switch is not part of the current work.

SQLite plus ordinary files is enough for a single-user library. Do not add a web server, Redis queue, cloud database, login system, or background service to solve a local job queue.

## 7. Provider evidence and remaining verification

Documentation consulted for this proposal; no paid API calls were made and no credentials were accessed.

- [OpenRouter image generation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation): the retrieved documentation describes a dedicated Image API and image model/per-endpoint capability discovery. Supports investigating an image adapter; does not establish video generation support.
- [Atlas Cloud overview](https://docs.atlascloud.ai/): lists image generation, video generation, and asynchronous task webhooks. Supports considering it for both media paths, but this overview does not verify a particular model, polling endpoint, access entitlement, or current price.
- [xAI video generation](https://docs.x.ai/developers/model-capabilities/video/generation): documents video generation with asynchronous request IDs/polling and configurable generation settings. This retrieved page is not proof of native extension or video-edit availability; verify those separately when needed.
- Fireworks: retrieval of `https://docs.fireworks.ai/guides/querying-image-generation-models` failed with `CRAWL_NOT_FOUND`; the browser fallback could not initialize because its configured Chrome profile databases were unavailable. Current image/video support remains unverified, not ruled out.

Before coding adapters, consult the full current endpoint documentation and validate exact request/response contracts. Before paid testing, agree the provider and spend ceiling. Before calling a release done, require the real desktop and live-generation evidence above, not just a mockup or passing fixtures.
