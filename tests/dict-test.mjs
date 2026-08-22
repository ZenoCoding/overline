import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Load the pinned CC-CEDICT data before the dictionary engine.
import "../extension/src/cedict-data.js";
import "../extension/src/dict.js";
const dict = globalThis.MandarinDict;

assert.ok(dict, "MandarinDict API should be defined on globalThis");
assert.equal(typeof dict.convertNumberedPinyin, "function", "convertNumberedPinyin must be exported");
assert.equal(typeof dict.segmentAndAnnotate, "function", "segmentAndAnnotate must be exported");
assert.equal(typeof dict.lookupWord, "function", "lookupWord must be exported");
assert.equal(typeof dict.lookupCandidates, "function", "lookupCandidates must be exported");
assert.equal(typeof dict.addAdaptation, "function", "addAdaptation must be exported");
assert.equal(dict.metadata.source, "CC-CEDICT");
assert.ok(dict.metadata.sourceEntries >= 120000, "the complete pinned CC-CEDICT release must be loaded");

// ============================================================================
// 1. Numbered-to-Marked Pinyin Conversion Rules
// ============================================================================
{
  const { convertNumberedPinyin } = dict;

  // Empty or invalid input
  assert.equal(convertNumberedPinyin(""), "");
  assert.equal(convertNumberedPinyin(null), "");
  assert.equal(convertNumberedPinyin(undefined), "");

  // Rule 1: 'a' or 'e' always takes precedence
  assert.equal(convertNumberedPinyin("hao3"), "hǎo");
  assert.equal(convertNumberedPinyin("bai2"), "bái");
  assert.equal(convertNumberedPinyin("bao3"), "bǎo");
  assert.equal(convertNumberedPinyin("ban4"), "bàn");
  assert.equal(convertNumberedPinyin("bang1"), "bāng");
  assert.equal(convertNumberedPinyin("bie2"), "bié");
  assert.equal(convertNumberedPinyin("tian1"), "tiān");
  assert.equal(convertNumberedPinyin("kuang4"), "kuàng");
  assert.equal(convertNumberedPinyin("xue2"), "xué");
  assert.equal(convertNumberedPinyin("yue4"), "yuè");
  assert.equal(convertNumberedPinyin("er3"), "ěr");
  assert.equal(convertNumberedPinyin("er4"), "èr");
  assert.equal(convertNumberedPinyin("hei1"), "hēi");
  assert.equal(convertNumberedPinyin("lei4"), "lèi");
  assert.equal(convertNumberedPinyin("zhuang1"), "zhuāng");

  // Rule 2: 'ou' places mark on 'o'
  assert.equal(convertNumberedPinyin("dou1"), "dōu");
  assert.equal(convertNumberedPinyin("tou2"), "tóu");
  assert.equal(convertNumberedPinyin("gou3"), "gǒu");
  assert.equal(convertNumberedPinyin("hou4"), "hòu");
  assert.equal(convertNumberedPinyin("kou3"), "kǒu");
  assert.equal(convertNumberedPinyin("you3"), "yǒu");
  assert.equal(convertNumberedPinyin("zhou1"), "zhōu");

  // Rule 3: In other diphthongs (iu, ui, uo, etc.), second/last vowel takes mark
  assert.equal(convertNumberedPinyin("liu4"), "liù");
  assert.equal(convertNumberedPinyin("jiu3"), "jiǔ");
  assert.equal(convertNumberedPinyin("qiu2"), "qiú");
  assert.equal(convertNumberedPinyin("gui3"), "guǐ");
  assert.equal(convertNumberedPinyin("dui4"), "duì");
  assert.equal(convertNumberedPinyin("hui4"), "huì");
  assert.equal(convertNumberedPinyin("shui3"), "shuǐ");
  assert.equal(convertNumberedPinyin("luo4"), "luò");
  assert.equal(convertNumberedPinyin("guo2"), "guó");
  assert.equal(convertNumberedPinyin("duo1"), "duō");
  assert.equal(convertNumberedPinyin("zhuo1"), "zhuō");

  // Single vowels
  assert.equal(convertNumberedPinyin("yi1"), "yī");
  assert.equal(convertNumberedPinyin("wu3"), "wǔ");
  assert.equal(convertNumberedPinyin("yu3"), "yǔ");
  assert.equal(convertNumberedPinyin("zhi1"), "zhī");
  assert.equal(convertNumberedPinyin("chi1"), "chī");
  assert.equal(convertNumberedPinyin("shi2"), "shí");
  assert.equal(convertNumberedPinyin("ri4"), "rì");
  assert.equal(convertNumberedPinyin("zi3"), "zǐ");
  assert.equal(convertNumberedPinyin("ci2"), "cí");
  assert.equal(convertNumberedPinyin("si4"), "sì");

  // Umlaut ü / v handling
  assert.equal(convertNumberedPinyin("lv4"), "lǜ");
  assert.equal(convertNumberedPinyin("nv3"), "nǚ");
  assert.equal(convertNumberedPinyin("lv3"), "lǚ");
  assert.equal(convertNumberedPinyin("lve4"), "lüè");
  assert.equal(convertNumberedPinyin("nve4"), "nüè");
  assert.equal(convertNumberedPinyin("qu1"), "qū");
  assert.equal(convertNumberedPinyin("xu3"), "xǔ");

  // Neutral tones (5)
  assert.equal(convertNumberedPinyin("de5"), "de");
  assert.equal(convertNumberedPinyin("zhe5"), "zhe");
  assert.equal(convertNumberedPinyin("ma5"), "ma");
  assert.equal(convertNumberedPinyin("ba5"), "ba");
  assert.equal(convertNumberedPinyin("lou5"), "lou");

  // Case preservation (mixed & upper case)
  assert.equal(convertNumberedPinyin("Hao3"), "Hǎo");
  assert.equal(convertNumberedPinyin("ZHONG1GUO2"), "ZHŌNGGUÓ");
  assert.equal(convertNumberedPinyin("BEI3JING1"), "BĚIJĪNG");

  // Multi-syllable spaced or compound string
  assert.equal(convertNumberedPinyin("ni3 hao3"), "nǐ hǎo");
  assert.equal(convertNumberedPinyin("zhong1guo2"), "zhōngguó");

  // Already marked strings remain unchanged
  assert.equal(convertNumberedPinyin("lǎo zūpó"), "lǎo zūpó");
  assert.equal(convertNumberedPinyin("diàor lángdāng de"), "diàor lángdāng de");
  assert.equal(convertNumberedPinyin("Qiáo Líng"), "Qiáo Líng");

  console.log("Pinyin tone mark conversion: PASS (comprehensive standard rules verified).");
}

