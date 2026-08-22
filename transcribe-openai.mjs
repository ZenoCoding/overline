#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/transcribe-openai.mjs /path/to/link-click-excerpt.webm");
  process.exit(2);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is not set. Export it in this shell, then rerun; the key is never written to disk or sent to the extension.");
  process.exit(3);
}
if (!fs.existsSync(input)) {
  console.error(`Capture not found: ${input}`);
  process.exit(2);
}

const outputDir = path.resolve(process.env.OUTPUT_DIR || "work/transcript");
const chunksDir = path.join(outputDir, ".chunks");
fs.mkdirSync(chunksDir, { recursive: true });

function mediaDuration(file) {
  return Number(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file
  ], { encoding: "utf8" }).trim());
}

function speechWindows(file, duration) {
  const analysis = spawnSync("ffmpeg", [
    "-hide_banner", "-i", file, "-af", "silencedetect=noise=-36dB:d=0.35", "-f", "null", "-"
  ], { encoding: "utf8" });
  const stderr = analysis.stderr || "";

  const events = [...stderr.matchAll(/silence_(start|end):\s*([0-9.]+)/g)]
    .map((match) => ({ type: match[1], time: Number(match[2]) }));
  const windows = [];
  let cursor = 0;
  for (const event of events) {
    if (event.type === "start" && event.time - cursor >= 0.45) windows.push([cursor, event.time]);
    if (event.type === "end") cursor = event.time;
  }
  if (duration - cursor >= 0.45) windows.push([cursor, duration]);

  // Bound each request to at most 15 seconds. Known offsets become draft segment timing.
  const bounded = [];
  for (const [start, end] of windows.length ? windows : [[0, duration]]) {
    for (let at = start; at < end; at += 15) bounded.push([at, Math.min(end, at + 15)]);
  }
  return bounded;
}

async function transcribeChunk(chunkPath) {
  const form = new FormData();
  const bytes = fs.readFileSync(chunkPath);
  form.append("file", new Blob([bytes], { type: "audio/wav" }), path.basename(chunkPath));
  form.append("model", "gpt-4o-transcribe");
  form.append("language", "zh");
  form.append("response_format", "json");
  form.append("prompt", "Transcribe the spoken Mandarin Chinese exactly in Simplified Chinese. Preserve names and sentence-final particles. Do not translate.");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`OpenAI transcription failed (${response.status}): ${payload.error?.message || "unknown error"}`);
  return payload.text?.trim() || "";
}

const duration = mediaDuration(input);
if (!Number.isFinite(duration) || duration <= 0 || duration > 95) {
  throw new Error(`Expected a short capture no longer than 95 seconds; found ${duration || "unknown"} seconds.`);
}

const windows = speechWindows(input, duration);
const segments = [];
for (let index = 0; index < windows.length; index += 1) {
  const [start, end] = windows[index];
  const chunkPath = path.join(chunksDir, `${String(index).padStart(3, "0")}.wav`);
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-ss", String(start), "-to", String(end), "-i", input,
    "-vn", "-ac", "1", "-ar", "16000", chunkPath
  ]);
  const text = await transcribeChunk(chunkPath);
  if (text) segments.push({ start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), text });
  console.log(`Transcribed speech window ${index + 1}/${windows.length}.`);
}

const raw = {
  schemaVersion: 1,
  model: "gpt-4o-transcribe",
  language: "zh",
  timingMethod: "ffmpeg silence windows; hand-correction required",
  sourceAudio: path.basename(input),
  durationSeconds: Number(duration.toFixed(3)),
  segments
};
const cueDraft = {
  schemaVersion: 1,
  source: "captured-episode-audio-draft",
  episode: "Link Click — Episode 1",
  notice: "Draft from a user-initiated short audio capture. Mandarin text and timing must be manually checked before replacing extension cues.",
  cues: segments.map((segment) => ({
    start: segment.start,
    end: segment.end,
    words: [{ text: segment.text, pinyin: "TODO", gloss: "TODO" }]
  }))
};

fs.writeFileSync(path.join(outputDir, "transcript.raw.json"), JSON.stringify(raw, null, 2) + "\n");
fs.writeFileSync(path.join(outputDir, "cue-draft.json"), JSON.stringify(cueDraft, null, 2) + "\n");
fs.rmSync(chunksDir, { recursive: true, force: true });
console.log(`Wrote timestamped transcript and cue draft to ${outputDir}`);
