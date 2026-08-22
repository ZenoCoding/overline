import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const ROOT = process.cwd();
const OFFSCREEN_PATH = path.join(ROOT, "extension/capture/offscreen.js");
const BACKGROUND_PATH = path.join(ROOT, "extension/src/background.js");
const POPUP_PATH = path.join(ROOT, "extension/capture/popup.js");
const PLAYER_PATH = path.join(ROOT, "extension/src/player.js");
const OUTER_PATH = path.join(ROOT, "extension/src/outer.js");

const offscreenSource = fs.readFileSync(OFFSCREEN_PATH, "utf8");
const popupSource = fs.readFileSync(POPUP_PATH, "utf8");
const playerSource = fs.readFileSync(PLAYER_PATH, "utf8");
const outerSource = fs.readFileSync(OUTER_PATH, "utf8");

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    dispatch(...args) {
      return listeners.map((listener) => listener(...args));
    }
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function dispatchMessage(listeners, message, sender = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sendResponse = (response) => {
      if (!settled) {
        settled = true;
        resolve(response);
      }
    };

    try {
      const returnValues = listeners.map((listener) => listener(message, sender, sendResponse));
      if (!returnValues.includes(true) && !settled) {
        settled = true;
        resolve(returnValues.find((value) => value !== undefined));
      }
    } catch (error) {
      if (!settled) {
        settled = true;
        reject(error);
      }
    }
  });
}

function createAudioContextHarness(audioContexts) {
  class MockAudioContext {
    constructor() {
      this.sampleRate = 44_100;
      this.state = "running";
      this.destination = {};
      this.audioWorklet = undefined;
      this.processor = null;
      audioContexts.push(this);
    }

    async resume() {
      this.state = "running";
    }

    createMediaStreamSource() {
      return {
        connect() {},
        disconnect() {}
      };
    }

    createScriptProcessor() {
      const processor = {
        onaudioprocess: null,
        connect() {},
        disconnect() {}
      };
      this.processor = processor;
      return processor;
    }

    async close() {
      this.state = "closed";
    }
  }

  return MockAudioContext;
}

function createWebSocketHarness() {
  const sockets = [];

  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = MockWebSocket.OPEN;
      this.sent = [];
      sockets.push(this);
    }

    send(payload) {
      this.sent.push(String(payload));
    }

    close() {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  return { MockWebSocket, sockets };
}

