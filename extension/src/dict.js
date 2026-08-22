(function (global) {
  "use strict";

  const data = global.MandarinCedictData;
  if (!data || !Array.isArray(data.entries)) {
    throw new Error("CC-CEDICT data must load before the Mandarin dictionary engine");
  }

  const TONE_MARKS = {
    a: ["ā", "á", "ǎ", "à", "a"],
    e: ["ē", "é", "ě", "è", "e"],
    i: ["ī", "í", "ǐ", "ì", "i"],
    o: ["ō", "ó", "ǒ", "ò", "o"],
    u: ["ū", "ú", "ǔ", "ù", "u"],
    v: ["ǖ", "ǘ", "ǚ", "ǜ", "ü"],
    ü: ["ǖ", "ǘ", "ǚ", "ǜ", "ü"]
  };
  const PUNCTUATION = /[，。！？、：；“”‘’「」（）《》,.!?:;]/u;
  const HANZI = /\p{Script=Han}/u;
  const LATIN_TOKEN = /^[A-Za-z0-9_\-.%]+/;
  const MAX_SCAN_LENGTH = 32;

  function convertSyllable(rawSyllable, toneNumber) {
    const tone = Number(toneNumber) - 1;
    let syllable = rawSyllable.replace(/u:/gi, (value) => value[0] === "U" ? "Ü" : "ü");
    if (tone === 4) return syllable.replace(/v/g, "ü").replace(/V/g, "Ü");

    const lower = syllable.toLowerCase();
    let target = "";
    if (lower.includes("a")) target = "a";
    else if (lower.includes("e")) target = "e";
    else if (lower.includes("ou")) target = "o";
    else {
      for (let index = lower.length - 1; index >= 0; index--) {
        if ("aeiouvü".includes(lower[index])) {
          target = lower[index];
          break;
        }
      }
    }
    if (!target || !TONE_MARKS[target]) return syllable.replace(/v/g, "ü").replace(/V/g, "Ü");
    const marked = TONE_MARKS[target][tone] || target;
    return syllable
      .replace(new RegExp(target, "i"), (match) => match === match.toUpperCase() ? marked.toUpperCase() : marked)
      .replace(/v/g, "ü")
      .replace(/V/g, "Ü");
  }

  function convertNumberedPinyin(value) {
    if (!value || typeof value !== "string") return "";
    return value.replace(/([A-Za-züÜvV]+(?::[A-Za-z]*)?)([1-5])/g, (_, syllable, tone) => convertSyllable(syllable, tone));
  }

  function normalizeAdaptation(entry) {
    if (!entry || typeof entry !== "object") throw new TypeError("adaptation must be an object");
    const term = String(entry.term || entry.text || "").trim();
    const pinyin = String(entry.pinyin || "").trim();
    const gloss = String(entry.gloss || "").trim();
    if (!term || !pinyin || !gloss) throw new TypeError("adaptation requires term, pinyin, and gloss");
    return { text: term, pinyin: convertNumberedPinyin(pinyin), gloss, source: "adaptation", kind: entry.kind || "custom" };
  }

  const bundledAdaptations = new Map();
  const runtimeAdaptations = new Map();
  for (const entry of data.adaptations || []) {
    const normalized = normalizeAdaptation(entry);
    bundledAdaptations.set(normalized.text, normalized);
  }

  function lowerBound(term) {
    const entries = data.entries;
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entries[middle][0] < term) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function lookupCedictCandidates(term) {
    const candidates = [];
    for (let index = lowerBound(term); index < data.entries.length; index++) {
      const [simplified, numberedPinyin, gloss, traditional] = data.entries[index];
      if (simplified !== term) break;
      candidates.push({
        text: term,
        pinyin: convertNumberedPinyin(numberedPinyin),
        gloss,
        traditional: traditional || simplified,
        source: "CC-CEDICT"
      });
    }
    candidates.sort((left, right) => {
      const referencePattern = /^(?:old )?variant of |^see |^CL:/i;
      const leftReference = referencePattern.test(left.gloss) ? 1 : 0;
      const rightReference = referencePattern.test(right.gloss) ? 1 : 0;
      if (leftReference !== rightReference) return leftReference - rightReference;
      const leftProper = /^[A-Z]/.test(left.pinyin) ? 1 : 0;
      const rightProper = /^[A-Z]/.test(right.pinyin) ? 1 : 0;
      return leftProper - rightProper;
    });
    return candidates;
  }

  function lookupCandidates(term) {
    if (!term || typeof term !== "string") return [];
    const runtime = runtimeAdaptations.get(term);
    const bundled = bundledAdaptations.get(term);
    return [runtime, bundled, ...lookupCedictCandidates(term)].filter(Boolean).map((entry) => ({ ...entry }));
  }

  function lookupWord(term) {
    return lookupCandidates(term)[0] || null;
  }

  function addAdaptation(entry) {
    const normalized = normalizeAdaptation(entry);
    runtimeAdaptations.set(normalized.text, normalized);
    return { ...normalized };
  }

  function removeAdaptation(term) {
    return runtimeAdaptations.delete(String(term || ""));
  }

  function setAdaptations(entries) {
    if (!Array.isArray(entries)) throw new TypeError("adaptations must be an array");
    const next = entries.map(normalizeAdaptation);
    runtimeAdaptations.clear();
    for (const entry of next) runtimeAdaptations.set(entry.text, entry);
    return next.map((entry) => ({ ...entry }));
  }

  function getAdaptations() {
    return [...runtimeAdaptations.values()].map((entry) => ({ ...entry }));
  }

  function consumePunctuation(text, start) {
    let end = start;
    while (end < text.length && PUNCTUATION.test(text[end])) end++;
    return end;
  }

  function findLongestMatch(text, start) {
    const remaining = text.length - start;
    const maxLength = Math.min(remaining, MAX_SCAN_LENGTH);
    for (let length = maxLength; length > 0; length--) {
      const term = text.slice(start, start + length);
      const match = lookupWord(term);
      if (match) return match;
    }
    return null;
  }

  function segmentAndAnnotate(text) {
    if (!text || typeof text !== "string") return [];
    const tokens = [];
    let index = 0;

    while (index < text.length) {
      const character = text[index];
      if (/\s/u.test(character)) {
        index++;
        continue;
      }

      const latinMatch = text.slice(index).match(LATIN_TOKEN);
      if (latinMatch) {
        const term = latinMatch[0];
        const annotation = lookupWord(term) || { text: term, pinyin: term, gloss: term, source: "literal" };
        const end = consumePunctuation(text, index + term.length);
        tokens.push({ ...annotation, text: text.slice(index, end) });
        index = end;
        continue;
      }

      const match = findLongestMatch(text, index);
      if (match) {
        const end = consumePunctuation(text, index + match.text.length);
        tokens.push({ ...match, text: text.slice(index, end) });
        index = end;
        continue;
      }

      if (PUNCTUATION.test(character) && tokens.length > 0) {
        tokens[tokens.length - 1].text += character;
        index++;
        continue;
      }

      tokens.push({
        text: character,
        pinyin: "",
        gloss: HANZI.test(character) ? "Not found in CC-CEDICT" : character,
        source: "unmatched"
      });
      index++;
    }

    return tokens;
  }

  const api = {
    convertNumberedPinyin,
    segmentAndAnnotate,
    lookupWord,
    lookupCandidates,
    addAdaptation,
    removeAdaptation,
    setAdaptations,
    getAdaptations,
    metadata: Object.freeze({
      source: data.source,
      publishedAt: data.publishedAt,
      sourceEntries: data.sourceEntries,
      sha256: data.sha256,
      bundledAdaptations: bundledAdaptations.size
    })
  };

  global.MandarinDict = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
