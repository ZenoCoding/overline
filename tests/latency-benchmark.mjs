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

assert(MandarinDict, "MandarinDict must be available");
assert(typeof MandarinDict.segmentAndAnnotate === "function", "segmentAndAnnotate must be a function");
assert(typeof MandarinDict.convertNumberedPinyin === "function", "convertNumberedPinyin must be a function");

// Audio downsampler and WAV encoder implementation (matching extension/capture/popup.js)
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

// ---------------------------------------------------------------------------
// 1. Generate 1,000 Representative Mandarin Sentences
// ---------------------------------------------------------------------------
const baseSubjects = [
  "乔苓姐", "程小时", "陆光", "老租婆", "总监助理Emma", "时光照相馆的委托人",
  "雀德游戏的核心总监", "我们", "你们", "他们", "大家", "租户"
];

const baseVerbs = [
  "现在开始准备", "随身携带了", "拿到了核心财务数据", "要求公布第三季度财报",
  "避免电脑系统被黑客攻击", "发现了关键的突破口", "成天吊儿郎当的", "不想关门歇业",
  "觉得这德行不行", "希望提前结束任务", "回去时光照相馆", "从小在这里长大"
];

const baseParticles = [
  "。", "！", "？", "喽！", "吧？", "呢。", "啊！", "啥？"
];

const sentences = [];
for (let i = 0; i < 1000; i++) {
  const subj = baseSubjects[i % baseSubjects.length];
  const verb = baseVerbs[(i * 3 + Math.floor(i / 12)) % baseVerbs.length];
  const punct = baseParticles[i % baseParticles.length];
  const prefix = i % 7 === 0 ? "如果" : (i % 5 === 0 ? "虽然" : (i % 3 === 0 ? "其实" : ""));
  const connector = i % 4 === 0 ? "，而且必须" : (i % 6 === 0 ? "，但是可能" : "，");
  const sentence = `${prefix}${subj}${connector}${verb}${punct}`;
  sentences.push(sentence);
}

assert.equal(sentences.length, 1000, "Must generate exactly 1,000 test sentences");

// ---------------------------------------------------------------------------
// 2. Benchmark: Dictionary Segmentation (1,000 Sentences)
// ---------------------------------------------------------------------------
// Warmup
for (let i = 0; i < 50; i++) {
  MandarinDict.segmentAndAnnotate(sentences[i]);
}

const tSegStart = performance.now();
let totalTokensCount = 0;
for (let i = 0; i < 1000; i++) {
  const tokens = MandarinDict.segmentAndAnnotate(sentences[i]);
  totalTokensCount += tokens.length;
  if (i === 0) {
    assert(tokens.length >= 3, "First sentence must have multiple segmented tokens");
    assert(tokens[0].text && tokens[0].pinyin && tokens[0].gloss, "Token must have text, pinyin, gloss");
  }
}
const tSegEnd = performance.now();
const segDurationMs = tSegEnd - tSegStart;
const avgSegMsPerSent = segDurationMs / 1000;
const avgSegUsPerSent = avgSegMsPerSent * 1000;
const segSentencesPerSec = Math.round((1000 / segDurationMs) * 1000);

// Performance thresholds: < 0.2ms per sentence average; > 5,000 sentences/sec
assert(avgSegMsPerSent < 0.2, `Dictionary segmentation too slow: ${avgSegMsPerSent.toFixed(4)}ms per sentence (expected < 0.2ms)`);
assert(segSentencesPerSec > 5000, `Throughput too low: ${segSentencesPerSec} sentences/sec`);

// ---------------------------------------------------------------------------
// 3. Benchmark: Pinyin Tone Conversion (1,000 Phrases)
// ---------------------------------------------------------------------------
const pinyinSamples = [
  "hao3", "ni3 hao3", "Qiao2 Ling2 jie3", "Lu4 Guang1", "Cheng2 Xiao3shi2",
  "di4-san1 ji4du4", "zhe4 de2xing", "guan1men2 xie1ye4", "sui2shen1 xie2dai4",
  "cai2bao4", "zong3jian1 zhu4li3", "shi2guang1 zhao4xiang4guan3", "you4zhi4",
  "pin1yin1", "lu:4", "nu:3", "zhong1guo2", "xue2xi2", "shui3guo3", "mei3li4"
];

const pinyinTestPhrases = [];
for (let i = 0; i < 1000; i++) {
  pinyinTestPhrases.push(pinyinSamples[i % pinyinSamples.length]);
}

// Correctness check
assert.equal(MandarinDict.convertNumberedPinyin("hao3"), "hǎo");
assert.equal(MandarinDict.convertNumberedPinyin("ni3 hao3"), "nǐ hǎo");
assert.equal(MandarinDict.convertNumberedPinyin("di4-san1"), "dì-sān");