async function loadOffscreen({ model, latencyMode, showId, episodeNumber, fetchImpl }) {
  const runtimeOnMessage = createEvent();
  const runtimeMessages = [];
  const audioContexts = [];
  const { MockWebSocket, sockets } = createWebSocketHarness();
  const tracks = [{ stop() {} }];
  let clock = 0;
  const fetchCalls = [];
  const RealDate = Date;
  class TestDate extends RealDate {
    static now() {
      return clock;
    }
  }

  const chrome = {
    runtime: {
      onMessage: runtimeOnMessage,
      getURL: (file) => `chrome-extension://test/${file}`,
      sendMessage: async (message) => {
        runtimeMessages.push(message);
        return { ok: true };
      }
    }
  };

  // A real offscreen document is intentionally denied the tabs API. Reading
  // this property makes the integration harness fail loudly at the exact
  // point where the old popup-to-offscreen migration broke.
  Object.defineProperty(chrome, "tabs", {
    configurable: false,
    get() {
      throw new Error("offscreen document must not access chrome.tabs");
    }
  });

  const MockAudioContext = createAudioContextHarness(audioContexts);
  const stream = {
    getTracks: () => tracks
  };
  const context = vm.createContext({
    chrome,
    window: { AudioContext: MockAudioContext, webkitAudioContext: null, MandarinDict: {
      segmentAndAnnotate: (text) => [{ text, pinyin: "", gloss: "" }]
    } },
    navigator: {
      mediaDevices: {
        getUserMedia: async () => stream
      }
    },
    AudioWorkletNode: class {},
    WebSocket: MockWebSocket,
    Blob,
    FormData,
    ArrayBuffer,
    DataView,
    Float32Array,
    Uint8Array,
    Math,
    JSON,
    Promise,
    String,
    Number,
    Boolean,
    Error,
    Date: TestDate,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    performance,
    fetch: async (...args) => {
      fetchCalls.push(args);
      return fetchImpl(...args);
    },
    console,
    setTimeout,
    clearTimeout
  });

  new vm.Script(offscreenSource, { filename: OFFSCREEN_PATH }).runInContext(context);

  const startResponse = await dispatchMessage(runtimeOnMessage.listeners, {
    target: "offscreen",
    type: "START_OFFSCREEN_LIVE",
    streamId: "stream-1",
    apiKey: "sk-test-key",
    model,
    latencyMode,
    tabId: 42,
    showId,
    episodeNumber
  });
  assert.equal(startResponse?.ok, true, "offscreen capture should start in the VM harness");
  assert.equal(typeof startResponse?.state, "object", "offscreen start should return a structured state snapshot");
  assert.equal(startResponse.state.active, true, "offscreen start state should be active");
  assert.equal(audioContexts.length, 1, "the real offscreen source should create one audio context");
  assert.ok(audioContexts[0].processor?.onaudioprocess, "the real offscreen source should install an audio processor");

  // Let one speech buffer cross the HTTP fallback's 2.5-second window.
  clock = 3_000;
  audioContexts[0].processor.onaudioprocess({
    inputBuffer: {
      getChannelData: () => new Float32Array([0.25, 0.25, 0.25, 0.25])
    }
  });
  await flushMicrotasks();
  await flushMicrotasks();

  return { runtimeOnMessage, runtimeMessages, fetchCalls, sockets, audioContexts };
}

function parseWebSocketMessages(socket) {
  return socket.sent.map((payload) => JSON.parse(payload));
}

async function testOffscreenRuntimeOnlyCueAndStatusEgress() {
  assert.doesNotMatch(
    offscreenSource,
    /\bchrome\s*\.\s*tabs\b/,
    "offscreen source must use runtime messaging; tabs is unavailable in an offscreen document"
  );
  assert.match(
    offscreenSource,
    /chrome\s*\.\s*runtime\s*\.\s*sendMessage/,
    "offscreen source must have a runtime egress for cues/status"
  );

  const result = await loadOffscreen({
    model: "gpt-4o-transcribe",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({ text: "你好" })
    })
  });

  const cues = result.runtimeMessages.filter((message) => message?.type === "ak-mandarin-live-cue");
  assert.equal(cues.length, 1, "one successful audio buffer should produce one runtime cue");
  assert.equal(cues[0].tabId, 42, "cue egress should retain the captured tab id");
  assert.equal(cues[0].cue?.text, "你好。", "final cue should contain the transcription with a sentence boundary");

  const diagnostics = result.runtimeMessages.filter((message) => /status|error/i.test(String(message?.type)));
  assert.ok(diagnostics.length >= 1, "offscreen should expose lifecycle/status information through runtime messaging");
}

