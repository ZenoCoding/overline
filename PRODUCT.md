# Overline

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Active Mandarin learners watching Chinese-language video in the browser. Their primary job is to follow authentic dialogue while checking pronunciation and meaning without leaving the viewing flow.

## Product Purpose

The extension makes Mandarin video comprehensible without turning viewing into a stop-start study session. Success means learners can follow dialogue, intentionally inspect unfamiliar words, and return their attention to the scene with minimal interruption.

## Positioning

Unlike ordinary bilingual subtitles or detached transcript tools, the extension turns each on-video Mandarin word into an intentional learning surface: hover reveals pinyin and a contextual gloss while preserving the surrounding scene.

## Operating Context

The current supported experience is Link Click episode 1 on AniKoto, whose video may run inside a cross-origin provider iframe. Learners start live transcription from the browser-extension popup, then may close the popup while background capture continues. The player overlay presents Mandarin cues and reveals learning detail on intentional hover.

## Capabilities and Constraints

- Preserve the MV3 ownership boundaries: the popup initiates capture, the offscreen document owns audio and transcription, and the background service worker routes state and cues.
- Tab capture must begin from the extension toolbar user gesture; the player must not auto-start it.
- Preserve the existing hover behavior, player controls, live transcription, short excerpt capture, API-key configuration, and sync controls.
- Use CC-CEDICT as the general Mandarin lexical source; reserve the adaptation layer for names, fictional entities, and contextual overrides.
- Render Chinese continuously even though dictionary matches remain separate hover targets.
- Keep functional live transcription distinct from timing accuracy. Existing approximate cue offsets are not proof of synchronization.
- The current product surface is intentionally narrow rather than a general streaming platform.

## Evidence on Hand

- Real Link Click episode 1 cue data at `extension/data/link-click-ep1.real.json`.
- A working live-transcription architecture and browser-verified popup-close persistence.
- Existing fixture and regression coverage under `fixture/` and `tests/`.
- No testimonials, benchmark claims, or licensed brand imagery are available; future work must not fabricate them.

## Product Principles

- Keep the scene primary and learning detail available on intent.
- Make system state legible without making the interface feel diagnostic.
- Preserve user agency around capture, pausing, and disclosure.
- Suspend live audio submission whenever video playback is paused, and make that state explicit in the overlay.
- Prefer authentic dialogue and honest uncertainty over invented completeness.
- Treat synchronization as an evidence-backed behavior, not a cosmetic label.

## Accessibility & Inclusion

Controls must remain keyboard reachable, focus-visible, readable over moving video, and usable with reduced motion. Status must not rely on color alone.
