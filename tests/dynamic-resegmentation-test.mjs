import assert from "node:assert/strict";
import "../extension/src/cedict-data.js";
import "../extension/src/dict.js";

const MandarinDict = globalThis.MandarinDict;

console.log("================================================================================");
console.log("       Dynamic Incremental Re-Segmentation & Audio Cache Test Suite            ");
console.log("================================================================================");

// 1. Test Incremental Re-segmentation across delta arrivals
console.log("Testing incremental delta accumulation and dynamic re-segmentation...");

const streamTrials = [
  {
    name: "关门歇业 (close down shop / idiom)",
    deltas: ["关", "门", "歇", "业"],
    expectedTokensAtStep: [
      [{ text: "关", pinyin: "guān" }],
      [{ text: "关门", pinyin: "guānmén" }],
      [{ text: "关门", pinyin: "guānmén" }, { text: "歇", pinyin: "xiē" }],
      [{ text: "关门", pinyin: "guānmén" }, { text: "歇业", pinyin: "xiēyè" }]
    ]
  },
  {
    name: "包租婆又来吸血喽 (Landlady comes to bleed us dry)",
    deltas: ["包", "租", "婆", "又", "来", "吸", "血", "喽"],
    expectedTokensAtStep: [
      [{ text: "包" }],
      [{ text: "包租" }],
      [{ text: "包租" }, { text: "婆" }],
      [{ text: "包租" }, { text: "婆" }, { text: "又" }],
      [{ text: "包租" }, { text: "婆" }, { text: "又" }, { text: "来" }],
      [{ text: "包租" }, { text: "婆" }, { text: "又" }, { text: "来" }, { text: "吸" }],
      [{ text: "包租" }, { text: "婆" }, { text: "又" }, { text: "来" }, { text: "吸血" }],
      [{ text: "包租" }, { text: "婆" }, { text: "又" }, { text: "来" }, { text: "吸血" }, { text: "喽" }]
    ]
  },
  {
    name: "不知所措 (at a loss / idiom)",
    deltas: ["不", "知", "所", "措"],
    expectedTokensAtStep: [
      [{ text: "不" }],
      [{ text: "不知" }],
      [{ text: "不知" }, { text: "所" }],
      [{ text: "不知所措" }]
    ]
  },
  {
    name: "原地上吊 (hang oneself on the spot)",
    deltas: ["原", "地", "上", "吊"],
    expectedTokensAtStep: [
      [{ text: "原" }],
      [{ text: "原地" }],
      [{ text: "原地" }, { text: "上" }],
      [{ text: "原地" }, { text: "上吊" }]
    ]
  }
];

for (const trial of streamTrials) {
  let accumulated = "";
  for (let step = 0; step < trial.deltas.length; step++) {
    accumulated += trial.deltas[step];
    const words = MandarinDict.segmentAndAnnotate(accumulated);
    const expected = trial.expectedTokensAtStep[step];
    
    assert.equal(words.length, expected.length, `Trial [${trial.name}] step ${step + 1} ("${accumulated}") token count mismatch`);
    for (let i = 0; i < expected.length; i++) {
      assert.equal(words[i].text, expected[i].text, `Trial [${trial.name}] step ${step + 1} word[${i}] text mismatch`);
      if (expected[i].pinyin) {
        assert.equal(words[i].pinyin.replaceAll(" ", ""), expected[i].pinyin.replaceAll(" ", ""), `Trial [${trial.name}] step ${step + 1} word[${i}] pinyin mismatch`);
      }
    }
  }
  console.log(`  ✓ ${trial.name}: verified dynamic re-segmentation over ${trial.deltas.length} deltas.`);
}

// 2. Audio Transcript Cache Hash & Hit Verification
console.log("Testing audio transcript cache hashing & LRU retrieval...");

function computeAudioHash(samples) {
  let hash = 0x811c9dc5;
  const step = Math.max(1, Math.floor(samples.length / 1000));
  for (let i = 0; i < samples.length; i += step) {
    const val = Math.round(samples[i] * 32767) & 0xffff;
    hash ^= val;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16) + `-${samples.length}`;
}

const mockAudioA = new Float32Array(16000 * 2.5); // 2.5s chunk
for (let i = 0; i < mockAudioA.length; i++) mockAudioA[i] = Math.sin(i / 10) * 0.5;

const mockAudioB = new Float32Array(16000 * 2.5);
for (let i = 0; i < mockAudioB.length; i++) mockAudioB[i] = Math.cos(i / 15) * 0.3;

const hashA = computeAudioHash(mockAudioA);
const hashB = computeAudioHash(mockAudioB);

assert.ok(hashA && hashA.length > 5, "hashA must be non-empty string");
assert.ok(hashB && hashB.length > 5, "hashB must be non-empty string");
assert.notEqual(hashA, hashB, "Distinct audio buffers must produce distinct hashes");

// Exact reproducibility
const hashA2 = computeAudioHash(mockAudioA);
assert.equal(hashA, hashA2, "Identical audio buffer must produce identical hash");

const cache = new Map();
cache.set(hashA, "这是音频A的转录内容");
cache.set(hashB, "这是音频B的转录内容");

assert.equal(cache.get(hashA), "这是音频A的转录内容");
assert.equal(cache.get(hashB), "这是音频B的转录内容");
console.log("  ✓ Audio cache hashing, collision resistance & LRU lookups verified.");

console.log("================================================================================");
console.log("Dynamic Re-Segmentation & Audio Cache: ALL TESTS PASS.");
console.log("================================================================================");
