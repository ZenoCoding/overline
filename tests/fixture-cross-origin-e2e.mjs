import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

console.log("================================================================================");
console.log("     Cross-Origin Fixture & Interactive Subtitle Overlay E2E Test Suite         ");
console.log("================================================================================");

// Load source scripts
const dictCode = ["extension/src/cedict-data.js", "extension/src/dict.js"]
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
const adapterCode = fs.readFileSync("extension/src/site-adapter.js", "utf8");
const outerCode = fs.readFileSync("extension/src/outer.js", "utf8");
const playerCode = fs.readFileSync("extension/src/player.js", "utf8");
const realData = JSON.parse(fs.readFileSync("extension/data/link-click-ep1.real.json", "utf8"));

// Track all console errors across parent and player frames
const parentConsoleErrors = [];
const playerConsoleErrors = [];

// ============================================================================
// DOM & Event Target Mock Infrastructure
// ============================================================================
class MockKeyboardEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.code = init.code || "";
    this.key = init.key || "";
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
    this.defaultPrevented = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

class MockDOMElement {
  constructor(tagName, ownerDoc) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDoc;
    this.children = [];
    this.parentElement = null;
    this.classList = new Set();
    this.classList.remove = (c) => this.classList.delete(c);
    this.classList.contains = (c) => this.classList.has(c);
    this.classList.toggle = (c, force) => {
      if (force === undefined) {
        if (this.classList.has(c)) this.classList.delete(c);
        else this.classList.add(c);
      } else if (force) {
        this.classList.add(c);
      } else {
        this.classList.delete(c);
      }
    };
    this.style = {
      setProperty: (prop, val, priority) => { this.style[prop] = val; }
    };
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this._textContent = "";
  }

  get className() {
    return Array.from(this.classList).join(" ");
  }
  set className(val) {
    this.classList.clear();
    if (val) val.split(/\s+/).forEach((c) => c && this.classList.add(c));
  }

  get textContent() {
    if (this.children.length > 0) {
      return this.children.map((c) => c.textContent).join("");
    }
    return this._textContent;
  }
  set textContent(val) {
    this.children = [];
    this._textContent = String(val);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  appendChild(child) {
    if (child.parentElement) {
      child.parentElement.children = child.parentElement.children.filter((candidate) => candidate !== child);
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...newChildren) {
    this.children = [];
    this._textContent = "";
    for (const c of newChildren) {
      if (c) {
        c.parentElement = this;
        this.children.push(c);
      }
    }
  }

  addEventListener(event, fn, options) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }
  removeEventListener(event, fn) {
    if (this.listeners.has(event)) {
      this.listeners.set(event, this.listeners.get(event).filter((f) => f !== fn));
    }
  }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    const fns = this.listeners.get(event.type) || [];
    for (const fn of fns) fn(event);
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450 };
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const selectors = selector.split(",").map((s) => s.trim());
    function match(el) {
      for (const sel of selectors) {
        if (sel.startsWith("[class*='") && sel.endsWith("']")) {
          const sub = sel.slice(9, -2);
          if (el.className.includes(sub)) { results.push(el); break; }
        } else if (sel.startsWith(".")) {
          const cls = sel.slice(1);
          if (el.classList.contains(cls)) { results.push(el); break; }
        } else if (sel.startsWith("[") && sel.includes("=")) {
          const m = sel.match(/\[([a-zA-Z0-9_\-]+)=['"]?([^'"\]]*)['"]?\]/);
          if (m && (el.getAttribute(m[1]) === m[2] || el.dataset[m[1].replace(/^data-/, "")] === m[2])) { results.push(el); break; }
        } else if (sel.startsWith("[")) {
          const attr = sel.slice(1, -1);
          if (el.attributes.has(attr) || (el.dataset && el.dataset[attr.replace(/^data-/, "")])) { results.push(el); break; }
        } else if (sel.toLowerCase() === el.tagName.toLowerCase()) {
          results.push(el);
          break;
        }
      }
      for (const c of el.children) match(c);
    }
    for (const c of this.children) match(c);
    return results;
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (selector.startsWith("[class*='") && selector.endsWith("']")) {
        const sub = selector.slice(9, -2);
        if (curr.className.includes(sub)) return curr;
      } else if (selector.startsWith(".")) {
        if (curr.classList.contains(selector.slice(1))) return curr;
      }
      curr = curr.parentElement;
    }
    return null;
  }

  set innerHTML(html) {
    this.children = [];
    this._textContent = "";
    // Simplified parser for our known template markup in player.js
    if (html.includes("ak-mandarin-scrim")) {
      const scrim = new MockDOMElement("div", this.ownerDocument);
      scrim.className = "ak-mandarin-scrim";
      this.appendChild(scrim);

      const line = new MockDOMElement("div", this.ownerDocument);
      line.className = "ak-mandarin-line";
      line.setAttribute("aria-label", "Interactive Mandarin subtitles");
      this.appendChild(line);

      const pauseHint = new MockDOMElement("div", this.ownerDocument);
      pauseHint.className = "ak-pause-hint";
      pauseHint.textContent = "Paused · Space to resume";
      this.appendChild(pauseHint);

      const syncPanel = new MockDOMElement("div", this.ownerDocument);
      syncPanel.className = "ak-sync-panel";

      const syncState = new MockDOMElement("span", this.ownerDocument);
      syncState.className = "ak-sync-state";
      syncPanel.appendChild(syncState);

      const btnMinus = new MockDOMElement("button", this.ownerDocument);
      btnMinus.setAttribute("type", "button");
      btnMinus.dataset.adjust = "-0.5";
      btnMinus.setAttribute("data-adjust", "-0.5");
      btnMinus.textContent = "−0.5";
      syncPanel.appendChild(btnMinus);

      const btnSync = new MockDOMElement("button", this.ownerDocument);
      btnSync.setAttribute("type", "button");
      btnSync.dataset.sync = "true";
      btnSync.setAttribute("data-sync", "true");
      btnSync.textContent = "Sync first line";
      syncPanel.appendChild(btnSync);

      const btnPlus = new MockDOMElement("button", this.ownerDocument);
      btnPlus.setAttribute("type", "button");
      btnPlus.dataset.adjust = "0.5";
      btnPlus.setAttribute("data-adjust", "0.5");
      btnPlus.textContent = "+0.5";
      syncPanel.appendChild(btnPlus);

      this.appendChild(syncPanel);
    }
  }
}

