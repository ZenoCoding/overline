#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import "../extension/src/cedict-data.js";
import "../extension/src/dict.js";

const MandarinDict = globalThis.MandarinDict;

export function normalizeTranscriptText(text) {
  return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export function textSimilarity(left, right) {
  const a = [...normalizeTranscriptText(left)];
  const b = [...normalizeTranscriptText(right)];
  if (!a.length || !b.length) return 0;
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return 1 - previous[b.length] / Math.max(a.length, b.length);
}

export function splitCaptionPhrases(text) {
  const chunks = String(text || "").match(/[^，。！？；,.!?;…]+(?:[…，。！？；,.!?;]+|$)/gu) || [];
  const phrases = [];
  for (const raw of chunks) {
    const phrase = raw.trim();
    if (!phrase) continue;
    const contentLength = normalizeTranscriptText(phrase).length;
    if (contentLength < 3 && phrases.length) phrases[phrases.length - 1] += phrase;
    else phrases.push(phrase);
  }
  return phrases.length ? phrases : [String(text || "").trim()].filter(Boolean);
}

function timestampGroups(segments, sourceStart, sourceEnd) {
  const eligible = segments
    .map((segment, index) => ({ ...segment, index }))
    .filter((segment) => normalizeTranscriptText(segment.text)
      && Number(segment.end) >= sourceStart - 1.5
      && Number(segment.start) <= sourceEnd + 1.5);
  const groups = [];
  for (let start = 0; start < eligible.length; start += 1) {
    for (let size = 1; size <= 3 && start + size <= eligible.length; size += 1) {
      const members = eligible.slice(start, start + size);
      if (members.some((member, index) => index && member.index !== members[index - 1].index + 1)) break;
      groups.push({
        firstIndex: members[0].index,
        lastIndex: members.at(-1).index,
        start: Number(members[0].start),
        end: Number(members.at(-1).end),
        text: members.map((member) => member.text).join("")
      });
    }
  }
  return groups;
}

export function alignTranscriptSegments(accurateSegments, timestampSegments, minimumSimilarity = 0.55) {
  const cues = [];
  for (const source of accurateSegments) {
    const sourceStart = Number(source.start);
    const sourceEnd = Number(source.end);
    if (!(sourceStart < sourceEnd) || !normalizeTranscriptText(source.text)) continue;
    const phrases = splitCaptionPhrases(source.text);
    const lengths = phrases.map((phrase) => Math.max(1, normalizeTranscriptText(phrase).length));
    const totalLength = lengths.reduce((sum, length) => sum + length, 0);
    const groups = timestampGroups(timestampSegments, sourceStart, sourceEnd);
    let consumedLength = 0;
    let lastTimestampIndex = -1;

    for (let index = 0; index < phrases.length; index += 1) {
      const phrase = phrases[index];
      const fallbackStart = sourceStart + (sourceEnd - sourceStart) * consumedLength / totalLength;
      consumedLength += lengths[index];
      const fallbackEnd = sourceStart + (sourceEnd - sourceStart) * consumedLength / totalLength;
      const candidates = groups
        .filter((group) => group.firstIndex > lastTimestampIndex)
        .map((group) => ({ ...group, similarity: textSimilarity(phrase, group.text) }))
        .sort((left, right) => right.similarity - left.similarity
          || Math.abs(left.start - fallbackStart) - Math.abs(right.start - fallbackStart));
      const best = candidates[0];
      const aligned = best && best.similarity >= minimumSimilarity;
      if (aligned) lastTimestampIndex = best.lastIndex;
      cues.push({
        start: Number((aligned ? Math.max(sourceStart, best.start) : fallbackStart).toFixed(3)),
        end: Number((aligned ? Math.min(sourceEnd, best.end) : fallbackEnd).toFixed(3)),
        text: phrase,
        timing: {
          source: aligned ? "whisper-aligned" : "source-window-proportional",
          confidence: Number((aligned ? best.similarity : 0).toFixed(3))
        }
      });
    }
  }

  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    const next = cues[index + 1];
    if (next && cue.end > next.start) {
      const boundary = Number(((cue.end + next.start) / 2).toFixed(3));
      cue.end = boundary;
      next.start = boundary;
    }
    if (cue.end <= cue.start) cue.end = Number((cue.start + 0.25).toFixed(3));
  }
  return cues;
}

function main() {
  const [accurateArg, timestampsArg, outputArg] = process.argv.slice(2);
  if (!accurateArg || !timestampsArg) {
    console.error("Usage: node scripts/hybrid-transcript-alignment.mjs <accurate-transcript.json> <timestamp-transcript.json> [cue-draft.json]");
    process.exit(2);
  }
  const accuratePath = path.resolve(accurateArg);
  const timestampsPath = path.resolve(timestampsArg);
  const outputPath = path.resolve(outputArg || "work/transcript/hybrid-cue-draft.json");
  const accurate = JSON.parse(fs.readFileSync(accuratePath, "utf8"));
  const timestamps = JSON.parse(fs.readFileSync(timestampsPath, "utf8"));
  const aligned = alignTranscriptSegments(accurate.segments || [], timestamps.segments || []);
  const output = {
    schemaVersion: 1,
    source: "gpt-text-with-whisper-timing-fallback",
    textModel: accurate.model,
    timingModel: timestamps.model,
    cues: aligned.map((cue) => ({
      start: cue.start,
      end: cue.end,
      timing: cue.timing,
      words: MandarinDict?.segmentAndAnnotate
        ? MandarinDict.segmentAndAnnotate(cue.text)
        : [{ text: cue.text, pinyin: "TODO", gloss: "TODO" }]
    }))
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
  const alignedCount = aligned.filter((cue) => cue.timing.source === "whisper-aligned").length;
  console.log(`Wrote ${aligned.length} cues (${alignedCount} timestamp-aligned, ${aligned.length - alignedCount} conservative fallbacks) to ${outputPath}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) main();
