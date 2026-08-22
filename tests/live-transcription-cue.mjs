import assert from "node:assert/strict";
import fs from "node:fs";

// Load MandarinDict in Node environment
const dictSource = ["extension/src/cedict-data.js", "extension/src/dict.js"]
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
const dictContext = { globalThis: {}, module: {} };
new Function("globalThis", "module", dictSource)(dictContext.globalThis, dictContext.module);
const MandarinDict = dictContext.module.exports || dictContext.globalThis.MandarinDict;

assert(MandarinDict, "MandarinDict must be available");
assert(typeof MandarinDict.segmentAndAnnotate === "function", "segmentAndAnnotate must be a function");

// Test segmentation of live speech sentence
const sampleSpeech = "乔苓姐，我们现在开始准备。";
const tokens = MandarinDict.segmentAndAnnotate(sampleSpeech);

assert(Array.isArray(tokens), "segmentAndAnnotate must return an array of word tokens");
assert(tokens.length >= 4, "Sentence must be segmented into multiple tokens");

// Check structured token fields: text, pinyin, gloss
for (const token of tokens) {
  assert("text" in token, "Token must have text");
  assert("pinyin" in token, "Token must have pinyin");
  assert("gloss" in token, "Token must have gloss");
}

const firstWord = tokens[0];
assert.equal(firstWord.text, "乔苓姐，");
assert.equal(firstWord.pinyin, "Qiáo Líng jiě");
assert.equal(firstWord.gloss, "Sister Qiao Ling");

const luGuangTokens = MandarinDict.segmentAndAnnotate("光光，你看到陆光了吗？");
assert.equal(luGuangTokens[0].text, "光光，", "Lu Guang's nickname should remain one hover target");
assert.equal(luGuangTokens[0].gloss, "Guangguang (nickname for Lu Guang)");
assert.equal(luGuangTokens.find((token) => token.text === "陆光")?.gloss, "Lu Guang (character)");

// Test Live Cue payload construction with timing metadata
const liveCuePayload = {
  type: "ak-mandarin-live-cue",
  cue: {
    text: sampleSpeech,
    words: tokens,
    isLive: true,
    timestamp: 1724089999000,
    timing: {
      audioChunkDurationMs: 2500,
      encodeLatencyMs: 1.2,
      apiLatencyMs: 420.5,
      tokenizationLatencyMs: 0.15,
      capturedAt: 1724089998000,
      totalPipelineLatencyMs: 421.85
    }
  }
};

assert.equal(liveCuePayload.type, "ak-mandarin-live-cue");
assert.equal(liveCuePayload.cue.isLive, true);
assert.equal(liveCuePayload.cue.words.length, tokens.length);
assert.equal(typeof liveCuePayload.cue.timing.audioChunkDurationMs, "number");
assert.equal(typeof liveCuePayload.cue.timing.apiLatencyMs, "number");
assert.equal(typeof liveCuePayload.cue.timing.tokenizationLatencyMs, "number");
assert.equal(typeof liveCuePayload.cue.timing.totalPipelineLatencyMs, "number");

console.log("Live transcription cues: PASS (MandarinDict word tokenization & live cue payload structure validated). ");