async function testRealtimeStreamsWithLowLatencyVad() {
  const result = await loadOffscreen({
    model: "gpt-live-transcribe",
    latencyMode: "medium",
    showId: "link-click",
    episodeNumber: "1",
    fetchImpl: async () => {
      throw new Error("HTTP fallback must not be needed for this realtime test");
    }
  });
  assert.equal(result.sockets.length, 1, "realtime capture should create one WebSocket");
  assert.match(result.sockets[0].url, /intent=transcription$/, "WebSocket must use a dedicated transcription session");
  assert.doesNotMatch(result.sockets[0].url, /[?&]model=/, "transcription session URL must not select a general Realtime model");

  const messages = parseWebSocketMessages(result.sockets[0]);
  const sessionUpdate = messages.find((message) => message.type === "session.update");
  const appends = messages.filter((message) => message.type === "input_audio_buffer.append");
  const commits = messages.filter((message) => message.type === "input_audio_buffer.commit");
  assert.equal(sessionUpdate.session.audio.input.transcription.model, "gpt-live-transcribe");
  assert.equal(sessionUpdate.session.audio.input.transcription.delay, "medium", "the selected latency mode must reach the Realtime session");
  assert.equal(sessionUpdate.session.audio.input.turn_detection, null, "gpt-live-transcribe must retain streaming deltas without unsupported server VAD");
  assert.ok(sessionUpdate.session.audio.input.transcription.keywords.includes("陆光"), "the Realtime session must receive canonical show names");
  assert.ok(sessionUpdate.session.audio.input.transcription.keywords.includes("雀德"), "the Realtime session should hint the shorter fictional company name too");
  assert.ok(sessionUpdate.session.audio.input.transcription.keywords.includes("核心财务数据"), "the Realtime session must receive episode vocabulary");
  assert.deepEqual(Array.from(sessionUpdate.session.audio.input.transcription.languages), ["cmn"], "the Realtime session should identify spoken Mandarin precisely");
  assert.match(sessionUpdate.session.audio.input.transcription.prompt, /Mandarin dialogue.*Link Click/i, "the prompt should describe the recording and setting");
  assert.doesNotMatch(sessionUpdate.session.audio.input.transcription.prompt, /Vocabulary:/i, "literal keyword hints should not be duplicated into the setting prompt");
  assert.equal(commits.length, 0, "the stream should commit only when capture stops");
  assert.equal(appends.length, 1, "each live audio buffer must be streamed exactly once");

  const appendedBytes = Buffer.from(appends[0].audio, "base64").byteLength;
  assert.equal(appendedBytes, 4, "the one four-sample input buffer should be sent exactly once as 16-bit PCM");

  result.audioContexts[0].processor.onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array(4410).fill(0.25) }
  });

  result.sockets[0].onmessage({ data: JSON.stringify({ type: "input_audio_buffer.speech_started" }) });
  result.sockets[0].onmessage({ data: JSON.stringify({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "item-1",
    delta: "你"
  }) });
  result.sockets[0].onmessage({ data: JSON.stringify({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "item-1",
    delta: "好"
  }) });
  await flushMicrotasks();
  const cues = result.runtimeMessages.filter((message) => message?.type === "ak-mandarin-live-cue");
  assert.deepEqual(cues.map((message) => message.cue.text), ["你", "你好"], "deltas must reach the player incrementally");
  assert.ok(cues.every((message) => message.cue.isDelta), "streamed cues must remain marked as deltas");
  assert.ok(cues.every((message) => message.cue.itemId === "item-1"), "streamed cues must retain their Realtime item id");
  assert.ok(cues.every((message) => message.cue.words[0].text === message.cue.text), "capture must retain the complete live utterance for two-line rendering");
  assert.equal(cues[1].cue.timing.firstTokenLatencyMs, cues[0].cue.timing.firstTokenLatencyMs, "first-token timing must persist across later deltas for the same item");
  assert.ok(cues.every((message) => !("streamLagMs" in message.cue.timing)), "Realtime cues must not claim to measure WebSocket stream lag");

  await new Promise((resolve) => setTimeout(resolve, 1250));
  assert.equal(
    parseWebSocketMessages(result.sockets[0]).filter((message) => message.type === "input_audio_buffer.commit").length,
    1,
    "a transcript-delta pause should commit one turn without disabling live deltas"
  );

  result.sockets[0].onmessage({ data: JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item-1",
    transcript: "你好"
  }) });
  await flushMicrotasks();
  const finalCue = result.runtimeMessages.filter((message) => message?.type === "ak-mandarin-live-cue").at(-1)?.cue;
  assert.equal(finalCue.text, "你好。", "a completed turn should gain terminal punctuation when the model omits it");
}

