import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Load real cues from extension dataset
const realCuesPath = path.join(process.cwd(), "extension/data/link-click-ep1.real.json");
const realData = JSON.parse(fs.readFileSync(realCuesPath, "utf8"));
assert.ok(Array.isArray(realData.cues) && realData.cues.length > 0, "Real cues must exist");

/**
 * Standard cue matching algorithm from extension/src/player.js:
 * Computes active cue index for a given captureTime and cues array with 3.0s linger logic.
 */
function findActiveCueIndex(cues, captureTime) {
  return cues.findIndex((cue, i) => {
    const nextCue = cues[i + 1];
    const minLinger = 3.0;
    const maxLingerEnd = nextCue ? Math.min(cue.start + minLinger, nextCue.start - 0.1) : cue.start + minLinger;
    const effectiveEnd = Math.max(cue.end, maxLingerEnd);
    return captureTime >= cue.start && captureTime < effectiveEnd;
  });
}

function computeEffectiveEnd(cues, cueIndex) {
  const cue = cues[cueIndex];
  const nextCue = cues[cueIndex + 1];
  const minLinger = 3.0;
  const maxLingerEnd = nextCue ? Math.min(cue.start + minLinger, nextCue.start - 0.1) : cue.start + minLinger;
  return Math.max(cue.end, maxLingerEnd);
}

// ============================================================================
// 1. Rapid Consecutive Cues (Gaps < 0.1s and 0s)
// ============================================================================
console.log("Testing rapid consecutive cues linger behavior...");
{
  const rapidCues = [
    { start: 10.0, end: 10.8, text: "Cue 1" },
    { start: 10.85, end: 11.4, text: "Cue 2 (0.05s gap)" },
    { start: 11.4, end: 12.0, text: "Cue 3 (0s back-to-back gap)" },
    { start: 12.05, end: 12.5, text: "Cue 4 (0.05s gap)" }
  ];

  // Cue 1: start = 10.0, end = 10.8. Next cue starts at 10.85.
  // maxLingerEnd = min(13.0, 10.85 - 0.1) = 10.75.
  // effectiveEnd = max(10.8, 10.75) = 10.8.
  assert.equal(computeEffectiveEnd(rapidCues, 0), 10.8);
  assert.equal(findActiveCueIndex(rapidCues, 9.999), -1);
  assert.equal(findActiveCueIndex(rapidCues, 10.0), 0);
  assert.equal(findActiveCueIndex(rapidCues, 10.799), 0);
  assert.equal(findActiveCueIndex(rapidCues, 10.8), -1, "Cue 1 must end at 10.8 with no active cue during the 0.05s gap");
  assert.equal(findActiveCueIndex(rapidCues, 10.849), -1);

  // Cue 2: start = 10.85, end = 11.4. Next cue starts at 11.4.
  // maxLingerEnd = min(13.85, 11.4 - 0.1) = 11.3.
  // effectiveEnd = max(11.4, 11.3) = 11.4.
  assert.equal(computeEffectiveEnd(rapidCues, 1), 11.4);
  assert.equal(findActiveCueIndex(rapidCues, 10.85), 1);
  assert.equal(findActiveCueIndex(rapidCues, 11.399), 1);

  // Instant back-to-back transition from Cue 2 (ends at 11.4) to Cue 3 (starts at 11.4)
  assert.equal(findActiveCueIndex(rapidCues, 11.4), 2, "Seamless back-to-back switch to Cue 3");
  assert.equal(findActiveCueIndex(rapidCues, 11.999), 2);

  // Cue 3 ends at 12.0. Cue 4 starts at 12.05.
  assert.equal(findActiveCueIndex(rapidCues, 12.0), -1);
  assert.equal(findActiveCueIndex(rapidCues, 12.05), 3);

  console.log("  ✓ Rapid consecutive cues test passed.");
}

// ============================================================================
// 2. Short Cues (< 1.0s Duration) with Minimum Linger Persistence
// ============================================================================
console.log("Testing short cues with minimum 3.0s linger persistence...");
{
  const shortCues = [
    { start: 5.0, end: 5.2, text: "Very short 200ms cue" }, // Isolated cue
    { start: 20.0, end: 20.5, text: "Short cue followed soon" },
    { start: 22.0, end: 22.8, text: "Following cue at +2s" }
  ];

  // Isolated short cue (5.0s - 5.2s) should linger for full 3.0s until 8.0s
  assert.equal(computeEffectiveEnd(shortCues, 0), 8.0);
  assert.equal(findActiveCueIndex(shortCues, 4.99), -1);
  assert.equal(findActiveCueIndex(shortCues, 5.0), 0);
  assert.equal(findActiveCueIndex(shortCues, 5.2), 0, "Must linger past cue.end");
  assert.equal(findActiveCueIndex(shortCues, 7.5), 0, "Must stay active during linger window");
  assert.equal(findActiveCueIndex(shortCues, 7.999), 0);
  assert.equal(findActiveCueIndex(shortCues, 8.0), -1, "Must expire at exactly start + minLinger");

  // Short cue (20.0s - 20.5s) followed by cue at 22.0s:
  // maxLingerEnd = min(23.0, 22.0 - 0.1) = 21.9s.
  assert.equal(computeEffectiveEnd(shortCues, 1), 21.9);
  assert.equal(findActiveCueIndex(shortCues, 20.0), 1);
  assert.equal(findActiveCueIndex(shortCues, 21.899), 1);
  assert.equal(findActiveCueIndex(shortCues, 21.9), -1, "Must yield 0.1s gap before next cue");
  assert.equal(findActiveCueIndex(shortCues, 21.95), -1);
  assert.equal(findActiveCueIndex(shortCues, 22.0), 2);

  console.log("  ✓ Short cues linger persistence passed.");
}

