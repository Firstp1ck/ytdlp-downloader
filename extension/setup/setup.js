"use strict";

/*
 * First-run setup page. Pings the helper through the background page, renders
 * the state from YtdlpSetup.deriveSetupState, and polls until everything is
 * installed so the page flips to "Ready" on its own after the user runs the command.
 */

const {
  MANUAL_INSTALL_URL,
  MIN_HOST_VERSION,
  setupCommand,
  setupScriptUrl,
  deriveSetupState,
  describeToolProblems,
  joinNames,
} = globalThis.YtdlpSetup;

const POLL_INTERVAL_MS = 2500;
const COPIED_FEEDBACK_MS = 2500;
const COMMAND_STATES = new Set(["missing", "outdated", "tools"]);
const STATUS_ICONS = Object.freeze({ ok: "✓", bad: "✗", warn: "⚠", pending: "…" });
const STATUS_WORDS = Object.freeze({ ok: "Done", bad: "Needs action", warn: "Recommended", pending: "Not checked yet" });

const VERSION = browser.runtime.getManifest().version;
const COMMAND = setupCommand(VERSION);

const card = document.getElementById("setup-card");
const stateTitle = document.getElementById("state-title");
const stateLead = document.getElementById("state-lead");
const checklist = document.getElementById("checklist");
const commandBlock = document.getElementById("command-block");
const commandCode = document.getElementById("command");
const copyButton = document.getElementById("copy");
const copyStatus = document.getElementById("copy-status");
const errorDetails = document.getElementById("error-details");
const errorText = document.getElementById("error-text");
const readyBlock = document.getElementById("ready-block");
const readyWarning = document.getElementById("ready-warning");
const pollStatus = document.getElementById("poll-status");
const pollText = document.getElementById("poll-text");
const checkAgainButton = document.getElementById("check-again");
const announce = document.getElementById("announce");

let current = deriveSetupState(null);
let pollTimer = null;
let checking = false;
let copiedTimer = null;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Heading and explanation for a setup state.
 * @param {import("../shared/setup-info.js").SetupView} view
 * @returns {{title: string, lead: string}}
 */
function describe(view) {
  switch (view.state) {
    case "checking":
      return { title: "Checking for the helper…", lead: "This page checks whether the helper program is installed." };
    case "missing":
      return {
        title: "Install the helper",
        lead:
          "The browser can't run programs by itself, so a small helper program on your computer runs " +
          "yt-dlp for this extension. One command installs it.",
      };
    case "outdated":
      return {
        title: "Update the helper",
        lead:
          `The installed helper is version ${view.hostVersion ?? "unknown"}; this extension needs ` +
          `${MIN_HOST_VERSION} or newer. The same command updates it.`,
      };
    case "tools": {
      const missing = view.missingTools.length > 0;
      const broken = view.brokenTools.length > 0;
      const actions = [];
      if (missing) actions.push(`install ${joinNames(view.missingTools)}`);
      if (broken) actions.push(`repair ${joinNames(view.brokenTools)}`);
      const title = actions.join(" and ");
      const cause = broken ? ", often because the system's Python is too old for it" : "";
      // setup.sh only installs tools that are absent; a broken yt-dlp counts as
      // present, so the user has to update or remove it first.
      const lead = broken
        ? `The helper is connected, but ${describeToolProblems(view)}${cause}. Update yt-dlp with your package manager, ` +
          "or remove it and run the same command again, which installs a working one" +
          (missing ? " together with what's missing." : ".")
        : `The helper is connected, but ${describeToolProblems(view)}. Run the same command again: it offers to install what's missing.`;
      return { title: title.charAt(0).toUpperCase() + title.slice(1), lead };
    }
    default:
      return { title: "Ready to download", lead: "The helper, yt-dlp, and ffmpeg are installed." };
  }
}

/**
 * @param {import("../shared/setup-info.js").CheckItem} check
 * @returns {HTMLLIElement}
 */
function checklistRow(check) {
  const row = document.createElement("li");
  row.dataset.status = check.status;
  const icon = document.createElement("span");
  icon.className = "check-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = STATUS_ICONS[check.status];
  const label = document.createElement("span");
  label.className = "check-label";
  label.textContent = check.label;
  const word = document.createElement("span");
  word.className = "visually-hidden";
  word.textContent = `: ${STATUS_WORDS[check.status]}.`;
  const detail = document.createElement("span");
  detail.className = "check-detail";
  detail.textContent = check.detail;
  row.append(icon, label, word, detail);
  return row;
}