async function testEpisodeSpecificTranscriptionContext() {
  const result = await loadOffscreen({
    model: "gpt-live-transcribe",
    latencyMode: "low",
    showId: "link-click",
    episodeNumber: "2",
    fetchImpl: async () => { throw new Error("HTTP fallback must not be needed"); }
  });
  const messages = parseWebSocketMessages(result.sockets[0]);
  const transcription = messages.find((message) => message.type === "session.update").session.audio.input.transcription;
  assert.ok(transcription.keywords.includes("陆光"), "later episodes retain recurring character names");
  assert.ok(!transcription.keywords.includes("核心财务数据"), "episode 1 vocabulary must not pollute later episodes");
  assert.match(transcription.prompt, /Current episode: 2\./, "the active episode number must reach the transcription prompt");

  const girlResult = await loadOffscreen({
    model: "gpt-live-transcribe",
    latencyMode: "low",
    showId: "the-girl-downstairs",
    episodeNumber: "1",
    fetchImpl: async () => { throw new Error("HTTP fallback must not be needed"); }
  });
  const girlMessages = parseWebSocketMessages(girlResult.sockets[0]);
  const girlTranscription = girlMessages.find((message) => message.type === "session.update").session.audio.input.transcription;
  assert.ok(girlTranscription.keywords.includes("袁君瑭"), "The Girl Downstairs must receive its canonical lead name");
  assert.ok(girlTranscription.keywords.includes("李诗雅"), "The Girl Downstairs must receive its canonical heroine name");
  assert.ok(!girlTranscription.keywords.includes("陆光"), "Link Click names must not leak into The Girl Downstairs");
  assert.match(girlTranscription.prompt, /The Girl Downstairs.*爱上她的理由/i, "the model prompt must identify The Girl Downstairs");
}

async function testPlaybackPauseSuspendsAudioSubmission() {
  const result = await loadOffscreen({
    model: "gpt-live-transcribe",
    fetchImpl: async () => { throw new Error("HTTP fallback must not be needed"); }
  });
  const socket = result.sockets[0];
  const beforePause = parseWebSocketMessages(socket).filter((message) => message.type === "input_audio_buffer.append").length;
  const paused = await dispatchMessage(result.runtimeOnMessage.listeners, {
    target: "offscreen",
    type: "SET_OFFSCREEN_PLAYBACK_STATE",
    paused: true,
    sequence: 10,
    reason: "pause"
  });
  assert.equal(paused?.state?.status, "suspended", "offscreen state should expose billing-safe suspension");
  result.audioContexts[0].processor.onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array([0.4, 0.4, 0.4, 0.4]) }
  });
  const whilePaused = parseWebSocketMessages(socket).filter((message) => message.type === "input_audio_buffer.append").length;
  assert.equal(whilePaused, beforePause, "no audio may be appended while video playback is paused");
  assert.equal(parseWebSocketMessages(socket).filter((message) => message.type === "input_audio_buffer.commit").length, 0, "a sub-100ms buffer should not be committed");

  await dispatchMessage(result.runtimeOnMessage.listeners, {
    target: "offscreen",
    type: "SET_OFFSCREEN_PLAYBACK_STATE",
    paused: false,
    sequence: 11,
    reason: "play"
  });
  result.audioContexts[0].processor.onaudioprocess({
    inputBuffer: { getChannelData: () => new Float32Array([0.4, 0.4, 0.4, 0.4]) }
  });
  const afterResume = parseWebSocketMessages(socket).filter((message) => message.type === "input_audio_buffer.append").length;
  assert.equal(afterResume, beforePause + 1, "audio submission should resume with video playback");

  for (let index = 0; index < 1200; index++) {
    result.audioContexts[0].processor.onaudioprocess({
      inputBuffer: { getChannelData: () => new Float32Array([0.4, 0.4, 0.4, 0.4]) }
    });
  }
  await dispatchMessage(result.runtimeOnMessage.listeners, {
    target: "offscreen",
    type: "SET_OFFSCREEN_PLAYBACK_STATE",
    paused: true,
    sequence: 12,
    reason: "pause"
  });
  assert.equal(
    parseWebSocketMessages(socket).filter((message) => message.type === "input_audio_buffer.commit").length,
    1,
    "pausing should commit a valid buffered partial turn"
  );
}

