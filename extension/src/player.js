(function () {
  "use strict";

  if (window.top === window) return;
  if (window.__akMandarinPlayerScriptLoaded) {
    window.parent.postMessage({ type: "ak-mandarin-player-ready" }, "*");
    return;
  }
  window.__akMandarinPlayerScriptLoaded = true;
  const adapter = window.AniKotoMandarinAdapter;
  const isFixture = document.documentElement.dataset.akMandarinPlayerFixture === "true";
  const PARENT_ORIGIN = isFixture ? "http://127.0.0.1:4173" : "https://anikototv.to";
  const STORAGE_KEY = "link-click-ep1-offset-seconds";
  const LIVE_LINE_MAX_CHARS = 16;
  const LIVE_LINE_MIN_SOFT_BREAK_CHARS = 6;
  const LIVE_LINE_MIN_HARD_BREAK_CHARS = 3;
  const PINYIN_INITIALS = ["zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h", "j", "q", "x", "r", "z", "c", "s", "y", "w", ""];
  const PINYIN_FINALS = new Set([
    "a", "ai", "an", "ang", "ao", "e", "ei", "en", "eng", "er", "o", "ong", "ou",
    "i", "ia", "ian", "iang", "iao", "ie", "in", "ing", "iong", "iu",
    "u", "ua", "uai", "uan", "uang", "ue", "ui", "un", "uo",
    "v", "van", "ve", "vn"
  ]);
  const PINYIN_TONELESS = {
    ā: "a", á: "a", ǎ: "a", à: "a", Ā: "a", Á: "a", Ǎ: "a", À: "a",
    ē: "e", é: "e", ě: "e", è: "e", Ē: "e", É: "e", Ě: "e", È: "e",
    ī: "i", í: "i", ǐ: "i", ì: "i", Ī: "i", Í: "i", Ǐ: "i", Ì: "i",
    ō: "o", ó: "o", ǒ: "o", ò: "o", Ō: "o", Ó: "o", Ǒ: "o", Ò: "o",
    ū: "u", ú: "u", ǔ: "u", ù: "u", Ū: "u", Ú: "u", Ǔ: "u", Ù: "u",
    ǖ: "v", ǘ: "v", ǚ: "v", ǜ: "v", ü: "v", Ǖ: "v", Ǘ: "v", Ǚ: "v", Ǜ: "v", Ü: "v"
  };
  let activated = false;
  let activationPromise = null;
  const pendingLiveCues = [];

  function codePoints(text) {
    return Array.from(String(text || ""));
  }

  function codePointSlice(text, start, end) {
    return codePoints(text).slice(start, end).join("");
  }

  function pinyinKey(text) {
    return codePoints(text)
      .map((char) => PINYIN_TONELESS[char] || char.toLowerCase())
      .join("")
      .replace(/[^a-zv]/g, "");
  }

  function isPinyinSyllable(text) {
    if (["m", "n", "ng", "hm", "hng"].includes(text)) return true;
    return PINYIN_INITIALS.some((initial) => text.startsWith(initial) && PINYIN_FINALS.has(text.slice(initial.length)));
  }

  function splitPinyin(pinyin, count, expected = []) {
    const letters = codePoints(pinyin).filter((char) => /[A-Za-zÀ-ɏüÜ]/u.test(char));
    const normalized = letters.map((char) => pinyinKey(char)).join("");
    const expectedKeys = expected.map(pinyinKey);
    const memo = new Map();

    function visit(position, unitIndex) {
      const memoKey = `${position}:${unitIndex}`;
      if (memo.has(memoKey)) return memo.get(memoKey);
      if (unitIndex === count) return position === normalized.length ? { score: 0, parts: [] } : null;

      const unitsLeft = count - unitIndex - 1;
      const maxEnd = Math.min(normalized.length - unitsLeft, position + 7);
      let best = null;
      for (let end = position + 1; end <= maxEnd; end++) {
        const syllable = normalized.slice(position, end);
        if (!isPinyinSyllable(syllable)) continue;
        const rest = visit(end, unitIndex + 1);
        if (!rest) continue;
        const expectedKey = expectedKeys[unitIndex];
        const score = rest.score + 1 + (expectedKey && expectedKey === syllable ? 8 : 0);
        if (!best || score > best.score) {
          best = { score, parts: [letters.slice(position, end).join(""), ...rest.parts] };
        }
      }
      memo.set(memoKey, best);
      return best;
    }

    return visit(0, 0)?.parts || [];
  }

  function pronunciationUnits(word) {
    const textUnits = String(word.text || "").match(/[\p{Script=Han}]|[A-Za-z0-9]+(?:[.'’-][A-Za-z0-9]+)*|[^\p{Script=Han}A-Za-z0-9]/gu) || [];
    const spokenIndexes = textUnits
      .map((text, index) => ({ text, index }))
      .filter(({ text }) => /[\p{Script=Han}A-Za-z0-9]/u.test(text));

    if (!spokenIndexes.length) return textUnits.map((text) => ({ text, pinyin: "" }));
    if (spokenIndexes.length === 1) {
      return textUnits.map((text, index) => ({ text, pinyin: index === spokenIndexes[0].index ? (word.pinyin || "") : "" }));
    }

    const expected = spokenIndexes.map(({ text }) => {
      if (!/\p{Script=Han}/u.test(text)) return text;
      return window.MandarinDict?.segmentAndAnnotate?.(text)?.[0]?.pinyin || "";
    });
    let pinyinParts = splitPinyin(word.pinyin || "", spokenIndexes.length, expected);
    if (pinyinParts.length !== spokenIndexes.length) pinyinParts = expected;

    const pinyinByIndex = new Map(spokenIndexes.map(({ index }, unitIndex) => [index, pinyinParts[unitIndex] || ""]));
    return textUnits.map((text, index) => ({ text, pinyin: pinyinByIndex.get(index) || "" }));
  }

  function findLiveLineBreak(text) {
    const chars = codePoints(text);
    if (chars.length < LIVE_LINE_MIN_HARD_BREAK_CHARS + 1) return 0;
    const searchEnd = Math.min(LIVE_LINE_MAX_CHARS, chars.length - 1);

    for (let i = searchEnd - 1; i >= LIVE_LINE_MIN_HARD_BREAK_CHARS - 1; i--) {
      if (/[。！？!?]/u.test(chars[i])) return i + 1;
    }
    for (let i = searchEnd - 1; i >= LIVE_LINE_MIN_SOFT_BREAK_CHARS - 1; i--) {
      if (/[，、；：,;:]/u.test(chars[i])) return i + 1;
    }
    if (chars.length <= LIVE_LINE_MAX_CHARS) return 0;

    if (window.MandarinDict?.segmentAndAnnotate) {
      const words = window.MandarinDict.segmentAndAnnotate(text);
      let boundary = 0;
      for (const word of words || []) {
        const nextBoundary = boundary + codePoints(word.text).length;
        if (nextBoundary > LIVE_LINE_MAX_CHARS) break;
        boundary = nextBoundary;
      }
      if (boundary > 0 && boundary < chars.length) return boundary;
    }
    return LIVE_LINE_MAX_CHARS;
  }

  function runtimeAvailable() {
    try {
      return Boolean(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id && chrome.runtime.sendMessage);
    } catch {
      return false;
    }
  }

  function sendRuntimeMessage(message) {
    if (!runtimeAvailable()) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  function extensionStorageAvailable() {
    try {
      return Boolean(runtimeAvailable() && chrome.storage?.local);
    } catch {
      return false;
    }
  }

  function storageGet(defaultValue) {
    if (typeof chrome === "undefined" || !extensionStorageAvailable()) return Promise.resolve(defaultValue);
    try {
      return chrome.storage.local.get({ [STORAGE_KEY]: defaultValue })
        .then((result) => Number(result[STORAGE_KEY]))
        .catch(() => defaultValue);
    } catch {
      return Promise.resolve(defaultValue);
    }
  }

  function storageSet(value) {
    if (typeof chrome === "undefined" || !extensionStorageAvailable()) return Promise.resolve();
    try {
      return chrome.storage.local.set({ [STORAGE_KEY]: value }).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  // Anchor dialogue in Link Click Ep 1 for automatic synchronization from native English subtitles
  const DIALOGUE_ANCHORS = [
    { pattern: /paying your debt|landlady|bleed us dry/i, captureTime: 12.0 },
    { pattern: /slacking|shiftless|sorry attitude|all day long/i, captureTime: 17.0 },
    { pattern: /close up shop|pack your things|get lost/i, captureTime: 20.0 },
    { pattern: /grew up|in this shop|with my parents/i, captureTime: 24.0 },
    { pattern: /won't go|before they return/i, captureTime: 27.0 },
    { pattern: /hang myself|drive me out/i, captureTime: 29.5 },
    { pattern: /childish/i, captureTime: 33.7 },
    { pattern: /idiot/i, captureTime: 35.0 },
    { pattern: /what did he just say/i, captureTime: 38.2 },
    { pattern: /financial report|third-quarter|quede/i, captureTime: 62.5 },
    { pattern: /core financial data|ahead of time/i, captureTime: 65.5 },
    { pattern: /avoid the system being hacked|hacked/i, captureTime: 74.0 },
    { pattern: /assistant.*emma|emma/i, captureTime: 87.5 }
  ];

  async function activate(cueData) {
    if (activated) return;
    activated = true;
    window.parent.postMessage({ type: "ak-mandarin-player-activated" }, PARENT_ORIGIN);
    const hasPreloadedCues = cueData.hasPreloadedCues !== false && Array.isArray(cueData.cues) && cueData.cues.length > 0;
    const defaultOffset = isFixture || !hasPreloadedCues ? 0 : Number(cueData.alignment?.defaultEpisodeOffsetSeconds ?? 124);
    const state = {
      video: null,
      player: null,
      cues: Array.isArray(cueData.cues) ? cueData.cues : [],
      hasPreloadedCues,
      cueIndex: -1,
      hoverTimer: null,
      activeWord: null,
      pausedByHover: false,
      blockUntilLeave: false,
      restoreNativeSubtitles: null,
      autoSynced: false,
      boundDocuments: new WeakSet(),
      liveStatus: "idle",
      liveError: null,
      boundVideoHandlers: null,
      timelineStalled: false,
      timelineAnchorSequence: 0,
      seenLiveCueKeys: new Set(),
      liveCaption: {
        activeItemId: null,
        activeText: "",
        rolledChars: 0,
        stableText: "",
        itemTexts: new Map()
      },
      videoResizeObserver: new ResizeObserver(positionOverlay),
      offsetSeconds: await storageGet(defaultOffset)
    };

    function postTimelineAnchor(reason = "periodic") {
      const video = state.video;
      if (!video) return false;
      const playerTimeSeconds = Number(video.currentTime);
      if (!Number.isFinite(playerTimeSeconds)) return false;
      const durationSeconds = Number(video.duration);
      const observedAtEpochMs = Date.now();
      const sequence = ++state.timelineAnchorSequence;
      window.parent.postMessage({
        type: "ak-mandarin-player-timeline-anchor",
        anchor: {
          schemaVersion: 1,
          anchorId: `${observedAtEpochMs}-${sequence}`,
          sequence,
          reason: String(reason || "periodic"),
          observedAtEpochMs,
          playerTimeSeconds: Math.round(playerTimeSeconds * 1000) / 1000,
          durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0
            ? Math.round(durationSeconds * 1000) / 1000
            : null,
          playbackRate: Number(video.playbackRate) || 1,
          paused: Boolean(video.paused),
          stalled: Boolean(state.timelineStalled),
          ended: Boolean(video.ended),
          readyState: Number(video.readyState) || 0
        }
      }, PARENT_ORIGIN);
      return true;
    }

    const root = document.createElement("div");
    root.className = "ak-mandarin-root";
    root.setAttribute("aria-live", "off");
    root.innerHTML = `
      <div class="ak-mandarin-scrim"></div>
      <div class="ak-mandarin-line" aria-label="Interactive Mandarin subtitles"></div>
      <div class="ak-pause-hint">Paused · Space to resume</div>
      <div class="ak-overlay-status"></div>
      <div class="ak-sync-panel">
        <span class="ak-live-indicator"><span class="ak-live-dot"></span><span class="ak-sync-state"></span></span>
        <button type="button" data-mode aria-label="Toggle subtitle source">Mode: Live</button>
        <button type="button" data-adjust="-0.5" class="ak-offset-ctrl" aria-label="Show subtitles half a second earlier">−0.5</button>
        <button type="button" data-sync class="ak-offset-ctrl" aria-label="Align the first Mandarin cue to the current video time">Sync first line</button>
        <button type="button" data-adjust="0.5" class="ak-offset-ctrl" aria-label="Show subtitles half a second later">+0.5</button>
      </div>`;
    root.style.display = "none";

    const line = root.querySelector(".ak-mandarin-line");
    const pauseHint = root.querySelector(".ak-pause-hint");
    const syncState = root.querySelector(".ak-sync-state");
    const modeBtn = root.querySelector("[data-mode]");
    const liveDot = root.querySelector(".ak-live-dot");
    const overlayStatus = root.querySelector(".ak-overlay-status");
    state.liveMode = !isFixture || !state.hasPreloadedCues;

    function showOverlayToast(text, durationMs = 3000) {
      if (!overlayStatus) return;
      overlayStatus.textContent = text;
      overlayStatus.classList.add("ak-visible");
      clearTimeout(state.toastTimer);
      state.toastTimer = setTimeout(() => {
        overlayStatus.classList.remove("ak-visible");
      }, durationMs);
    }

    function updateSyncState(message) {
      const offsetCtrls = root.querySelectorAll(".ak-offset-ctrl");
      if (modeBtn) modeBtn.style.display = state.hasPreloadedCues ? "inline-flex" : "none";
      if (state.liveMode) {
        offsetCtrls.forEach((btn) => { btn.style.display = "none"; });
        if (modeBtn) modeBtn.textContent = "Mode: Live";
        if (message) {
          syncState.textContent = message;
        } else if (state.liveError) {
          syncState.textContent = `Live ASR Error: ${state.liveError}`;
          liveDot?.classList.add("error");
        } else if (state.liveStatus === "starting") {
          syncState.textContent = "Starting Live ASR…";
          liveDot?.classList.remove("paused");
          liveDot?.classList.add("transcribing");
        } else if (state.liveStatus === "transcribing") {
          syncState.textContent = "Live ASR Transcribing…";
          liveDot?.classList.remove("paused", "error");
        } else if (state.liveStatus === "suspended") {
          syncState.textContent = "Live ASR Suspended · no audio sent";
          liveDot?.classList.add("paused");
          liveDot?.classList.remove("error", "transcribing");
        } else if (state.liveStatus === "active") {
          if (state.video && state.video.paused) {
            syncState.textContent = "Live ASR Active · video paused";
            liveDot?.classList.add("paused");
          } else {
            syncState.textContent = "Live ASR Active";
            liveDot?.classList.remove("paused", "error");
          }
        } else {
          syncState.textContent = "Live ASR Ready · start from extension popup";
          liveDot?.classList.add("paused");
        }
      } else {
        offsetCtrls.forEach((btn) => { btn.style.display = "inline-flex"; });
        if (modeBtn) modeBtn.textContent = "Mode: Pre-loaded";
        syncState.textContent = message || `Mandarin · offset +${state.offsetSeconds.toFixed(1)}s`;
        liveDot?.classList.add("paused");
      }
    }

    function applyLiveState(snapshot) {
      if (!snapshot) return;
      state.liveStatus = snapshot.status || (snapshot.active ? "active" : "idle");
      state.liveError = snapshot.error || null;
      updateSyncState();
      if (state.liveError) liveDot?.classList.add("error");
    }

    function refreshLiveState() {
      sendRuntimeMessage({ type: "GET_LIVE_STATE" }).then((response) => {
        if (response?.state) applyLiveState(response.state);
      }).catch(() => {});
    }

    function positionOverlay() {
      if (!state.video) return;
      const rect = state.video.getBoundingClientRect();
      Object.assign(root.style, {
        left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
        display: rect.width > 0 && rect.height > 0 ? "block" : "none"
      });
    }

    function mountOverlay() {
      if (!state.video) return;
      const targetDocument = state.video.ownerDocument;
      const fullscreenElement = targetDocument.fullscreenElement || targetDocument.webkitFullscreenElement;
      const host = fullscreenElement && fullscreenElement !== state.video
        ? fullscreenElement
        : targetDocument.body;
      if (host && root.parentElement !== host) host.appendChild(root);
      positionOverlay();
    }

    function closeWord() {
      clearTimeout(state.hoverTimer);
      state.hoverTimer = null;
      state.activeWord?.classList.remove("ak-active");
      state.activeWord = null;
    }

    function endWordInteraction({ resume = true } = {}) {
      const shouldResume = resume && state.pausedByHover;
      state.pausedByHover = false;
      closeWord();
      pauseHint.classList.remove("ak-visible");
      if (shouldResume) state.video?.play().catch(() => {});
    }

    function showWord(button) {
      if (state.blockUntilLeave || !state.video) return;
      if (!state.video.paused) {
        state.video.pause();
        state.pausedByHover = true;
      }
      state.activeWord = button;
      button.classList.add("ak-active");
      pauseHint.classList.add("ak-visible");
    }

    function attachWordEvents(button) {
      button.addEventListener("mouseenter", () => {
        if (state.blockUntilLeave) return;
        clearTimeout(state.hoverTimer);
        state.hoverTimer = setTimeout(() => showWord(button), 200);
      });
      button.addEventListener("mouseleave", (event) => {
        const movedToAnotherWord = Boolean(event.relatedTarget?.closest?.(".ak-mandarin-word"));
        if (movedToAnotherWord) closeWord();
        else endWordInteraction();
        state.blockUntilLeave = false;
      });
      button.addEventListener("focus", () => showWord(button));
      button.addEventListener("blur", () => endWordInteraction());
    }

    function appendWordButtons(target, words, { animateFromChar = null } = {}) {
      let characterCursor = 0;
      for (const word of words) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ak-mandarin-word";
        button.setAttribute("aria-label", `${word.text}, ${word.pinyin || ""}, ${word.gloss || ""}`);
        const wordLength = codePoints(word.text).length;
        if (animateFromChar !== null && characterCursor + wordLength > animateFromChar) {
          button.classList.add("ak-delta-arrival");
        }
        characterCursor += wordLength;

        const unitsSpan = document.createElement("span");
        unitsSpan.className = "ak-mandarin-units";
        for (const unit of pronunciationUnits(word)) {
          const unitSpan = document.createElement("span");
          unitSpan.className = "ak-mandarin-unit";

          const pinyinSpan = document.createElement("span");
          pinyinSpan.className = "ak-mandarin-pinyin";
          pinyinSpan.textContent = unit.pinyin;

          const textSpan = document.createElement("span");
          textSpan.className = "ak-mandarin-text";
          textSpan.textContent = unit.text;

          unitSpan.appendChild(pinyinSpan);
          unitSpan.appendChild(textSpan);
          unitsSpan.appendChild(unitSpan);
        }

        const glossSpan = document.createElement("span");
        glossSpan.className = "ak-mandarin-gloss";
        glossSpan.textContent = word.gloss || "";

        button.appendChild(unitsSpan);
        button.appendChild(glossSpan);

        attachWordEvents(button);
        target.appendChild(button);
      }
    }

    function renderWordButtons(words) {
      line.replaceChildren();
      line.classList.remove("ak-live-rollup");
      if (!words || !words.length) {
        root.classList.remove("ak-has-cue");
        return;
      }
      root.classList.add("ak-has-cue");
      appendWordButtons(line, words);
    }

    function annotateText(text) {
      if (!text) return [];
      if (window.MandarinDict?.segmentAndAnnotate) return window.MandarinDict.segmentAndAnnotate(text);
      return [{ text, pinyin: "", gloss: "" }];
    }

    function renderLiveRows(stableText, liveText, animateFromChar = null) {
      line.replaceChildren();
      line.classList.add("ak-live-rollup");
      for (const [kind, text] of [["stable", stableText], ["active", liveText]]) {
        if (!text) continue;
        const row = document.createElement("div");
        row.className = `ak-live-caption-row ak-live-caption-row-${kind}`;
        appendWordButtons(row, annotateText(text), {
          animateFromChar: kind === "active" ? animateFromChar : null
        });
        line.appendChild(row);
      }
      root.classList.toggle("ak-has-cue", Boolean(stableText || liveText));
    }

    function advanceLiveCaption(cue) {
      const caption = state.liveCaption;
      const itemId = String(cue.itemId || cue.item_id || `cue-${cue.timestamp || Date.now()}`);
      const text = String(cue.text || "").trim();

      // A completion for an older committed turn may arrive after the next turn has
      // already started. Reconcile it in memory without replacing newer text.
      if (caption.activeItemId !== itemId && caption.itemTexts.has(itemId)) {
        caption.itemTexts.set(itemId, text);
        return {
          stableText: caption.stableText,
          liveText: codePointSlice(caption.activeText, caption.rolledChars).trim()
        };
      }

      if (caption.activeItemId !== itemId) {
        const previousTail = codePointSlice(caption.activeText, caption.rolledChars).trim();
        if (previousTail) caption.stableText = previousTail;
        caption.activeItemId = itemId;
        caption.activeText = "";
        caption.rolledChars = 0;
      }

      const committedPrefix = codePointSlice(caption.activeText, 0, caption.rolledChars);
      if (caption.rolledChars && !text.startsWith(committedPrefix)) caption.rolledChars = 0;
      caption.activeText = text;
      caption.itemTexts.set(itemId, text);
      if (caption.itemTexts.size > 32) caption.itemTexts.delete(caption.itemTexts.keys().next().value);

      let liveText = codePointSlice(text, caption.rolledChars).trimStart();
      let breakAt = findLiveLineBreak(liveText);
      while (breakAt > 0) {
        const stableText = codePointSlice(liveText, 0, breakAt).trim();
        if (stableText) caption.stableText = stableText;
        caption.rolledChars += breakAt;
        liveText = codePointSlice(text, caption.rolledChars).trimStart();
        breakAt = findLiveLineBreak(liveText);
      }

      return { stableText: caption.stableText, liveText };
    }

    function renderCue(index) {
      if (state.cueIndex === index) return;
      closeWord();
      state.cueIndex = index;
      const cue = state.cues[index];
      renderWordButtons(cue?.words);
    }

    function updateCue() {
      if (!state.video || state.liveMode) return;
      const captureTime = state.video.currentTime - state.offsetSeconds;
      const index = state.cues.findIndex((cue, i) => {
        const nextCue = state.cues[i + 1];
        const minLinger = 3.0;
        const maxLingerEnd = nextCue ? Math.min(cue.start + minLinger, nextCue.start - 0.1) : cue.start + minLinger;
        const effectiveEnd = Math.max(cue.end, maxLingerEnd);
        return captureTime >= cue.start && captureTime < effectiveEnd;
      });
      renderCue(index);
    }

    function checkNativeSubtitleSync(text, time) {
      if (!text || state.autoSynced || isFixture || state.liveMode) return;
      for (const anchor of DIALOGUE_ANCHORS) {
        if (anchor.pattern.test(text)) {
          const detected = Math.round((time - anchor.captureTime) * 10) / 10;
          if (detected > 20 && detected < 900) {
            state.autoSynced = true;
            setOffset(detected, `Auto-synced: +${detected.toFixed(1)}s`);
            break;
          }
        }
      }
    }

    function setupNativeSubtitleObserver(video) {
      if (isFixture) return;
      try {
        if (video.textTracks) {
          for (let i = 0; i < video.textTracks.length; i++) {
            const track = video.textTracks[i];
            track.addEventListener("cuechange", () => {
              if (track.activeCues) {
                for (let j = 0; j < track.activeCues.length; j++) {
                  const c = track.activeCues[j];
                  checkNativeSubtitleSync(c.text, c.startTime || video.currentTime);
                }
              }
            });
          }
        }
        if (state.player) {
          const domObserver = new MutationObserver(() => {
            if (state.autoSynced) {
              domObserver.disconnect();
              return;
            }
            const text = state.player.textContent || "";
            checkNativeSubtitleSync(text, video.currentTime);
          });
          domObserver.observe(state.player, { childList: true, subtree: true, characterData: true });
        }
      } catch {
        // Observer fail-open
      }
    }

    function bindVideo(video) {
      if (state.video === video) return;
      for (const eventName of ["timeupdate", "seeked", "loadedmetadata"]) {
        state.video?.removeEventListener(eventName, updateCue);
      }
      if (state.video && state.boundVideoHandlers) {
        for (const [eventName, handler] of Object.entries(state.boundVideoHandlers)) {
          state.video.removeEventListener(eventName, handler);
        }
      }
      state.restoreNativeSubtitles?.();
      state.video = video;
      mountOverlay();
      bindInteractionDocument(video.ownerDocument);
      state.videoResizeObserver.disconnect();
      state.videoResizeObserver.observe(video);
      state.player = adapter.findPlayer(video);
      state.restoreNativeSubtitles = adapter.hideLikelyNativeSubtitles(state.player);
      for (const event of ["timeupdate", "seeked", "loadedmetadata"]) video.addEventListener(event, updateCue);
      state.timelineStalled = false;
      state.boundVideoHandlers = {
        play: () => {
          state.timelineStalled = false;
          if (state.liveMode) refreshLiveState();
          postTimelineAnchor("play");
        },
        pause: () => {
          if (state.liveMode) updateSyncState("Live ASR Suspending · video paused");
          postTimelineAnchor("pause");
        },
        seeking: () => postTimelineAnchor("seeking"),
        seeked: () => postTimelineAnchor("seeked"),
        ratechange: () => postTimelineAnchor("ratechange"),
        waiting: () => {
          state.timelineStalled = true;
          postTimelineAnchor("waiting");
        },
        stalled: () => {
          state.timelineStalled = true;
          postTimelineAnchor("stalled");
        },
        playing: () => {
          state.timelineStalled = false;
          postTimelineAnchor("playing");
        },
        loadedmetadata: () => postTimelineAnchor("loadedmetadata"),
        ended: () => postTimelineAnchor("ended")
      };
      for (const [eventName, handler] of Object.entries(state.boundVideoHandlers)) {
        video.addEventListener(eventName, handler);
      }
      setupNativeSubtitleObserver(video);
      positionOverlay();
      if (state.liveMode) {
        refreshLiveState();
      } else {
        updateCue();
      }
      updateSyncState();
      window.parent.postMessage({ type: "ak-mandarin-player-connected", offsetSeconds: state.offsetSeconds }, PARENT_ORIGIN);
      postTimelineAnchor("video-bound");
    }

    function discoverVideo() {
      const video = adapter.findVideo();
      if (video) bindVideo(video);
      else updateSyncState("Mandarin connected · waiting for video");
    }

    async function setOffset(value, message) {
      state.offsetSeconds = Math.round(value * 1000) / 1000;
      await storageSet(state.offsetSeconds);
      state.cueIndex = -2;
      updateCue();
      updateSyncState(message || `Mandarin · offset +${state.offsetSeconds.toFixed(1)}s`);
      window.parent.postMessage({ type: "ak-mandarin-player-connected", offsetSeconds: state.offsetSeconds }, PARENT_ORIGIN);
    }

    try {
      if (extensionStorageAvailable()) {
        chrome.storage.local.get("subtitle_mode").then((data) => {
          if (data.subtitle_mode === "preloaded" && state.hasPreloadedCues) {
            state.liveMode = false;
            updateSyncState();
          }
        }).catch(() => {});
        chrome.storage.onChanged?.addListener((changes, area) => {
          if (area === "local" && changes.subtitle_mode) {
            state.liveMode = !state.hasPreloadedCues || changes.subtitle_mode.newValue !== "preloaded";
            updateSyncState();
          }
        });
      }
    } catch {}

    modeBtn?.addEventListener("click", () => {
      if (!state.hasPreloadedCues) return;
      state.liveMode = !state.liveMode;
      const newMode = state.liveMode ? "live" : "preloaded";
      if (extensionStorageAvailable()) {
        chrome.storage.local.set({ subtitle_mode: newMode }).catch(() => {});
      }
      updateSyncState();
      if (state.liveMode) {
        showOverlayToast("● Live ASR selected · start capture from the extension popup", 3500);
        refreshLiveState();
      } else {
        showOverlayToast("Switched to Pre-loaded Subtitles", 2500);
        if (runtimeAvailable()) sendRuntimeMessage({ type: "ak-mandarin-auto-stop-live" });
        state.cueIndex = -2;
        updateCue();
      }
    });

    root.querySelector("[data-sync]").addEventListener("click", () => {
      if (!state.video || !state.cues.length) return;
      setOffset(state.video.currentTime - state.cues[0].start, "Synced first line here");
    });
    for (const button of root.querySelectorAll("[data-adjust]")) {
      button.addEventListener("click", () => setOffset(state.offsetSeconds + Number(button.dataset.adjust)));
    }

    function handleResumeKey(event) {
      if (event.code !== "Space" || !state.pausedByHover) return;
      const tag = event.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || event.target?.isContentEditable) return;
      event.preventDefault();
      state.blockUntilLeave = true;
      endWordInteraction();
    }

    function bindInteractionDocument(targetDocument) {
      if (!targetDocument || state.boundDocuments.has(targetDocument)) return;
      state.boundDocuments.add(targetDocument);
      targetDocument.addEventListener("keydown", handleResumeKey, true);
      const handleFullscreenChange = () => requestAnimationFrame(mountOverlay);
      targetDocument.addEventListener("fullscreenchange", handleFullscreenChange);
      targetDocument.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    }

    bindInteractionDocument(document);

    function renderLiveCue(cue) {
      if (!cue) return;
      const key = cue.id || [cue.timestamp, cue.text, cue.isDelta, cue.isFinal].join("|");
      if (key && state.seenLiveCueKeys.has(key)) return;
      if (key) {
        state.seenLiveCueKeys.add(key);
        if (state.seenLiveCueKeys.size > 256) state.seenLiveCueKeys.delete(state.seenLiveCueKeys.values().next().value);
      }
      const renderStartTime = performance.now();
      closeWord();
      discoverVideo();
      positionOverlay();
      line.replaceChildren();
      root.classList.add("ak-has-cue");
      root.style.display = "block";
      state.cueIndex = -999;

      const incomingItemId = String(cue.itemId || cue.item_id || `cue-${cue.timestamp || Date.now()}`);
      const sameActiveItem = state.liveCaption.activeItemId === incomingItemId;
      const previousLiveText = sameActiveItem
        ? codePointSlice(state.liveCaption.activeText, state.liveCaption.rolledChars).trimStart()
        : "";
      const { stableText, liveText } = advanceLiveCaption(cue);
      const animateFromChar = cue.isDelta && liveText.startsWith(previousLiveText)
        ? codePoints(previousLiveText).length
        : null;
      renderLiveRows(stableText, liveText, animateFromChar);
      const words = cue.words?.length ? cue.words : annotateText(cue.text || "");

      // Compute render latency and total pipeline delay
      const renderEndTime = performance.now();
      const renderLatencyMs = Math.round((renderEndTime - renderStartTime) * 100) / 100;
      let totalPipelineLatencyMs = cue.timing?.totalPipelineLatencyMs || null;
      if (cue.timing?.capturedAt) {
        const currentEpochHighRes = (performance.timeOrigin || Date.now()) + renderEndTime;
        const diff = currentEpochHighRes - cue.timing.capturedAt;
        if (diff > 0 && diff < 60_000) {
          totalPipelineLatencyMs = Math.round(diff * 10) / 10;
        }
      }

      if (cue.timing) {
        cue.timing.renderLatencyMs = renderLatencyMs;
        cue.timing.totalPipelineLatencyMs = totalPipelineLatencyMs;
      }

      updateSyncState("Live ASR Active");
      liveDot?.classList.remove("paused", "error");

      if (state.video) {
        const start = Math.max(0, state.video.currentTime - state.offsetSeconds);
        state.cues.push({
          start,
          end: start + 3.5,
          text: cue.text,
          words,
          timing: cue.timing
        });
      }

      clearTimeout(state.liveCueTimer);
      state.liveCueTimer = setTimeout(() => {
        if (state.cueIndex === -999 && !state.activeWord && !state.pausedByHover) {
          line.replaceChildren();
          line.classList.remove("ak-live-rollup");
          root.classList.remove("ak-has-cue");
          state.cueIndex = -1;
          updateSyncState();
        }
      }, 4500);
    }

    state.renderLiveCue = renderLiveCue;
    state.applyLiveState = applyLiveState;
    state.postTimelineAnchor = postTimelineAnchor;
    activePlayerState = state;
    while (pendingLiveCues.length) state.renderLiveCue(pendingLiveCues.shift());

    new MutationObserver(discoverVideo).observe(document.documentElement, { childList: true, subtree: true });
    new ResizeObserver(positionOverlay).observe(document.documentElement);
    window.addEventListener("resize", positionOverlay);
    setInterval(discoverVideo, 1500);
    discoverVideo();
  }

  let activePlayerState = null;

  function ensureActivated(cueData) {
    if (activePlayerState) return Promise.resolve();
    if (!activationPromise) {
      activationPromise = activate(cueData).catch(() => {
        activated = false;
        activationPromise = null;
      });
    }
    return activationPromise;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    if (event.data?.type === "ak-mandarin-activate") ensureActivated(event.data.cueData || { cues: [] });
    if (event.data?.type === "ak-mandarin-live-cue" && event.data.cue) {
      if (!activePlayerState) {
        pendingLiveCues.push(event.data.cue);
        if (pendingLiveCues.length > 256) pendingLiveCues.shift();
        ensureActivated({ cues: [], alignment: {} });
      } else {
        activePlayerState.renderLiveCue(event.data.cue);
      }
    }
    if (event.data?.type === "ak-mandarin-request-timeline-anchor") {
      activePlayerState?.postTimelineAnchor?.(event.data.reason || "requested");
    }
    if (event.data?.type === "ak-mandarin-resume") {
      document.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    }
  });

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (["ak-mandarin-live-state", "LIVE_STATE", "OFFSCREEN_LIVE_STATE", "ak-mandarin-live-status", "LIVE_STATUS"].includes(message?.type)) {
        activePlayerState?.applyLiveState?.(message.state || message);
      }
    });
  }

  function announce() {
    window.parent.postMessage({ type: "ak-mandarin-player-ready" }, PARENT_ORIGIN);
  }
  announce();
  const announceTimer = setInterval(() => { if (activated) clearInterval(announceTimer); else announce(); }, 1000);
})();