// ============================================================================
// 2. Tokenization and Segmentation of Link Click & Complex Sentences
// ============================================================================
{
  const realCuesPath = path.join(process.cwd(), "extension/data/link-click-ep1.real.json");
  const rawJson = fs.readFileSync(realCuesPath, "utf8");
  const data = JSON.parse(rawJson);

  assert.ok(Array.isArray(data.cues) && data.cues.length > 0, "Real cues must exist");

  // Reconstruct full sentence for each cue and verify segmentAndAnnotate output
  for (const [cueIdx, cue] of data.cues.entries()) {
    const fullText = cue.words.map((w) => w.text).join("");
    const segmented = dict.segmentAndAnnotate(fullText);

    assert.ok(segmented.length > 0, `Cue ${cueIdx} "${fullText}" should segment into tokens`);
    assert.equal(
      segmented.map((t) => t.text).join(""),
      fullText,
      `Segmented text must reconstruct original text for cue ${cueIdx}: "${fullText}"`
    );

    for (const [wordIndex, actual] of segmented.entries()) {
      assert.ok(actual.text, `Cue ${cueIdx} word ${wordIndex} text must not be empty`);
      assert.equal(typeof actual.pinyin, "string", `Cue ${cueIdx} word ${wordIndex} pinyin must be a string`);
      assert.ok(actual.gloss && actual.gloss.trim().length > 0, `Cue ${cueIdx} word ${wordIndex} gloss must not be empty`);
    }
  }

  // Mixed English/Chinese, numbers, and alphanumerics test
  const mixedSentence = "Link Click时光照相馆在2026年发布了v1.0版，准确率达99.9%！";
  const mixedTokens = dict.segmentAndAnnotate(mixedSentence);
  assert.equal(mixedTokens.map((t) => t.text).join(""), mixedSentence.replace(/\s+/g, ""));

  const tokenTexts = mixedTokens.map((t) => t.text);
  assert.ok(tokenTexts.includes("Link"), "English word 'Link' should be segmented");
  assert.ok(tokenTexts.includes("Click"), "English word 'Click' should be segmented");
  assert.ok(tokenTexts.includes("时光照相馆"), "Multi-character idiom '时光照相馆' should be segmented");
  assert.ok(tokenTexts.includes("2026"), "Number '2026' should be segmented");
  assert.ok(tokenTexts.includes("年"), "Time unit '年' should be segmented");
  assert.ok(tokenTexts.includes("v1.0"), "Version code 'v1.0' should be segmented");
  assert.ok(tokenTexts.includes("准确") && tokenTexts.includes("率"), "Compositional term '准确率' should remain reconstructable");

  // Idioms & Dialogue expressions test
  const idiomSentence = "不知所措、莫名其妙、一清二楚、不可思议。";
  const idiomTokens = dict.segmentAndAnnotate(idiomSentence);
  assert.equal(idiomTokens.length, 4, "Should recognize 4 four-character idioms with punctuation attached");
  assert.equal(idiomTokens[0].text, "不知所措、");
  assert.equal(idiomTokens[0].pinyin.replaceAll(" ", ""), "bùzhīsuǒcuò");
  assert.equal(idiomTokens[1].text, "莫名其妙、");
  assert.equal(idiomTokens[2].text, "一清二楚、");
  assert.equal(idiomTokens[3].text, "不可思议。");

  const animeDialogue = "原来如此，怎么可能！放心吧，加油！";
  const animeTokens = dict.segmentAndAnnotate(animeDialogue);
  assert.equal(animeTokens.map((token) => token.text).join(""), animeDialogue);
  assert.equal(animeTokens[0].text, "原来如此，");
  assert.ok(animeTokens.some((token) => token.text === "怎么"));
  assert.ok(animeTokens.some((token) => token.text === "可能！"));
  assert.ok(animeTokens.some((token) => token.text === "加油！"));

  console.log("Link Click & sentence segmentation: PASS (all 24 episode cues, mixed English/numbers, and idioms).");
}

