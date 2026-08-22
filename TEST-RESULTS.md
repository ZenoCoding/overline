# Verification results

Date: 2026-08-19

## 2026-08-21 live transcription context, turn, and pause regression

- Full `npm test`: PASS.
- Realtime session receives canonical Link Click names and episode vocabulary generated from `dictionary-adaptations.json`.
- `gpt-live-transcribe` keeps unsupported server VAD disabled; live deltas remain immediate and 1.2 seconds of delta inactivity triggers an explicit turn commit.
- Playback pause routes to the offscreen owner and blocks further Realtime audio appends until playback resumes.
- OpenAI documentation audit: live context uses a setting prompt, literal keyword hints, `languages: ["cmn"]`, and `delay: "low"`; the offline helper shares the same prompt source.
- Unpacked extension reloaded and reconnected to the live AniKoto provider frame; final API-backed pause/resume listening verification remains for the user.

## Passed

- `npm run check`: MV3 manifest, narrow AniKoto/player-provider permissions and match paths, inherited provider-frame coverage, JavaScript syntax, non-overlapping cue timing, explicit segmentation, and required word fields.
- Local browser fixture: overlay matched the 960×540 video bounds and followed playback time.
- Native-caption test element was hidden.
- Intentional hover: after 250 ms the video paused and the pinyin/contextual-gloss popup opened.
- Mouseleave: popup closed and the video remained paused.
- Space: playback resumed and the popup stayed closed.
- Browser console: no warnings or errors during the fixture interaction.
- Cross-origin fixture: AniKoto-like outer page and player run on separate origins, complete the authenticated handshake, and render the overlay inside the player frame.
- Aside live inspection: the unpacked extension was found stale at v0.2.0, then reloaded successfully to v0.4.0. AniKoto's VidPlay-1 resolved to `vidtube.site`; Vidstream-2 and HD-1 resolved to `megaplay.buzz`. A working Vidstream-2 playback was visually observed at 00:10 before the extension reload.
- Aside live v0.4.1 regression: with the extension enabled, Vidstream-2 connected to the actual nested `<video>` and playback advanced from 142.25s to 146.15s while remaining unpaused. Reloading the extension during playback did not stop or intercept the video.
- Aside live v0.4.1 interaction: real Mandarin cues rendered over the live episode. A 350 ms hover paused the video at 190.46s and showed `tízǎo` / `ahead of time`; moving to another point in the player closed the popup while playback remained paused; Space resumed playback.
- Fail-open checks: the overlay remains detached/hidden until an actual video is found; an empty subtitle line has no pointer hitbox; only rendered word buttons are interactive; invalidated extension contexts stop polling without an uncaught runtime call.
- Packaged ZIP integrity: `unzip -t` passed.
- Hosted-transcription helper: syntax checks passed; empty hidden-key input cancels safely without writing a credential.
- Real capture: the user's 90-second Chrome WebM passed trusted-metadata validation and hosted transcription completed with `gpt-4o-transcribe`.
- Boundary review: Homebrew `openai-whisper` 20250625_3 with the `tiny` model and word timestamps supplied an independent local timing pass.
- Real cue dataset: corrected Mandarin, explicit phrase segmentation, pinyin, contextual glosses, provenance, and uncertainty notes are present; the uncertain 44–50 second exchange is omitted.

## Not yet verified / blocked

- Cue timing has not yet been checked against playback in the user's live AniKoto player. The independent local boundary pass is approximate, especially where background music overlaps speech.
- The +124.0s default episode offset is anchored from the observed 2:18 English subtitle and has about ±2.5s uncertainty; use the player overlay's sync/fine-adjust controls.
- The dialogue around 44–50 seconds remains intentionally absent because both transcription passes were low-confidence there.

## Precise completion sequence

1. Load the `extension/` folder unpacked in Chrome and confirm version 0.4.1.
2. Reload the supported AniKoto episode after reloading the extension.
3. Choose any working SUB server; Vidstream-2 is supported and avoids requiring VidPlay-1. Click the large player play button if AniKoto first shows a placeholder.
4. Wait for the diagnostic to say **Mandarin connected**, then seek to about 2:15 and verify timing/hover behavior, noting any small offset adjustment.
