# Browserless Mandarin ASR benchmark

This fixture exercises the transcription event pipeline without Chrome. The private audio clip is a 38.4-second clean section cut from the existing user-initiated Link Click episode capture. It deliberately excludes the earlier low-confidence exchange.

## Fast deterministic replay

```sh
npm run benchmark
```

This replays fixed Realtime events, accumulates incremental deltas, rejects duplicate final events, normalizes the transcript, and checks character error rate (CER), coverage, and insertions. It is offline, deterministic, and runs on every `npm test`.

To verify the private clip can be decoded into the exact format sent by the extension, without contacting OpenAI:

```sh
npm run benchmark:preflight
```

## Live browserless transcription

```sh
OPENAI_API_KEY=... npm run benchmark:live
```

The live run decodes the fixture to mono 24 kHz PCM with `ffmpeg`, sends 100 ms chunks through a dedicated Realtime transcription session with `gpt-live-transcribe`, explicitly commits the completed stream, and scores finalized events. It takes approximately the clip's 38-second duration. It never launches Chrome.

To preserve a live event stream for deterministic debugging:

```sh
OPENAI_API_KEY=... npm run benchmark:live -- --record benchmark/live-events.ndjson
```

`live-events.ndjson` is intentionally not required by the test suite because hosted output and timing can vary.

After a live run, rescore the saved events without contacting OpenAI:

```sh
npm run benchmark:latest
```

This writes the current metrics and transcript to `latest-report.json`.

## Reference review

The wording and boundaries in `reference.json` came from the corrected cue dataset and are marked provisional. Before treating the quality threshold as proof, listen to `link-click-ep1-clean-38s.webm` once while checking these lines:

1. 00:00.0–00:02.4 — 年纪比你小，懂事比你早。
2. 00:02.8–00:04.0 — 乔苓姐。
3. 00:04.9–00:07.8 — 要不是看在你的面子上，我才懒得管他。
4. 00:08.3–00:10.0 — 这次任务的委托人，
5. 00:10.0–00:13.6 — 希望我们能在雀德游戏后天公布第三季度财报之前，
6. 00:13.6–00:16.0 — 提早拿到他们的核心财务数据。
7. 00:18.1–00:21.7 — 但这份资料被他们的财务总监单独监管。
8. 00:22.7–00:24.5 — 为了避免系统被黑，
9. 00:24.5–00:28.4 — 他也从不在电脑上留底，随身携带。
10. 00:28.4–00:30.1 — 时间紧，任务重，
11. 00:30.1–00:33.6 — 就别卖关子了，快说突破口在哪儿吧。
12. 00:35.3–00:38.4 — 他的助理：Emma。

The disputed wording at 24.5s and 30.1s was human-reviewed against the clip. The clip hash protects against accidentally benchmarking a different recording.
