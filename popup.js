(function () {
  "use strict";

  const MAX_MS = 90_000;
  const toggle = document.querySelector("#toggle");
  const status = document.querySelector("#status");
  const elapsed = document.querySelector("#elapsed");
  let recorder = null;
  let stream = null;
  let audioContext = null;
  let chunks = [];
  let startedAt = 0;
  let timer = null;
  let activeTab = null;

  function formatTime(milliseconds) {
    const total = Math.floor(milliseconds / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  async function download(blob, suffix) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `link-click-ep1-excerpt-${new Date().toISOString().replace(/[:.]/g, "-")}.${suffix}`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function stopRecording() {
    if (!recorder || recorder.state === "inactive") return;
    recorder.stop();
  }

  async function finish() {
    clearInterval(timer);
    const durationMs = Date.now() - startedAt;
    const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    const metadata = {
      schemaVersion: 1,
      sourceUrl: activeTab?.url || null,
      capturedAt: new Date(startedAt).toISOString(),
      durationSeconds: Math.round(durationMs / 100) / 10,
      mediaType: audio.type,
      note: "User-initiated short tab-audio capture for local transcription; contains no video."
    };
    await download(audio, "webm");
    await download(new Blob([JSON.stringify(metadata, null, 2)], { type: "application/json" }), "capture.json");
    stream?.getTracks().forEach((track) => track.stop());
    await audioContext?.close();
    status.textContent = "Saved audio and capture metadata to Downloads.";
    toggle.textContent = "Done";
    toggle.classList.remove("recording");
    toggle.disabled = true;
  }

  async function startRecording() {
    toggle.disabled = true;
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const supported = /^https:\/\/anikototv\.to\/watch\/link-click-2e0jm\/ep-1\/?(?:[?#].*)?$/.test(activeTab?.url || "");
    if (!supported) throw new Error("Open Link Click episode 1 on AniKoto first.");

    stream = await new Promise((resolve, reject) => {
      chrome.tabCapture.capture({ audio: true, video: false }, (captured) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!captured) reject(new Error("Chrome did not return an audio stream."));
        else resolve(captured);
      });
    });

    // Chrome mutes captured tab audio unless it is explicitly routed back to the speakers.
    audioContext = new AudioContext();
    audioContext.createMediaStreamSource(stream).connect(audioContext.destination);
    chunks = [];
    const preferredType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    recorder = new MediaRecorder(stream, { mimeType: preferredType });
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size) chunks.push(event.data);
    });
    recorder.addEventListener("stop", finish, { once: true });
    recorder.start(1000);
    startedAt = Date.now();
    elapsed.textContent = "0:00";
    status.textContent = "Recording tab audio… keep the episode playing.";
    toggle.textContent = "Stop and save";
    toggle.classList.add("recording");
    toggle.disabled = false;
    timer = setInterval(() => {
      const duration = Date.now() - startedAt;
      elapsed.textContent = formatTime(duration);
      if (duration >= MAX_MS) stopRecording();
    }, 250);
  }

  toggle.addEventListener("click", async () => {
    try {
      if (recorder?.state === "recording") await stopRecording();
      else await startRecording();
    } catch (error) {
      status.textContent = error.message;
      toggle.disabled = false;
    }
  });
})();
