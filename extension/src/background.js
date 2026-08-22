"use strict";

const EPISODE_URL = /^https:\/\/anikototv\.to\/watch\/(?:link-click-2e0jm|the-girl-downstairs-9eddv)\/ep-\d+\/?(?:[?#].*)?$/;
const PLAYER_HOSTS = new Set(["vidtube.site", "megaplay.buzz"]);
const DEFAULT_MODEL = "gpt-live-transcribe";
const DEFAULT_LATENCY_MODE = "low";

// The service worker is the sole owner of live-capture lifecycle. The popup
// and player can request transitions, but neither is allowed to own a stream.
let liveState = {
  status: "idle",
  active: false,
  tabId: null,
  model: null,
  latencyMode: null,
  episodeNumber: null,
  showId: null,
  keyFingerprint: null,
  startedAt: null,
  error: null,
  lastCueAt: null
};
let stateHydration = Promise.resolve();
let transition = Promise.resolve();
const seenCueKeys = new Set();

function isLiveStatus(status) {
  return status === "starting" || status === "active" || status === "transcribing" || status === "suspended" || status === "stopping";
}

function snapshotLiveState() {
  const { keyFingerprint, ...safeState } = liveState;
  return { ...safeState, active: Boolean(liveState.active || isLiveStatus(liveState.status)) };
}

function persistLiveState() {
  try {
    return chrome.storage?.session?.set({
      live_state: { ...snapshotLiveState(), keyFingerprint: liveState.keyFingerprint }
    }).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

function publishLiveState() {
  const state = snapshotLiveState();
  persistLiveState();
  try {
    chrome.runtime.sendMessage({ type: "ak-mandarin-live-state", source: "background", state }).catch(() => {});
  } catch {}
}

function setLiveState(patch, notify = true) {
  liveState = { ...liveState, ...patch };
  if (notify) publishLiveState();
  return snapshotLiveState();
}

async function hydrateLiveState() {
  try {
    const stored = await chrome.storage?.session?.get("live_state");
    if (stored?.live_state && typeof stored.live_state === "object") {
      liveState = { ...liveState, ...stored.live_state };
    }
  } catch {}
}

stateHydration = hydrateLiveState();

function queueTransition(operation) {
  const run = transition.then(operation, operation);
  transition = run.catch(() => {});
  return run;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen?.hasDocument || !chrome.offscreen?.createDocument) {
    throw new Error("Chrome offscreen capture is unavailable.");
  }
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "capture/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Real-time tab audio streaming for Mandarin live subtitles"
  });
}

async function getStoredApiKey() {
  try {
    const local = await chrome.storage?.local?.get(["openai_api_key", "openai_model", "openai_latency_mode"]);
    if (local?.openai_api_key) {
      return { apiKey: local.openai_api_key, model: local.openai_model || DEFAULT_MODEL, latencyMode: local.openai_latency_mode || DEFAULT_LATENCY_MODE };
    }
  } catch {}
  try {
    const session = await chrome.storage?.session?.get(["openai_api_key", "openai_model", "openai_latency_mode"]);
    if (session?.openai_api_key) {
      return { apiKey: session.openai_api_key, model: session.openai_model || DEFAULT_MODEL, latencyMode: session.openai_latency_mode || DEFAULT_LATENCY_MODE };
    }
  } catch {}
  return { apiKey: "", model: DEFAULT_MODEL, latencyMode: DEFAULT_LATENCY_MODE };
}

function keyFingerprint(apiKey) {
  const value = String(apiKey || "");
  return value ? `${value.length}:${value.slice(-4)}` : null;
}

async function resolveTargetTabId(explicitTabId, senderTabId) {
  if (explicitTabId !== undefined && explicitTabId !== null) return explicitTabId;
  if (senderTabId !== undefined && senderTabId !== null) return senderTabId;
  try {
    const tabs = await chrome.tabs.query({ url: "*://anikototv.to/*" });
    if (tabs.length > 0) return tabs[0].id;
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    return active?.id ?? null;
  } catch {
    return null;
  }
}

async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ target: "offscreen", ...message });
  return response || null;
}

function isSameConfiguration(tabId, model, latencyMode, apiKey, showId, episodeNumber) {
  return liveState.tabId === tabId &&
    liveState.model === model &&
    liveState.latencyMode === latencyMode &&
    liveState.episodeNumber === (episodeNumber || null) &&
    liveState.showId === (showId || null) &&
    liveState.keyFingerprint === keyFingerprint(apiKey);
}

