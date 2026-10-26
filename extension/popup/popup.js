"use strict";

const { STATUS_LABELS, isActive, formatDetail } = globalThis.YtdlpDownloads;
const { deriveSetupState, describeToolProblems } = globalThis.YtdlpSetup;

const list = document.getElementById("list");
const empty = document.getElementById("empty");
const notice = document.getElementById("notice");
const clearButton = document.getElementById("clear");
const template = document.getElementById("item-template");
const setupBanner = document.getElementById("setup-banner");
const setupText = document.getElementById("setup-text");
const setupButton = document.getElementById("open-setup");

const SETUP_BANNERS = Object.freeze({
  missing: { text: "The helper program is not reachable, so downloads can't start.", button: "Set up the helper" },
  outdated: { text: "The helper program needs an update.", button: "Update the helper" },
  tools: { text: "", button: "Finish setup" },
});

/** id → rendered <li>; rows are updated in place so focus survives progress ticks. */
const rows = new Map();

/**
 * Shows or clears an error banner.
 * @param {string | null} message
 */
function showNotice(message) {
  notice.textContent = message ?? "";
  notice.hidden = !message;
}

/**
 * Sends a command to the background page and surfaces failures.
 * @param {object} message
 * @returns {Promise<object | null>} the reply, or null on failure
 */
async function command(message) {
  try {
    const result = await browser.runtime.sendMessage(message);
    if (result && result.ok === false) {
      showNotice(result.error);
      return null;
    }
    showNotice(null);
    return result;
  } catch (error) {
    showNotice(`Background page unavailable: ${error.message}`);
    return null;
  }
}

/**
 * Creates the row for a download id, wiring buttons by id so handlers never hold stale entries.
 * @param {string} id
 * @returns {HTMLLIElement}
 */
function createRow(id) {
  const row = template.content.firstElementChild.cloneNode(true);
  row.dataset.id = id;
  row.querySelector(".cancel").addEventListener("click", () => void command({ type: "cancel", id }));
  row.querySelector(".open").addEventListener("click", () => void command({ type: "openFolder", id }));
  return row;
}

/**
 * Updates one row from an entry. All network-sourced text goes through textContent.
 * @param {HTMLLIElement} row
 * @param {import("../shared/downloads.js").DownloadEntry} entry
 */
function updateRow(row, entry) {
  const name = entry.title ?? entry.url;
  const active = isActive(entry);
  row.dataset.status = entry.status;

  const title = row.querySelector(".title");
  title.textContent = name;
  title.title = entry.url;

  const modeLabel = entry.mode === "audio" ? "Audio" : "Video";
  row.querySelector(".status").textContent = `${STATUS_LABELS[entry.status] ?? entry.status} · ${modeLabel}`;
  row.querySelector(".detail").textContent = formatDetail(entry);
  row.querySelector(".error").textContent = entry.status === "error" ? (entry.error ?? "") : "";

  const progress = row.querySelector("progress");
  progress.hidden = !active;
  progress.setAttribute("aria-label", `Progress for ${name}`);
  if (entry.percent === null) progress.removeAttribute("value");
  else progress.value = entry.percent;

  const cancel = row.querySelector(".cancel");
  cancel.hidden = !active;
  cancel.setAttribute("aria-label", `Cancel ${name}`);

  const open = row.querySelector(".open");
  open.hidden = entry.status !== "finished";
  open.setAttribute("aria-label", `Open folder of ${name}`);
}

/**
 * Reconciles the list with the background's download snapshot (newest first).
 * @param {object[]} downloads
 */
function render(downloads) {
  const seen = new Set();
  let previous = null;
  for (const entry of downloads) {
    seen.add(entry.id);
    let row = rows.get(entry.id);
    if (!row) {
      row = createRow(entry.id);
      rows.set(entry.id, row);
    }
    updateRow(row, entry);
    const expectedPosition = previous ? previous.nextElementSibling : list.firstElementChild;
    if (row !== expectedPosition) list.insertBefore(row, expectedPosition);
    previous = row;
  }
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.remove();
      rows.delete(id);
    }
  }
  empty.hidden = downloads.length > 0;
  clearButton.hidden = !downloads.some((entry) => !isActive(entry));
}

/**
 * Shows the setup banner for the background's host status, or hides it.
 * @param {{reachable: boolean | null, error: string | null, pong: object | null} | undefined} host
 */
function renderHost(host) {
  if (!host || host.reachable === null) return;
  const view = deriveSetupState(host.reachable ? { ok: true, pong: host.pong } : { ok: false, error: host.error });
  const banner = SETUP_BANNERS[view.state] ?? (view.needsAttention
    ? { text: "Downloads are ready, but optional or setup checks need attention.", button: "Review setup" }
    : null);
  setupBanner.hidden = !banner;
  if (!banner) return;
  setupText.textContent = view.state === "tools" ? `${describeToolProblems(view)}, so downloads fail.`
    : view.state === "outdated" && view.updateReason !== "version"
      ? "Helper compatibility or required diagnostics are not confirmed. Open setup to update or reinstall it."
      : banner.text;
  setupButton.textContent = banner.button;
}

setupButton.addEventListener("click", async () => {
  if (await command({ type: "openSetup" })) window.close();
});

document.getElementById("open-settings").addEventListener("click", async () => {
  await browser.runtime.openOptionsPage();
  window.close();
});

clearButton.addEventListener("click", () => void command({ type: "clearInactive" }));

browser.runtime.onMessage.addListener((message) => {
  if (message?.type !== "state") return;
  if (Array.isArray(message.downloads)) render(message.downloads);
  renderHost(message.host);
});

(async () => {
  const state = await command({ type: "getState" });
  render(state?.downloads ?? []);
  renderHost(state?.host);
  // Nothing has talked to the helper yet, or it was unreachable last time: ask
  // again so the banner reflects the helper now. The reply arrives as a state broadcast.
  if (state && state.host?.reachable !== true) {
    void browser.runtime.sendMessage({ type: "ping" }).catch(() => {});
  }
})();