// ============================================================================
// 3. CC-CEDICT coverage, screenshot regression, and adaptation precedence
// ============================================================================
{
  const { lookupWord, segmentAndAnnotate } = dict;

  // Single characters from Link Click and general Mandarin
  const testChars = [
    ["乔", "qiáo"],
    ["苓", "líng"],
    ["雀", "què"],
    ["德", "dé"],
    ["陆", "lù"],
    ["光", "guāng"],
    ["程", "chéng"],
    ["照", "zhào"],
    ["租", "zū"],
    ["婆", "pó"],
    ["吸", "xī"],
    ["血", "xuè"],
    ["喽", "lou"],
    ["吊", "diào"],
    ["郎", "láng"],
    ["歇", "xiē"],
    ["滚", "gǔn"],
    ["蛋", "dàn"],
    ["懂", "dǒng"],
    ["懒", "lǎn"],
    ["托", "tuō"],
    ["黑", "hēi"],
    ["饕", "tāo"],
    ["餮", "tiè"],
    ["喵", "miāo"],
    ["龙", "lóng"],
    ["凤", "fèng"]
  ];

  for (const [char, expectedPinyin] of testChars) {
    const entry = lookupWord(char);
    assert.ok(entry, `lookupWord('${char}') must return entry`);
    assert.equal(entry.text, char);
    assert.ok(
      dict.lookupCandidates(char).some((candidate) => candidate.pinyin.toLowerCase() === expectedPinyin.toLowerCase()),
      `CC-CEDICT candidates for '${char}' must include '${expectedPinyin}'`
    );
    assert.ok(entry.gloss && entry.gloss.trim().length > 0, `Gloss for '${char}' must not be empty`);
  }

  const screenshotSentence = "剧透可耻，程小时，你在干嘛呢？";
  const screenshotTokens = segmentAndAnnotate(screenshotSentence);
  assert.deepEqual(
    screenshotTokens.map((token) => token.text),
    ["剧透", "可耻，", "程小时，", "你", "在", "干嘛", "呢？"]
  );
  assert.equal(screenshotTokens[0].source, "CC-CEDICT");
  assert.equal(screenshotTokens[2].source, "adaptation");
  assert.equal(screenshotTokens[5].pinyin, "gàn má");
  assert.equal(screenshotTokens[5].gloss, "what are you doing?");

  const girlDownstairsTokens = segmentAndAnnotate("袁君瑭在闵松大学遇见李诗雅和朱茱");
  assert.deepEqual(
    girlDownstairsTokens.filter((token) => token.source === "adaptation").map((token) => token.text),
    ["袁君瑭", "闵松大学", "李诗雅", "朱茱"],
    "The Girl Downstairs names and setting must remain whole hover targets"
  );

  const screenshotRegression = segmentAndAnnotate("拿着家伙呢。");
  assert.deepEqual(screenshotRegression.map((token) => token.text), ["拿着", "家伙", "呢。"]);
  assert.equal(screenshotRegression[0].pinyin, "ná zhe");
  assert.equal(screenshotRegression[0].gloss, "holding; carrying");
  assert.equal(screenshotRegression[1].pinyin, "jiāhuo");
  assert.equal(screenshotRegression[1].gloss, "guy; fellow; thing; tool; weapon");
  assert.doesNotMatch(lookupWord("拿").gloss, /variant of/i, "real definitions must outrank variant metadata");

  dict.addAdaptation({ term: "林娜", pinyin: "Lín Nà", gloss: "Lin Na (episode character)", kind: "name" });
  const adapted = segmentAndAnnotate("林娜来了");
  assert.equal(adapted[0].text, "林娜");
  assert.equal(adapted[0].source, "adaptation");
  assert.equal(adapted[0].gloss, "Lin Na (episode character)");
  assert.equal(dict.removeAdaptation("林娜"), true);

  // Segmentation fallback for novel / unseen compounds: "饕餮盛宴"
  const rareTokens = segmentAndAnnotate("饕餮盛宴");
  assert.ok(rareTokens.length >= 2);
  const taoToken = rareTokens.find((t) => t.text === "饕餮");
  assert.ok(taoToken, "CC-CEDICT should recognize '饕餮' as a word");
  assert.equal(taoToken.pinyin, "tāo tiè");

  // Single character with trailing punctuation
  const singlePunc = segmentAndAnnotate("走，跑！跳？");
  assert.equal(singlePunc.length, 3);
  assert.equal(singlePunc[0].text, "走，");
  assert.ok(dict.lookupCandidates("走").some((candidate) => candidate.pinyin === "zǒu"));
  assert.equal(singlePunc[1].text, "跑！");
  assert.ok(dict.lookupCandidates("跑").some((candidate) => candidate.pinyin === "pǎo"));
  assert.equal(singlePunc[2].text, "跳？");
  assert.ok(dict.lookupCandidates("跳").some((candidate) => candidate.pinyin === "tiào"));

  console.log("CC-CEDICT and adaptation layers: PASS (general vocabulary, names, and fallback behavior).");
}

console.log("All dictionary unit tests: PASS.");
