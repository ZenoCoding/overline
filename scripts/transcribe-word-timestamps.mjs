#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { ApiKeyFormatError, normalizeApiKey } from "./api-key.mjs";
import { TRANSCRIPTION_ENDPOINT } from "./transcription-request.mjs";

const DEFAULT_WHISPER_CONTEXT_PROMPT = "时光代理人，程小时，陆光，乔苓，雀德游戏，财务总监，Emma。简体中文对白。";

function loadDotEnvKey() {
  if (process.env.OPENAI_API_KEY || !fs.existsSync(".env")) return;
  const match = fs.readFileSync(".env", "utf8")
    .match(/^\s*OPENAI_API_KEY\s*=\s*["']?([^\r\n"']+)["']?/m);
  if (match) process.env.OPENAI_API_KEY = match[1];
}

function usage() {
  console.error("Usage: node scripts/transcribe-word-timestamps.mjs <audio> [output.json]");
}

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg) {
  usage();
  process.exit(2);
}

const inputPath = path.resolve(inputArg);
const outputPath = path.resolve(outputArg || "work/transcript/whisper-word-timestamps.json");
if (!fs.existsSync(inputPath)) throw new Error(`Audio file not found: ${inputPath}`);
if (fs.statSync(inputPath).size > 25 * 1024 * 1024) {
  throw new Error("Audio exceeds the Transcriptions API 25 MB file limit; split it at a silence first.");
}

loadDotEnvKey();
let apiKey;
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

const bytes = fs.readFileSync(inputPath);
const form = new FormData();
form.append("file", new Blob([bytes], { type: "audio/webm" }), path.basename(inputPath));
form.append("model", "whisper-1");
form.append("language", "zh");
form.append("response_format", "verbose_json");
form.append("timestamp_granularities[]", "word");
form.append("timestamp_granularities[]", "segment");
form.append("prompt", process.env.WHISPER_CONTEXT_PROMPT || DEFAULT_WHISPER_CONTEXT_PROMPT);

const response = await fetch(TRANSCRIPTION_ENDPOINT, {
  method: "POST",
  headers: { Authorization: `Bearer ${apiKey}` },
  body: form
});
const payload = await response.json();
if (!response.ok) {
  throw new Error(`OpenAI timestamp transcription failed (${response.status}): ${payload.error?.message || "unknown error"}`);
}
if (!Array.isArray(payload.words) || !payload.words.length) {
  throw new Error("Timestamp transcription returned no word timing data.");
}

const output = {
  schemaVersion: 1,
  model: "whisper-1",
  language: payload.language || "zh",
  sourceAudio: path.basename(inputPath),
  durationSeconds: payload.duration,
  text: payload.text,
  segments: payload.segments || [],
  words: payload.words
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(`Wrote ${output.words.length} word timestamps and ${output.segments.length} segments to ${outputPath}`);
