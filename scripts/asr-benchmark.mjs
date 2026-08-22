#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { evaluateBenchmark } from "./asr-benchmark-core.mjs";

const ROOT = process.cwd();
const BENCHMARK_DIR = path.join(ROOT, "benchmark");
const REFERENCE_PATH = path.join(BENCHMARK_DIR, "reference.json");
const REPLAY_PATH = path.join(BENCHMARK_DIR, "replay-events.ndjson");
const live = process.argv.includes("--live");
const preflight = process.argv.includes("--preflight");
const noPace = process.argv.includes("--no-pace");
const recordIndex = process.argv.indexOf("--record");
const recordPath = recordIndex >= 0 ? path.resolve(process.argv[recordIndex + 1] || "") : null;
const eventsIndex = process.argv.indexOf("--events");
const eventsPath = eventsIndex >= 0 ? path.resolve(process.argv[eventsIndex + 1] || "") : null;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readNdjson(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(check, 25);
    };
    check();
  });
}

function decodePcm(audioPath) {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", audioPath,
    "-vn", "-ac", "1", "-ar", "24000", "-f", "s16le", "pipe:1"
  ], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg could not decode benchmark audio: ${String(result.stderr || "").trim()}`);
  }
  return result.stdout;
}

async function runLive(reference, audioPath) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for --live; deterministic replay needs no key.");
  if (typeof WebSocket !== "function") throw new Error("This Node runtime does not provide WebSocket support.");

  const transcriptionModel = process.env.OPENAI_TRANSCRIBE_MODEL || reference.live.model;
  const socket = new WebSocket(
    "wss://api.openai.com/v1/realtime?intent=transcription",
    ["realtime", `openai-insecure-api-key.${apiKey}`]
  );
  const records = [];
  let sessionReady = false;
  let fatalError = null;
  let audioStartedAt = null;
  let lastRelevantEventAt = 0;
  let pendingCompletions = 0;

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: {
              model: transcriptionModel,
              prompt: reference.live.prompt,
              keywords: reference.live.keywords,
              languages: ["zh"],
              delay: "minimal"
            },
            turn_detection: null
          }
        }
      }
    }));
  });

  socket.addEventListener("message", (message) => {
    let event;
    try {
      event = JSON.parse(String(message.data));
    } catch {
      return;
    }
    if (event.type === "error") {
      fatalError = new Error(event.error?.message || event.error?.code || "Realtime benchmark failed");
      try { socket.close(1011, "benchmark error"); } catch {}
      return;
    }
    if (event.type === "session.updated") sessionReady = true;
    if (event.type === "input_audio_buffer.speech_stopped") pendingCompletions++;
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      pendingCompletions = Math.max(0, pendingCompletions - 1);
    }
    if (audioStartedAt !== null && [
      "input_audio_buffer.speech_started",
      "input_audio_buffer.speech_stopped",
      "conversation.item.input_audio_transcription.delta",
      "conversation.item.input_audio_transcription.completed"
    ].includes(event.type)) {
      const atMs = Math.round(performance.now() - audioStartedAt);
      records.push({ atMs, event });
      lastRelevantEventAt = performance.now();
    }
  });
  socket.addEventListener("error", () => {
    fatalError = new Error("Realtime WebSocket connection failed.");
  });

  await waitFor(() => sessionReady || fatalError, 10_000, "Realtime session configuration");
  if (fatalError) throw fatalError;

  const pcm = decodePcm(audioPath);
  const bytesPer100ms = 24_000 * 2 / 10;
  audioStartedAt = performance.now();
  lastRelevantEventAt = audioStartedAt;
  for (let offset = 0; offset < pcm.length; offset += bytesPer100ms) {
    if (fatalError) throw fatalError;
    const chunk = pcm.subarray(offset, Math.min(pcm.length, offset + bytesPer100ms));
    socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: chunk.toString("base64") }));
    if (!noPace) await delay(100);
  }

  // A short silent tail lets server VAD close speech at the end of the clip.
  for (let i = 0; i < 10; i++) {
    socket.send(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: Buffer.alloc(bytesPer100ms).toString("base64")
    }));
    if (!noPace) await delay(100);
  }
  socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

  await waitFor(
    () => fatalError || (records.some((record) => record.event.type.endsWith(".completed"))
      && pendingCompletions === 0
      && performance.now() - lastRelevantEventAt > 1500),
    15_000,
    "final transcription events"
  );
  try { socket.close(1000, "benchmark complete"); } catch {}
  if (fatalError) throw fatalError;
  return records;
}

function printReport(mode, reference, result) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  console.log(`ASR benchmark: ${result.passed ? "PASS" : "FAIL"} (${mode})`);
  console.log(`Reference: ${reference.utterances.length} utterances, ${result.quality.referenceCharacters} normalized characters`);
  console.log(`Observed:  ${result.utteranceCount} final utterances, ${result.quality.hypothesisCharacters} normalized characters`);
  console.log(`CER: ${percent(result.quality.cer)} | coverage: ${percent(result.quality.coverage)} | insertion rate: ${percent(result.quality.insertionRate)}`);
  console.log(`Edits: ${result.quality.substitutions} substitutions, ${result.quality.deletions} deletions, ${result.quality.insertions} insertions`);
  console.log(`First-token latency: median ${result.firstTokenLatencyMs.median ?? "n/a"} ms, p95 ${result.firstTokenLatencyMs.p95 ?? "n/a"} ms`);
  console.log(`Finalization: median ${result.finalizationMs.median ?? "n/a"} ms, p95 ${result.finalizationMs.p95 ?? "n/a"} ms`);
  if (!result.passed) {
    console.log(`Checks: ${Object.entries(result.checks).map(([name, passed]) => `${name}=${passed ? "pass" : "fail"}`).join(", ")}`);
  }
}

async function main() {
  const reference = readJson(REFERENCE_PATH);
  const audioPath = path.join(BENCHMARK_DIR, reference.clip.file);
  const actualHash = sha256(audioPath);
  if (actualHash !== reference.clip.sha256) {
    throw new Error(`Benchmark clip hash mismatch: expected ${reference.clip.sha256}, got ${actualHash}`);
  }

  if (preflight) {
    const pcm = decodePcm(audioPath);
    const decodedSeconds = pcm.length / (24_000 * 2);
    const durationError = Math.abs(decodedSeconds - reference.clip.durationSeconds);
    if (durationError > 0.1) {
      throw new Error(`Decoded duration ${decodedSeconds.toFixed(3)}s differs from reference by ${durationError.toFixed(3)}s`);
    }
    console.log(`ASR benchmark preflight: PASS (${decodedSeconds.toFixed(3)}s mono 24 kHz PCM, ${pcm.length} bytes, clip hash verified)`);
    return;
  }

  const records = live ? await runLive(reference, audioPath) : readNdjson(eventsPath || REPLAY_PATH);
  if (recordPath) {
    fs.writeFileSync(recordPath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    console.log(`Recorded ${records.length} events to ${recordPath}`);
  }
  const result = evaluateBenchmark(reference, records);
  const mode = live ? "live 24 kHz PCM" : (eventsPath ? "recorded live event replay" : "deterministic event replay");
  if (live || eventsPath) {
    const reportPath = path.join(BENCHMARK_DIR, "latest-report.json");
    fs.writeFileSync(reportPath, JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      mode,
      clipSha256: reference.clip.sha256,
      referenceReviewState: reference.reviewState,
      passed: result.passed,
      checks: result.checks,
      quality: {
        referenceCharacters: result.quality.referenceCharacters,
        hypothesisCharacters: result.quality.hypothesisCharacters,
        substitutions: result.quality.substitutions,
        deletions: result.quality.deletions,
        insertions: result.quality.insertions,
        cer: result.quality.cer,
        coverage: result.quality.coverage,
        insertionRate: result.quality.insertionRate
      },
      utteranceCount: result.utteranceCount,
      duplicateFinals: result.duplicateFinals,
      firstTokenLatencyMs: result.firstTokenLatencyMs,
      finalizationMs: result.finalizationMs,
      transcript: result.transcript
    }, null, 2) + "\n");
    console.log(`Wrote scored report to ${reportPath}`);
  }
  printReport(mode, reference, result);
  if (!result.passed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`ASR benchmark error: ${error.message}`);
  process.exitCode = 1;
});