function createBackgroundHarness() {
  const backgroundSource = fs.readFileSync(BACKGROUND_PATH, "utf8");
  const runtimeOnMessage = createEvent();
  const removed = createEvent();
  const runtimeMessages = [];
  const tabMessages = [];
  let captureRequests = 0;

  const chrome = {
    offscreen: {
      hasDocument: async () => true,
      createDocument: async () => {}
    },
    runtime: {
      onMessage: runtimeOnMessage,
      sendMessage: async (message) => {
        runtimeMessages.push(message);
        return { ok: true };
      }
    },
    storage: {
      local: { get: async () => ({}) },
      session: { get: async () => ({}) }
    },
    tabCapture: {
      getMediaStreamId: async () => {
        captureRequests += 1;
        return `stream-${captureRequests}`;
      }
    },
    tabs: {
      query: async () => [],
      sendMessage: (tabId, message, options) => {
        tabMessages.push({ tabId, message, options });
        return Promise.resolve();
      },
      onRemoved: removed
    },
    webNavigation: {
      getAllFrames: async () => [
        { frameId: 0, url: "https://anikototv.to/watch/link-click-2e0jm/ep-1/" },
        { frameId: 7, url: "https://vidtube.site/embed/player" }
      ]
    },
    scripting: {
      insertCSS: async () => {},
      executeScript: async () => {}
    }
  };

  const context = vm.createContext({
    chrome,
    URL,
    Promise,
    Error,
    Set,
    String,
    Number,
    Boolean,
    Object,
    Array,
    JSON,
    console,
    setTimeout,
    clearTimeout
  });
  new vm.Script(backgroundSource, { filename: BACKGROUND_PATH }).runInContext(context);

  return { runtimeOnMessage, removed, runtimeMessages, tabMessages, getCaptureRequests: () => captureRequests };
}

