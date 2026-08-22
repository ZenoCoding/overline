export function normalizeTranscript(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{White_Space}\p{P}\p{S}]/gu, "");
}

function editDistance(reference, hypothesis) {
  const a = Array.from(reference);
  const b = Array.from(hypothesis);
  const rows = Array.from({ length: a.length + 1 }, () => Array(b.length + 1));
  rows[0][0] = { cost: 0, substitutions: 0, deletions: 0, insertions: 0 };

  for (let i = 1; i <= a.length; i++) {
    rows[i][0] = { cost: i, substitutions: 0, deletions: i, insertions: 0 };
  }
  for (let j = 1; j <= b.length; j++) {
    rows[0][j] = { cost: j, substitutions: 0, deletions: 0, insertions: j };
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        rows[i][j] = { ...rows[i - 1][j - 1] };
        continue;
      }
      const choices = [
        { ...rows[i - 1][j - 1], substitutions: rows[i - 1][j - 1].substitutions + 1 },
        { ...rows[i - 1][j], deletions: rows[i - 1][j].deletions + 1 },
        { ...rows[i][j - 1], insertions: rows[i][j - 1].insertions + 1 }
      ].map((choice) => ({ ...choice, cost: choice.cost + 1 }));
      choices.sort((left, right) => left.cost - right.cost
        || left.substitutions - right.substitutions
        || left.deletions - right.deletions);
      rows[i][j] = choices[0];
    }
  }
  return rows[a.length][b.length];
}

export function scoreTranscript(referenceText, hypothesisText) {
  const reference = normalizeTranscript(referenceText);
  const hypothesis = normalizeTranscript(hypothesisText);
  const edits = editDistance(reference, hypothesis);
  const referenceCharacters = Array.from(reference).length;
  const hypothesisCharacters = Array.from(hypothesis).length;
  return {
    reference,
    hypothesis,
    referenceCharacters,
    hypothesisCharacters,
    ...edits,
    cer: referenceCharacters ? edits.cost / referenceCharacters : (hypothesisCharacters ? 1 : 0),
    insertionRate: referenceCharacters ? edits.insertions / referenceCharacters : (hypothesisCharacters ? 1 : 0),
    coverage: referenceCharacters ? Math.max(0, 1 - edits.deletions / referenceCharacters) : 1
  };
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index];
}

export class RealtimeTranscriptCollector {
  constructor() {
    this.partialText = new Map();
    this.firstDeltaAt = new Map();
    this.lastDeltaAt = new Map();
    this.speechWindows = new Map();
    this.finalItems = new Set();
    this.finals = [];
    this.duplicateFinals = 0;
  }

  consume(record) {
    const event = record?.event || record;
    const atMs = Number(record?.atMs ?? event?.atMs ?? 0);
    const itemId = event?.item_id || "active";
    if (!event?.type) return;

    if (event.type === "input_audio_buffer.speech_started") {
      const prior = this.speechWindows.get(itemId) || {};
      this.speechWindows.set(itemId, {
        ...prior,
        startMs: Number(event.audio_start_ms ?? prior.startMs ?? atMs)
      });
      return;
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      const prior = this.speechWindows.get(itemId) || {};
      this.speechWindows.set(itemId, {
        ...prior,
        endMs: Number(event.audio_end_ms ?? prior.endMs ?? atMs)
      });
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.delta") {
      this.partialText.set(itemId, (this.partialText.get(itemId) || "") + String(event.delta || ""));
      if (!this.firstDeltaAt.has(itemId)) this.firstDeltaAt.set(itemId, atMs);
      this.lastDeltaAt.set(itemId, atMs);
      return;
    }

    if (event.type !== "conversation.item.input_audio_transcription.completed") return;
    if (this.finalItems.has(itemId)) {
      this.duplicateFinals++;
      return;
    }

    const speech = this.speechWindows.get(itemId) || {};
    const text = String(event.transcript || this.partialText.get(itemId) || "").trim();
    // Explicit-commit transcription sessions do not emit VAD speech_started
    // events. In that mode the benchmark clip begins with dialogue, so measure
    // first-token latency from the start of audio streaming.
    const latencyStartMs = Number.isFinite(speech.startMs) ? speech.startMs : 0;
    this.finalItems.add(itemId);
    if (text) {
      this.finals.push({
        itemId,
        text,
        startMs: Number.isFinite(speech.startMs) ? speech.startMs : null,
        endMs: Number.isFinite(speech.endMs) ? speech.endMs : null,
        firstTokenLatencyMs: this.firstDeltaAt.has(itemId)
          ? Math.max(0, this.firstDeltaAt.get(itemId) - latencyStartMs)
          : null,
        finalizationMs: this.lastDeltaAt.has(itemId)
          ? Math.max(0, atMs - this.lastDeltaAt.get(itemId))
          : null
      });
    }
  }

  summary() {
    const firstTokenLatencies = this.finals.map((item) => item.firstTokenLatencyMs).filter(Number.isFinite);
    const finalizationLatencies = this.finals.map((item) => item.finalizationMs).filter(Number.isFinite);
    return {
      finalItems: this.finals,
      transcript: this.finals.map((item) => item.text).join(""),
      utteranceCount: this.finals.length,
      duplicateFinals: this.duplicateFinals,
      firstTokenLatencyMs: {
        median: percentile(firstTokenLatencies, 0.5),
        p95: percentile(firstTokenLatencies, 0.95)
      },
      finalizationMs: {
        median: percentile(finalizationLatencies, 0.5),
        p95: percentile(finalizationLatencies, 0.95)
      }
    };
  }
}

export function evaluateBenchmark(reference, records) {
  const collector = new RealtimeTranscriptCollector();
  for (const record of records) collector.consume(record);
  const collected = collector.summary();
  const referenceText = reference.utterances
    .filter((utterance) => utterance.reviewState !== "excluded")
    .map((utterance) => utterance.text)
    .join("");
  const quality = scoreTranscript(referenceText, collected.transcript);
  const thresholds = reference.thresholds || {};
  const checks = {
    cer: quality.cer <= (thresholds.maxCer ?? 1),
    coverage: quality.coverage >= (thresholds.minCoverage ?? 0),
    insertionRate: quality.insertionRate <= (thresholds.maxInsertionRate ?? 1),
    duplicateFinals: collected.duplicateFinals <= (thresholds.maxDuplicateFinals ?? 0)
  };
  return {
    passed: Object.values(checks).every(Boolean),
    checks,
    quality,
    ...collected
  };
}
