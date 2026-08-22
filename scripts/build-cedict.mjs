import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archivePath = path.join(root, "vendor/cc-cedict/cedict_1_0_ts_utf-8_mdbg-2026-08-20.zip");
const adaptationsPath = path.join(root, "extension/data/dictionary-adaptations.json");
const outputPath = path.join(root, "extension/src/cedict-data.js");
const expectedSha256 = "31e3ed2803242a398bd396d62cc961f95892deeec49a0a0fb9605c84fbac4fe1";

const archive = fs.readFileSync(archivePath);
const actualSha256 = crypto.createHash("sha256").update(archive).digest("hex");
if (actualSha256 !== expectedSha256) {
  throw new Error(`CC-CEDICT archive checksum mismatch: ${actualSha256}`);
}

const raw = execFileSync("unzip", ["-p", archivePath], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024
});
const metadata = Object.fromEntries(
  raw.split(/\r?\n/)
    .filter((line) => line.startsWith("#! "))
    .map((line) => line.slice(3).split(/=(.*)/s).slice(0, 2))
);

const entries = [];
for (const line of raw.split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const match = line.match(/^(\S+) (\S+) \[([^\]]+)] \/(.*)\/$/);
  if (!match) throw new Error(`Unrecognized CC-CEDICT line: ${line.slice(0, 120)}`);
  const [, traditional, simplified, pinyin, definitionsText] = match;
  const definitions = definitionsText.split("/").map((value) => value.trim()).filter(Boolean);
  const preferred = definitions.find((value) => !/^(CL:|variant of |old variant of |see |surname )/i.test(value)) || definitions[0] || "";
  entries.push([simplified, pinyin, preferred, traditional === simplified ? "" : traditional]);
}

entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

const adaptationsDocument = JSON.parse(fs.readFileSync(adaptationsPath, "utf8"));
if (!Array.isArray(adaptationsDocument.entries)) throw new Error("dictionary adaptations must contain an entries array");
if (!adaptationsDocument.transcription || typeof adaptationsDocument.transcription !== "object") {
  throw new Error("dictionary adaptations must contain transcription context");
}
if (typeof adaptationsDocument.transcription.prompt !== "string" || !adaptationsDocument.transcription.prompt.trim()) {
  throw new Error("transcription context lacks prompt");
}
if (!Array.isArray(adaptationsDocument.transcription.languages) || !adaptationsDocument.transcription.languages.length) {
  throw new Error("transcription context must contain language hints");
}
if (!Array.isArray(adaptationsDocument.transcription.keywords) || !adaptationsDocument.transcription.keywords.length) {
  throw new Error("transcription context must contain keywords");
}
for (const keyword of adaptationsDocument.transcription.keywords) {
  if (typeof keyword !== "string" || !keyword.trim() || /[<>\r\n]/.test(keyword)) {
    throw new Error("transcription keywords must be nonempty single-line literal terms");
  }
}
for (const [episode, context] of Object.entries(adaptationsDocument.transcription.episodes || {})) {
  if (!/^\d+$/.test(episode) || !context || typeof context !== "object") {
    throw new Error("episode transcription contexts must use numeric episode keys");
  }
  if (context.prompt !== undefined && (typeof context.prompt !== "string" || !context.prompt.trim())) {
    throw new Error(`episode ${episode} transcription prompt must be nonempty`);
  }
  if (!Array.isArray(context.keywords)) throw new Error(`episode ${episode} transcription keywords must be an array`);
  for (const keyword of context.keywords) {
    if (typeof keyword !== "string" || !keyword.trim() || /[<>\r\n]/.test(keyword)) {
      throw new Error(`episode ${episode} contains an invalid transcription keyword`);
    }
  }
}
for (const [showId, context] of Object.entries(adaptationsDocument.transcription.shows || {})) {
  if (!/^[a-z0-9-]+$/.test(showId) || !context || typeof context !== "object") {
    throw new Error("show transcription contexts must use stable lowercase IDs");
  }
  if (typeof context.prompt !== "string" || !context.prompt.trim()) throw new Error(`${showId} transcription context lacks prompt`);
  if (!Array.isArray(context.languages) || !context.languages.length) throw new Error(`${showId} transcription context lacks languages`);
  if (!Array.isArray(context.keywords) || !context.keywords.length) throw new Error(`${showId} transcription context lacks keywords`);
  for (const keyword of context.keywords) {
    if (typeof keyword !== "string" || !keyword.trim() || /[<>\r\n]/.test(keyword)) {
      throw new Error(`${showId} contains an invalid transcription keyword`);
    }
  }
}
for (const [index, entry] of adaptationsDocument.entries.entries()) {
  for (const key of ["term", "pinyin", "gloss"]) {
    if (typeof entry[key] !== "string" || !entry[key].trim()) throw new Error(`adaptation ${index} lacks ${key}`);
  }
}

const header = `/*\n * Generated by scripts/build-cedict.mjs. Do not hand-edit.\n+ * Dictionary data: CC-CEDICT ${metadata.date || "unknown date"}, published by MDBG.\n+ * License: Creative Commons Attribution-ShareAlike 4.0 International.\n+ * https://creativecommons.org/licenses/by-sa/4.0/\n+ */\n`;
const payload = {
  source: "CC-CEDICT",
  publishedAt: metadata.date || null,
  sourceEntries: Number(metadata.entries || entries.length),
  sha256: actualSha256,
  entries,
  adaptations: adaptationsDocument.entries,
  transcription: adaptationsDocument.transcription
};
fs.writeFileSync(outputPath, `${header}(function(global){"use strict";global.MandarinCedictData=${JSON.stringify(payload)};})(typeof globalThis!=="undefined"?globalThis:this);\n`);

console.log(`Generated ${path.relative(root, outputPath)} with ${entries.length} CC-CEDICT entries and ${adaptationsDocument.entries.length} adaptations.`);