class MockVideoElement extends MockDOMElement {
  constructor(ownerDoc) {
    super("video", ownerDoc);
    this.currentTime = 0;
    this.paused = false;
    this.duration = 100.0;
  }
  play() {
    this.paused = false;
    this.dispatchEvent({ type: "play" });
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent({ type: "pause" });
  }
}

// Global ResizeObserver & MutationObserver mock
class MockResizeObserver {
  observe() {}
  disconnect() {}
}

class MockMutationObserver {
  constructor(cb) { this.cb = cb; }
  observe() {}
  disconnect() {}
}

// ============================================================================
// Create Isolated Parent (4173) and Player (4174) Contexts
// ============================================================================
console.log("Setting up dual-origin cross-frame message bridge...");

const parentWindow = {
  name: "parentWindow",
  location: { href: "http://127.0.0.1:4173/fixture/", hostname: "127.0.0.1", origin: "http://127.0.0.1:4173" },
  listeners: new Map(),
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  },
  postMessage(data, targetOrigin) {
    // Dispatch to parentWindow
    setImmediate(() => {
      parentWindow.dispatchEvent({
        type: "message",
        data,
        origin: playerWindow.location.origin,
        source: playerFrame.contentWindow
      });
    });
  },
  dispatchEvent(event) {
    const fns = this.listeners.get(event.type) || [];
    for (const fn of fns) fn(event);
  }
};
parentWindow.top = parentWindow;
parentWindow.parent = parentWindow;
const observedTimelineAnchors = [];
parentWindow.addEventListener("message", (event) => {
  if (event.data?.type === "ak-mandarin-player-timeline-anchor") {
    observedTimelineAnchors.push(event.data.anchor);
  }
});

