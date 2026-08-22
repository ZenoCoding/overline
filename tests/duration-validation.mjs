import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mandarin-capture-test-"));
try {
  const startedAt = "2026-08-19T06:13:22.651Z";
  const endedToken = "2026-08-19T06-13-23-651Z";
  const audio = path.join(directory, `link-click-ep1-excerpt-${endedToken}.webm`);
  const metadata = path.join(directory, `link-click-ep1-excerpt-2026-08-19T06-13-23-653Z.capture.json`);

  const generated = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:a", "libopus", "-f", "webm", "pipe:1"
  ], { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(generated.status, 0, generated.stderr?.toString());
  fs.writeFileSync(audio, generated.stdout);
  fs.writeFileSync(metadata, JSON.stringify({
    schemaVersion: 2,
    sourceUrl: "https://anikototv.to/watch/link-click-2e0jm/ep-1",
    capturedAt: startedAt,
    durationSeconds: 1,
    mediaType: "audio/webm;codecs=opus",
    timeline: {
      schemaVersion: 1,
      clock: "HTMLMediaElement.currentTime",
      anchors: [
        { captureTimeSeconds: 0, playerTimeSeconds: 120, playbackRate: 1, paused: false },
        { captureTimeSeconds: 1, playerTimeSeconds: 121, playbackRate: 1, paused: false }
      ]
    }
  }));

  const result = spawnSync("node", ["scripts/transcribe-openai.mjs", "--validate-only", audio], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, OPENAI_API_KEY: "" }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /trusted capture metadata/);
  assert.match(result.stdout, /No API call made/);
  console.log("Duration regression: PASS (unknown-duration WebM accepted through matching trusted metadata). ");
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
