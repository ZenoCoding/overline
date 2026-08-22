import assert from "node:assert/strict";
import {
  buildTranscriptionForm,
  DEFAULT_TRANSCRIPTION_MODEL,
  resolveTranscriptionModel,
  TRANSCRIPTION_ENDPOINT
} from "../scripts/transcription-request.mjs";

assert.equal(DEFAULT_TRANSCRIPTION_MODEL, "gpt-transcribe");
assert.equal(resolveTranscriptionModel(undefined), "gpt-transcribe");
assert.equal(resolveTranscriptionModel(" gpt-4o-transcribe "), "gpt-4o-transcribe");
assert.throws(() => resolveTranscriptionModel("gpt-transcribe\nAuthorization: bad"));

const form = buildTranscriptionForm(new Uint8Array([1, 2, 3]), "chunk.wav", resolveTranscriptionModel(undefined));
assert.equal(TRANSCRIPTION_ENDPOINT, "https://api.openai.com/v1/audio/transcriptions");
assert.equal(form.get("model"), "gpt-transcribe");
assert.equal(form.get("language"), "zh");
assert.equal(form.get("response_format"), "json");
assert.match(form.get("prompt"), /Simplified Chinese/);
assert.match(form.get("prompt"), /陆光 \(Lu Guang\)/, "offline transcription should share the canonical live context");
assert.doesNotMatch(form.get("prompt"), /Vocabulary:/, "offline prompt should not duplicate the keyword list");
assert.equal(form.get("file").name, "chunk.wav");

console.log("Transcription request: PASS (gpt-transcribe default and safe override; multipart fields validated; no network call). ");
