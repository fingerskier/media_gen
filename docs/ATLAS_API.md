# Atlas Cloud adapter contract

Official documentation checked during implementation. These are documentation contracts, not observations of paid live requests.

## Endpoints

Base: `https://api.atlascloud.ai/api/v1/model`

- Image submission: `POST /generateImage`
- Video submission: `POST /generateVideo`
- Existing prediction: `GET /prediction/{id}`
- Bearer authentication; JSON request bodies. Do not forward authorization to output/CDN URLs.
- Persist `data.id` immediately. Never automatically retry an uncertain submission: no documented idempotency-key contract was found.

## Initial catalog

### FLUX Schnell

ID: `black-forest-labs/flux-schnell`

- Prompt required.
- Initial verified size preset: `1024*1024`. Documentation does not publish an exhaustive size enum, so the app does not invent more presets.
- `num_images`: 1–4.
- Fixed initial settings: `seed: -1`, `enable_sync_mode: false`, `enable_base64_output: false`, `enable_safety_checker: true`.

Source: https://www.atlascloud.ai/models/black-forest-labs/flux-schnell/llms.txt

### Wan 2.5 Text-to-Video Fast

ID: `alibaba/wan-2.5/text-to-video-fast`

- Prompt and size required.
- Sizes: `1280*720`, `720*1280`, `1920*1080`, `1080*1920`.
- Duration: 5 or 10 seconds.
- Fixed initial settings: `seed: -1`, `enable_prompt_expansion: false`.
- Audio reference and negative prompt exist in the docs but are not exposed by this initial build.

Source: https://www.atlascloud.ai/models/alibaba/wan-2.5/text-to-video-fast/llms.txt

### FLUX Dev

ID: `black-forest-labs/flux-dev`. Text-to-image controls: `size: 1024*1024`, `num_images: 1–4`. Fixed settings are `seed: -1`, `num_inference_steps: 28`, `guidance_scale: 3.5`, `enable_base64_output: false`, `enable_safety_checker: true`. Unlike Schnell, its documented schema does not include `enable_sync_mode`; the app does not send that field. Reference-image fields remain unexposed.

Source: https://www.atlascloud.ai/models/black-forest-labs/flux-dev/llms.txt

### Wan 2.5 Text-to-Video

ID: `alibaba/wan-2.5/text-to-video`. Sizes: `832*480`, `480*832`, `624*624`, `1280*720`, `720*1280`, `960*960`, `1088*832`, `832*1088`, `1920*1080`, `1080*1920`, `1440*1440`, `1632*1248`, `1248*1632`. Default size `1920*1080`; duration 5 or 10 seconds. Fixed settings `seed: -1`, `enable_prompt_expansion: false`, `generate_audio: true` explicitly match the documented defaults. Actual audio output remains unverified until live testing.

Source: https://www.atlascloud.ai/models/alibaba/wan-2.5/text-to-video/llms.txt

These four curated definitions are built in. They override the live parse of the same IDs, remain selectable offline, and stay the initial defaults until changed explicitly. Local defaults are saved to `preferences.json` beside the library database.

## Live catalog

Verified 2026-09-11 against the public endpoints, not against paid requests.

- Listing: `GET https://api.atlascloud.ai/api/v1/models`, no authentication, about 0.7 MB. Returns `{code, data:[...]}` with `model` (ID), `type`, `displayName`, `profile`, `organization`, `categories` (`TEXT-TO-IMAGE`, `TEXT-TO-VIDEO`, `IMAGE-TO-VIDEO`, `LLM`, …), `price.actual.base_price` (string, unit unspecified) and `schema`, a URL under `https://static.atlascloud.ai/model/schema/`.
- Schema: one OpenAPI 3.0 document per model. `components.schemas.Input` holds the request body: `properties` with `type`, `default`, `enum`, `minimum`, `maximum`, `step`, `title`, `description`, `disabled`, `x-ui-component` (`select`, `slider`, `switch`, `uploader`), plus `required` and `x-order-properties`.
- The app only lists models whose categories are exactly text-to-image or text-to-video. The API key is never sent to either catalog host.