// ============================================================================
// 3. Large Gap (> 4s Gap Between Subtitle Cues)
// ============================================================================
console.log("Testing large gaps (> 4s) between subtitle cues...");
{
  const gappedCues = [
    { start: 10.0, end: 12.0, text: "Line 1" },
    { start: 25.0, end: 27.5, text: "Line 2 (13s gap)" }
  ];

  // Line 1: start = 10.0, end = 12.0. Next starts at 25.0.
  // maxLingerEnd = min(13.0, 24.9) = 13.0.
  // effectiveEnd = max(12.0, 13.0) = 13.0.
  assert.equal(computeEffectiveEnd(gappedCues, 0), 13.0);
  assert.equal(findActiveCueIndex(gappedCues, 10.0), 0);
  assert.equal(findActiveCueIndex(gappedCues, 12.999), 0);
  assert.equal(findActiveCueIndex(gappedCues, 13.0), -1, "Cue must cleanly disappear at 13.0s");

  // The entire gap between 13.0s and 24.999s (12 seconds) must return -1 (blank subtitle overlay)
  for (let t = 13.0; t < 25.0; t += 0.5) {
    assert.equal(findActiveCueIndex(gappedCues, t), -1, `Gap at time ${t}s must return -1`);
  }

  // At 25.0s, Line 2 appears
  assert.equal(findActiveCueIndex(gappedCues, 25.0), 1);

  console.log("  ✓ Large gaps test passed.");
}

// ============================================================================
// 4. Long Cues (> 3.0s Duration)
// ============================================================================
console.log("Testing long cues (> 3.0s) duration preservation...");
{
  const longCues = [
    { start: 30.0, end: 38.0, text: "8-second monologue cue" },
    { start: 45.0, end: 50.0, text: "5-second response cue" }
  ];

  // 8-second cue: effectiveEnd must be 38.0s (not truncated to 33.0s)
  assert.equal(computeEffectiveEnd(longCues, 0), 38.0);
  assert.equal(findActiveCueIndex(longCues, 30.0), 0);
  assert.equal(findActiveCueIndex(longCues, 34.0), 0, "Must not be cut off at start + 3s");
  assert.equal(findActiveCueIndex(longCues, 37.999), 0);
  assert.equal(findActiveCueIndex(longCues, 38.0), -1);

  console.log("  ✓ Long cues duration preservation passed.");
}

// ============================================================================
// 5. Seeking and Timeline Navigation (Backwards, Forwards, Negative Time)
// ============================================================================
console.log("Testing seeking and timeline jump simulations...");
{
  const cues = realData.cues;

  // Jump before start of video / capture
  assert.equal(findActiveCueIndex(cues, -124.0), -1);
  assert.equal(findActiveCueIndex(cues, 0.0), -1);
  assert.equal(findActiveCueIndex(cues, 5.0), -1);

  // Seek directly to first cue (11.4s)
  assert.equal(findActiveCueIndex(cues, 11.4), 0);

  // Jump from cue 0 forward to cue 8 (35.0s)
  assert.equal(findActiveCueIndex(cues, 35.0), 8);

  // Jump forward to cue 10 (39.5s)
  assert.equal(findActiveCueIndex(cues, 39.5), 10);

  // Jump backwards from cue 10 back to cue 1 (16.0s)
  assert.equal(findActiveCueIndex(cues, 16.0), 1);

  // Jump into known gap (e.g. 45.0s where dialogue is omitted)
  assert.equal(findActiveCueIndex(cues, 45.0), -1);

  // Jump past end of all cues (120.0s)
  assert.equal(findActiveCueIndex(cues, 120.0), -1);

  console.log("  ✓ Seeking and timeline navigation passed.");
}

// ============================================================================
// 6. Full Real Dataset Continuous Playback Simulation
// ============================================================================
console.log("Testing continuous timeline playback simulation across real Link Click cues...");
{
  const cues = realData.cues;
  const maxTime = realData.provenance.captureDurationSeconds || 95.0;
  let activeTransitions = 0;
  let previousIndex = -1;
  const visitedCues = new Set();

  for (let t = 0; t <= maxTime; t += 0.05) {
    const time = Math.round(t * 100) / 100;
    const index = findActiveCueIndex(cues, time);

    if (index !== previousIndex) {
      activeTransitions++;
      previousIndex = index;
    }

    if (index !== -1) {
      visitedCues.add(index);
      const cue = cues[index];
      const effEnd = computeEffectiveEnd(cues, index);
      assert.ok(time >= cue.start && time < effEnd, `Time ${time} outside cue bounds [${cue.start}, ${effEnd}]`);
    }
  }

  assert.equal(visitedCues.size, cues.length, `All ${cues.length} real cues must be visited during playback`);
  assert.ok(activeTransitions >= cues.length, `Expected at least ${cues.length} state transitions, got ${activeTransitions}`);
  console.log(`  ✓ Simulated ${Math.round(maxTime / 0.05)} timeline steps; visited all ${visitedCues.size} cues with ${activeTransitions} transitions.`);
}

console.log("Subtitle linger persistence tests: PASS (All edge cases, short cues, rapid consecutive cues, gaps, and seeking validated).");