const parentDoc = {
  documentElement: {
    dataset: { akMandarinOuterFixture: "true" },
    style: {},
    classList: new Set()
  },
  body: new MockDOMElement("body", null),
  createElement(tag) { return new MockDOMElement(tag, parentDoc); },
  listeners: new Map(),
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  },
  dispatchEvent(event) {
    const fns = this.listeners.get(event.type) || [];
    for (const fn of fns) fn(event);
  },
  querySelectorAll(sel) { return parentDoc.body.querySelectorAll(sel); },
  querySelector(sel) { return parentDoc.body.querySelector(sel); }
};
parentDoc.body.ownerDocument = parentDoc;

// Player Frame Context (4174)
const playerWindow = {
  name: "playerWindow",
  location: { href: "http://127.0.0.1:4174/fixture/player.html", hostname: "127.0.0.1", origin: "http://127.0.0.1:4174" },
  listeners: new Map(),
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  },
  postMessage(data, targetOrigin) {
    // Dispatch to playerWindow
    setImmediate(() => {
      playerWindow.dispatchEvent({
        type: "message",
        data,
        origin: parentWindow.location.origin,
        source: parentWindow
      });
    });
  },
  dispatchEvent(event) {
    const fns = this.listeners.get(event.type) || [];
    for (const fn of fns) fn(event);
  }
};
playerWindow.top = parentWindow; // Top is parent (iframe relationship)
playerWindow.parent = parentWindow;

const playerDoc = {
  documentElement: {
    dataset: { akMandarinPlayerFixture: "true" },
    style: {},
    classList: new Set()
  },
  body: new MockDOMElement("body", null),
  createElement(tag) {
    if (tag === "video") return new MockVideoElement(playerDoc);
    return new MockDOMElement(tag, playerDoc);
  },
  listeners: new Map(),
  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  },
  dispatchEvent(event) {
    const fns = this.listeners.get(event.type) || [];
    for (const fn of fns) fn(event);
  },
  querySelectorAll(sel) { return playerDoc.body.querySelectorAll(sel); },
  querySelector(sel) { return playerDoc.body.querySelector(sel); }
};
playerDoc.body.ownerDocument = playerDoc;

// Setup DOM elements in Player
const playerContainer = new MockDOMElement("div", playerDoc);
playerContainer.className = "player";
const mockVideo = new MockVideoElement(playerDoc);
playerContainer.appendChild(mockVideo);
const fakeCaption = new MockDOMElement("div", playerDoc);
fakeCaption.className = "fake-caption subtitle";
fakeCaption.textContent = "Native English subtitle should be hidden";
playerContainer.appendChild(fakeCaption);
playerDoc.body.appendChild(playerContainer);

// Setup Iframe element in Parent
const playerFrame = new MockDOMElement("iframe", parentDoc);
playerFrame.dataset.akPlayerFrame = "true";
playerFrame.setAttribute("data-ak-player-frame", "true");
playerFrame.src = "http://127.0.0.1:4174/fixture/player.html";
playerFrame.contentWindow = playerWindow;
parentDoc.body.appendChild(playerFrame);

// Mock fetch for parent window to load real cues JSON
const mockFetch = (url) => {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(realData)
  });
};

// ============================================================================
// Execute Extension Scripts in Dual-Origin Environments
// ============================================================================
console.log("Initializing Mandarin Subtitle extension in simulated parent and player frames...");

// 1. Load in Player Frame (4174)
const playerSandbox = {
  window: playerWindow,
  document: playerDoc,
  globalThis: playerWindow,
  ResizeObserver: MockResizeObserver,
  MutationObserver: MockMutationObserver,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  performance: globalThis.performance,
  KeyboardEvent: MockKeyboardEvent,
  WeakSet: globalThis.WeakSet,
  URL: globalThis.URL,
  console: {
    log: (...args) => {},
    error: (...args) => playerConsoleErrors.push(args.join(" ")),
    warn: (...args) => {}
  }
};

