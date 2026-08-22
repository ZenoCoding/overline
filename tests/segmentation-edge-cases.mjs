import assert from "node:assert/strict";
import fs from "node:fs";

const dictSource = ["extension/src/cedict-data.js", "extension/src/dict.js"]
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
const dictContext = { globalThis: {}, module: {} };
new Function("globalThis", "module", dictSource)(dictContext.globalThis, dictContext.module);
const dict = dictContext.module.exports || dictContext.globalThis.MandarinDict;
const { segmentAndAnnotate, lookupCandidates } = dict;

function tokenTexts(text) {
  return segmentAndAnnotate(text).map((token) => token.text);
}

function normalizedPinyin(value) {
  return value.replace(/[\s-]/g, "").toLowerCase();
}

console.log("Testing CC-CEDICT lexical compounds and polyphones...");
for (const [term, expectedPinyin] of [
  ["长大", "zhǎng dà"],
  ["意味深长", "yì wèi shēn cháng"],
  ["拔苗助长", "bá miáo zhù zhǎng"],
  ["重要", "zhòng yào"],
  ["干嘛", "gàn má"]
]) {
  const token = segmentAndAnnotate(term)[0];
  assert.equal(token.text, term, `${term} should be one dictionary term`);
  assert.equal(normalizedPinyin(token.pinyin), normalizedPinyin(expectedPinyin), `${term} should use its lexical reading`);
  assert.equal(token.source, "CC-CEDICT");
}
assert.deepEqual(tokenTexts("看着"), ["看", "着"]);
assert.ok(lookupCandidates("着").some((candidate) => candidate.pinyin === "zhe"));

console.log("Testing the reported subtitle grouping regression...");
const screenshot = segmentAndAnnotate("剧透可耻，程小时，你在干嘛呢？");
assert.deepEqual(
  screenshot.map((token) => token.text),
  ["剧透", "可耻，", "程小时，", "你", "在", "干嘛", "呢？"]
);
assert.equal(screenshot[2].source, "adaptation", "show-specific name must come from the adaptation layer");
assert.equal(screenshot[5].source, "CC-CEDICT", "general vocabulary must come from CC-CEDICT");

console.log("Testing Yomitan-style longest-prefix scanning...");
assert.deepEqual(tokenTexts("乒乓球拍卖完了"), ["乒乓球拍", "卖完", "了"]);
assert.deepEqual(tokenTexts("不知所措，不可思议！"), ["不知所措，", "不可思议！"]);
assert.deepEqual(tokenTexts("时光照相馆的委托人"), ["时光照相馆", "的", "委托人"]);
assert.deepEqual(tokenTexts("雀德游戏公布财报"), ["雀德游戏", "公布", "财报"]);

console.log("Testing layered adaptation and replacement...");
dict.addAdaptation({ term: "董总", pinyin: "Dǒng zǒng", gloss: "Director Dong", kind: "name" });
dict.addAdaptation({ term: "董总助理", pinyin: "Dǒng zǒng zhùlǐ", gloss: "Director Dong's assistant", kind: "name" });
assert.deepEqual(tokenTexts("董总助理来了"), ["董总助理", "来", "了"]);
assert.equal(segmentAndAnnotate("董总助理")[0].gloss, "Director Dong's assistant");

dict.addAdaptation({ term: "干嘛", pinyin: "gàn ma", gloss: "episode-specific override" });
const overridden = segmentAndAnnotate("干嘛")[0];
assert.equal(overridden.source, "adaptation");
assert.equal(overridden.gloss, "episode-specific override");
assert.ok(lookupCandidates("干嘛").some((candidate) => candidate.source === "CC-CEDICT"), "base entry must remain available");
dict.setAdaptations([]);
assert.equal(segmentAndAnnotate("干嘛")[0].source, "CC-CEDICT");

console.log("Testing mixed text, punctuation, and reconstruction...");
for (const text of [
  "Link Click时光照相馆在2026年发布v1.0。",
  "他说：“不可思议！”",
  "第一集：剧透可耻。",
  "𲎉是罕见字。"
]) {
  const tokens = segmentAndAnnotate(text);
  assert.equal(tokens.map((token) => token.text).join(""), text.replace(/\s+/g, ""));
  for (const token of tokens) {
    assert.equal(typeof token.pinyin, "string");
    assert.equal(typeof token.gloss, "string");
  }
}

console.log("Segmentation edge cases: PASS (CC-CEDICT, longest match, adaptations, and reconstruction).");