/**
 * Shows a setup view and announces it when the state changed.
 * @param {import("../shared/setup-info.js").SetupView} view
 */
function render(view) {
  const changed = view.state !== current.state;
  current = view;
  const { title, lead } = describe(view);
  card.dataset.state = view.state;
  stateTitle.textContent = title;
  stateLead.textContent = lead;
  checklist.replaceChildren(...view.checklist.map(checklistRow));
  const runtimeWarning = view.state === "ready" && view.warnings.includes("jsRuntime");
  readyWarning.hidden = !runtimeWarning;
  // The same command installs Deno, so a ready page with the warning still needs it.
  commandBlock.hidden = !COMMAND_STATES.has(view.state) && !runtimeWarning;
  errorDetails.hidden = !view.error;
  errorText.textContent = view.error ?? "";
  readyBlock.hidden = view.state !== "ready";
  if (changed) announce.textContent = title;
  updatePollStatus();
}

function updatePollStatus() {
  const ready = current.state === "ready";
  pollStatus.hidden = ready;
  pollStatus.dataset.active = String(!document.hidden && !ready);
  if (current.state === "checking") pollText.textContent = "Checking…";
  else if (document.hidden) pollText.textContent = "Paused while this tab is in the background.";
  else if (current.state === "tools") {
    pollText.textContent = `Waiting for ${joinNames([...current.missingTools, ...current.brokenTools])}…`;
  }
  else pollText.textContent = "Waiting for the helper…";
}

// ---------------------------------------------------------------------------
// Checking and polling
// ---------------------------------------------------------------------------

/** Pings the helper once and schedules the next poll. Overlapping calls are dropped. */
async function check() {
  if (checking) return;
  checking = true;
  clearTimeout(pollTimer);
  pollTimer = null;
  // A running old helper keeps answering with its old version after an update,
  // so an outdated helper is pinged on a fresh connection.
  const reconnect = current.state === "outdated";
  let result;
  try {
    result = await browser.runtime.sendMessage({ type: "ping", reconnect });
  } catch (error) {
    result = { ok: false, error: `Background page unavailable: ${error.message}` };
  }
  checking = false;
  render(deriveSetupState(result));
  schedulePoll();
}

/** Polls only while something is missing and the tab is visible. */
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (current.state !== "ready" && !document.hidden) {
    pollTimer = setTimeout(() => void check(), POLL_INTERVAL_MS);
  }
  updatePollStatus();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && current.state !== "ready") void check();
  else schedulePoll();
});

checkAgainButton.addEventListener("click", () => void check());

// ---------------------------------------------------------------------------
// Copying the command
// ---------------------------------------------------------------------------

function selectCommand() {
  window.getSelection().selectAllChildren(commandCode);
}

/**
 * @param {string} text
 * @param {"ok" | "error"} state
 */
function showCopyStatus(text, state) {
  clearTimeout(copiedTimer);
  copyStatus.textContent = text;
  copyStatus.dataset.state = state;
  copyButton.textContent = state === "ok" ? "Copied ✓" : "Copy";
  if (state === "ok") {
    copiedTimer = setTimeout(() => {
      copyStatus.textContent = "";
      delete copyStatus.dataset.state;
      copyButton.textContent = "Copy";
    }, COPIED_FEEDBACK_MS);
  }
}

copyButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(COMMAND);
    showCopyStatus("Copied. Paste it into a terminal.", "ok");
  } catch {
    selectCommand();
    commandCode.focus();
    showCopyStatus("Could not copy automatically. The command is selected: press Ctrl+C.", "error");
  }
});

// Selecting on focus makes Tab + Ctrl+C copy the whole command without a mouse.
commandCode.addEventListener("focus", selectCommand);

document.getElementById("open-settings").addEventListener("click", () => void browser.runtime.openOptionsPage());

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

commandCode.textContent = COMMAND;
document.getElementById("script-link").href = setupScriptUrl(VERSION);
document.getElementById("extension-version").textContent = `v${VERSION}`;
document.getElementById("manual-link").href = MANUAL_INSTALL_URL;
render(current);
void check();
