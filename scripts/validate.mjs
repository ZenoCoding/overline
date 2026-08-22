import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("extension/manifest.json", "utf8"));
const data = JSON.parse(fs.readFileSync("extension/data/link-click-ep1.real.json", "utf8"));

const errors = [];
if (manifest.manifest_version !== 3) errors.push("manifest_version must be 3");
if (!manifest.permissions?.includes("tabCapture")) errors.push("tabCapture permission is missing");
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["https://anikototv.to/*", "https://vidtube.site/*", "https://megaplay.buzz/*", "https://api.openai.com/*"])) {
  errors.push("host permissions must be narrowly scoped to AniKoto, the two observed player providers, and the OpenAI API");
}
const playerScript = manifest.content_scripts.find((entry) => entry.matches?.includes("https://vidtube.site/*"));
const outerScript = manifest.content_scripts.find((entry) => entry.js?.includes("src/outer.js"));
if (!outerScript?.matches?.includes("https://anikototv.to/watch/link-click-2e0jm/ep-*") ||
    !outerScript?.matches?.includes("https://anikototv.to/watch/the-girl-downstairs-9eddv/ep-*") ||
    !outerScript.js?.includes("src/site-adapter.js")) {
  errors.push("all supported numbered episode pages must receive the outer controller");
}
if (!playerScript?.matches?.includes("https://megaplay.buzz/*") || !playerScript?.all_frames || !playerScript.js?.includes("src/player.js")) {
  errors.push("observed player-frame content scripts are not configured correctly");
}
if (!playerScript?.match_about_blank || !playerScript?.match_origin_as_fallback) {
  errors.push("inherited provider subframes must receive the player adapter");
}
if (playerScript?.js?.indexOf("src/cedict-data.js") !== 0 || playerScript?.js?.indexOf("src/dict.js") !== 1) {
  errors.push("CC-CEDICT data must load immediately before the dictionary engine in player frames");
}
if (manifest.background?.service_worker !== "src/background.js") errors.push("background player-injection fallback is missing");
for (const permission of ["scripting", "webNavigation"]) {
  if (!manifest.permissions?.includes(permission)) errors.push(`${permission} permission is missing`);
}
if (data.source !== "user-captured-episode-audio") errors.push("real cue data must have accurate capture provenance");
if (data.provenance?.hostedModel !== "gpt-4o-transcribe") errors.push("completed capture must preserve its hosted model provenance");
if (!Array.isArray(data.reviewNotes) || !data.reviewNotes.length) errors.push("review uncertainties must be documented");
if (!Array.isArray(data.cues) || data.cues.length < 1) errors.push("cues are missing");

let previousEnd = -Infinity;
for (const [cueIndex, cue] of data.cues.entries()) {
  if (!(cue.start < cue.end)) errors.push(`cue ${cueIndex} has invalid timing`);
  if (cue.end > data.provenance.captureDurationSeconds) errors.push(`cue ${cueIndex} exceeds capture duration`);
  if (cue.start < previousEnd) errors.push(`cue ${cueIndex} overlaps the previous cue`);
  previousEnd = cue.end;
  if (!Array.isArray(cue.words) || !cue.words.length) errors.push(`cue ${cueIndex} has no segmented words`);
  for (const [wordIndex, word] of cue.words.entries()) {
    for (const field of ["text", "pinyin", "gloss"]) {
      if (typeof word[field] !== "string" || !word[field].trim()) {
        errors.push(`cue ${cueIndex}, word ${wordIndex} lacks ${field}`);
      }
      if (String(word[field]).includes("TODO")) errors.push(`cue ${cueIndex}, word ${wordIndex} still contains TODO`);
    }
  }
}

for (const file of ["extension/src/cedict-data.js", "extension/src/dict.js", "extension/src/site-adapter.js", "extension/src/outer.js", "extension/src/player.js", "extension/src/background.js"]) {
  const source = fs.readFileSync(file, "utf8");
  try { new Function(source); } catch (error) { errors.push(`${file}: ${error.message}`); }
}