async function testBackgroundLifecycleAndSingleCueFanout() {
  const harness = createBackgroundHarness();
  const sender = {
    tab: { id: 42 },
    url: "https://anikototv.to/watch/link-click-2e0jm/ep-1/"
  };
  const startMessage = {
    type: "ak-mandarin-auto-start-live",
    tabId: 42,
    apiKey: "sk-test-key",
    model: "gpt-4o-transcribe",
    latencyMode: "low",
    showId: "the-girl-downstairs",
    episodeNumber: "2"
  };

  const episodeTwoConnection = await dispatchMessage(
    harness.runtimeOnMessage.listeners,
    { type: "ak-mandarin-connect-player" },
    { tab: { id: 42 }, url: "https://anikototv.to/watch/link-click-2e0jm/ep-2/" }
  );
  assert.equal(episodeTwoConnection?.ok, true, "numbered Link Click episodes beyond episode 1 must activate the player frame");

  const girlConnection = await dispatchMessage(
    harness.runtimeOnMessage.listeners,
    { type: "ak-mandarin-connect-player" },
    { tab: { id: 42 }, url: "https://anikototv.to/watch/the-girl-downstairs-9eddv/ep-1" }
  );
  assert.equal(girlConnection?.ok, true, "The Girl Downstairs episodes must activate the player frame");

  const unsupportedConnection = await dispatchMessage(
    harness.runtimeOnMessage.listeners,
    { type: "ak-mandarin-connect-player" },
    { tab: { id: 42 }, url: "https://anikototv.to/watch/another-show/ep-2/" }
  );
  assert.equal(unsupportedConnection?.reason, "unsupported-parent", "other shows must remain outside the capture scope");

  const startResponses = await Promise.all([
    dispatchMessage(harness.runtimeOnMessage.listeners, startMessage, sender),
    dispatchMessage(harness.runtimeOnMessage.listeners, startMessage, sender)
  ]);
  assert.ok(startResponses.every((response) => response?.ok), "idempotent starts should both report an active capture");
  assert.equal(harness.getCaptureRequests(), 1, "starting twice for one tab must request tab capture only once");
  assert.equal(
    harness.runtimeMessages.filter((message) => message?.type === "START_OFFSCREEN_LIVE").length,
    1,
    "starting twice must send one offscreen START message"
  );
  assert.equal(
    harness.runtimeMessages.find((message) => message?.type === "START_OFFSCREEN_LIVE")?.latencyMode,
    "low",
    "background must preserve the selected latency mode when starting offscreen capture"
  );
  assert.equal(
    harness.runtimeMessages.find((message) => message?.type === "START_OFFSCREEN_LIVE")?.episodeNumber,
    "2",
    "the active episode number must reach the offscreen transcription owner"
  );
  assert.equal(
    harness.runtimeMessages.find((message) => message?.type === "START_OFFSCREEN_LIVE")?.showId,
    "the-girl-downstairs",
    "the selected show context must reach the offscreen transcription owner"
  );

  harness.removed.dispatch(99);
  await flushMicrotasks();
  assert.equal(
    harness.runtimeMessages.filter((message) => message?.type === "STOP_OFFSCREEN_LIVE").length,
    0,
    "removing an unrelated tab must not stop the captured tab"
  );

  harness.runtimeOnMessage.listeners[0]({
    type: "ak-mandarin-player-timeline-anchor",
    anchor: { paused: true, ended: false, sequence: 12, reason: "pause" }
  }, sender, () => {});
  await flushMicrotasks();
  assert.equal(
    harness.runtimeMessages.filter((message) => message?.type === "SET_OFFSCREEN_PLAYBACK_STATE").length,
    1,
    "a player pause must reach the offscreen audio gate"
  );

  harness.removed.dispatch(42);
  await flushMicrotasks();
  assert.equal(
    harness.runtimeMessages.filter((message) => message?.type === "STOP_OFFSCREEN_LIVE").length,
    1,
    "removing the captured tab must stop live capture"
  );

  const cue = { text: "你好", words: [], isLive: true };
  const cueReturn = harness.runtimeOnMessage.listeners[0](
    { type: "ak-mandarin-live-cue", tabId: 42, cue },
    {},
    () => {}
  );
  assert.equal(cueReturn, false, "cue routing is a one-way fanout message");
  await flushMicrotasks();
  assert.equal(harness.tabMessages.length, 1, "a cue must take one background-to-player path");
  assert.equal(
    JSON.stringify(harness.tabMessages[0].message),
    JSON.stringify({ type: "ak-mandarin-live-cue", tabId: 42, cue }),
    "cue payload should survive the VM boundary unchanged"
  );
}

