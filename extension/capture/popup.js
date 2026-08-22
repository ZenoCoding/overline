(function () {
  "use strict";

  const MAX_EXCERPT_MS = 90_000;
  const TIMELINE_ANCHOR_INTERVAL_MS = 15_000;
  const DEFAULT_MODEL = "gpt-live-transcribe";
  const DEFAULT_LATENCY_MODE = "low";
  const SUPPORTED_SHOWS = [
    { showId: "link-click", slug: "link-click", url: /^https:\/\/anikototv\.to\/watch\/link-click-2e0jm\/ep-(\d+)\/?(?:[?#].*)?$/, preloadedEpisode: "1" },
    { showId: "the-girl-downstairs", slug: "the-girl-downstairs", url: /^https:\/\/anikototv\.to\/watch\/the-girl-downstairs-9eddv\/ep-(\d+)\/?(?:[?#].*)?$/, preloadedEpisode: null }
  ];

  const apiKeyInput = document.querySelector("#apiKey");
  const saveKeyBtn = document.querySelector("#saveKeyBtn");
  const keyStatus = document.querySelector("#keyStatus");
  const modeSelect = document.querySelector("#modeSelect");
  const modelSelect = document.querySelector("#modelSelect");
  const latencyModeSelect = document.querySelector("#latencyModeSelect");
  const latencyModeHint = document.querySelector("#latencyModeHint");
  const statusIndicator = document.querySelector("#statusIndicator");
  const statusText = document.querySelector("#statusText");
  const elapsed = document.querySelector("#elapsed");
  const settingsPanel = document.querySelector("#settingsPanel");
  const toggleLiveBtn = document.querySelector("#toggleLive");
  const toggleExcerptBtn = document.querySelector("#toggleExcerpt");

  let sessionApiKey = "";
  let liveState = { status: "idle", active: false, tabId: null, startedAt: null, error: null };
  let liveTimer = null;
  let excerptTimer = null;
  let timelineAnchorTimer = null;
  let activeTab = null;
  let stream = null;
  let audioContext = null;
  let excerptRecorder = null;
  let excerptChunks = [];
  let excerptStartedAt = 0;
  let excerptActive = false;
  let excerptStopping = false;
  let timelineAnchors = [];
  let timelineAnchorIds = new Set();
  function extensionRuntimeAvailable() {
    try { return Boolean(chrome?.runtime?.sendMessage); } catch { return false; }
  }

  function formatTime(milliseconds) {
    const total = Math.floor(Math.max(0, milliseconds) / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  function setStatus(message, state = "idle") {
    statusText.textContent = message;
    statusIndicator.className = "status-dot";
    if (state === "active") statusIndicator.classList.add("active");
    else if (state === "transcribing" || state === "starting") statusIndicator.classList.add("transcribing");
    else if (state === "error") statusIndicator.classList.add("error");
  }

  function normalizeApiKey(raw) {
    if (typeof raw !== "string") throw new Error("OpenAI API key is required.");
    const normalized = raw.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
    if (!normalized) throw new Error("API key was empty after trimming whitespace.");
    if (normalized.startsWith('"') || normalized.endsWith('"') || normalized.startsWith("'") || normalized.endsWith("'")) {
      throw new Error("API key contains surrounding quotes.");
    }
    if (/[^\x21-\x7E]/.test(normalized) || /[\x00-\x20\x7F]/.test(normalized)) {
      throw new Error("API key contains invalid whitespace or control characters.");
    }
    if (!/^[A-Za-z0-9._~+/=-]+$/.test(normalized)) throw new Error("API key contains invalid token characters.");
    if (normalized.length < 20) throw new Error("API key is unexpectedly short.");
    return normalized;
  }

  function updateLatencyControl() {
    const available = modelSelect?.value === DEFAULT_MODEL;
    if (latencyModeSelect) latencyModeSelect.disabled = !available;
    if (latencyModeHint) latencyModeHint.textContent = available
      ? "Low latency"
      : "Available for GPT Live Transcribe";
  }

  function matchSupportedEpisode(value) {
    for (const show of SUPPORTED_SHOWS) {
      const match = String(value || "").match(show.url);
      if (match) return { ...show, episodeNumber: match[1] };
    }
    return null;
  }

  async function updateSubtitleSourceAvailability() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const episode = matchSupportedEpisode(tab?.url);
      const preloadedOption = modeSelect?.querySelector('option[value="preloaded"]');
      const hasPreloaded = Boolean(episode?.preloadedEpisode && episode.episodeNumber === episode.preloadedEpisode);
      if (preloadedOption) preloadedOption.disabled = !hasPreloaded;
      if (episode && !hasPreloaded && modeSelect?.value === "preloaded") {
        modeSelect.value = "live";
        await chrome.storage?.local?.set({ subtitle_mode: "live" });
      }
    } catch {}
  }

  async function readConfig() {
    const result = {};
    try { Object.assign(result, await chrome.storage?.local?.get(["openai_api_key", "openai_model", "openai_latency_mode", "subtitle_mode"])); } catch {}
    if (!result.openai_api_key) {
      try { Object.assign(result, await chrome.storage?.session?.get(["openai_api_key", "openai_model", "openai_latency_mode", "subtitle_mode"])); } catch {}
    }
    return result;
  }

  async function loadStoredConfig() {
    try {
      const data = await readConfig();
      if (data.openai_api_key) {
        sessionApiKey = data.openai_api_key;
        apiKeyInput.value = sessionApiKey;
        keyStatus.textContent = `API key active (••••${sessionApiKey.slice(-4)})`;
        keyStatus.classList.remove("missing");
      } else {
        keyStatus.textContent = "No API key configured for live mode";
        keyStatus.classList.add("missing");
        if (settingsPanel) settingsPanel.open = true;
      }
      if (data.openai_model && modelSelect) modelSelect.value = data.openai_model;
      if (data.openai_latency_mode && latencyModeSelect) latencyModeSelect.value = data.openai_latency_mode;
      if (data.subtitle_mode && modeSelect) modeSelect.value = data.subtitle_mode;
      updateLatencyControl();
      await updateSubtitleSourceAvailability();
    } catch {
      keyStatus.textContent = "Storage unavailable";
      keyStatus.classList.add("missing");
    }
  }

  async function saveConfig() {
    try {
      sessionApiKey = normalizeApiKey(apiKeyInput.value);
      const values = {
        openai_api_key: sessionApiKey,
        openai_model: modelSelect?.value || DEFAULT_MODEL,
        openai_latency_mode: latencyModeSelect?.value || DEFAULT_LATENCY_MODE,
        subtitle_mode: modeSelect?.value || "live"
      };
      try { await chrome.storage?.local?.set(values); } catch { await chrome.storage?.session?.set(values); }
      keyStatus.textContent = `API key saved (••••${sessionApiKey.slice(-4)})`;
      keyStatus.classList.remove("missing");
      setStatus("Key saved");
      return true;
    } catch (error) {
      keyStatus.textContent = error.message;
      keyStatus.classList.add("missing");
      setStatus(error.message, "error");
      return false;
    }
  }

  function stopTimer(timerName) {
    if (timerName === "live") {
      clearInterval(liveTimer);
      liveTimer = null;
    } else {
      clearInterval(excerptTimer);
      excerptTimer = null;
    }
  }

  function updateLiveView() {
    const active = Boolean(liveState.active || ["starting", "active", "transcribing", "suspended"].includes(liveState.status));
    toggleLiveBtn.textContent = active ? "Stop subtitles" : "Start subtitles";
    toggleLiveBtn.classList.toggle("recording", active);
    toggleLiveBtn.disabled = excerptActive;
    toggleExcerptBtn.disabled = excerptActive ? false : active;

    stopTimer("live");
    if (active && liveState.startedAt) {
      const tick = () => { elapsed.textContent = formatTime(Date.now() - liveState.startedAt); };
      tick();
      liveTimer = setInterval(tick, 250);
    } else if (!excerptActive) {
      elapsed.textContent = "0:00";
    }

    if (liveState.error) setStatus(liveState.error, "error");
    else if (liveState.status === "starting") setStatus("Starting…", "starting");
    else if (liveState.status === "transcribing") setStatus("Listening", "transcribing");
    else if (liveState.status === "suspended") setStatus("Paused · no audio sent", "idle");
    else if (active) setStatus("Listening in background", "active");
    else if (!excerptActive) setStatus("Ready");
  }

  function applyLiveState(next) {
    if (!next) return;
    liveState = {
      ...liveState,
      ...next,
      active: Boolean(next.active || ["starting", "active", "transcribing", "suspended"].includes(next.status))
    };
    updateLiveView();
  }

  async function refreshLiveState() {
    if (!extensionRuntimeAvailable()) return;
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_LIVE_STATE" });
      if (response?.state) applyLiveState(response.state);
    } catch (error) {
      setStatus(error.message || "Background unavailable.", "error");
    }
  }

  async function startLiveCapture() {
    if (!sessionApiKey && !(await saveConfig())) throw new Error("Please enter your OpenAI API key above.");
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const episode = matchSupportedEpisode(activeTab?.url);
    if (!episode) throw new Error("Open a supported Mandarin show on AniKoto first.");

    toggleLiveBtn.disabled = true;
    toggleExcerptBtn.disabled = true;
    const model = modelSelect?.value || DEFAULT_MODEL;
    const latencyMode = latencyModeSelect?.value || DEFAULT_LATENCY_MODE;
    try { await chrome.storage?.local?.set({ openai_api_key: sessionApiKey, openai_model: model, openai_latency_mode: latencyMode, subtitle_mode: modeSelect?.value || "live", live_mode_enabled: true }); } catch {}

    const response = await chrome.runtime.sendMessage({
      type: "ak-mandarin-auto-start-live",
      tabId: activeTab.id,
      apiKey: sessionApiKey,
      model,
      latencyMode,
      showId: episode.showId,
      episodeNumber: episode.episodeNumber
    });
    if (!response || response.ok !== true) {
      applyLiveState(response?.state || { status: "error", active: false, error: response?.error || "Live capture failed." });
      throw new Error(response?.error || "Live capture failed.");
    }
    applyLiveState(response.state || { status: "active", active: true, tabId: activeTab.id, startedAt: Date.now() });
  }

  async function stopLiveCapture() {
    toggleLiveBtn.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ type: "ak-mandarin-auto-stop-live" });
      if (!response || response.ok !== true) throw new Error(response?.error || "Live capture stop failed.");
      try { await chrome.storage?.local?.set({ live_mode_enabled: false }); } catch {}
      applyLiveState(response.state || { status: "idle", active: false });
    } finally {
      toggleLiveBtn.disabled = false;
    }
  }

  async function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function requestTimelineAnchor(reason) {
    if (!excerptActive || !activeTab?.id || !extensionRuntimeAvailable()) return false;
    try {
      await chrome.tabs.sendMessage(activeTab.id, {
        type: "ak-mandarin-request-timeline-anchor",
        reason: String(reason || "periodic")
      });
      return true;
    } catch {
      return false;
    }
  }

  function collectTimelineAnchor(anchor, sender) {
    if (!excerptActive || !anchor || sender?.tab?.id !== activeTab?.id) return;
    const observedAtEpochMs = Number(anchor.observedAtEpochMs);
    const playerTimeSeconds = Number(anchor.playerTimeSeconds);
    if (!Number.isFinite(observedAtEpochMs) || !Number.isFinite(playerTimeSeconds) || playerTimeSeconds < 0) return;
    const captureTimeSeconds = Math.max(0, (observedAtEpochMs - excerptStartedAt) / 1000);
    const currentDurationSeconds = Math.max(0, (Date.now() - excerptStartedAt) / 1000);
    if (captureTimeSeconds > currentDurationSeconds + 2) return;
    const anchorId = String(anchor.anchorId || `${observedAtEpochMs}-${anchor.sequence || timelineAnchors.length}`);
    if (timelineAnchorIds.has(anchorId)) return;
    timelineAnchorIds.add(anchorId);
    timelineAnchors.push({
      schemaVersion: 1,
      anchorId,
      sequence: Number(anchor.sequence) || timelineAnchors.length + 1,
      reason: String(anchor.reason || "periodic"),
      observedAtEpochMs,
      captureTimeSeconds: Math.round(captureTimeSeconds * 1000) / 1000,
      playerTimeSeconds: Math.round(playerTimeSeconds * 1000) / 1000,
      durationSeconds: Number.isFinite(Number(anchor.durationSeconds)) ? Number(anchor.durationSeconds) : null,
      playbackRate: Number(anchor.playbackRate) || 1,
      paused: Boolean(anchor.paused),
      stalled: Boolean(anchor.stalled),
      ended: Boolean(anchor.ended),
      readyState: Number(anchor.readyState) || 0
    });
    timelineAnchors.sort((left, right) => left.captureTimeSeconds - right.captureTimeSeconds || left.sequence - right.sequence);
    if (timelineAnchors.length > 5000) timelineAnchors.shift();
  }

  async function stopExcerptRecording(reason = "capture-stop") {
    if (excerptStopping || !excerptRecorder || excerptRecorder.state !== "recording") return;
    excerptStopping = true;
    await requestTimelineAnchor(reason);
    await new Promise((resolve) => setTimeout(resolve, 150));
    excerptRecorder.stop();
  }

  async function finishExcerpt() {
    stopTimer("excerpt");
    clearInterval(timelineAnchorTimer);
    timelineAnchorTimer = null;
    const durationMs = Date.now() - excerptStartedAt;
    const audio = new Blob(excerptChunks, { type: excerptRecorder?.mimeType || "audio/webm" });
    const episode = matchSupportedEpisode(activeTab?.url);
    const basename = `${episode?.slug || "mandarin-show"}-ep${episode?.episodeNumber || "unknown"}-excerpt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const metadata = {
      schemaVersion: 2,
      sourceUrl: activeTab?.url || null,
      capturedAt: new Date(excerptStartedAt).toISOString(),
      durationSeconds: Math.round(durationMs / 100) / 10,
      mediaType: audio.type,
      audioFile: `${basename}.webm`,
      timeline: {
        schemaVersion: 1,
        clock: "HTMLMediaElement.currentTime",
        captureStartedAtEpochMs: excerptStartedAt,
        anchorIntervalSeconds: TIMELINE_ANCHOR_INTERVAL_MS / 1000,
        anchors: timelineAnchors,
        startAnchorPresent: Boolean(timelineAnchors[0] && timelineAnchors[0].captureTimeSeconds <= 1),
        endAnchorPresent: Boolean(timelineAnchors.at(-1) && timelineAnchors.at(-1).captureTimeSeconds >= durationMs / 1000 - 1)
      },
      note: "User-initiated tab-audio capture with exact player-time anchors for precomputed subtitles; contains no video."
    };
    await download(audio, `${basename}.webm`);
    await download(new Blob([JSON.stringify(metadata, null, 2)], { type: "application/json" }), `${basename}.capture.json`);
    stream?.getTracks().forEach((track) => track.stop());
    await audioContext?.close();
    stream = null;
    audioContext = null;
    excerptActive = false;
    excerptStopping = false;
    setStatus("Saved audio and capture metadata to Downloads.");
    toggleExcerptBtn.textContent = "Save Audio Excerpt";
    toggleExcerptBtn.classList.remove("recording");
    updateLiveView();
  }

  async function startExcerptRecording() {
    if (liveState.active) throw new Error("Stop live transcription before recording an excerpt.");
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!matchSupportedEpisode(activeTab?.url)) throw new Error("Open a supported Mandarin show on AniKoto first.");
    toggleExcerptBtn.disabled = true;
    toggleLiveBtn.disabled = true;

    stream = await new Promise((resolve, reject) => {
      chrome.tabCapture.capture({ audio: true, video: false }, (captured) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!captured) reject(new Error("Chrome did not return tab audio stream."));
        else resolve(captured);
      });
    });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    audioContext.createMediaStreamSource(stream).connect(audioContext.destination);
    excerptChunks = [];
    const preferredType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    excerptRecorder = new MediaRecorder(stream, { mimeType: preferredType });
    excerptRecorder.addEventListener("dataavailable", (event) => { if (event.data.size) excerptChunks.push(event.data); });
    excerptRecorder.addEventListener("stop", finishExcerpt, { once: true });
    excerptStartedAt = Date.now();
    excerptActive = true;
    excerptStopping = false;
    timelineAnchors = [];
    timelineAnchorIds = new Set();
    excerptRecorder.start(1000);
    await requestTimelineAnchor("capture-start");
    setTimeout(() => { requestTimelineAnchor("capture-start-retry"); }, 300);
    setTimeout(() => { requestTimelineAnchor("capture-start-retry"); }, 750);
    timelineAnchorTimer = setInterval(() => { requestTimelineAnchor("periodic"); }, TIMELINE_ANCHOR_INTERVAL_MS);
    elapsed.textContent = "0:00";
    setStatus("Recording tab audio excerpt…", "active");
    toggleExcerptBtn.textContent = "Stop and Save Excerpt";
    toggleExcerptBtn.classList.add("recording");
    toggleExcerptBtn.disabled = false;
    excerptTimer = setInterval(() => {
      const duration = Date.now() - excerptStartedAt;
      elapsed.textContent = formatTime(duration);
      if (duration >= MAX_EXCERPT_MS && excerptRecorder?.state === "recording") stopExcerptRecording("capture-limit");
    }, 250);
  }

  if (extensionRuntimeAvailable() && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (message?.type === "ak-mandarin-player-timeline-anchor") collectTimelineAnchor(message.anchor, sender);
      if (["ak-mandarin-live-state", "LIVE_STATE", "OFFSCREEN_LIVE_STATE", "ak-mandarin-live-status", "LIVE_STATUS"].includes(message?.type)) {
        applyLiveState(message.state || message);
      }
      if (["ak-mandarin-live-error", "LIVE_ERROR", "OFFSCREEN_LIVE_ERROR"].includes(message?.type)) {
        applyLiveState({ ...message, status: "error", active: false, error: message.error || message.message || "Live transcription failed." });
      }
    });
  }

  saveKeyBtn.addEventListener("click", saveConfig);
  apiKeyInput.addEventListener("keydown", (event) => { if (event.key === "Enter") saveConfig(); });
  modeSelect?.addEventListener("change", () => { try { chrome.storage?.local?.set({ subtitle_mode: modeSelect.value }); } catch {} });
  modelSelect?.addEventListener("change", () => {
    try { chrome.storage?.local?.set({ openai_model: modelSelect.value }); } catch {}
    updateLatencyControl();
    if (liveState.active) setStatus("Engine saved; restart live transcription to apply it.", "active");
  });
  latencyModeSelect?.addEventListener("change", () => {
    try { chrome.storage?.local?.set({ openai_latency_mode: latencyModeSelect.value }); } catch {}
    if (liveState.active) setStatus("Latency saved; restart live transcription to apply it.", "active");
  });

  toggleLiveBtn.addEventListener("click", async () => {
    try {
      if (liveState.active) await stopLiveCapture();
      else await startLiveCapture();
    } catch (error) {
      setStatus(error.message, "error");
      toggleLiveBtn.disabled = false;
      toggleExcerptBtn.disabled = false;
    }
  });

  toggleExcerptBtn.addEventListener("click", async () => {
    try {
      if (excerptActive && excerptRecorder?.state === "recording") await stopExcerptRecording("capture-stop");
      else await startExcerptRecording();
    } catch (error) {
      setStatus(error.message, "error");
      toggleExcerptBtn.disabled = false;
      toggleLiveBtn.disabled = false;
    }
  });

  loadStoredConfig().then(refreshLiveState);
})();