async function stopLiveInternal({ notify = true } = {}) {
  const hadState = liveState.active || liveState.tabId !== null || liveState.status !== "idle";
  if (!hadState) return { ok: true, active: false, state: snapshotLiveState() };

  setLiveState({ status: "stopping", active: false, error: null }, notify);
  try {
    let response = null;
    if (chrome.offscreen?.hasDocument && await chrome.offscreen.hasDocument()) {
      response = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "STOP_OFFSCREEN_LIVE"
      });
      if (response && response.ok === false) {
        throw new Error(response.error || "Offscreen capture stop failed.");
      }
    }
    const state = setLiveState({
      status: "idle",
      active: false,
      tabId: null,
      model: null,
      latencyMode: null,
      episodeNumber: null,
      showId: null,
      keyFingerprint: null,
      startedAt: null,
      error: null
    }, notify);
    return { ok: true, active: false, state, response };
  } catch (error) {
    const state = setLiveState({ status: "error", active: true, error: error.message || "Live capture stop failed." }, notify);
    return { ok: false, active: true, error: state.error, state };
  }
}

async function getStreamId(tabId) {
  try {
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    const message = String(error?.message || "");
    if (!message.includes("Cannot capture a tab with an active stream")) throw error;

    // A previous service-worker incarnation may have left a tab stream alive.
    // Release it and retry once; never turn a failed retry into success.
    try {
      if (chrome.offscreen?.hasDocument && await chrome.offscreen.hasDocument()) {
        await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_OFFSCREEN_LIVE" }).catch(() => {});
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
    return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  }
}

async function startLiveInternal(tabId, apiKey, model, latencyMode, showId, episodeNumber) {
  const selectedModel = model || DEFAULT_MODEL;
  const selectedLatencyMode = latencyMode || DEFAULT_LATENCY_MODE;
  const fingerprint = keyFingerprint(apiKey);
  setLiveState({
    status: "starting",
    active: true,
    tabId,
    model: selectedModel,
    latencyMode: selectedLatencyMode,
    episodeNumber: episodeNumber || null,
    showId: showId || null,
    keyFingerprint: fingerprint,
    startedAt: liveState.startedAt || Date.now(),
    error: null
  });

  try {
    const streamId = await getStreamId(tabId);
    const response = await sendToOffscreen({
      type: "START_OFFSCREEN_LIVE",
      streamId,
      apiKey,
      model: selectedModel,
      latencyMode: selectedLatencyMode,
      tabId,
      showId: showId || null,
      episodeNumber: episodeNumber || null
    });
    if (!response || response.ok !== true) {
      throw new Error(response?.error || "Offscreen capture did not acknowledge startup.");
    }
    const state = setLiveState({
      status: "active",
      active: true,
      tabId,
      model: selectedModel,
      latencyMode: selectedLatencyMode,
      episodeNumber: episodeNumber || null,
      showId: showId || null,
      keyFingerprint: fingerprint,
      startedAt: liveState.startedAt || Date.now(),
      error: null
    });
    return { ok: true, active: true, state };
  } catch (error) {
    const state = setLiveState({
      status: "error",
      active: false,
      error: error.message || "Live audio capture failed."
    });
    return { ok: false, active: false, error: state.error, state };
  }
}

async function handleAutoStartLive(tabId, explicitKey, explicitModel, explicitLatencyMode, showId, episodeNumber) {
  await stateHydration;
  const stored = await getStoredApiKey();
  const apiKey = explicitKey || stored.apiKey;
  const model = explicitModel || stored.model || DEFAULT_MODEL;
  const latencyMode = explicitLatencyMode || stored.latencyMode || DEFAULT_LATENCY_MODE;
  if (!apiKey) {
    const state = setLiveState({ status: "error", active: false, tabId, model, error: "Please enter your OpenAI API key in the extension popup." });
    return { ok: false, reason: "no-key", error: state.error, state };
  }

  return queueTransition(async () => {
    if ((liveState.status === "active" || liveState.status === "starting") && isSameConfiguration(tabId, model, latencyMode, apiKey, showId, episodeNumber)) {
      return { ok: true, active: true, state: snapshotLiveState() };
    }

    if (liveState.status !== "idle" || liveState.tabId !== null) {
      const stopped = await stopLiveInternal();
      if (!stopped.ok) return stopped;
    }
    return await startLiveInternal(tabId, apiKey, model, latencyMode, showId, episodeNumber);
  });
}

async function handleAutoStopLive(requestedTabId = null) {
  await stateHydration;
  return queueTransition(async () => {
    if (requestedTabId !== null && liveState.tabId !== null && requestedTabId !== liveState.tabId) {
      return { ok: true, active: Boolean(liveState.active), state: snapshotLiveState() };
    }
    return await stopLiveInternal();
  });
}

function cueKey(cue) {
  if (!cue) return null;
  return cue.id || [cue.timestamp, cue.text, cue.isDelta, cue.isFinal].join("|");
}

function routeLiveCue(message, sender) {
  const tabId = message.tabId ?? sender.tab?.id ?? liveState.tabId;
  if (tabId === undefined || tabId === null) return;
  if (liveState.tabId !== null && tabId !== liveState.tabId) return;
  const key = cueKey(message.cue);
  if (key && seenCueKeys.has(key)) return;
  if (key) {
    seenCueKeys.add(key);
    if (seenCueKeys.size > 256) seenCueKeys.delete(seenCueKeys.values().next().value);
  }
  setLiveState({ lastCueAt: Date.now() });
  // frameId 0 is the outer AniKoto content script. It forwards exactly once
  // to the selected provider player frame; broadcasting to all frames causes
  // duplicate rendering and annotation work.
  chrome.tabs.sendMessage(tabId, { ...message, tabId }, { frameId: 0 }).catch(() => {});
}

function applyOffscreenState(message) {
  const incoming = message.state && typeof message.state === "object" ? message.state : message;
  const status = incoming.status || (incoming.error ? "error" : incoming.active ? "active" : "idle");
  const active = incoming.active === undefined ? isLiveStatus(status) : Boolean(incoming.active);
  const state = setLiveState({
    status,
    active,
    tabId: incoming.tabId ?? liveState.tabId,
    model: incoming.model ?? liveState.model,
    latencyMode: incoming.latencyMode ?? liveState.latencyMode,
    startedAt: incoming.startedAt ?? liveState.startedAt,
    error: incoming.error || null
  });
  return state;
}

async function refreshOffscreenState() {
  try {
    if (!chrome.offscreen?.hasDocument || !await chrome.offscreen.hasDocument()) {
      if (liveState.active) setLiveState({ status: "idle", active: false, tabId: null, model: null, startedAt: null, error: null });
      return;
    }
    const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "GET_OFFSCREEN_LIVE_STATE" });
    if (response?.state || response?.status || response?.active !== undefined) applyOffscreenState(response);
  } catch {}
}

