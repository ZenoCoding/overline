import assert from "node:assert/strict";
import {
  alignTranscriptSegments,
  normalizeTranscriptText,
  splitCaptionPhrases,
  textSimilarity
} from "../scripts/hybrid-transcript-alignment.mjs";

assert.equal(normalizeTranscriptText("他也从不，"), "他也从不");
assert.ok(textSimilarity("就别卖关子了", "就别卖关了") > 0.7);
assert.deepEqual(splitCaptionPhrases("时间紧任务重，就别卖关子了。"), ["时间紧任务重，", "就别卖关子了。"]);

const cues = alignTranscriptSegments([
  { start: 10, end: 16, text: "他也从不在电脑上留底，随身携带。" },
  { start: 20, end: 24, text: "完全没有时间证据。" }
], [
  { start: 10.2, end: 12.1, text: "他也从不在电脑上留底" },
  { start: 12.4, end: 13.5, text: "随身携带" }
]);

assert.equal(cues[0].timing.source, "whisper-aligned");
assert.deepEqual([cues[0].start, cues[0].end], [10.2, 12.1]);
assert.equal(cues[1].timing.source, "whisper-aligned");
assert.equal(cues[2].timing.source, "source-window-proportional");
assert.ok(cues.every((cue) => cue.start < cue.end));

console.log("Hybrid transcript alignment: PASS (accurate text retained; timestamp matches and conservative fallbacks validated).");
