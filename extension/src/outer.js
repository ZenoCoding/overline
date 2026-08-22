(function () {
  "use strict";

  const adapter = window.AniKotoMandarinAdapter;
  const isFixture = document.documentElement.dataset.akMandarinOuterFixture === "true";
  if (!adapter || (!adapter.isSupportedPage() && !isFixture) || window.top !== window) return;

  const showRoutes = [
    { showId: "link-click", path: /^\/watch\/link-click-2e0jm\/ep-(\d+)\/?$/, preloadedEpisode: "1" },
    { showId: "the-girl-downstairs", path: /^\/watch\/the-girl-downstairs-9eddv\/ep-(\d+)\/?$/, preloadedEpisode: null }
  ];
  const route = isFixture
    ? { showId: "link-click", episodeNumber: "1", preloadedEpisode: "1" }
    : showRoutes.map((candidate) => {
        const match = location.pathname.match(candidate.path);
        return match ? { ...candidate, episodeNumber: match[1] } : null;
      }).find(Boolean);
  const showId = route?.showId || "unknown-show";
  const episodeNumber = route?.episodeNumber || null;
  const episodeId = `${showId}-ep${episodeNumber || "unknown"}`;
  const hasPreloadedCues = isFixture || Boolean(route?.preloadedEpisode && episodeNumber === route.preloadedEpisode);

  let frame = null;
  let cueData = null;
  let connected = false;
  let frameScriptReady = false;
  let lastInjectionReason = null;
  let stopped = false;
  let connectionTimer = null;
  const pendingLiveCues = [];

  const status = document.createElement("div");
  status.className = "ak-connection-status ak-waiting";
  status.textContent = "Mandarin: waiting for video player";
  document.body.appendChild(status);

  function dataUrl() {
    if (isFixture) return "/extension/data/link-click-ep1.real.json";
    return chrome.runtime.getURL("data/link-click-ep1.real.json");
  }

  function playerOrigin() {
    if (isFixture) return "http://127.0.0.1:4174";
    if (!frame?.src) return null;
    try { return new URL(frame.src).origin; } catch { return null; }
  }

  function positionStatus() {
    if (!frame) {
      Object.assign(status.style, { right: "16px", top: "16px", left: "auto" });
      return;
    }
    const rect = frame.getBoundingClientRect();
    Object.assign(status.style, {
      left: `${Math.max(8, rect.left + 10)}px`,
      top: `${Math.max(8, rect.top + 10)}px`,
      right: "auto"
    });
  }

  function discoverFrame() {
    const found = adapter.findSupportedPlayerFrame();
    if (found === frame) return;
    frame = found;
    connected = false;
    status.className = "ak-connection-status ak-waiting";
    frameScriptReady = false;
    status.textContent = frame ? "Mandarin: connecting to video…" : "Mandarin: waiting for video player";
    positionStatus();
  }

  function runtimeAvailable() {
    try {
      return Boolean(chrome.runtime?.id && chrome.runtime?.sendMessage);
    } catch {
      return false;
    }
  }

  function requestInjection() {
    if (stopped || isFixture || typeof chrome === "undefined") return;
    let request;
    try {
      if (!runtimeAvailable()) {
        stopAfterExtensionReload();
        return;
      }
      request = chrome.runtime.sendMessage({ type: "ak-mandarin-connect-player" });
    } catch {
      stopAfterExtensionReload();
      return;
    }
    Promise.resolve(request).then((result) => {
      lastInjectionReason = result?.reason || null;
      if (!result?.ok && result?.reason === "injection-failed") {
        status.className = "ak-connection-status ak-waiting";
        status.textContent = "Mandarin unavailable · video playback unaffected";
      }
    }).catch(() => {
      if (!runtimeAvailable()) stopAfterExtensionReload();
      else lastInjectionReason = "background-unavailable";
    });
  }

  function stopAfterExtensionReload() {
    stopped = true;
    if (connectionTimer) clearInterval(connectionTimer);
    status.className = "ak-connection-status ak-waiting";
    status.textContent = "Mandarin extension updated · refresh this page";
  }

  function sendActivation(target) {
    const origin = playerOrigin();
    if (!cueData || !origin) return;
    target.postMessage({
      type: "ak-mandarin-activate",
      episode: episodeId,
      cueData
    }, origin);
  }

  function postLiveCue(cue) {
    const origin = playerOrigin();
    if (!frame?.contentWindow || !frameScriptReady || !origin) return false;
    frame.contentWindow.postMessage({ type: "ak-mandarin-live-cue", cue }, origin);
    return true;
  }

  function queueOrPostLiveCue(cue) {
    if (postLiveCue(cue)) return;
    pendingLiveCues.push(cue);
    if (pendingLiveCues.length > 256) pendingLiveCues.shift();
  }

  function flushPendingLiveCues() {
    while (pendingLiveCues.length && postLiveCue(pendingLiveCues[0])) pendingLiveCues.shift();
  }

  function requestTimelineAnchor(reason = "periodic") {
    const origin = playerOrigin();
    if (!frame?.contentWindow || !frameScriptReady || !origin) return false;
    frame.contentWindow.postMessage({
      type: "ak-mandarin-request-timeline-anchor",
      reason: String(reason || "periodic")
    }, origin);
    return true;
  }

  window.addEventListener("message", (event) => {
    if (!frame || event.origin !== playerOrigin() || event.source !== frame.contentWindow) return;
    if (event.data?.type === "ak-mandarin-player-ready") {
      frameScriptReady = true;
      status.className = "ak-connection-status ak-waiting";
      status.textContent = "Mandarin ready · waiting for video to load";
      sendActivation(event.source);
      flushPendingLiveCues();
    }
    if (event.data?.type === "ak-mandarin-player-activated") {
      frameScriptReady = true;
      status.className = "ak-connection-status ak-waiting";
      status.textContent = "Mandarin ready · waiting for video to load";
      flushPendingLiveCues();
    }
    if (event.data?.type === "ak-mandarin-player-connected") {
      connected = true;
      status.className = "ak-connection-status ak-connected";
      status.textContent = `Mandarin connected · sync +${Number(event.data.offsetSeconds).toFixed(1)}s`;
      status.style.display = "none";
    }
    if (event.data?.type === "ak-mandarin-player-timeline-anchor" && event.data.anchor && runtimeAvailable()) {
      try {
        chrome.runtime.sendMessage({
          type: "ak-mandarin-player-timeline-anchor",
          anchor: event.data.anchor
        }).catch(() => {});
      } catch {}
    }
  });

  const cueDataRequest = hasPreloadedCues
    ? fetch(dataUrl()).then((response) => {
        if (!response.ok) throw new Error(`Subtitle data failed: ${response.status}`);
        return response.json();
      })
    : Promise.resolve({ schemaVersion: 1, cues: [], alignment: {} });

  cueDataRequest
    .then((data) => {
      cueData = { ...data, episodeId, hasPreloadedCues };
      discoverFrame();
      if (frame?.contentWindow) sendActivation(frame.contentWindow);
      requestInjection();
    })
    .catch(() => {
      status.className = "ak-connection-status ak-error";
      status.textContent = "Mandarin: cue data failed to load";
    });

  new MutationObserver(discoverFrame).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
  new ResizeObserver(positionStatus).observe(document.documentElement);
  window.addEventListener("resize", positionStatus);
  document.addEventListener("keydown", (event) => {
    if (event.code === "Space" && connected && frame?.contentWindow) {
      const origin = playerOrigin();
      if (origin) frame.contentWindow.postMessage({ type: "ak-mandarin-resume" }, origin);
    }
  }, true);
  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type === "ak-mandarin-request-timeline-anchor") {
        requestTimelineAnchor(message.reason || "requested");
        return false;
      }
      if (message?.type === "ak-mandarin-live-cue" && message.cue) {
        queueOrPostLiveCue(message.cue);
        status.className = "ak-connection-status ak-connected";
        const snippet = message.cue.text || "";
        const latency = message.cue.timing?.totalPipelineLatencyMs || message.cue.timing?.apiLatencyMs;
        const latencyText = latency ? ` (${Math.round(latency)}ms)` : "";
        status.textContent = `Mandarin Live: “${snippet.slice(0, 14)}${snippet.length > 14 ? "…" : ""}”${latencyText}`;
      }
      return false;
    });
  }

  connectionTimer = setInterval(() => {
    if (stopped) return;
    discoverFrame();
    if (frame && !connected && frameScriptReady) status.textContent = "Mandarin ready · waiting for video to load";
    if (frame && !connected && !frameScriptReady && lastInjectionReason === "injection-failed") {
      status.className = "ak-connection-status ak-waiting";
      status.textContent = "Mandarin unavailable · video playback unaffected";
    } else if (frame && !connected && !frameScriptReady) {
      status.textContent = "Mandarin: connecting to video…";
      requestInjection();
    }
  }, 2000);
  discoverFrame();
})();
