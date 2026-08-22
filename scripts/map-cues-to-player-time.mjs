#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { analyzeTimeline, mapCuesToPlayerTimeline } from "./player-time-mapping.mjs";

const [metadataArg, cuesArg, outputArg] = process.argv.slice(2);
if (!metadataArg || !cuesArg) {
  console.error("Usage: node scripts/map-cues-to-player-time.mjs <capture.json> <cue-draft.json> [output.json]");
  process.exit(2);
}

const metadataPath = path.resolve(metadataArg);
const cuesPath = path.resolve(cuesArg);
const outputPath = path.resolve(outputArg || "work/transcript/cues.player-time.json");
const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
const cueDraft = JSON.parse(fs.readFileSync(cuesPath, "utf8"));
const analysis = analyzeTimeline(metadata.timeline?.anchors, metadata.durationSeconds);
if (!analysis.valid || !metadata.timeline?.startAnchorPresent || !metadata.timeline?.endAnchorPresent) {
  throw new Error(`Timeline metadata is not safe to map: ${analysis.warnings.join("; ") || "missing start/end anchor"}`);
}

const cues = mapCuesToPlayerTimeline(cueDraft.cues, analysis.anchors);
const crossing = cues.filter((cue) => cue.timelineWarning);
if (crossing.length) throw new Error(`${crossing.length} cue(s) cross a player seek and require review.`);

const output = {
  schemaVersion: 1,
  source: cueDraft.source || "captured-episode-audio-draft",
  timingMethod: "recorded HTMLMediaElement.currentTime anchors",
  captureMetadata: path.basename(metadataPath),
  timelineAnalysis: {
    anchorCount: analysis.anchors.length,
    maxGapSeconds: analysis.maxGapSeconds,
    maxPredictionErrorSeconds: analysis.maxPredictionErrorSeconds,
    discontinuityCount: analysis.discontinuityCount
  },
  cues
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(`Mapped ${cues.length} cues to recorded player time: ${outputPath}`);
