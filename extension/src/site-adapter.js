(function () {
  "use strict";

  const EPISODE_PATH = /^\/watch\/(?:link-click-2e0jm|the-girl-downstairs-9eddv)\/ep-\d+\/?$/;
  const PLAYER_HOSTS = new Set(["vidtube.site", "megaplay.buzz"]);

  function isSupportedPage(location = window.location) {
    return location.hostname === "anikototv.to" && EPISODE_PATH.test(location.pathname);
  }

  function isSupportedPlayerUrl(value) {
    try {
      const url = new URL(value, window.location.href);
      return url.protocol === "https:" && PLAYER_HOSTS.has(url.hostname) && url.pathname.startsWith("/stream/");
    } catch {
      return false;
    }
  }

  function findSupportedPlayerFrame() {
    return [...document.querySelectorAll("iframe")].find((frame) =>
      frame.dataset.akPlayerFrame === "true" || isSupportedPlayerUrl(frame.src)
    ) || null;
  }

  function scoreVideo(video) {
    const rect = video.getBoundingClientRect();
    const visible = rect.width > 200 && rect.height > 100;
    return visible ? rect.width * rect.height : 0;
  }

  function collectVideos(root, videos = []) {
    videos.push(...root.querySelectorAll("video"));
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) collectVideos(element.shadowRoot, videos);
    }
    for (const frame of root.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument) collectVideos(frame.contentDocument, videos);
      } catch {
        // Cross-origin descendants are handled by their own matching content script.
      }
    }
    return videos;
  }

  function findVideo() {
    return collectVideos(document)
      .sort((a, b) => scoreVideo(b) - scoreVideo(a))[0] || null;
  }

  function findPlayer(video) {
    if (!video) return null;
    const candidates = [
      video.closest("[class*='player']"),
      video.closest("[id*='player']"),
      video.parentElement
    ].filter(Boolean);
    const videoRect = video.getBoundingClientRect();
    return candidates.find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width <= videoRect.width * 1.35 && rect.height <= videoRect.height * 1.35;
    }) || video.parentElement;
  }

  function hideLikelyNativeSubtitles(player) {
    if (!player) return () => {};
    const selectors = [
      ".vjs-text-track-display",
      ".jw-captions",
      ".plyr__captions",
      "[class*='subtitle']",
      "[class*='caption']"
    ];
    const changed = [];
    for (const element of player.querySelectorAll(selectors.join(","))) {
      if (element.closest(".ak-mandarin-root")) continue;
      changed.push([element, element.style.visibility]);
      element.style.setProperty("visibility", "hidden", "important");
    }
    return () => changed.forEach(([element, value]) => {
      element.style.visibility = value;
    });
  }

  window.AniKotoMandarinAdapter = {
    isSupportedPage,
    isSupportedPlayerUrl,
    findSupportedPlayerFrame,
    findVideo,
    findPlayer,
    hideLikelyNativeSubtitles
  };
})();