async function getLiveState() {
  await stateHydration;
  await refreshOffscreenState();
  return snapshotLiveState();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ak-mandarin-auto-start-live") {
    (async () => {
      const tabId = await resolveTargetTabId(message.tabId, sender.tab?.id);
      if (tabId === null || tabId === undefined) return { ok: false, reason: "no-tab", error: "No active video tab found." };
      return await handleAutoStartLive(tabId, message.apiKey, message.model, message.latencyMode, message.showId, message.episodeNumber);
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message || "Live capture start failed." }));
    return true;
  }

  if (message?.type === "ak-mandarin-auto-stop-live") {
    handleAutoStopLive(message.tabId ?? null)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || "Live capture stop failed." }));
    return true;
  }

  if (message?.type === "GET_LIVE_STATE" || message?.type === "ak-mandarin-get-live-state") {
    getLiveState().then((state) => sendResponse({ ok: true, state })).catch(() => sendResponse({ ok: true, state: snapshotLiveState() }));
    return true;
  }

  if (message?.type === "ak-mandarin-live-cue") {
    routeLiveCue(message, sender);
    return false;
  }

  if (message?.type === "ak-mandarin-player-timeline-anchor" && message.anchor) {
    const tabId = sender.tab?.id ?? null;
    if (tabId === null || liveState.tabId !== tabId || !liveState.active) return false;
    const anchor = message.anchor;
    chrome.runtime.sendMessage({
      target: "offscreen",
      type: "SET_OFFSCREEN_PLAYBACK_STATE",
      paused: Boolean(anchor.paused),
      ended: Boolean(anchor.ended),
      sequence: anchor.sequence,
      reason: anchor.reason
    }).catch(() => {});
    return false;
  }

  if (["ak-mandarin-live-state", "LIVE_STATE", "OFFSCREEN_LIVE_STATE", "ak-mandarin-live-status", "LIVE_STATUS"].includes(message?.type)) {
    if (message.source === "background") return false;
    applyOffscreenState(message);
    return false;
  }

  if (["ak-mandarin-live-error", "LIVE_ERROR", "OFFSCREEN_LIVE_ERROR"].includes(message?.type)) {
    applyOffscreenState({ ...message, status: "error", error: message.error || message.message || "Live transcription failed." });
    return false;
  }

  if (message?.type !== "ak-mandarin-connect-player") return false;
  if (!sender.tab?.id || !EPISODE_URL.test(sender.url || "")) {
    sendResponse({ ok: false, reason: "unsupported-parent" });
    return false;
  }

  (async () => {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: sender.tab.id });
    const playerFrame = frames.find((frame) => {
      try {
        const url = new URL(frame.url);
        return frame.frameId !== 0 && url.protocol === "https:" && PLAYER_HOSTS.has(url.hostname);
      } catch {
        return false;
      }
    });
    if (!playerFrame) return { ok: false, reason: "frame-not-found" };

    const target = { tabId: sender.tab.id, frameIds: [playerFrame.frameId] };
    await chrome.scripting.insertCSS({ target, files: ["src/content.css"] });
    await chrome.scripting.executeScript({ target, files: ["src/cedict-data.js", "src/dict.js", "src/site-adapter.js", "src/player.js"] });
    return { ok: true, frameId: playerFrame.frameId };
  })().then(sendResponse).catch((error) => {
    sendResponse({ ok: false, reason: "injection-failed", detail: String(error?.message || "unknown") });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (liveState.tabId === tabId) handleAutoStopLive(tabId).catch(() => {});
});
