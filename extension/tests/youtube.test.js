"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyYouTubeUrl, resolveContextUrl, LINK_TARGET_PATTERNS, DOCUMENT_PATTERNS, MAX_URL_LENGTH } =
  require("../shared/youtube.js");

const ID = "dQw4w9WgXcQ";
const LIST = "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf";

test("watch URLs on every supported youtube.com host", () => {
  for (const host of ["youtube.com", "www.youtube.com", "m.youtube.com"]) {
    assert.deepEqual(classifyYouTubeUrl(`https://${host}/watch?v=${ID}`), {
      kind: "video",
      url: `https://www.youtube.com/watch?v=${ID}`,
      videoId: ID,
      listId: null,
    }, host);
  }
});

test("music.youtube.com keeps its host", () => {
  assert.equal(classifyYouTubeUrl(`https://music.youtube.com/watch?v=${ID}`).url, `https://music.youtube.com/watch?v=${ID}`);
  assert.deepEqual(classifyYouTubeUrl(`https://music.youtube.com/playlist?list=${LIST}`), {
    kind: "playlist",
    url: `https://music.youtube.com/playlist?list=${LIST}`,
    videoId: null,
    listId: LIST,
  });
});

test("http, uppercase hosts and trailing slashes are normalized", () => {
  assert.equal(classifyYouTubeUrl(`http://WWW.YouTube.com/watch/?v=${ID}`).url, `https://www.youtube.com/watch?v=${ID}`);
});

test("watch URL with list= keeps the list so the host can apply --no-playlist", () => {
  const result = classifyYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&list=${LIST}&index=3`);
  assert.equal(result.kind, "video");
  assert.equal(result.listId, LIST);
  assert.equal(result.url, `https://www.youtube.com/watch?v=${ID}&list=${LIST}`);
});

test("tracking and unknown parameters are dropped", () => {
  const result = classifyYouTubeUrl(`https://www.youtube.com/watch?feature=share&v=${ID}&si=abc&t=42&pp=x`);
  assert.equal(result.url, `https://www.youtube.com/watch?v=${ID}`);
});

test("youtu.be short links", () => {
  assert.deepEqual(classifyYouTubeUrl(`https://youtu.be/${ID}?si=tracking`), {
    kind: "video",
    url: `https://www.youtube.com/watch?v=${ID}`,
    videoId: ID,
    listId: null,
  });
  assert.equal(classifyYouTubeUrl(`https://youtu.be/${ID}?list=${LIST}`).listId, LIST);
  assert.equal(classifyYouTubeUrl(`https://youtu.be/${ID}/`).videoId, ID);
  assert.equal(classifyYouTubeUrl("https://youtu.be/"), null);
  assert.equal(classifyYouTubeUrl(`https://youtu.be/${ID}/extra`), null);
  assert.equal(classifyYouTubeUrl(`https://www.youtu.be/${ID}`), null);
});

test("shorts and live URLs", () => {
  assert.deepEqual(classifyYouTubeUrl(`https://www.youtube.com/shorts/${ID}`), {
    kind: "shorts",
    url: `https://www.youtube.com/shorts/${ID}`,
    videoId: ID,
    listId: null,
  });
  assert.equal(classifyYouTubeUrl(`https://m.youtube.com/shorts/${ID}/?feature=share`).url, `https://www.youtube.com/shorts/${ID}`);
  assert.deepEqual(classifyYouTubeUrl(`https://youtube.com/live/${ID}?si=x`), {
    kind: "live",
    url: `https://www.youtube.com/live/${ID}`,
    videoId: ID,
    listId: null,
  });
});

test("playlist URLs", () => {
  assert.deepEqual(classifyYouTubeUrl(`https://www.youtube.com/playlist?list=${LIST}&si=x`), {
    kind: "playlist",
    url: `https://www.youtube.com/playlist?list=${LIST}`,
    videoId: null,
    listId: LIST,
  });
  assert.equal(classifyYouTubeUrl("https://www.youtube.com/playlist"), null);
  assert.equal(classifyYouTubeUrl("https://www.youtube.com/playlist?list="), null);
});

test("unsupported YouTube pages are rejected", () => {
  for (const url of [
    "https://www.youtube.com/",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=",
    "https://www.youtube.com/watch?v=short",
    `https://www.youtube.com/watch?v=${ID}x`,
    "https://www.youtube.com/@channel",
    "https://www.youtube.com/feed/subscriptions",
    `https://www.youtube.com/embed/${ID}`,
    `https://www.youtube.com/shorts/${ID}/extra`,
    "https://www.youtube.com/shorts/",
    `https://studio.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/browse/${ID}`,
  ]) {
    assert.equal(classifyYouTubeUrl(url), null, url);
  }
});