const tPinStart = performance.now();
for (let i = 0; i < 1000; i++) {
  MandarinDict.convertNumberedPinyin(pinyinTestPhrases[i]);
}
const tPinEnd = performance.now();
const pinDurationMs = tPinEnd - tPinStart;
const avgPinUsPerPhrase = (pinDurationMs / 1000) * 1000;
const pinPhrasesPerSec = Math.round((1000 / pinDurationMs) * 1000);

assert(avgPinUsPerPhrase < 50, `Pinyin conversion too slow: ${avgPinUsPerPhrase.toFixed(2)}μs per phrase`);

// ---------------------------------------------------------------------------
// 4. Benchmark: Audio WAV Encoder Throughput
// ---------------------------------------------------------------------------
const NUM_CHUNKS = 20;
const CHUNK_DURATION_SEC = 2.5;
const INPUT_SAMPLE_RATE = 44100;
const OUTPUT_SAMPLE_RATE = 16000;
const samplesPerChunk = Math.round(INPUT_SAMPLE_RATE * CHUNK_DURATION_SEC); // 110,250 samples

// Create synthetic audio buffers (sine wave audio speech simulation)
const audioChunks = [];
for (let c = 0; c < NUM_CHUNKS; c++) {
  const buffer = new Float32Array(samplesPerChunk);
  const freq = 220 + (c * 15);
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = Math.sin((2 * Math.PI * freq * i) / INPUT_SAMPLE_RATE) * 0.4;
  }
  audioChunks.push(buffer);
}

// Warmup
const warmupDown = downsampleBuffer(audioChunks[0], INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE);
encodeWAV(warmupDown, OUTPUT_SAMPLE_RATE);

const tWavStart = performance.now();
let totalEncodedBytes = 0;
let lastWavView = null;

for (let c = 0; c < NUM_CHUNKS; c++) {
  const downsampled = downsampleBuffer(audioChunks[c], INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE);
  const wavView = encodeWAV(downsampled, OUTPUT_SAMPLE_RATE);
  totalEncodedBytes += wavView.byteLength;
  lastWavView = wavView;
}
const tWavEnd = performance.now();
const wavDurationMs = tWavEnd - tWavStart;
const totalAudioSec = NUM_CHUNKS * CHUNK_DURATION_SEC; // 50.0 seconds
const realtimeFactor = Math.round((totalAudioSec * 1000) / wavDurationMs);
const throughputSamplesPerSec = Math.round(((NUM_CHUNKS * samplesPerChunk) / (wavDurationMs / 1000)));

// Validate WAV structure
assert(lastWavView !== null, "WAV DataView must be created");
assert.equal(lastWavView.getUint8(0), 0x52, "Must start with 'R'"); // R
assert.equal(lastWavView.getUint8(1), 0x49, "Must have 'I'"); // I
assert.equal(lastWavView.getUint8(2), 0x46, "Must have 'F'"); // F
assert.equal(lastWavView.getUint8(3), 0x46, "Must have 'F'"); // F
assert.equal(lastWavView.getUint16(20, true), 1, "Format must be PCM (1)");
assert.equal(lastWavView.getUint16(22, true), 1, "Channels must be Mono (1)");
assert.equal(lastWavView.getUint32(24, true), OUTPUT_SAMPLE_RATE, `Sample rate must be ${OUTPUT_SAMPLE_RATE}`);
assert.equal(lastWavView.getUint16(34, true), 16, "Bits per sample must be 16");

// Throughput threshold: must encode faster than 50x real-time (typically > 1,000x)
assert(realtimeFactor > 50, `WAV encoder throughput too slow: ${realtimeFactor}x realtime (expected > 50x)`);

// ---------------------------------------------------------------------------
// 5. Formatted Summary Output
// ---------------------------------------------------------------------------
console.log("================================================================================");
console.log("         Mandarin Live Pipeline & Dictionary Engine Latency Benchmark          ");
console.log("================================================================================");
console.log(`[Dictionary Segmentation] 1,000 sentences in ${segDurationMs.toFixed(2)}ms (${avgSegUsPerSent.toFixed(2)}μs/sent | ${segSentencesPerSec.toLocaleString()} sent/sec | ${totalTokensCount} tokens)`);
console.log(`[Pinyin Tone Conversion] 1,000 phrases in ${pinDurationMs.toFixed(2)}ms (${avgPinUsPerPhrase.toFixed(2)}μs/phrase | ${pinPhrasesPerSec.toLocaleString()} phrases/sec)`);
console.log(`[Audio WAV Encoder]      ${totalAudioSec.toFixed(1)}s audio in ${wavDurationMs.toFixed(2)}ms (${realtimeFactor.toLocaleString()}x realtime | ${(totalEncodedBytes / 1024).toFixed(1)} KB output)`);
console.log("================================================================================");
console.log("Latency benchmark: PASS (Microsecond dictionary segmentation & audio WAV encoder throughput validated).");