new Function(...Object.keys(playerSandbox), dictCode)(...Object.values(playerSandbox));
new Function(...Object.keys(playerSandbox), adapterCode)(...Object.values(playerSandbox));
new Function(...Object.keys(playerSandbox), playerCode)(...Object.values(playerSandbox));

// 2. Load in Parent Frame (4173)
const parentSandbox = {
  window: parentWindow,
  document: parentDoc,
  globalThis: parentWindow,
  ResizeObserver: MockResizeObserver,
  MutationObserver: MockMutationObserver,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  fetch: mockFetch,
  URL: globalThis.URL,
  console: {
    log: (...args) => {},
    error: (...args) => parentConsoleErrors.push(args.join(" ")),
    warn: (...args) => {}
  }
};

new Function(...Object.keys(parentSandbox), dictCode)(...Object.values(parentSandbox));
new Function(...Object.keys(parentSandbox), adapterCode)(...Object.values(parentSandbox));
new Function(...Object.keys(parentSandbox), outerCode)(...Object.values(parentSandbox));

// Give async postMessages and fetch a few ticks to complete handshake
await new Promise((r) => setTimeout(r, 100));

// ============================================================================
// 1. Verify Cross-Origin Connection Handshake & Status Indicator
// ============================================================================
console.log("Verifying cross-origin parent/player activation handshake...");
{
  const statusEl = parentDoc.body.querySelector(".ak-connection-status");
  assert.ok(statusEl, "Parent frame must create .ak-connection-status");
  assert.ok(
    statusEl.classList.contains("ak-connected"),
    `Status should be ak-connected, got: ${statusEl.className} (${statusEl.textContent})`
  );
  assert.match(statusEl.textContent, /Mandarin connected/);

  // Player overlay root
  const root = playerDoc.body.querySelector(".ak-mandarin-root");
  assert.ok(root, "Player frame must render .ak-mandarin-root overlay");

  // Native subtitle hidden verification
  assert.equal(fakeCaption.style.visibility, "hidden", "Native caption container must be hidden");

  console.log("  ✓ Cross-origin handshake and connection status verified.");
}

console.log("Verifying exact player-time anchor messages...");
{
  assert.ok(observedTimelineAnchors.some((anchor) => anchor.reason === "video-bound"), "player activation must publish an initial media-clock anchor");
  mockVideo.currentTime = 42.125;
  mockVideo.playbackRate = 1.25;
  mockVideo.paused = false;
  playerWindow.postMessage({ type: "ak-mandarin-request-timeline-anchor", reason: "capture-start" }, "http://127.0.0.1:4174");
  await new Promise((r) => setTimeout(r, 20));
  const anchor = observedTimelineAnchors.at(-1);
  assert.equal(anchor.reason, "capture-start");
  assert.equal(anchor.playerTimeSeconds, 42.125);
  assert.equal(anchor.playbackRate, 1.25);
  assert.equal(anchor.paused, false);
  assert.ok(Number.isFinite(anchor.observedAtEpochMs));
  console.log("  ✓ Requested player currentTime, playback state, and epoch anchor crossed the iframe boundary.");
}

