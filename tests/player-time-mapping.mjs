import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  analyzeTimeline,
  mapCaptureTimeToPlayer,
  mapCuesToPlayerTimeline
} from "../scripts/player-time-mapping.mjs";

const anchors = [
  { captureTimeSeconds: 0, playerTimeSeconds: 100, playbackRate: 1, paused: false, reason: "capture-start" },
  { captureTimeSeconds: 10, playerTimeSeconds: 110, playbackRate: 1, paused: false, reason: "periodic" },
  { captureTimeSeconds: 12, playerTimeSeconds: 112, playbackRate: 1, paused: true, reason: "pause" },
  { captureTimeSeconds: 15, playerTimeSeconds: 112, playbackRate: 1, paused: false, reason: "play" },
  { captureTimeSeconds: 20, playerTimeSeconds: 300, playbackRate: 1, paused: false, reason: "seeked" },
  { captureTimeSeconds: 25, playerTimeSeconds: 305, playbackRate: 2, paused: false, reason: "ratechange" },
  { captureTimeSeconds: 30, playerTimeSeconds: 315, playbackRate: 2, paused: false, stalled: true, reason: "waiting" },
  { captureTimeSeconds: 32, playerTimeSeconds: 315, playbackRate: 2, paused: false, stalled: false, reason: "playing" },
  { captureTimeSeconds: 35, playerTimeSeconds: 321, playbackRate: 2, paused: false, reason: "capture-stop" }
];

assert.equal(mapCaptureTimeToPlayer(5, anchors), 105);
assert.equal(mapCaptureTimeToPlayer(13.5, anchors), 112, "player time must remain fixed while paused");
assert.equal(mapCaptureTimeToPlayer(17, anchors), 114, "mapping must resume from the play anchor");
assert.equal(mapCaptureTimeToPlayer(21.25, anchors), 301.25, "a seek anchor must replace all earlier offsets");
assert.equal(mapCaptureTimeToPlayer(27, anchors), 309, "playback rate changes must affect subsequent mapping");
assert.equal(mapCaptureTimeToPlayer(31, anchors), 315, "player time must remain fixed while buffering");
assert.equal(mapCaptureTimeToPlayer(34, anchors), 319, "mapping must resume after buffering");

const analysis = analyzeTimeline(anchors, 35);
assert.equal(analysis.valid, true, analysis.warnings.join("; "));
assert.equal(analysis.discontinuityCount, 1);
assert.equal(analysis.maxGapSeconds, 10);
assert.equal(analysis.maxPredictionErrorSeconds, 0);

const mapped = mapCuesToPlayerTimeline([
  { start: 1, end: 2, text: "normal" },
  { start: 19.5, end: 20.5, text: "crosses seek" }
], anchors);
assert.deepEqual({ start: mapped[0].start, end: mapped[0].end }, { start: 101, end: 102 });
assert.equal(mapped[1].timelineWarning, "cue-crosses-player-seek");

const popupSource = fs.readFileSync("extension/capture/popup.js", "utf8");
const outerSource = fs.readFileSync("extension/src/outer.js", "utf8");
const playerSource = fs.readFileSync("extension/src/player.js", "utf8");
assert.match(popupSource, /schemaVersion:\s*2/);
assert.match(popupSource, /timelineAnchors/);
assert.match(outerSource, /ak-mandarin-player-timeline-anchor/);
assert.match(playerSource, /ak-mandarin-request-timeline-anchor/);

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "player-time-capture-"));
try {
  const metadataPath = path.join(tempDirectory, "sample.capture.json");
  const cuesPath = path.join(tempDirectory, "cues.json");
  const outputPath = path.join(tempDirectory, "mapped.json");
  fs.writeFileSync(metadataPath, JSON.stringify({
    schemaVersion: 2,
    durationSeconds: 35,
    timeline: {
      clock: "HTMLMediaElement.currentTime",
      startAnchorPresent: true,
      endAnchorPresent: true,
      anchors
    }
  }));
  fs.writeFileSync(cuesPath, JSON.stringify({ source: "test", cues: [{ start: 1, end: 2, words: [{ text: "好" }] }] }));

  const validation = spawnSync("node", ["scripts/validate-timeline-capture.mjs", metadataPath], { encoding: "utf8" });
  assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  assert.match(validation.stdout, /Timeline capture: PASS/);

  const conversion = spawnSync("node", ["scripts/map-cues-to-player-time.mjs", metadataPath, cuesPath, outputPath], { encoding: "utf8" });
  assert.equal(conversion.status, 0, conversion.stderr || conversion.stdout);
  const converted = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.deepEqual({ start: converted.cues[0].start, end: converted.cues[0].end }, { start: 101, end: 102 });
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}

console.log("Player-time mapping: PASS (periodic anchors, pause, seek, rate change, buffering, and cue mapping validated).");
