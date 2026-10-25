/*
 * YouTube URL classification and context-menu URL resolution.
 *
 * Pure functions only, so the same file runs as a classic script in the
 * background page (globalThis.YtdlpYouTube) and under `node --test`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.YtdlpYouTube = api;
  }
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const MAX_URL_LENGTH = 2048;
  const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
  const LIST_ID = /^[A-Za-z0-9_-]{2,64}$/;

  const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);
  const SHORT_HOST = "youtu.be";
  // Embedded players (player menu inside an iframe) run on these hosts at /embed/<id>.
  const EMBED_HOSTS = new Set(["www.youtube.com", "youtube.com", "www.youtube-nocookie.com"]);

  // Match patterns are deliberately broader than the classifier (`*.youtube.com`
  // also covers studio., accounts., ...). The click handler re-validates with
  // classifyYouTubeUrl, so a loose pattern only means a harmless "not a video" notice.
  const LINK_TARGET_PATTERNS = Object.freeze([
    "*://*.youtube.com/watch*",
    "*://*.youtube.com/shorts/*",
    "*://*.youtube.com/playlist*",
    "*://*.youtube.com/live/*",
    "*://youtu.be/*",
  ]);

  const DOCUMENT_PATTERNS = Object.freeze([
    "*://*.youtube.com/watch*",
    "*://*.youtube.com/shorts/*",
    "*://*.youtube.com/playlist*",
    "*://*.youtube.com/live/*",
  ]);

  /**
   * @typedef {object} YouTubeTarget
   * @property {"video" | "shorts" | "live" | "playlist"} kind
   * @property {string} url canonical https URL to hand to yt-dlp
   * @property {string | null} videoId
   * @property {string | null} listId playlist id; may accompany a video
   */

  /**
   * Parses a URL string, rejecting anything that is not plain http(s).
   * @param {unknown} input
   * @returns {URL | null}
   */
  function parseHttpUrl(input) {
    if (typeof input !== "string" || input.length === 0 || input.length > MAX_URL_LENGTH) return null;
    let url;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.port) return null;
    return url;
  }

  /**
   * Reads and validates the `list` query parameter.
   * @param {URL} url
   * @returns {string | null}
   */
  function listIdOf(url) {
    const list = url.searchParams.get("list");
    return list && LIST_ID.test(list) ? list : null;
  }

  /**
   * Builds a watch-style target, keeping a valid `list` so the host can apply
   * --no-playlist / --yes-playlist from the user's setting.
   * @param {string} host canonical host
   * @param {string} videoId
   * @param {string | null} listId
   * @returns {YouTubeTarget}
   */
  function watchTarget(host, videoId, listId) {
    const url = new URL(`https://${host}/watch`);
    url.searchParams.set("v", videoId);
    if (listId) url.searchParams.set("list", listId);
    return { kind: "video", url: url.href, videoId, listId };
  }

  /**
   * Classifies a URL as a downloadable YouTube target.
   *
   * Supports youtube.com (bare, www., m., music.) and youtu.be, with
   * /watch?v=, /shorts/<id>, /live/<id> and /playlist?list=, plus embedded
   * players at /embed/<id> (youtube.com, youtube-nocookie.com). The returned URL
   * is rebuilt from validated parts, which drops tracking parameters and any
   * payload smuggled through other query keys.
   * @param {unknown} input
   * @returns {YouTubeTarget | null} null for anything unsupported or malformed
   */
  function classifyYouTubeUrl(input) {
    const url = parseHttpUrl(input);
    if (!url) return null;
    const host = url.hostname;

    if (host === SHORT_HOST) {
      const match = /^\/([^/]+)\/?$/.exec(url.pathname);
      if (!match || !VIDEO_ID.test(match[1])) return null;
      return watchTarget("www.youtube.com", match[1], listIdOf(url));
    }

    const embed = /^\/embed\/([^/]+)\/?$/.exec(url.pathname);
    if (embed && EMBED_HOSTS.has(host)) {
      return VIDEO_ID.test(embed[1]) ? watchTarget("www.youtube.com", embed[1], listIdOf(url)) : null;
    }

    if (!YOUTUBE_HOSTS.has(host)) return null;
    // music.youtube.com has its own extractor behaviour (album/playlist titles); keep it.
    const canonicalHost = host === "music.youtube.com" ? host : "www.youtube.com";
    const path = url.pathname.replace(/\/+$/, "");

    if (path === "/watch") {
      const videoId = url.searchParams.get("v");
      if (videoId && VIDEO_ID.test(videoId)) return watchTarget(canonicalHost, videoId, listIdOf(url));
      return null;
    }

    if (path === "/playlist") {
      const listId = listIdOf(url);
      if (!listId) return null;
      const target = new URL(`https://${canonicalHost}/playlist`);
      target.searchParams.set("list", listId);
      return { kind: "playlist", url: target.href, videoId: null, listId };
    }

    const segment = /^\/(shorts|live)\/([^/]+)$/.exec(path);
    if (segment && VIDEO_ID.test(segment[2])) {
      const [, kind, videoId] = segment;
      return { kind, url: `https://www.youtube.com/${kind}/${videoId}`, videoId, listId: null };
    }

    return null;
  }

  /**
   * Picks the URL a context-menu click refers to and classifies it.
   *
   * A click on a link always means the link (`linkUrl`), even on a YouTube
   * page. Otherwise (page or video context) the page URL is used, because the
   * video element's `srcUrl` on YouTube is a `blob:` URL yt-dlp cannot fetch.
   * @param {{linkUrl?: string, pageUrl?: string, srcUrl?: string, mediaType?: string}} info
   *   menus.OnClickData
   * @returns {YouTubeTarget | null}
   */
  function resolveContextUrl(info) {
    if (!info || typeof info !== "object") return null;
    if (typeof info.linkUrl === "string" && info.linkUrl !== "") return classifyYouTubeUrl(info.linkUrl);
    return classifyYouTubeUrl(info.pageUrl);
  }

  return Object.freeze({
    MAX_URL_LENGTH,
    LINK_TARGET_PATTERNS,
    DOCUMENT_PATTERNS,
    classifyYouTubeUrl,
    resolveContextUrl,
  });
});
