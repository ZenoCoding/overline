import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TRANSCRIPTION_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
export const DEFAULT_TRANSCRIPTION_MODEL = "gpt-transcribe";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRANSCRIPTION_CONTEXT = JSON.parse(
  fs.readFileSync(path.join(ROOT, "extension/data/dictionary-adaptations.json"), "utf8")
).transcription;

export function resolveTranscriptionModel(raw = process.env.OPENAI_TRANSCRIBE_MODEL) {
  if (raw == null || raw === "") return DEFAULT_TRANSCRIPTION_MODEL;
  const model = String(raw).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) {
    throw new Error("OPENAI_TRANSCRIBE_MODEL contains invalid characters. Use a plain model ID such as gpt-transcribe or gpt-4o-transcribe.");
  }
  return model;
}

export const DEFAULT_CONTEXT_PROMPT = TRANSCRIPTION_CONTEXT.prompt;

export function buildTranscriptionForm(bytes, filename, model, customPrompt) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), filename);
  form.append("model", model);
  form.append("language", "zh");
  form.append("response_format", "json");
  form.append("prompt", customPrompt || DEFAULT_CONTEXT_PROMPT);
  return form;
}