const outerSource = fs.readFileSync("extension/src/outer.js", "utf8");
if (outerSource.includes("Chrome blocked video access")) errors.push("misleading blocked-video diagnostic remains");
if (!outerSource.includes("stopAfterExtensionReload")) errors.push("extension-reload fail-open guard is missing");
if (!outerSource.includes("ak-mandarin-player-timeline-anchor")) errors.push("outer frame must relay player-time anchors to the capture popup");
if (!outerSource.includes("hasPreloadedCues")) errors.push("outer frame must distinguish live-only episodes from episode 1 cue data");
const playerSource = fs.readFileSync("extension/src/player.js", "utf8");
if (!playerSource.includes('root.style.display = "none"')) errors.push("player overlay must remain detached/hidden until a video exists");
if (!playerSource.includes("extensionStorageAvailable")) errors.push("extension-reload storage fail-open guard is missing");
if (!playerSource.includes("postTimelineAnchor")) errors.push("player must expose exact media-clock timeline anchors");
const cssSource = fs.readFileSync("extension/src/content.css", "utf8");
if (!/\.ak-mandarin-line\s*\{[\s\S]*?pointer-events:\s*none;/.test(cssSource)) errors.push("empty subtitle line must not intercept player clicks");
if (!/\.ak-mandarin-word\s*\{[\s\S]*?pointer-events:\s*auto;/.test(cssSource)) errors.push("subtitle words must remain interactive");
if (!/\.ak-mandarin-line\s*\{[\s\S]*?column-gap:\s*0;/.test(cssSource)) errors.push("Chinese subtitle tokens must render without artificial horizontal gaps");
if (!/\.ak-mandarin-word\s*\{[\s\S]*?padding:\s*3px 0;/.test(cssSource)) errors.push("word hit targets must not insert visible spaces between Chinese terms");

const cedictDataSource = fs.readFileSync("extension/src/cedict-data.js", "utf8");
if (!cedictDataSource.includes('"source":"CC-CEDICT"')) errors.push("generated CC-CEDICT metadata is missing");
if (!cedictDataSource.includes('"sourceEntries":124880')) errors.push("the pinned CC-CEDICT release is incomplete");
if (!cedictDataSource.includes('"sha256":"31e3ed2803242a398bd396d62cc961f95892deeec49a0a0fb9605c84fbac4fe1"')) errors.push("CC-CEDICT checksum metadata is incorrect");
const dictionarySource = fs.readFileSync("extension/src/dict.js", "utf8");
for (const method of ["lookupCandidates", "addAdaptation", "removeAdaptation", "setAdaptations"]) {
  if (!dictionarySource.includes(method)) errors.push(`dictionary adaptation API is missing ${method}`);
}

for (const file of ["extension/capture/popup.js", "extension/capture/audio-processor.js", "extension/capture/offscreen.js"]) {
  const source = fs.readFileSync(file, "utf8");
  try { new Function(source); } catch (error) { errors.push(`${file}: ${error.message}`); }
}

const popupSource = fs.readFileSync("extension/capture/popup.js", "utf8");
if (!popupSource.includes("schemaVersion: 2")) errors.push("audio capture metadata must use the anchored schema v2 contract");
if (!popupSource.includes('clock: "HTMLMediaElement.currentTime"')) errors.push("capture metadata must identify the player media clock");
if (!popupSource.includes("TIMELINE_ANCHOR_INTERVAL_MS")) errors.push("capture must request periodic player-time anchors");

const offscreenSource = fs.readFileSync("extension/capture/offscreen.js", "utf8");
if (offscreenSource.includes("chrome.tabs")) errors.push("offscreen capture must route cues through chrome.runtime only");
if (!offscreenSource.includes('sendRuntimeMessage({ type: "ak-mandarin-live-cue"')) errors.push("offscreen cue routing must use the runtime message path");
if (!offscreenSource.includes('type: "transcription"')) errors.push("Realtime transcription session schema is missing");
if (!offscreenSource.includes('wss://api.openai.com/v1/realtime?intent=transcription')) errors.push("Realtime speech-to-text must use a dedicated transcription session");
if (offscreenSource.includes('wss://api.openai.com/v1/realtime?model=')) errors.push("transcription sessions must not use a general Realtime model URL");
if (!offscreenSource.includes("turn_detection: null")) errors.push("gpt-live-transcribe must disable unsupported server VAD");
if (!offscreenSource.includes("scheduleRealtimeIdleCommit")) errors.push("Realtime turn separation must preserve deltas and commit after inactivity");
if (!offscreenSource.includes("languages: activeContext.languages")) errors.push("Realtime transcription must send configured language hints");
if (!offscreenSource.includes('DEFAULT_LATENCY_MODE = "low"')) errors.push("Realtime live captions must default to low latency");
if (!offscreenSource.includes("realtimeHasUncommittedAudio")) errors.push("Realtime audio must be explicitly committed when capture stops");
if (!offscreenSource.includes("playbackSuspended")) errors.push("live capture must gate audio submission while playback is paused");
if (!offscreenSource.includes('format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE }')) errors.push("Realtime audio format must be explicit 24 kHz PCM");
if ((offscreenSource.match(/type: "input_audio_buffer\.append"/g) || []).length !== 1) errors.push("Realtime audio must have one append path");
if (!offscreenSource.includes('type: "ak-mandarin-live-status"')) errors.push("transport status messages are missing");
if (!offscreenSource.includes('message.type === "GET_OFFSCREEN_LIVE_STATE"')) errors.push("offscreen live-state query is missing");

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Validated MV3 manifest and ${data.cues.length} cues (${data.cues.flatMap(c => c.words).length} segmented words).`);
