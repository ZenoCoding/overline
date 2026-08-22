const DISCONTINUITY_REASONS = new Set(["seeking", "seeked", "source-change"]);

function round(value, places = 3) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

export function normalizeTimelineAnchors(rawAnchors) {
  if (!Array.isArray(rawAnchors)) return [];
  return rawAnchors
    .map((anchor, index) => ({
      ...anchor,
      captureTimeSeconds: Number(anchor.captureTimeSeconds),
      playerTimeSeconds: Number(anchor.playerTimeSeconds),
      playbackRate: Number(anchor.playbackRate || 1),
      sequence: Number.isFinite(Number(anchor.sequence)) ? Number(anchor.sequence) : index,
      paused: Boolean(anchor.paused),
      stalled: Boolean(anchor.stalled),
      ended: Boolean(anchor.ended)
    }))
    .filter((anchor) => Number.isFinite(anchor.captureTimeSeconds)
      && anchor.captureTimeSeconds >= 0
      && Number.isFinite(anchor.playerTimeSeconds)
      && anchor.playerTimeSeconds >= 0
      && Number.isFinite(anchor.playbackRate)
      && anchor.playbackRate > 0)
    .sort((left, right) => left.captureTimeSeconds - right.captureTimeSeconds || left.sequence - right.sequence);
}

function effectiveRate(anchor) {
  return anchor.paused || anchor.stalled || anchor.ended ? 0 : anchor.playbackRate;
}

export function mapCaptureTimeToPlayer(captureTimeSeconds, rawAnchors) {
  const captureTime = Number(captureTimeSeconds);
  const anchors = normalizeTimelineAnchors(rawAnchors);
  if (!Number.isFinite(captureTime) || captureTime < 0) throw new Error("Capture time must be a non-negative number.");
  if (!anchors.length) throw new Error("At least one valid player-time anchor is required.");

  let anchor = anchors[0];
  for (const candidate of anchors) {
    if (candidate.captureTimeSeconds > captureTime) break;
    anchor = candidate;
  }
  const elapsed = captureTime - anchor.captureTimeSeconds;
  let playerTime = anchor.playerTimeSeconds + elapsed * effectiveRate(anchor);
  const duration = Number(anchor.durationSeconds);
  if (Number.isFinite(duration) && duration > 0) playerTime = Math.min(duration, playerTime);
  return round(Math.max(0, playerTime));
}

export function analyzeTimeline(rawAnchors, captureDurationSeconds = null) {
  const anchors = normalizeTimelineAnchors(rawAnchors);
  const warnings = [];
  const predictionErrors = [];
  let maxGapSeconds = 0;
  let discontinuityCount = 0;

  if (!anchors.length) return { valid: false, anchors, warnings: ["No valid timeline anchors."], maxGapSeconds: null, maxPredictionErrorSeconds: null, discontinuityCount: 0 };
  if (anchors[0].captureTimeSeconds > 1) warnings.push("The first player-time anchor is more than one second after capture start.");

  for (let index = 1; index < anchors.length; index++) {
    const previous = anchors[index - 1];
    const current = anchors[index];
    const gap = current.captureTimeSeconds - previous.captureTimeSeconds;
    maxGapSeconds = Math.max(maxGapSeconds, gap);
    const stateTransition = previous.paused !== current.paused
      || previous.stalled !== current.stalled
      || previous.ended !== current.ended
      || previous.playbackRate !== current.playbackRate;
    const explicitDiscontinuity = DISCONTINUITY_REASONS.has(String(current.reason || ""));
    const predicted = previous.playerTimeSeconds + gap * effectiveRate(previous);
    const error = Math.abs(current.playerTimeSeconds - predicted);
    if (explicitDiscontinuity || (!stateTransition && error > 0.75)) discontinuityCount++;
    if (!explicitDiscontinuity && !stateTransition) predictionErrors.push(error);
  }

  const duration = Number(captureDurationSeconds);
  if (Number.isFinite(duration) && duration > 0 && anchors.at(-1).captureTimeSeconds < duration - 1) {
    warnings.push("The final player-time anchor is more than one second before capture end.");
  }
  if (maxGapSeconds > 20) warnings.push("Timeline anchors contain a gap longer than 20 seconds.");

  return {
    valid: warnings.length === 0,
    anchors,
    warnings,
    maxGapSeconds: round(maxGapSeconds),
    maxPredictionErrorSeconds: predictionErrors.length ? round(Math.max(...predictionErrors)) : 0,
    discontinuityCount
  };
}

export function mapCuesToPlayerTimeline(cues, rawAnchors) {
  const anchors = normalizeTimelineAnchors(rawAnchors);
  return (Array.isArray(cues) ? cues : []).map((cue) => {
    const start = Number(cue.start);
    const end = Number(cue.end);
    if (!(start < end)) throw new Error("Each cue must have increasing capture start/end times.");
    const crossedDiscontinuity = anchors.some((anchor) => anchor.captureTimeSeconds > start
      && anchor.captureTimeSeconds < end
      && DISCONTINUITY_REASONS.has(String(anchor.reason || "")));
    return {
      ...cue,
      captureStart: start,
      captureEnd: end,
      start: mapCaptureTimeToPlayer(start, anchors),
      end: mapCaptureTimeToPlayer(end, anchors),
      timelineWarning: crossedDiscontinuity ? "cue-crosses-player-seek" : null
    };
  });
}