The app caches the filtered listing and every resolved definition in `catalog.json` beside the library (atomic replacement, size-bounded, zod-validated; a corrupt file falls back to the built-in list). The listing refreshes at startup when older than 24 hours and on demand from Settings; a model's schema is fetched once, when it is first chosen as a default. `MEDIA_GEN_CATALOG=off` disables all catalog network access (used by the smoke harnesses).

Schema-to-control mapping (`src/main/schema.ts`):

| Schema property                                                                                                                                    | App behaviour                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `enum` of strings/numbers (≤ 64)                                                                                                                   | Select control; default from `default` if listed, else first option                          |
| `boolean`                                                                                                                                          | On/Off control, default from `default` (false if absent)                                     |
| `integer`/`number` with finite `minimum` < `maximum`                                                                                               | Number input with min/max/step; integers enforced                                            |
| numeric without both bounds                                                                                                                        | Fixed at `default` if present (e.g. `seed: -1`), else omitted                                |
| `string` without enum, name or `x-ui-component` suggesting media (`image`, `audio`, `video`, `mask`, `file`, `url`, `lora`, `reference`, uploader) | Omitted                                                                                      |
| `string` without enum, non-empty `default`                                                                                                         | Fixed at the default (e.g. `size: 1024*1024`)                                                |
| other `string`                                                                                                                                     | Optional text input, dropped from the payload when empty (e.g. `negative_prompt`)            |
| `disabled: true`                                                                                                                                   | Fixed at `default`, never editable                                                           |
| `enable_sync_mode`, `enable_base64_output`                                                                                                         | Always fixed `false`, whatever the schema says, because the adapter polls and downloads URLs |
| arrays, objects, `$ref`, `oneOf`                                                                                                                   | Omitted                                                                                      |
| any omitted property listed in `required`                                                                                                          | Model marked unavailable in the picker (e.g. `alibaba/wan-2.5/video-extend` needs `video`)   |

The submit endpoint follows the listing category, not the schema's `paths`, because several published schemas name the wrong endpoint (Seedream text-to-image documents `generateVideo`; LTX text-to-video documents `generateImage`). Of the 119 text-to-image/video models listed on 2026-09-11, 118 parse as usable. Atlas's server-side validation remains the final authority: a rejected payload fails the job with the provider message and no retry.

## Response inconsistencies

The documented usage example submits as `{code:200,data:{id,status:"processing"}}`. Model schemas also describe bare objects. General prediction documentation uses `outputs` and `completed`; FLUX schema uses `output` and `succeeded`. The adapter tolerates these documented variants, not arbitrary guessed object-to-URL fields.

- Pending: `created`, `queued`, `processing`.
- Successful remote generation: `completed`, `succeeded` plus a nonempty array of HTTPS output URL strings.
- Failed: `failed`, `timeout`.
- Unknown status or malformed output: explicit tracking/schema problem, never successful local completion.
- `ready` in the local app means validated media has been saved locally and asset metadata committed.

Sources:

- https://atlascloud.ai/docs/en/predictions
- https://atlascloud.ai/docs/en/errors
- https://atlascloud.ai/docs/en/more-models/black-forest-labs/flux-schnell/generateImage
- https://atlascloud.ai/docs/en/more-models/alibaba/wan-2.5-text-to-video-fast/generateVideo

## Cost and retention

The Schnell and Wan Fast model pages published $0.003/image and $0.071/generated video second when checked. Resolution/account-specific charges were not verified; the app deliberately does not turn these into guaranteed totals. Recheck provider pricing before enabling estimates or spending limits.

Atlas documents generated-output retention of 14 days by default. Download promptly; refreshing a prediction does not guarantee that an already-deleted remote asset can be restored.

Source: https://atlascloud.ai/docs/en/data-retention

## Still unverified

Real account access, service availability, actual request/response payloads, resulting MIME/codec choices, actual prices, cancellation support, image-to-video, and native video extension/editing. The user deferred live testing until they configure an Atlas key. Fixture payloads in tests are labelled as fixtures and must not be reported as generated results.
