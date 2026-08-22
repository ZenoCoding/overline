(function () {
  "use strict";

  const TARGET_SAMPLE_RATE = 16_000;
  const REALTIME_SAMPLE_RATE = 24_000;
  const HTTP_SPEECH_WINDOW_MS = 2500;
  const MIN_SPEECH_RMS = 0.001;
  const DEFAULT_MODEL = "gpt-live-transcribe";
  const HTTP_FALLBACK_MODEL = "gpt-4o-transcribe";
  const DEFAULT_LATENCY_MODE = "low";
  const LATENCY_MODES = new Set(["minimal", "low", "medium", "high", "xhigh"]);
  const DEFAULT_TRANSCRIPTION_CONTEXT = {
    prompt: "Mandarin dialogue from the Chinese animated drama Link Click (时光代理人). Transcribe verbatim in Simplified Chinese. Recurring characters include 程小时 (Cheng Xiaoshi), 陆光 (Lu Guang), and 乔苓 (Qiao Ling). Preserve character names, recurring places such as 时光照相馆, and colloquial sentence-final particles such as 喽, 嘛, 啦, 呀, 吧, and 呢.",
    languages: ["cmn"],
    keywords: ["程小时", "陆光", "光光", "乔苓", "乔苓姐", "时光照相馆"],
    episodes: {
      "1": {
        prompt: "Episode 1 includes Emma and scenes involving 雀德游戏, a financial report, and the photo studio's landlords.",
        keywords: ["Emma", "雀德", "雀德游戏", "包租婆", "包租公", "董总", "第三季度财报", "核心财务数据", "财务总监"]
      }
    },
    shows: {
      "the-girl-downstairs": {
        prompt: "Natural conversational Mandarin from the modern university romance drama The Girl Downstairs (爱上她的理由). Transcribe verbatim in Simplified Chinese. Preserve character names, casual speech, forms of address such as 学姐, and sentence-final particles.",
        languages: ["cmn"],
        keywords: ["爱上她的理由", "袁君瑭", "李诗雅", "朱茱", "崔若霓", "郑国洙", "徐云泽", "陈星国", "闵松大学", "学姐", "前偶像"],
        episodes: {}
      }
    }
  };
  const transcriptionContext = window.MandarinCedictData?.transcription || DEFAULT_TRANSCRIPTION_CONTEXT;
  let activeContext = resolveTranscriptionContext("link-click", null);
  const TURN_IDLE_COMMIT_MS = 1200;
  const MIN_COMMIT_AUDIO_MS = 100;

  let liveActive = false;
  let activeTabId = null;
  let stream = null;
  let audioContext = null;
  let audioWorkletNode = null;
  let scriptProcessor = null;
  let mediaStreamSource = null;
  let sessionApiKey = "";
  let currentModel = DEFAULT_MODEL;
  let currentLatencyMode = DEFAULT_LATENCY_MODE;
  let playbackSuspended = false;
  let lastPlaybackSequence = 0;

  function resolveTranscriptionContext(showId, episodeNumber) {
    const showContext = showId && showId !== "link-click"
      ? transcriptionContext.shows?.[showId] || transcriptionContext
      : transcriptionContext;
    const episodeKey = /^\d+$/.test(String(episodeNumber || "")) ? String(episodeNumber) : null;
    const episodeContext = episodeKey ? showContext.episodes?.[episodeKey] : null;
    const basePrompt = String(showContext.prompt || DEFAULT_TRANSCRIPTION_CONTEXT.prompt).trim();
    const episodePrompt = String(episodeContext?.prompt || "").trim();
    return {
      episodeNumber: episodeKey,
      prompt: [basePrompt, episodeKey ? `Current episode: ${episodeKey}.` : "", episodePrompt].filter(Boolean).join(" "),
      showId: showId || null,
      keywords: [...new Set([...(showContext.keywords || []), ...(episodeContext?.keywords || [])]
        .map((value) => String(value).trim()).filter(Boolean))],
      languages: [...new Set((showContext.languages || ["cmn"])
        .map((value) => String(value).trim().toLowerCase()).filter(Boolean))]
    };
  }

  // Realtime WebSocket State
  let realtimeWs = null;
  let realtimeState = "idle";
  let realtimeSessionConfigured = false;
  let realtimeIntentionalClose = false;
  let realtimePendingCompletions = 0;
  let realtimeUtterances = new Map();
  let realtimeSpeechStartTime = 0;
  let realtimeSpeechActive = false;
  let realtimeHasUncommittedAudio = false;
  let realtimeUncommittedAudioMs = 0;
  let realtimeCommitTimer = null;
  let realtimeLastSendQueueMs = 0;
  const realtimeLastDeltaAt = new Map();
  const realtimeFirstTokenLatency = new Map();

  let activeTransport = null;
  let isStopping = false;
  let lastStatus = "idle";
  let lastStatusError = null;

  // Memory Transcript Cache
  const memoryCache = new Map();

  function computeAudioHash(samples) {
    let hash = 0x811c9dc5;
    const step = Math.max(1, Math.floor(samples.length / 1000));
    for (let i = 0; i < samples.length; i += step) {
      const val = Math.round(samples[i] * 32767) & 0xffff;
      hash ^= val;
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16) + `-${samples.length}`;
  }

  // Rolling PCM Buffer
  let pcmBuffer = [];
  let lastWindowFlushTime = 0;
  let windowMaxRms = 0;
  let isTranscribingChunk = false;
  let httpRequestPromise = null;
  let httpFlushRequested = false;

  function safeErrorMessage(error) {
    let message = error?.message ? String(error.message) : String(error || "Unknown transport error");
    if (sessionApiKey) message = message.split(sessionApiKey).join("[redacted]");
    message = message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    return message.slice(0, 500);
  }

  function sendRuntimeMessage(message) {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch {}
  }

  function normalizeStatus(phase, error) {
    if (error) return "error";
    if (phase === "stopped" || phase === "idle") return "idle";
    if (phase === "connecting") return "starting";
    if (["ready", "committed", "fallback", "audio-worklet-fallback"].includes(phase)) return "active";
    if (phase === "suspended") return "suspended";
    if (["starting", "active", "transcribing", "stopping"].includes(phase)) return phase;
    return liveActive ? "active" : "idle";
  }

  function transportState(phase = lastStatus, error = lastStatusError, extra = {}) {
    const status = normalizeStatus(phase, error);
    return {
      status,
      phase,
      active: !["idle", "error"].includes(status),
      tabId: activeTabId,
      model: currentModel,
      latencyMode: currentLatencyMode,
      transport: activeTransport,
      playbackSuspended,
      error: error ? safeErrorMessage(error) : null,
      ...extra
    };
  }

  function sendStatus(phase, error, extra = {}) {
    lastStatus = phase;
    lastStatusError = error || null;
    const state = transportState(phase, error, extra);
    sendRuntimeMessage({
      type: "ak-mandarin-live-status",
      source: "offscreen",
      state,
      ...state
    });
    return state;
  }

  function downsampleBuffer(buffer, inputRate, outputRate) {
    if (inputRate === outputRate) return buffer;
    const ratio = inputRate / outputRate;
    const newLength = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < result.length) {
      const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffsetBuffer;
    }
    return result;
  }

  function encodeWAV(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    function writeString(offset, str) {
      for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }
    writeString(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); // 16-bit
    writeString(36, "data");
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([view], { type: "audio/wav" });
  }

  function float32ToBase64Pcm16(samples) {
    const buffer = new ArrayBuffer(samples.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  async function transcribeAudioChunk(wavBlob, model) {
    const formData = new FormData();
    formData.append("file", wavBlob, `live-chunk-${Date.now()}.wav`);
    const initialModel = (!model || model === DEFAULT_MODEL) ? HTTP_FALLBACK_MODEL : model;
    formData.append("model", initialModel);
    formData.append("language", "zh");
    formData.append("response_format", "json");
    formData.append("prompt", activeContext.prompt);

    let res;
    try {
      res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionApiKey}`
        },
        body: formData
      });
    } catch (error) {
      throw new Error(`HTTP transcription network error: ${safeErrorMessage(error)}`);
    }

    if (!res.ok && res.status === 404 && initialModel !== "whisper-1") {
      // Automatic fallback if account does not have early access to gpt-4o-transcribe
      formData.set("model", "whisper-1");
      try {
        res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${sessionApiKey}`
          },
          body: formData
        });
      } catch (error) {
        throw new Error(`HTTP transcription fallback network error: ${safeErrorMessage(error)}`);
      }
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      let errMsg = `Transcription failed (${res.status})`;
      try {
        const json = JSON.parse(errText);
        if (json?.error?.message) errMsg = json.error.message;
      } catch {}
      throw new Error(errMsg);
    }

    const data = await res.json();
    return data.text || "";
  }

  function handleLiveTranscriptionResult(rawText, timingInfo = {}) {
    let text = String(rawText || "").trim();
    if (timingInfo.isFinal && text && !/[。！？!?…]$/u.test(text)) text += "。";
    if (!text) return;

    const tTokenStart = performance.now();
    let words = [];
    if (window.MandarinDict?.segmentAndAnnotate) {
      words = window.MandarinDict.segmentAndAnnotate(text);
    } else {
      words = [{ text, pinyin: "", gloss: "" }];
    }
    const tokenizationLatencyMs = Math.round((performance.now() - tTokenStart) * 1000) / 1000;

    const apiLatencyMs = timingInfo.apiLatencyMs || 0;
    const encodeLatencyMs = timingInfo.encodeLatencyMs || 0;
    const audioChunkDurationMs = timingInfo.audioChunkDurationMs || 0;
    const totalPipelineLatencyMs = Math.round((apiLatencyMs + tokenizationLatencyMs + encodeLatencyMs) * 10) / 10;

    const cue = {
      text,
      words,
      isLive: true,
      isDelta: Boolean(timingInfo.isDelta),
      isFinal: Boolean(timingInfo.isFinal),
      itemId: timingInfo.itemId || null,
      timestamp: Date.now(),
      timing: {
        audioChunkDurationMs,
        encodeLatencyMs,
        apiLatencyMs,
        tokenizationLatencyMs,
        capturedAt: timingInfo.capturedAt || ((performance.timeOrigin || 0) + performance.now()),
        firstTokenLatencyMs: timingInfo.firstTokenLatencyMs ?? null,
        deltaGapMs: timingInfo.deltaGapMs ?? null,
        finalizationMs: timingInfo.finalizationMs ?? null,
        localSendQueueMs: timingInfo.localSendQueueMs ?? null,
        receivedAt: timingInfo.receivedAt ?? null,
        totalPipelineLatencyMs
      }
    };

    // Offscreen documents are runtime-only. The service worker owns tab routing.
    sendRuntimeMessage({ type: "ak-mandarin-live-cue", tabId: activeTabId, cue });
  }

  function closeRealtimeSocket() {
    const ws = realtimeWs;
    realtimeWs = null;
    realtimeSessionConfigured = false;
    realtimeIntentionalClose = true;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try { ws.close(1000, "capture stopped"); } catch {}
    }
  }

  function realtimeTimestamp() {
    return (performance.timeOrigin || 0) + performance.now();
  }

  function normalizeLatencyMode(value) {
    return LATENCY_MODES.has(value) ? value : DEFAULT_LATENCY_MODE;
  }

  function handleRealtimeFailure(error) {
    if (realtimeState === "failed" || realtimeState === "closed") return;
    realtimeState = "failed";
    realtimeSessionConfigured = false;
    const message = safeErrorMessage(error);
    if (realtimeWs) closeRealtimeSocket();
    if (liveActive && !isStopping) {
      void switchToHttpFallback(`Realtime transport failed: ${message}`);
    } else {
      sendStatus("error", new Error(`Realtime transport failed: ${message}`));
    }
  }

  function sendRealtimeAudio(entry) {
    if (entry.sentRealtime || activeTransport !== "realtime" || realtimeState !== "ready" || !realtimeWs) return false;
    try {
      const inputRate = audioContext?.sampleRate || 44_100;
      const downsampled24k = downsampleBuffer(entry.samples, inputRate, REALTIME_SAMPLE_RATE);
      realtimeWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: float32ToBase64Pcm16(downsampled24k)
      }));
      entry.sentRealtime = true;
      realtimeLastSendQueueMs = Math.max(0, realtimeTimestamp() - entry.capturedAt);
      realtimeHasUncommittedAudio = true;
      realtimeUncommittedAudioMs += (downsampled24k.length / REALTIME_SAMPLE_RATE) * 1000;
      if (!realtimeSpeechStartTime && entry.rms >= MIN_SPEECH_RMS) {
        realtimeSpeechStartTime = entry.capturedAt;
      }
      return true;
    } catch (error) {
      handleRealtimeFailure(new Error(`Realtime audio send failed: ${safeErrorMessage(error)}`));
      return false;
    }
  }

  function flushRealtimeAudioQueue() {
    if (activeTransport !== "realtime" || realtimeState !== "ready" || !realtimeWs) return;
    for (const entry of pcmBuffer) {
      if (!entry.sentRealtime) sendRealtimeAudio(entry);
      if (activeTransport !== "realtime") return;
    }
    pcmBuffer = pcmBuffer.filter((entry) => !entry.sentRealtime);
  }

  function commitRealtimeTail() {
    if (activeTransport !== "realtime" || realtimeState !== "ready" || !realtimeWs || !realtimeHasUncommittedAudio || realtimeUncommittedAudioMs < MIN_COMMIT_AUDIO_MS) return false;
    try {
      clearTimeout(realtimeCommitTimer);
      realtimeCommitTimer = null;
      realtimeWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      realtimePendingCompletions++;
      realtimeSpeechActive = false;
      realtimeHasUncommittedAudio = false;
      realtimeUncommittedAudioMs = 0;
      sendStatus("committed");
      return true;
    } catch (error) {
      handleRealtimeFailure(new Error(`Realtime final commit failed: ${safeErrorMessage(error)}`));
      return false;
    }
  }

  function scheduleRealtimeIdleCommit() {
    clearTimeout(realtimeCommitTimer);
    realtimeCommitTimer = setTimeout(() => {
      realtimeCommitTimer = null;
      if (!liveActive || playbackSuspended || activeTransport !== "realtime") return;
      commitRealtimeTail();
    }, TURN_IDLE_COMMIT_MS);
  }

  function initRealtimeWebSocket() {
    if (realtimeWs && (realtimeWs.readyState === WebSocket.OPEN || realtimeWs.readyState === WebSocket.CONNECTING)) return;
    if (!sessionApiKey) {
      handleRealtimeFailure(new Error("OpenAI API key is missing."));
      return;
    }

    realtimeState = "connecting";
    realtimeSessionConfigured = false;
    realtimeIntentionalClose = false;
    sendStatus("connecting");

    let ws;
    try {
      const url = "wss://api.openai.com/v1/realtime?intent=transcription";
      ws = new WebSocket(url, ["realtime", `openai-insecure-api-key.${sessionApiKey}`]);
      realtimeWs = ws;
    } catch (error) {
      handleRealtimeFailure(new Error(`Realtime connection could not start: ${safeErrorMessage(error)}`));
      return;
    }

    ws.onopen = () => {
      if (realtimeWs !== ws) return;
      if (realtimeSessionConfigured) return;
      try {
        ws.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
                transcription: {
                  model: currentModel,
                  prompt: activeContext.prompt,
                  keywords: activeContext.keywords,
                  languages: activeContext.languages,
                  delay: currentLatencyMode
                },
                // gpt-live-transcribe streams deltas but currently rejects
                // server VAD. The app commits turns after transcript-delta
                // inactivity so live generation remains intact.
                turn_detection: null
              }
            }
          }
        }));
        // WebSocket preserves message order, so audio sent after session.update
        // is safe even before the asynchronous session.updated acknowledgement.
        realtimeState = "ready";
        realtimeSessionConfigured = true;
        sendStatus("ready");
        flushRealtimeAudioQueue();
      } catch (error) {
        handleRealtimeFailure(new Error(`Realtime session setup failed: ${safeErrorMessage(error)}`));
      }
    };

    ws.onmessage = (event) => {
      if (realtimeWs !== ws) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type === "error") {
          handleRealtimeFailure(new Error(data.error?.message || data.error?.code || "OpenAI returned a Realtime error"));
          return;
        }
        if (data.type === "session.updated") {
          realtimeSessionConfigured = true;
          realtimeState = "ready";
          sendStatus("ready");
          flushRealtimeAudioQueue();
          return;
        }
        if (data.type === "input_audio_buffer.speech_started") {
          realtimeSpeechActive = true;
          if (!realtimeSpeechStartTime) realtimeSpeechStartTime = realtimeTimestamp();
          return;
        }
        if (data.type === "input_audio_buffer.speech_stopped") {
          realtimeSpeechActive = false;
          realtimeHasUncommittedAudio = false;
          realtimePendingCompletions++;
          return;
        }
        if (data.type === "conversation.item.input_audio_transcription.delta") {
          const itemId = data.item_id || "active";
          const priorText = realtimeUtterances.get(itemId) || "";
          const text = priorText + String(data.delta || "");
          realtimeUtterances.set(itemId, text);
          const receivedAt = realtimeTimestamp();
          const previousDeltaAt = realtimeLastDeltaAt.get(itemId) || 0;
          const deltaGapMs = previousDeltaAt ? Math.max(0, receivedAt - previousDeltaAt) : null;
          realtimeLastDeltaAt.set(itemId, receivedAt);
          scheduleRealtimeIdleCommit();
          let firstTokenLatencyMs = realtimeFirstTokenLatency.get(itemId) ?? null;
          if (!priorText) {
            firstTokenLatencyMs = Math.max(0, receivedAt - (realtimeSpeechStartTime || receivedAt));
            realtimeFirstTokenLatency.set(itemId, firstTokenLatencyMs);
          }
          handleLiveTranscriptionResult(text, {
            isDelta: true,
            itemId,
            firstTokenLatencyMs,
            deltaGapMs,
            localSendQueueMs: realtimeLastSendQueueMs,
            receivedAt,
            capturedAt: receivedAt
          });
          return;
        }
        if (data.type === "conversation.item.input_audio_transcription.completed") {
          const itemId = data.item_id || "active";
          const finalTranscript = data.transcript || realtimeUtterances.get(itemId) || "";
          if (finalTranscript) {
            const receivedAt = realtimeTimestamp();
            const lastDeltaAt = realtimeLastDeltaAt.get(itemId) || receivedAt;
            handleLiveTranscriptionResult(finalTranscript, {
              isFinal: true,
              itemId,
              firstTokenLatencyMs: realtimeFirstTokenLatency.get(itemId) ?? null,
              finalizationMs: Math.max(0, receivedAt - lastDeltaAt),
              localSendQueueMs: realtimeLastSendQueueMs,
              receivedAt,
              capturedAt: receivedAt
            });
          }
          realtimeUtterances.delete(itemId);
          realtimeLastDeltaAt.delete(itemId);
          realtimeFirstTokenLatency.delete(itemId);
          realtimePendingCompletions = Math.max(0, realtimePendingCompletions - 1);
          realtimeSpeechStartTime = 0;
        }
      } catch (error) {
        handleRealtimeFailure(new Error(`Realtime response could not be read: ${safeErrorMessage(error)}`));
      }
    };

    ws.onerror = () => {
      if (realtimeWs === ws) handleRealtimeFailure(new Error("Realtime WebSocket connection error."));
    };

    ws.onclose = (event) => {
      if (realtimeWs !== ws) return;
      realtimeWs = null;
      realtimeSessionConfigured = false;
      if (!realtimeIntentionalClose && liveActive && !isStopping) {
        const suffix = event.reason ? `: ${event.reason}` : ` (code ${event.code})`;
        handleRealtimeFailure(new Error(`Realtime WebSocket closed${suffix}`));
      } else {
        realtimeState = "closed";
      }
    };

    // Some embedders expose an already-open socket without dispatching onopen.
    if (ws.readyState === WebSocket.OPEN) ws.onopen();
  }

  async function switchToHttpFallback(reason) {
    if (activeTransport === "http") return;
    activeTransport = "http";
    realtimeState = "failed";
    realtimeSessionConfigured = false;
    // Do not send audio that has already been handed to Realtime a second time.
    pcmBuffer = pcmBuffer.filter((entry) => !entry.sentRealtime);
    closeRealtimeSocket();
    sendStatus("fallback", null, {
      fallbackReason: reason,
      fallbackModel: currentModel === DEFAULT_MODEL ? HTTP_FALLBACK_MODEL : currentModel
    });
    if (liveActive && pcmBuffer.length) await processRollingBuffer(true);
  }

  function flattenPcmBuffer(entries) {
    const totalLength = entries.reduce((total, entry) => total + entry.samples.length, 0);
    const flatSamples = new Float32Array(totalLength);
    let offset = 0;
    for (const entry of entries) {
      flatSamples.set(entry.samples, offset);
      offset += entry.samples.length;
    }
    return flatSamples;
  }

  function processRollingBuffer(force = false) {
    if ((!liveActive && !force) || !pcmBuffer.length) return Promise.resolve(false);

    if (activeTransport === "realtime") {
      if (realtimeWs?.readyState === WebSocket.OPEN && realtimeState !== "ready") {
        realtimeWs.onopen?.();
      }
      if (realtimeState === "ready") {
        flushRealtimeAudioQueue();
        return Promise.resolve(true);
      }
      if (!force) return Promise.resolve(false);
      return switchToHttpFallback("Realtime was not ready when capture stopped.")
        .then(() => processRollingBuffer(true));
    }

    const now = Date.now();
    if (!force && now - lastWindowFlushTime < HTTP_SPEECH_WINDOW_MS) return Promise.resolve(false);
    if (isTranscribingChunk) {
      httpFlushRequested = httpFlushRequested || force;
      return httpRequestPromise || Promise.resolve(false);
    }

    const entries = pcmBuffer;
    pcmBuffer = [];
    const chunkCaptureStartTime = lastWindowFlushTime;
    const chunkCaptureFinishedHighRes = (performance.timeOrigin || 0) + performance.now();
    const inputSampleRate = audioContext?.sampleRate || 44_100;
    const flatSamples = flattenPcmBuffer(entries);
    const audioChunkDurationMs = Math.round((flatSamples.length / inputSampleRate) * 1000 * 10) / 10;
    const hadSpeech = windowMaxRms >= MIN_SPEECH_RMS;
    lastWindowFlushTime = now;
    windowMaxRms = 0;

    if (!hadSpeech && !force) return Promise.resolve(false);

    const tEncodeStart = performance.now();
    const downsampled = downsampleBuffer(flatSamples, inputSampleRate, TARGET_SAMPLE_RATE);
    const encodeLatencyMs = Math.round((performance.now() - tEncodeStart) * 100) / 100;
    const audioHash = computeAudioHash(downsampled);
    if (memoryCache.has(audioHash)) {
      handleLiveTranscriptionResult(memoryCache.get(audioHash), {
        audioChunkDurationMs,
        encodeLatencyMs,
        apiLatencyMs: 0,
        capturedAt: chunkCaptureFinishedHighRes,
        chunkStartTime: chunkCaptureStartTime,
        isFinal: true
      });
      return Promise.resolve(true);
    }

    const wavBlob = encodeWAV(downsampled, TARGET_SAMPLE_RATE);
    isTranscribingChunk = true;
    httpFlushRequested = false;
    sendStatus("transcribing");

    const request = (async () => {
      try {
        const tApiStart = performance.now();
        const text = await transcribeAudioChunk(wavBlob, currentModel);
        const apiLatencyMs = Math.round((performance.now() - tApiStart) * 10) / 10;
        if (liveActive && text) {
          memoryCache.set(audioHash, text);
          handleLiveTranscriptionResult(text, {
            audioChunkDurationMs,
            encodeLatencyMs,
            apiLatencyMs,
            capturedAt: chunkCaptureFinishedHighRes,
            chunkStartTime: chunkCaptureStartTime,
            isFinal: true
          });
        }
        if (liveActive) sendStatus("active");
        return true;
      } catch (error) {
        if (liveActive) sendStatus("error", error, { transport: "http" });
        return false;
      }
    })();

    httpRequestPromise = request.finally(() => {
      isTranscribingChunk = false;
      httpRequestPromise = null;
    });
    return httpRequestPromise;
  }

  function handleIncomingAudioSamples(input) {
    if (!liveActive || playbackSuspended) return;
    const copy = new Float32Array(input.length);
    copy.set(input);

    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      sum += input[i] * input[i];
    }
    const rms = Math.sqrt(sum / input.length);
    if (rms > windowMaxRms) windowMaxRms = rms;

    const entry = {
      samples: copy,
      sentRealtime: false,
      capturedAt: realtimeTimestamp(),
      rms
    };
    if (activeTransport === "realtime") {
      if (!sendRealtimeAudio(entry)) pcmBuffer.push(entry);
      return;
    }
    pcmBuffer.push(entry);

    const durationMs = Date.now() - lastWindowFlushTime;
    if (durationMs >= HTTP_SPEECH_WINDOW_MS) {
      processRollingBuffer(false).catch(() => {});
    }
  }

  async function startOffscreenCapture(streamId, apiKey, model, latencyMode, tabId, showId, episodeNumber) {
    if (liveActive) await stopOffscreenCapture();
    if (!apiKey) throw new Error("OpenAI API key is missing.");
    if (!streamId) throw new Error("Tab audio stream ID is missing.");
    sessionApiKey = apiKey;
    currentModel = model || DEFAULT_MODEL;
    currentLatencyMode = normalizeLatencyMode(latencyMode);
    activeTabId = tabId;
    activeContext = resolveTranscriptionContext(showId, episodeNumber);
    activeTransport = currentModel === DEFAULT_MODEL ? "realtime" : "http";
    playbackSuspended = false;
    lastPlaybackSequence = 0;
    isStopping = false;
    sendStatus("starting");

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId
          }
        },
        video: false
      });

      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      mediaStreamSource = audioContext.createMediaStreamSource(stream);
      mediaStreamSource.connect(audioContext.destination);

      pcmBuffer = [];
      lastWindowFlushTime = Date.now();
      windowMaxRms = 0;
      realtimeUtterances.clear();
      realtimeSpeechStartTime = 0;
      realtimeSpeechActive = false;
      realtimeHasUncommittedAudio = false;
      realtimeUncommittedAudioMs = 0;
      clearTimeout(realtimeCommitTimer);
      realtimeCommitTimer = null;
      realtimeLastSendQueueMs = 0;
      realtimeLastDeltaAt.clear();
      realtimeFirstTokenLatency.clear();
      liveActive = true;

      if (audioContext.audioWorklet) {
        try {
          const workletUrl = chrome.runtime?.getURL ? chrome.runtime.getURL("capture/audio-processor.js") : "audio-processor.js";
          await audioContext.audioWorklet.addModule(workletUrl);
          audioWorkletNode = new AudioWorkletNode(audioContext, "live-audio-processor");
          audioWorkletNode.port.onmessage = (event) => {
            if (event.data) handleIncomingAudioSamples(event.data);
          };
          mediaStreamSource.connect(audioWorkletNode);
          audioWorkletNode.connect(audioContext.destination);
        } catch (error) {
          sendStatus("audio-worklet-fallback", null, { warning: safeErrorMessage(error) });
          audioWorkletNode = null;
        }
      }

      if (!audioWorkletNode) {
        scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
        scriptProcessor.onaudioprocess = (event) => {
          handleIncomingAudioSamples(event.inputBuffer.getChannelData(0));
        };
        mediaStreamSource.connect(scriptProcessor);
        scriptProcessor.connect(audioContext.destination);
      }

      if (activeTransport === "realtime") initRealtimeWebSocket();
      sendStatus("active");
    } catch (error) {
      liveActive = false;
      if (realtimeWs) closeRealtimeSocket();
      sendStatus("error", error);
      await cleanupCaptureResources();
      throw new Error(safeErrorMessage(error));
    }
  }

  async function cleanupCaptureResources() {
    if (audioWorkletNode) {
      audioWorkletNode.port.onmessage = null;
      audioWorkletNode.disconnect();
      audioWorkletNode = null;
    }
    if (scriptProcessor) {
      scriptProcessor.onaudioprocess = null;
      scriptProcessor.disconnect();
      scriptProcessor = null;
    }
    if (mediaStreamSource) {
      mediaStreamSource.disconnect();
      mediaStreamSource = null;
    }
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    const context = audioContext;
    audioContext = null;
    if (context) await context.close().catch(() => {});
    pcmBuffer = [];
    windowMaxRms = 0;
    lastWindowFlushTime = 0;
    realtimeUtterances.clear();
    realtimePendingCompletions = 0;
    realtimeSpeechStartTime = 0;
    realtimeSpeechActive = false;
    realtimeHasUncommittedAudio = false;
    realtimeUncommittedAudioMs = 0;
    clearTimeout(realtimeCommitTimer);
    realtimeCommitTimer = null;
    realtimeLastSendQueueMs = 0;
    realtimeLastDeltaAt.clear();
    realtimeFirstTokenLatency.clear();
    sessionApiKey = "";
  }

  async function waitForRealtimeCompletions(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (realtimePendingCompletions > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function setPlaybackSuspended(suspended, sequence = 0, reason = "playback") {
    const numericSequence = Number(sequence) || 0;
    if (numericSequence && numericSequence < lastPlaybackSequence) return transportState();
    if (numericSequence) lastPlaybackSequence = numericSequence;
    const next = Boolean(suspended);
    if (playbackSuspended === next) return transportState();

    playbackSuspended = next;
    if (next) {
      if (activeTransport === "realtime" && realtimeState === "ready") {
        commitRealtimeTail();
      }
      if (activeTransport === "http" && pcmBuffer.length) await processRollingBuffer(true);
      pcmBuffer = [];
      windowMaxRms = 0;
      sendStatus("suspended", null, { playbackReason: reason });
    } else if (liveActive) {
      lastWindowFlushTime = Date.now();
      sendStatus("active", null, { playbackReason: reason });
    }
    return transportState();
  }

  async function stopOffscreenCapture() {
    if (isStopping) return;
    if (!liveActive && !stream && !audioContext && !realtimeWs) return;
    isStopping = true;
    sendStatus("stopping");
    try {
      // Keep liveActive true while the final HTTP request or Realtime completion arrives.
      if (activeTransport === "realtime" && realtimeState === "ready") {
        flushRealtimeAudioQueue();
        commitRealtimeTail();
        await waitForRealtimeCompletions(1000);
      }
      if (activeTransport === "realtime" && realtimeState !== "ready" && pcmBuffer.length) {
        await switchToHttpFallback("Realtime was not ready when capture stopped.");
      }
      if (activeTransport === "http") {
        while (pcmBuffer.length || httpRequestPromise) {
          const before = pcmBuffer.length;
          await processRollingBuffer(true);
          if (httpRequestPromise) await httpRequestPromise;
          if (pcmBuffer.length && pcmBuffer.length === before && !httpRequestPromise) break;
        }
      }
      liveActive = false;
      sendStatus("stopped");
      closeRealtimeSocket();
      await cleanupCaptureResources();
    } finally {
      isStopping = false;
      activeTransport = null;
      activeTabId = null;
      playbackSuspended = false;
      lastPlaybackSequence = 0;
      currentModel = DEFAULT_MODEL;
      currentLatencyMode = DEFAULT_LATENCY_MODE;
      realtimeState = "idle";
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== "offscreen") return;
    if (message.type === "START_OFFSCREEN_LIVE") {
      startOffscreenCapture(message.streamId, message.apiKey, message.model, message.latencyMode, message.tabId, message.showId, message.episodeNumber)
        .then(() => sendResponse({ ok: true, state: transportState() }))
        .catch((err) => sendResponse({ ok: false, error: safeErrorMessage(err) }));
      return true;
    }
    if (message.type === "STOP_OFFSCREEN_LIVE") {
      stopOffscreenCapture()
        .then(() => sendResponse({ ok: true, state: transportState() }))
        .catch((err) => sendResponse({ ok: false, error: safeErrorMessage(err) }));
      return true;
    }
    if (message.type === "GET_OFFSCREEN_LIVE_STATE") {
      sendResponse({ ok: true, state: transportState() });
      return false;
    }
    if (message.type === "SET_OFFSCREEN_PLAYBACK_STATE") {
      setPlaybackSuspended(Boolean(message.paused || message.ended), message.sequence, message.reason)
        .then((state) => sendResponse({ ok: true, state }))
        .catch((err) => sendResponse({ ok: false, error: safeErrorMessage(err) }));
      return true;
    }
  });
})();
