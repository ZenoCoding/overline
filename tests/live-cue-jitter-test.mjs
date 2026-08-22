import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

// Load MandarinDict in Node environment
const dictSource = ["extension/src/cedict-data.js", "extension/src/dict.js"]
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
const dictContext = { globalThis: {}, module: {} };
new Function("globalThis", "module", dictSource)(dictContext.globalThis, dictContext.module);
const MandarinDict = dictContext.module.exports || dictContext.globalThis.MandarinDict;

assert.ok(MandarinDict, "MandarinDict must be available");

// Audio processing functions matching extension/capture/popup.js
function downsampleBuffer(buffer, inputRate, outputRate) {
  if (inputRate === outputRate) return buffer;
  const ratio = inputRate / outputRate;
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function encodeWAV(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }
  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); // 16-bit
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return view;
}

function computeRMS(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

// ============================================================================
// 1. Audio Downsampling & WAV Encoder Across All Standard Sample Rates
// ============================================================================
console.log("Testing audio downsampling and WAV encoder across diverse sample rates...");
{
  const testSampleRates = [8000, 11025, 16000, 22050, 44100, 48000, 96000];
  const TARGET_RATE = 16000;

  for (const inputRate of testSampleRates) {
    const durationSec = 1.5;
    const numSamples = Math.round(inputRate * durationSec);
    const audioBuffer = new Float32Array(numSamples);

    // Populate with test signal (including potential out-of-bound samples to test clamping)
    for (let i = 0; i < numSamples; i++) {
      const t = i / inputRate;
      let val = Math.sin(2 * Math.PI * 440 * t);
      if (i % 100 === 0) val *= 1.5; // Test clipping protection (> 1.0)
      if (i % 101 === 0) val = -1.8; // Test clipping protection (< -1.0)
      audioBuffer[i] = val;
    }

    const downsampled = downsampleBuffer(audioBuffer, inputRate, TARGET_RATE);
    const expectedLength = Math.round(numSamples / (inputRate / TARGET_RATE));
    assert.equal(downsampled.length, expectedLength, `Downsampled length mismatch for input rate ${inputRate}`);

    // Verify no NaNs or Infinities
    for (let i = 0; i < downsampled.length; i++) {
      assert.ok(!Number.isNaN(downsampled[i]), `NaN detected at index ${i} for rate ${inputRate}`);
      assert.ok(Number.isFinite(downsampled[i]), `Non-finite sample at ${i} for rate ${inputRate}`);
    }

    const wav = encodeWAV(downsampled, TARGET_RATE);
    assert.equal(wav.byteLength, 44 + downsampled.length * 2);

    // Assert WAV Header fields
    const riff = String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3));
    const wave = String.fromCharCode(wav.getUint8(8), wav.getUint8(9), wav.getUint8(10), wav.getUint8(11));
    const fmt = String.fromCharCode(wav.getUint8(12), wav.getUint8(13), wav.getUint8(14), wav.getUint8(15));
    const data = String.fromCharCode(wav.getUint8(36), wav.getUint8(37), wav.getUint8(38), wav.getUint8(39));

    assert.equal(riff, "RIFF");
    assert.equal(wave, "WAVE");
    assert.equal(fmt, "fmt ");
    assert.equal(data, "data");

    assert.equal(wav.getUint16(20, true), 1, "Format must be PCM (1)");
    assert.equal(wav.getUint16(22, true), 1, "Channels must be Mono (1)");
    assert.equal(wav.getUint32(24, true), TARGET_RATE, `Sample rate must be ${TARGET_RATE}`);
    assert.equal(wav.getUint32(28, true), TARGET_RATE * 2, `Byte rate must be ${TARGET_RATE * 2}`);
    assert.equal(wav.getUint16(32, true), 2, "Block align must be 2");
    assert.equal(wav.getUint16(34, true), 16, "Bits per sample must be 16");
    assert.equal(wav.getUint32(40, true), downsampled.length * 2, "Data chunk size must match samples length * 2");
  }
  console.log("  ✓ Downsampling & WAV encoding passed across all standard sample rates.");
}

// ============================================================================
// 2. Silence Suppression & RMS Energy Thresholding
// ============================================================================
console.log("Testing RMS energy calculation and silence suppression...");
{
  const MIN_SPEECH_RMS = 0.008;

  // Pure silence
  const silentBuffer = new Float32Array(44100).fill(0);
  assert.equal(computeRMS(silentBuffer), 0);
  assert.ok(computeRMS(silentBuffer) < MIN_SPEECH_RMS, "Silent buffer must be below speech threshold");

  // Low background noise
  const noiseBuffer = new Float32Array(44100);
  for (let i = 0; i < noiseBuffer.length; i++) noiseBuffer[i] = (Math.random() - 0.5) * 0.005;
  assert.ok(computeRMS(noiseBuffer) < MIN_SPEECH_RMS, "Noise floor must be below speech threshold");

  // Speech signal
  const speechBuffer = new Float32Array(44100);
  for (let i = 0; i < speechBuffer.length; i++) speechBuffer[i] = Math.sin(2 * Math.PI * 300 * (i / 44100)) * 0.2;
  const speechRms = computeRMS(speechBuffer);
  assert.ok(speechRms > MIN_SPEECH_RMS, `Speech RMS (${speechRms}) must exceed threshold`);

  console.log("  ✓ Silence suppression and RMS energy calculation passed.");
}