function testPopupDelegatesLivePipeline() {
  assert.doesNotMatch(popupSource, /\bnew\s+WebSocket\b/, "popup must not retain a second Realtime WebSocket");
  assert.doesNotMatch(popupSource, /input_audio_buffer\.append/, "popup must not append audio to Realtime");
  assert.doesNotMatch(
    popupSource,
    /sendMessage\s*\(\s*\{\s*type:\s*["']ak-mandarin-live-cue["']/,
    "popup may preview cues but must not re-broadcast them"
  );
  assert.match(popupSource, /ak-mandarin-auto-start-live/, "popup must retain the control-plane start request");
  assert.match(popupSource, /ak-mandarin-auto-stop-live/, "popup must retain the control-plane stop request");
  assert.doesNotMatch(popupSource, /Stream lag:/, "popup must not label mixed transcription latency as transport lag");
  assert.doesNotMatch(popupSource, /Delta gap:/, "the compact popup must not expose transcription diagnostics");
  assert.match(popupSource, /openai_latency_mode/, "popup must persist the selected Realtime latency mode");
  assert.match(popupSource, /latencyMode/, "popup must include the selected latency mode in the start request");
  assert.match(popupSource, /DEFAULT_LATENCY_MODE = "low"/, "live captions should default to the documented low-latency preset");
}

function testPlayerDoesNotAutoStartTabCapture() {
  assert.doesNotMatch(
    playerSource,
    /ak-mandarin-auto-start-live/,
    "the page/player cannot start tab capture because Chrome requires a toolbar user gesture"
  );
  assert.match(playerSource, /GET_LIVE_STATE/, "the player should observe the background-owned capture state");
  assert.doesNotMatch(
    playerSource,
    /else if \(state\.video && !state\.video\.paused\)/,
    "video playback alone must not be reported as active transcription"
  );
}

function testLiveCueActivationRaceIsQueued() {
  assert.match(playerSource, /pendingLiveCues\.push\(event\.data\.cue\)/, "player must queue cues received during async activation");
  assert.match(playerSource, /while \(pendingLiveCues\.length\) state\.renderLiveCue/, "player must flush queued cues after activation");
  assert.match(outerSource, /queueOrPostLiveCue\(message\.cue\)/, "outer frame must queue cues until the provider script is ready");
  assert.match(outerSource, /flushPendingLiveCues\(\)/, "outer frame must flush queued cues after the provider announces readiness");
}

function testDeltaArrivalMotionIsScoped() {
  assert.match(playerSource, /ak-delta-arrival/, "player must mark newly appended delta words for arrival feedback");
  assert.match(playerSource, /animateFromChar/, "player must scope arrival feedback to text appended by the latest delta");
}

async function testOffscreenApiErrorsAreVisible() {
  const result = await loadOffscreen({
    model: "gpt-4o-transcribe",
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: "Invalid API key" } }),
      json: async () => ({})
    })
  });

  const diagnostics = result.runtimeMessages.filter((message) => /status|error/i.test(String(message?.type)));
  const diagnosticText = diagnostics.map((message) => JSON.stringify(message)).join(" ");
  assert.match(diagnosticText, /Invalid API key|401/, "API failures must reach the runtime with a useful message");
}

function testMainCheckIsIncluded() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.scripts.check, "node scripts/validate.mjs", "the existing manifest validator remains the main check");
  assert.match(packageJson.scripts.test, /npm run check/, "npm test must run the existing manifest validator");
  assert.match(packageJson.scripts.test, /tests\/live-integration-regression\.mjs/, "integration regressions must be in npm test");

  const check = spawnSync(process.execPath, ["scripts/validate.mjs"], {
    cwd: ROOT,
    encoding: "utf8"
  });
  assert.equal(check.status, 0, `the main check must pass from npm test:\n${check.stdout}\n${check.stderr}`);
}

console.log("Testing live transcription offscreen migration and browser routing regressions...");
testMainCheckIsIncluded();
await testOffscreenRuntimeOnlyCueAndStatusEgress();
await testRealtimeStreamsWithLowLatencyVad();
await testEpisodeSpecificTranscriptionContext();
await testPlaybackPauseSuspendsAudioSubmission();
await testBackgroundLifecycleAndSingleCueFanout();
testPopupDelegatesLivePipeline();
testPlayerDoesNotAutoStartTabCapture();
testLiveCueActivationRaceIsQueued();
testDeltaArrivalMotionIsScoped();
await testOffscreenApiErrorsAreVisible();
console.log("Live integration regressions: PASS (offscreen runtime egress, Realtime buffering, background routing, popup delegation, player gesture boundary, API diagnostics, and main validation covered).");
