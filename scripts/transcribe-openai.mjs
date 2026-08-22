#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ApiKeyFormatError, normalizeApiKey } from "./api-key.mjs";
import { buildTranscriptionForm, resolveTranscriptionModel, TRANSCRIPTION_ENDPOINT } from "./transcription-request.mjs";
import "../extension/src/cedict-data.js";
import "../extension/src/dict.js";
const MandarinDict = globalThis.MandarinDict;

if (!process.env.OPENAI_API_KEY && fs.existsSync(".env")) {
  const envContent = fs.readFileSync(".env", "utf8");
  const match = envContent.match(/^\s*OPENAI_API_KEY\s*=\s*["']?([^\r\n"']+)["']?/m);
  if (match) process.env.OPENAI_API_KEY = match[1];
}

const validateOnly = process.argv.includes("--validate-only");
const preflight = process.argv.includes("--preflight");
const input = process.argv.find((argument, index) => index >= 2 && !["--validate-only", "--preflight"].includes(argument));
if (!input) {
  console.error("Usage: node scripts/transcribe-openai.mjs [--validate-only|--preflight] /path/to/link-click-excerpt.webm");
  process.exit(2);
}
if (!fs.existsSync(input)) {
  console.error(`Capture not found: ${input}`);
  process.exit(2);
}

const outputDir = path.resolve(process.env.OUTPUT_DIR || "work/transcript");
const chunksDir = path.join(outputDir, ".chunks");
fs.mkdirSync(chunksDir, { recursive: true });
let apiKey = null;
const transcriptionModel = resolveTranscriptionModel();

function probedDuration(file) {
  const value = Number(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file
  ], { encoding: "utf8" }).trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

function timestampTokenToMs(token) {
  const match = token.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  if (!match) return NaN;
  return Date.UTC(...match.slice(1).map(Number).map((value, index) => index === 1 ? value - 1 : value));
}

function companionDuration(file) {
  const directory = path.dirname(file);
  const basename = path.basename(file);
  const audioMatch = basename.match(/^(.*?)(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.webm$/);
  if (!audioMatch) return null;
  const [, prefix, audioToken] = audioMatch;
  const audioEndMs = timestampTokenToMs(audioToken);
  const candidates = fs.readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".capture.json"));

  for (const name of candidates) {
    const metadataMatch = name.match(/^(.*?)(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.capture\.json$/);
    if (!metadataMatch || metadataMatch[1] !== prefix) continue;
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      const duration = Number(metadata.durationSeconds);
      const capturedAtMs = Date.parse(metadata.capturedAt);
      const metadataEndMs = timestampTokenToMs(metadataMatch[2]);
      const expectedEndMs = capturedAtMs + duration * 1000;
      const supportedSchema = metadata.schemaVersion === 1 || metadata.schemaVersion === 2;
      const validTimeline = metadata.schemaVersion === 1 || (
        metadata.timeline?.clock === "HTMLMediaElement.currentTime"
        && Array.isArray(metadata.timeline?.anchors)
        && metadata.timeline.anchors.length >= 1
        && metadata.timeline.anchors.every((anchor) => Number.isFinite(Number(anchor.captureTimeSeconds))
          && Number.isFinite(Number(anchor.playerTimeSeconds)))
      );
      const trusted = supportedSchema
        && /^https:\/\/anikototv\.to\/watch\/link-click-2e0jm\/ep-\d+\/?(?:[?#].*)?$/.test(metadata.sourceUrl || "")
        && String(metadata.mediaType || "").startsWith("audio/webm")
        && Number.isFinite(duration) && duration > 0 && duration <= 95
        && Number.isFinite(capturedAtMs)
        && Math.abs(metadataEndMs - audioEndMs) <= 5_000
        && Math.abs(expectedEndMs - audioEndMs) <= 5_000
        && validTimeline;
      if (trusted) return { duration, file: path.join(directory, name) };
    } catch {
      // Ignore malformed or unrelated metadata and continue to the decode fallback.
    }
  }
  return null;
}

function decodedDuration(file) {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-i", file, "-f", "null", "-"], { encoding: "utf8" });
  const matches = [...(result.stderr || "").matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  if (!matches.length) return null;
  const [, hours, minutes, seconds] = matches.at(-1);
  const duration = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function mediaDuration(file) {
  const probed = probedDuration(file);
  if (probed) return { duration: probed, source: "ffprobe container metadata" };
  const companion = companionDuration(file);
  if (companion) return { duration: companion.duration, source: `trusted capture metadata (${path.basename(companion.file)})` };
  const decoded = decodedDuration(file);
  if (decoded) return { duration: decoded, source: "decoded audio stream" };
  return { duration: null, source: "unavailable" };
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
  const bytes = fs.readFileSync(chunkPath);
  const form = buildTranscriptionForm(bytes, path.basename(chunkPath), transcriptionModel);
  let response;
  try {
    response = await fetch(TRANSCRIPTION_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
  } catch (error) {
    if (error?.cause?.code === "UND_ERR_INVALID_ARG") {
      throw new Error("Local request setup rejected the Authorization header before contacting OpenAI. Re-enter the raw key without quotes, whitespace, or line breaks.");
    }
    throw new Error(`Could not reach the OpenAI transcription endpoint: ${error?.cause?.code || error.message || "network failure"}`);
  }
  const payload = await response.json();
  if (response.status === 401 || response.status === 403) {
    throw new Error(`OpenAI rejected the credential or project access (${response.status}). Verify the key and API project permissions, then retry.`);
  }
  if (!response.ok) throw new Error(`OpenAI transcription failed (${response.status}): ${payload.error?.message || "unknown error"}`);
  return payload.text?.trim() || "";
}

const durationResult = mediaDuration(input);
const duration = durationResult.duration;
if (!Number.isFinite(duration) || duration <= 0 || duration > 95) {
  throw new Error(`Expected a short capture no longer than 95 seconds; found ${duration || "unknown"} seconds.`);
}

const windows = speechWindows(input, duration);
if (validateOnly) {
  console.log(`Validated ${duration.toFixed(3)} second capture using ${durationResult.source}; ${windows.length} speech window(s). No API call made.`);
  process.exit(0);
}
try {
  apiKey = normalizeApiKey(process.env.OPENAI_API_KEY);
  delete process.env.OPENAI_API_KEY;
} catch (error) {
  if (error instanceof ApiKeyFormatError) {
    console.error(error.message);
    process.exit(3);
  }
  throw error;
}
if (preflight) {
  console.log(`Request preflight passed for model ${transcriptionModel}, a ${duration.toFixed(3)} second capture, and ${windows.length} speech window(s). Authorization header and multipart request fields are locally valid; no API call made.`);
  process.exit(0);
}
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
  model: transcriptionModel,
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
  notice: "Draft from a user-initiated short audio capture, automatically tokenized and annotated with MandarinDict.",
  cues: segments.map((segment) => ({
    start: segment.start,
    end: segment.end,
    words: MandarinDict?.segmentAndAnnotate
      ? MandarinDict.segmentAndAnnotate(segment.text)
      : [{ text: segment.text, pinyin: "TODO", gloss: "TODO" }]
  }))
};

fs.writeFileSync(path.join(outputDir, "transcript.raw.json"), JSON.stringify(raw, null, 2) + "\n");
fs.writeFileSync(path.join(outputDir, "cue-draft.json"), JSON.stringify(cueDraft, null, 2) + "\n");
fs.rmSync(chunksDir, { recursive: true, force: true });
console.log(`Wrote timestamped transcript and cue draft to ${outputDir}`);
