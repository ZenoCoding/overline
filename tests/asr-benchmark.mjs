import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { evaluateBenchmark, normalizeTranscript, scoreTranscript } from "../scripts/asr-benchmark-core.mjs";

assert.equal(normalizeTranscript(" 他的助理：Emma。\n"), "他的助理emma");

const exact = scoreTranscript("年纪比你小。", "年纪比你小");
assert.equal(exact.cer, 0, "punctuation must not count as a recognition error");

const changed = scoreTranscript("乔苓姐", "小林姐");
assert.ok(changed.cer > 0, "a wrong name must count as a recognition error");
assert.ok(changed.substitutions + changed.deletions + changed.insertions > 0);

const reference = JSON.parse(fs.readFileSync("benchmark/reference.json", "utf8"));
const records = fs.readFileSync("benchmark/replay-events.ndjson", "utf8")
  .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const result = evaluateBenchmark(reference, records);
assert.equal(result.passed, true);
assert.equal(result.quality.cer, 0);
assert.equal(result.utteranceCount, reference.utterances.length);
assert.equal(result.duplicateFinals, 0);
assert.ok(result.firstTokenLatencyMs.median !== null);
assert.ok(result.finalizationMs.median !== null);

const cli = spawnSync("node", ["scripts/asr-benchmark.mjs"], { encoding: "utf8" });
assert.equal(cli.status, 0, cli.stderr || cli.stdout);
assert.match(cli.stdout, /ASR benchmark: PASS \(deterministic event replay\)/);
assert.match(cli.stdout, /CER: 0\.0%/);

const preflight = spawnSync("node", ["scripts/asr-benchmark.mjs", "--preflight"], { encoding: "utf8" });
assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout);
assert.match(preflight.stdout, /ASR benchmark preflight: PASS \(38\.39\d+s mono 24 kHz PCM/);

console.log("Browserless ASR benchmark: PASS (reference integrity, event replay, and CER scoring validated).");