console.log("Verifying subtitle overlay follows the fullscreen player...");
{
  const root = playerDoc.body.querySelector(".ak-mandarin-root");
  assert.equal(root.parentElement, playerDoc.body, "Overlay starts in the document body");
  playerDoc.fullscreenElement = playerContainer;
  playerDoc.dispatchEvent({ type: "fullscreenchange" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(root.parentElement, playerContainer, "Overlay must move inside the fullscreen subtree");
  playerDoc.fullscreenElement = null;
  playerDoc.dispatchEvent({ type: "fullscreenchange" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(root.parentElement, playerDoc.body, "Overlay returns to the document body after fullscreen exits");
  console.log("  ✓ Overlay stays in the browser-visible fullscreen subtree and returns on exit.");
}

// ============================================================================
// 2. Test Video Seeking & Subtitle Cue Transitions (Ruby Spans, Pinyin, Gloss)
// ============================================================================
console.log("Testing video seeking and subtitle cue rendering...");
{
  const root = playerDoc.body.querySelector(".ak-mandarin-root");
  const line = playerDoc.body.querySelector(".ak-mandarin-line");
  assert.ok(line, ".ak-mandarin-line container must exist");

  // Seek to 12.0s (Cue 0: "老租婆又来吸血喽。")
  mockVideo.currentTime = 12.0;
  mockVideo.dispatchEvent({ type: "timeupdate" });

  assert.ok(root.classList.contains("ak-has-cue"), "Overlay must have .ak-has-cue class");
  assert.equal(line.children.length, 4, "Cue 0 has 4 words in real dataset");

  // Verify word 0
  const word0 = line.children[0];
  assert.ok(word0.classList.contains("ak-mandarin-word"), "Word button must have .ak-mandarin-word");
  const py0 = word0.querySelector(".ak-mandarin-pinyin");
  const text0 = word0.querySelector(".ak-mandarin-text");
  const gloss0 = word0.querySelector(".ak-mandarin-gloss");

  assert.ok(py0 && text0 && gloss0, "Word button must contain pinyin, text, and gloss spans");
  assert.equal(word0.querySelectorAll(".ak-mandarin-text").map((node) => node.textContent).join(""), "老租婆");
  assert.deepEqual(word0.querySelectorAll(".ak-mandarin-pinyin").map((node) => node.textContent), ["lǎo", "zū", "pó"]);
  assert.equal(word0.querySelectorAll(".ak-mandarin-unit").length, 3, "Each Hanzi must have its own aligned pronunciation unit");
  assert.match(gloss0.textContent, /landlady/i);

  // Seek into a gap at 45.0s
  mockVideo.currentTime = 45.0;
  mockVideo.dispatchEvent({ type: "timeupdate" });
  assert.equal(line.children.length, 0, "No words rendered during dialogue gap");
  assert.ok(!root.classList.contains("ak-has-cue"), ".ak-has-cue removed during gap");

  // Seek to Cue 23 at 87.0s ("他的助理：Emma。")
  mockVideo.currentTime = 87.0;
  mockVideo.dispatchEvent({ type: "timeupdate" });
  assert.ok(root.classList.contains("ak-has-cue"));
  assert.ok(line.children.length >= 2);

  const emmaWord = line.children.find((w) => w.querySelector(".ak-mandarin-text")?.textContent.includes("Emma"));
  assert.ok(emmaWord, "Emma word button must be rendered in Cue 23");
  assert.equal(emmaWord.querySelector(".ak-mandarin-pinyin").textContent, "Emma");

  console.log("  ✓ Subtitle cue seeking, word buttons, pinyin, and gloss spans verified.");
}

// ============================================================================
// 3. Test Hover-to-Pause and Pause Hint Visibility
// ============================================================================
console.log("Testing word button hover-to-pause and 200ms debounce timer...");
{
  const pauseHint = playerDoc.body.querySelector(".ak-pause-hint");
  const line = playerDoc.body.querySelector(".ak-mandarin-line");

  // Return to Cue 0
  mockVideo.currentTime = 12.0;
  mockVideo.paused = false;
  mockVideo.dispatchEvent({ type: "timeupdate" });

  const word0 = line.children[0];

  // Dispatch mouseenter (starts 200ms timer)
  word0.dispatchEvent({ type: "mouseenter" });
  assert.equal(mockVideo.paused, false, "Video must NOT pause immediately before debounce threshold");
  assert.ok(!word0.classList.contains("ak-active"), "Word must not become active immediately");

  // Wait 250ms for hover timer to trigger
  await new Promise((r) => setTimeout(r, 250));

  assert.equal(mockVideo.paused, true, "Video must be paused by hover");
  assert.ok(word0.classList.contains("ak-active"), "Word button must have .ak-active class");
  assert.ok(pauseHint.classList.contains("ak-visible"), ".ak-pause-hint must have .ak-visible class");

  word0.dispatchEvent({ type: "mouseleave" });
  assert.equal(mockVideo.paused, false, "Video must resume when the intentional hover ends");
  assert.ok(!word0.classList.contains("ak-active"), "Word button active state must clear on unhover");
  assert.ok(!pauseHint.classList.contains("ak-visible"), "Pause hint must clear on unhover");

  mockVideo.paused = true;
  word0.dispatchEvent({ type: "mouseenter" });
  await new Promise((r) => setTimeout(r, 250));
  word0.dispatchEvent({ type: "mouseleave" });
  assert.equal(mockVideo.paused, true, "Unhover must preserve a video that was already manually paused");
  mockVideo.paused = false;

  console.log("  ✓ Hover-to-pause, unhover resume, and manual-pause preservation verified.");
}

// ============================================================================
// 4. Test Spacebar-to-Resume Navigation
// ============================================================================
console.log("Testing Spacebar-to-resume in player frame and cross-origin parent frame...");
{
  const pauseHint = playerDoc.body.querySelector(".ak-pause-hint");
  const line = playerDoc.body.querySelector(".ak-mandarin-line");
  const word0 = line.children[0];

  word0.dispatchEvent({ type: "mouseenter" });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(mockVideo.paused, true);

  // Press Space in player document
  const spaceEvent = new MockKeyboardEvent("keydown", { code: "Space" });
  spaceEvent.target = playerDoc.body;
  playerDoc.dispatchEvent(spaceEvent);

  assert.equal(mockVideo.paused, false, "Video must resume playback on Spacebar");
  assert.ok(!word0.classList.contains("ak-active"), "Word button active state must be removed");
  assert.ok(!pauseHint.classList.contains("ak-visible"), ".ak-pause-hint visible state must be removed");

  // Test Space pressed in Parent frame (forwards to player frame via cross-origin postMessage)
  // 1. Leave word0 first to clear blockUntilLeave, then re-hover
  word0.dispatchEvent({ type: "mouseleave" });
  word0.dispatchEvent({ type: "mouseenter" });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(mockVideo.paused, true, "Video re-paused on second hover");

  // 2. Dispatch Space in parent document (outer.js forwards 'ak-mandarin-resume' via postMessage)
  const parentSpace = new MockKeyboardEvent("keydown", { code: "Space" });
  parentSpace.target = parentDoc.body;
  parentDoc.dispatchEvent(parentSpace);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(mockVideo.paused, false, "Space in parent frame successfully resumes player video across origin");

  console.log("  ✓ Spacebar-to-resume in player and cross-origin parent verified.");
}

// ============================================================================
// 5. Test Sync Button Offsets (+0.5s, −0.5s, Sync First Line)
// ============================================================================
console.log("Testing sync button adjustments (+0.5s, −0.5s, Sync first line)...");
{
  const syncState = playerDoc.body.querySelector(".ak-sync-state");
  const btnSync = playerDoc.body.querySelector("[data-sync]");
  const btnMinus = playerDoc.body.querySelector("[data-adjust='-0.5']");
  const btnPlus = playerDoc.body.querySelector("[data-adjust='0.5']");

  assert.ok(syncState && btnSync && btnMinus && btnPlus, "All sync panel elements must exist");

  // Click +0.5s button
  btnPlus.dispatchEvent({ type: "click" });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(syncState.textContent, /\+0\.5s/, "Sync state must reflect +0.5s offset");

  // Click +0.5s button again
  btnPlus.dispatchEvent({ type: "click" });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(syncState.textContent, /\+1\.0s/, "Sync state must reflect +1.0s offset");

  // Click −0.5s button
  btnMinus.dispatchEvent({ type: "click" });
  await new Promise((r) => setTimeout(r, 20));
  assert.match(syncState.textContent, /\+0\.5s/, "Sync state must reflect +0.5s offset");

  // Click Sync First Line at video time 15.0s
  mockVideo.currentTime = 15.0;
  btnSync.dispatchEvent({ type: "click" });
  await new Promise((r) => setTimeout(r, 20));
  // offset = 15.0 - cue[0].start (11.4) = 3.6s
  assert.match(syncState.textContent, /Synced first line here/);

  console.log("  ✓ Sync offset adjustments (+0.5, −0.5, Sync first line) verified.");
}

// ============================================================================
// 6. Test Live Transcription Cue Rendering in Player Overlay
// ============================================================================
console.log("Testing live transcription cue message dispatch and rendering...");
{
  const line = playerDoc.body.querySelector(".ak-mandarin-line");
  const syncState = playerDoc.body.querySelector(".ak-sync-state");

  const liveCuePayload = {
    itemId: "item-live-1",
    text: "乔苓姐，我们现在开始准备。",
    words: [
      { text: "乔苓姐，", pinyin: "Qiáo Líng jiě", gloss: "Sister Qiao Ling" },
      { text: "我们", pinyin: "wǒmen", gloss: "we / us" },
      { text: "现在", pinyin: "xiànzài", gloss: "now / currently" },
      { text: "开始", pinyin: "kāishǐ", gloss: "begin / start" },
      { text: "准备。", pinyin: "zhǔnbèi", gloss: "prepare / get ready" }
    ],
    isLive: true,
    timestamp: Date.now(),
    timing: {
      audioChunkDurationMs: 2500,
      encodeLatencyMs: 1.1,
      apiLatencyMs: 410,
      tokenizationLatencyMs: 0.15,
      capturedAt: Date.now() - 415,
      totalPipelineLatencyMs: 411.25
    }
  };

  // Dispatch live cue from parent to player window
  playerWindow.postMessage({ type: "ak-mandarin-live-cue", cue: liveCuePayload }, "http://127.0.0.1:4174");
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(line.children.length, 1, "The first partial utterance should paint immediately on the active row");
  assert.ok(line.children[0].classList.contains("ak-live-caption-row-active"));
  assert.equal(line.children[0].children.length, 5, "Must render 5 live word pills");
  const liveNameWord = line.children[0].children[0];
  assert.equal(liveNameWord.querySelectorAll(".ak-mandarin-text").map((node) => node.textContent).join(""), "乔苓姐，");
  assert.deepEqual(liveNameWord.querySelectorAll(".ak-mandarin-pinyin").map((node) => node.textContent), ["Qiáo", "Líng", "jiě", ""]);
  assert.match(syncState.textContent, /Live ASR/);

  playerWindow.postMessage({
    type: "ak-mandarin-live-cue",
    cue: {
      ...liveCuePayload,
      text: "乔苓姐，我们现在开始准备。大家马上行动吧。",
      words: [],
      isDelta: true,
      timestamp: Date.now() + 1
    }
  }, "http://127.0.0.1:4174");
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(line.children.length, 2, "Completed phrase should roll up while incoming text stays on row two");
  assert.ok(line.children[0].classList.contains("ak-live-caption-row-stable"));
  assert.ok(line.children[1].classList.contains("ak-live-caption-row-active"));
  const visibleText = (row) => row.querySelectorAll(".ak-mandarin-text").map((node) => node.textContent).join("");
  assert.equal(visibleText(line.children[0]), "乔苓姐，我们现在开始准备。");
  assert.equal(visibleText(line.children[1]), "大家马上行动吧。");

  console.log("  ✓ Two-line roll-up live cue rendering and clean live status verified.");
}

// ============================================================================
// 7. Console Errors & Exception Audit
// ============================================================================
console.log("Auditing console errors and uncaught exceptions...");
{
  assert.equal(
    parentConsoleErrors.length,
    0,
    `Parent frame logged console errors: ${parentConsoleErrors.join(", ")}`
  );
  assert.equal(
    playerConsoleErrors.length,
    0,
    `Player frame logged console errors: ${playerConsoleErrors.join(", ")}`
  );
  console.log("  ✓ Zero console errors recorded across parent and player frames.");
}

console.log("================================================================================");
console.log("Fixture Cross-Origin E2E: ALL TESTS PASS (Handshake, seeking, hover, space, sync, live).");
console.log("================================================================================");
process.exit(0);
