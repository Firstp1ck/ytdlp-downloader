"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../shared/downloads.js");

const ID = "0b6e5a52-6f1b-4b7f-9a77-2f1d7c9c0e11";

function entry(overrides = {}) {
  return { ...d.createEntry({ id: ID, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", mode: "video", now: 1 }), ...overrides };
}

test("createEntry starts pending and active", () => {
  const e = entry();
  assert.equal(e.status, "pending");
  assert.ok(d.isActive(e));
  assert.deepEqual(e.files, []);
});

test("applyHostEvent walks queued → started → progress → finished", () => {
  let e = entry();
  e = d.applyHostEvent(e, { type: "queued", id: ID }, 2);
  assert.equal(e.status, "queued");
  e = d.applyHostEvent(e, { type: "started", id: ID, saveDir: "/home/u/Downloads" }, 3);
  assert.equal(e.status, "started");
  assert.equal(e.saveDir, "/home/u/Downloads");
  e = d.applyHostEvent(e, {
    type: "progress", id: ID, status: "downloading", percent: 42.1, speed: "3.2MiB/s", eta: "00:12",
    title: "Never Gonna Give You Up", playlistIndex: null, playlistCount: null,
  }, 4);
  assert.equal(e.status, "downloading");
  assert.equal(e.percent, 42.1);
  assert.equal(e.title, "Never Gonna Give You Up");
  assert.equal(d.formatDetail(e), "42% · 3.2MiB/s · ETA 00:12");
  e = d.applyHostEvent(e, { type: "progress", id: ID, status: "processing", percent: null, speed: null, eta: null, title: null }, 5);
  assert.equal(e.status, "processing");
  assert.equal(e.title, "Never Gonna Give You Up", "a null title keeps the known one");
  e = d.applyHostEvent(e, { type: "finished", id: ID, files: ["/home/u/Downloads/a [x].mp4"] }, 6);
  assert.equal(e.status, "finished");
  assert.equal(e.percent, 100);
  assert.equal(d.isActive(e), false);
  assert.equal(d.folderOf(e), "/home/u/Downloads");
  assert.equal(e.updatedAt, 6);
});

test("applyHostEvent sanitizes untrusted host values", () => {
  const e = d.applyHostEvent(entry({ status: "started" }), {
    type: "progress", id: ID, status: "hacked", percent: 1e9, speed: 7, eta: "x".repeat(500),
    title: `  ${"t".repeat(1000)}  `, playlistIndex: -1, playlistCount: 2.5,
  });
  assert.equal(e.status, "started", "unknown progress status keeps the current one");
  assert.equal(e.percent, 100);
  assert.equal(e.speed, null);
  assert.ok(e.eta.length <= 40);
  assert.ok(e.title.length <= 300);
  assert.equal(e.playlistIndex, null);
  assert.equal(e.playlistCount, null);
  assert.equal(d.applyHostEvent(entry(), { type: "progress", id: ID, percent: Number.NaN }).percent, null);
});

test("finished keeps only absolute string paths", () => {
  const e = d.applyHostEvent(entry(), { type: "finished", id: ID, files: ["/ok.mp3", "rel.mp3", 5, null, "/b.mp3"] });
  assert.deepEqual(e.files, ["/ok.mp3", "/b.mp3"]);
  assert.deepEqual(d.applyHostEvent(entry(), { type: "finished", id: ID, files: "nope" }).files, []);
});

test("terminal entries are never revived", () => {
  for (const status of ["finished", "cancelled", "error"]) {
    for (const type of ["queued", "started", "progress", "finished", "cancelled", "error"]) {
      assert.equal(d.applyHostEvent(entry({ status }), { type, id: ID, status: "downloading" }), null, `${status} + ${type}`);
    }
  }
});

test("events for another id or of unknown type do not apply", () => {
  assert.equal(d.applyHostEvent(entry(), { type: "queued", id: "other" }), null);
  assert.equal(d.applyHostEvent(entry(), { type: "pong", id: ID }), null);
  assert.equal(d.applyHostEvent(entry(), null), null);
});

test("cancelled and error events", () => {
  assert.equal(d.applyHostEvent(entry({ status: "downloading" }), { type: "cancelled", id: ID }).status, "cancelled");
  const failed = d.applyHostEvent(entry(), { type: "error", id: ID, code: "ytdlp_failed", message: "ERROR: Video unavailable" });
  assert.equal(failed.status, "error");
  assert.equal(failed.errorCode, "ytdlp_failed");
  assert.equal(failed.error, "ERROR: Video unavailable");
  assert.equal(d.applyHostEvent(entry(), { type: "error", id: ID, code: "internal" }).error, "Download failed.");
});

test("folderOf falls back to saveDir, dirname handles edge cases", () => {
  assert.equal(d.folderOf(entry({ status: "finished", saveDir: "/srv/dl" })), "/srv/dl");
  assert.equal(d.folderOf(entry({ status: "finished" })), null);
  assert.equal(d.dirname("/a/b/c.mp4"), "/a/b");
  assert.equal(d.dirname("/c.mp4"), "/");
  assert.equal(d.dirname("/a/b/"), "/a");
  assert.equal(d.dirname("/"), "/");
});

test("formatDetail shows playlist position and file counts", () => {
  const e = entry({ status: "downloading", percent: 5.25, playlistIndex: 3, playlistCount: 10 });
  assert.equal(d.formatDetail(e), "5.3% · 3/10");
  assert.equal(d.formatDetail(entry({ status: "finished", files: ["/a", "/b"] })), "2 files");
  assert.equal(d.formatDetail(entry({ status: "finished", files: ["/a"] })), "");
});

test("pruneHistory keeps all active entries and the newest inactive ones", () => {
  const entries = [];
  for (let i = 0; i < 6; i += 1) entries.push(entry({ id: `f${i}`, status: "finished", createdAt: i }));
  entries.push(entry({ id: "active-old", status: "downloading", createdAt: -10 }));
  const kept = d.pruneHistory(entries, 2).map((e) => e.id);
  assert.deepEqual(kept, ["f5", "f4", "active-old"]);
});

test("every status has a label", () => {
  for (const status of [...d.ACTIVE_STATUSES, "finished", "cancelled", "error"]) {
    assert.equal(typeof d.STATUS_LABELS[status], "string", status);
  }
});