test("invalid ids and list ids are rejected or dropped", () => {
  assert.equal(classifyYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgX%3B"), null);
  assert.equal(classifyYouTubeUrl("https://www.youtube.com/watch?v=--exec%20rm"), null);
  assert.equal(classifyYouTubeUrl("https://www.youtube.com/shorts/%2e%2e%2fetc%2fpw"), null);
  assert.equal(classifyYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&list=a;b`).listId, null);
  assert.equal(classifyYouTubeUrl("https://www.youtube.com/playlist?list=$(id)"), null);
});

test("look-alike and non-YouTube hosts are rejected", () => {
  for (const url of [
    `https://evil.com/watch?v=${ID}`,
    `https://youtube.com.evil.com/watch?v=${ID}`,
    `https://evilyoutube.com/watch?v=${ID}`,
    `https://www.youtube.co/watch?v=${ID}`,
    `https://www.youtube.com@evil.com/watch?v=${ID}`,
    `https://user:pw@www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com:8443/watch?v=${ID}`,
    `https://evil.com/?u=https://www.youtube.com/watch?v=${ID}`,
    `https://youtu.be.evil.com/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
  ]) {
    assert.equal(classifyYouTubeUrl(url), null, url);
  }
});

test("non-http schemes and malicious strings are rejected", () => {
  for (const input of [
    "javascript:alert(1)",
    `javascript://www.youtube.com/watch?v=${ID}%0Aalert(1)`,
    "data:text/html,<script>alert(1)</script>",
    `data:text/plain,https://www.youtube.com/watch?v=${ID}`,
    "blob:https://www.youtube.com/6a3f1c2e-0000-4000-8000-000000000000",
    `file:///home/u/watch?v=${ID}`,
    `ftp://www.youtube.com/watch?v=${ID}`,
    `view-source:https://www.youtube.com/watch?v=${ID}`,
    `//www.youtube.com/watch?v=${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    `/watch?v=${ID}`,
    "",
    "   ",
    `https://www.youtube.com/watch?v=${ID}&x=${"a".repeat(MAX_URL_LENGTH)}`,
  ]) {
    assert.equal(classifyYouTubeUrl(input), null, input.slice(0, 80));
  }
});

test("non-string input is rejected", () => {
  for (const input of [undefined, null, 42, {}, [`https://youtu.be/${ID}`], new URL(`https://youtu.be/${ID}`)]) {
    assert.equal(classifyYouTubeUrl(input), null);
  }
});

test("link context resolves linkUrl, on any page", () => {
  const result = resolveContextUrl({
    linkUrl: `https://www.youtube.com/watch?v=${ID}`,
    pageUrl: "https://news.example.org/article",
  });
  assert.equal(result.url, `https://www.youtube.com/watch?v=${ID}`);
});

test("link context prefers the link over a YouTube page", () => {
  const other = "aaaaaaaaaaa";
  const result = resolveContextUrl({
    linkUrl: `https://www.youtube.com/shorts/${other}`,
    pageUrl: `https://www.youtube.com/watch?v=${ID}`,
  });
  assert.equal(result.videoId, other);
});

test("link context with a non-YouTube link does not fall back to the page", () => {
  assert.equal(resolveContextUrl({ linkUrl: "https://example.com/", pageUrl: `https://www.youtube.com/watch?v=${ID}` }), null);
  assert.equal(resolveContextUrl({ linkUrl: "javascript:alert(1)", pageUrl: `https://www.youtube.com/watch?v=${ID}` }), null);
});

test("page context resolves pageUrl", () => {
  assert.equal(resolveContextUrl({ pageUrl: `https://www.youtube.com/watch?v=${ID}&list=${LIST}` }).listId, LIST);
  assert.equal(resolveContextUrl({ pageUrl: `https://www.youtube.com/shorts/${ID}` }).kind, "shorts");
  assert.equal(resolveContextUrl({ pageUrl: `https://www.youtube.com/playlist?list=${LIST}` }).kind, "playlist");
  assert.equal(resolveContextUrl({ pageUrl: "https://example.com/" }), null);
});

test("video context ignores the blob: srcUrl and uses pageUrl", () => {
  const result = resolveContextUrl({
    mediaType: "video",
    srcUrl: "blob:https://www.youtube.com/6a3f1c2e-0000-4000-8000-000000000000",
    pageUrl: `https://m.youtube.com/watch?v=${ID}`,
  });
  assert.equal(result.url, `https://www.youtube.com/watch?v=${ID}`);
});

test("missing or malformed click info resolves to null", () => {
  for (const info of [undefined, null, "x", {}, { pageUrl: 5 }, { linkUrl: "", pageUrl: "" }]) {
    assert.equal(resolveContextUrl(info), null);
  }
});

test("menu match patterns are well formed", () => {
  const pattern = /^\*:\/\/(\*\.)?[a-z0-9.-]+\/\S*$/;
  for (const p of [...LINK_TARGET_PATTERNS, ...DOCUMENT_PATTERNS]) assert.match(p, pattern);
  assert.ok(LINK_TARGET_PATTERNS.includes("*://youtu.be/*"));
  assert.ok(!DOCUMENT_PATTERNS.some((p) => p.includes("youtu.be")), "youtu.be pages redirect; no document pattern needed");
});
