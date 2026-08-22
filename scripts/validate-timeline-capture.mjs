#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { analyzeTimeline } from "./player-time-mapping.mjs";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/validate-timeline-capture.mjs <capture.json>");
  process.exit(2);
}

const file = path.resolve(input);
const metadata = JSON.parse(fs.readFileSync(file, "utf8"));
if (metadata.schemaVersion !== 2) throw new Error(`Expected capture metadata schema 2, found ${metadata.schemaVersion ?? "none"}.`);
if (metadata.timeline?.clock !== "HTMLMediaElement.currentTime") throw new Error("Capture does not use the HTML media-element player clock.");

const analysis = analyzeTimeline(metadata.timeline.anchors, metadata.durationSeconds);
const startAnchorPresent = Boolean(metadata.timeline.startAnchorPresent && analysis.anchors[0]?.captureTimeSeconds <= 1);
const endAnchorPresent = Boolean(metadata.timeline.endAnchorPresent
  && analysis.anchors.at(-1)?.captureTimeSeconds >= Number(metadata.durationSeconds) - 1);
const passed = analysis.valid && startAnchorPresent && endAnchorPresent;

console.log(`Timeline capture: ${passed ? "PASS" : "FAIL"}`);
console.log(`File: ${file}`);
console.log(`Duration: ${Number(metadata.durationSeconds).toFixed(1)}s`);
console.log(`Anchors: ${analysis.anchors.length} (${analysis.anchors[0]?.playerTimeSeconds ?? "?"}s → ${analysis.anchors.at(-1)?.playerTimeSeconds ?? "?"}s player time)`);
console.log(`Maximum anchor gap: ${analysis.maxGapSeconds ?? "?"}s`);
console.log(`Maximum continuous-clock prediction error: ${analysis.maxPredictionErrorSeconds ?? "?"}s`);
console.log(`Detected discontinuities/seeks: ${analysis.discontinuityCount}`);
if (!startAnchorPresent) console.log("Problem: missing a player-time anchor within one second of capture start.");
if (!endAnchorPresent) console.log("Problem: missing a player-time anchor within one second of capture end.");
for (const warning of analysis.warnings) console.log(`Problem: ${warning}`);
if (!passed) process.exitCode = 1;