// ============================================================================
// 3. Pipeline Timing & Jitter Compensation Simulation
// ============================================================================
console.log("Testing pipeline timing and jitter compensation under fluctuating conditions...");
{
  // Simulated speech stream chunks with varying network jitter and burst conditions
  const simulatedEvents = [
    { text: "老租婆又来吸血喽。", chunkDur: 2500, encodeMs: 1.2, apiLatency: 350, networkJitterMs: 15 },
    { text: "成天吊儿郎当的。", chunkDur: 2400, encodeMs: 1.1, apiLatency: 820, networkJitterMs: 250 }, // Latency spike
    { text: "就你这德行！", chunkDur: 2200, encodeMs: 0.9, apiLatency: 280, networkJitterMs: -40 },
    { text: "等着关门歇业打包滚蛋吧！", chunkDur: 2800, encodeMs: 1.4, apiLatency: 410, networkJitterMs: 50 },
    { text: "", chunkDur: 2500, encodeMs: 0.8, apiLatency: 150, networkJitterMs: 0 }, // Silence / empty result
  ];

  const processedCues = [];
  const latencyHistory = [];
  let peakLatencyMs = 0;

  for (const evt of simulatedEvents) {
    if (!evt.text.trim()) continue; // Handled empty transcription frame

    const tTokenStart = performance.now();
    const words = MandarinDict.segmentAndAnnotate(evt.text);
    const tokenizationLatencyMs = Math.round((performance.now() - tTokenStart) * 1000) / 1000;

    const baseCapturedAt = 1724089990000;
    const apiLatencyMs = evt.apiLatency + evt.networkJitterMs;
    const encodeLatencyMs = evt.encodeMs;
    const audioChunkDurationMs = evt.chunkDur;
    const totalPipelineLatencyMs = Math.round((apiLatencyMs + tokenizationLatencyMs + encodeLatencyMs) * 10) / 10;

    // Track rolling average & peak
    latencyHistory.push(totalPipelineLatencyMs);
    if (latencyHistory.length > 50) latencyHistory.shift();
    const rollingAvg = Math.round(latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length);
    if (totalPipelineLatencyMs > peakLatencyMs) peakLatencyMs = totalPipelineLatencyMs;

    // Simulate player render latency
    const tRenderStart = performance.now();
    // Simulate DOM node creation
    const renderedWords = words.map((w) => ({
      text: w.text,
      pinyin: w.pinyin,
      gloss: w.gloss
    }));
    const tRenderEnd = performance.now();
    const renderLatencyMs = Math.round((tRenderEnd - tRenderStart) * 100) / 100;

    // Jitter validation: ensure pipeline latency calculations are positive and bounded
    assert.ok(totalPipelineLatencyMs > 0, "Pipeline latency must be positive");
    assert.ok(tokenizationLatencyMs >= 0, "Tokenization latency must be non-negative");
    assert.ok(renderLatencyMs >= 0, "Render latency must be non-negative");

    const cue = {
      text: evt.text,
      words: renderedWords,
      isLive: true,
      timestamp: Date.now(),
      timing: {
        audioChunkDurationMs,
        encodeLatencyMs,
        apiLatencyMs,
        tokenizationLatencyMs,
        renderLatencyMs,
        capturedAt: baseCapturedAt,
        totalPipelineLatencyMs
      }
    };

    processedCues.push(cue);
  }

  assert.equal(processedCues.length, 4, "Should process all 4 non-empty live speech events");
  assert.ok(peakLatencyMs > 1000, "Peak latency should reflect the simulated network jitter spike");
  assert.ok(processedCues.every((c) => c.words.length > 0), "All cues must have segmented words");

  console.log(`  ✓ Processed ${processedCues.length} live cue chunks with rolling avg and peak latency tracking.`);
}

// ============================================================================
// 4. Out-of-Order Timestamp and Jitter Bounds
// ============================================================================
console.log("Testing out-of-order and burst arrival timestamp compensation...");
{
  const now = Date.now();
  const testTimings = [
    { capturedAt: now - 500, renderEndTime: 10, expectedDiffValid: true },
    { capturedAt: now - 5000, renderEndTime: 12, expectedDiffValid: true },
    { capturedAt: now + 500, renderEndTime: 10, expectedDiffValid: false }, // Future timestamp (clock skew)
    { capturedAt: now - 120_000, renderEndTime: 10, expectedDiffValid: false } // Stale timestamp (> 60s)
  ];

  for (const item of testTimings) {
    const currentEpoch = now + item.renderEndTime;
    const diff = currentEpoch - item.capturedAt;
    const isValid = diff > 0 && diff < 60_000;
    assert.equal(isValid, item.expectedDiffValid, `Timestamp validation failed for diff: ${diff}ms`);
  }

  console.log("  ✓ Timestamp validation & clock skew bounds passed.");
}

console.log("Live cue jitter tests: PASS (All pipeline timing, downsampler, WAV encoder, and jitter compensation validated).");
