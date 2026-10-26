"use strict";

/*
 * First-run setup page. Pings the helper through the background page, renders
 * the state from YtdlpSetup.deriveSetupState, and polls while actionable setup
 * failures or warnings remain so repairs appear automatically.
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
const STATUS_WORDS = Object.freeze({ ok: "Passed", bad: "Needs action", warn: "Warning", pending: "Pending" });

const VERSION = browser.runtime.getManifest().version;
let displayedCommand = setupCommand(VERSION);

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
const warningText = document.getElementById("warning-text");
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

/** Setup skips existing yt-dlp; interpreter repair is separate from replacing that executable. */
function repairAdvice(view) {
  const guidance = [];
  if (view.unsupportedTools.length) {
    guidance.push("Install Python 3.8 or newer and reinstall the helper so it uses a supported interpreter.");
  }
  if (view.brokenTools.includes("yt-dlp")) {
    guidance.push("Update yt-dlp with your package manager, or remove it before running setup again. " +
      "Setup does not automatically replace an existing broken yt-dlp. Check that your Python also meets yt-dlp's requirements.");
  }
  return guidance.join(" ");
}

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
      if (view.updateReason === "diagnostics") {
        return {
          title: "Update or reinstall the helper",
          lead: `The helper reports version ${view.hostVersion}, but required diagnostics are missing or invalid. ` +
            "Download readiness cannot be confirmed. Update or reinstall the helper, then check again; the next check reconnects to it.",
        };
      }
      if (view.updateReason === "versionUnknown") {
        return {
          title: "Update or reinstall the helper",
          lead: "The helper answered without a valid version, so compatibility cannot be confirmed. " +
            `Update or reinstall helper ${MIN_HOST_VERSION} or newer, then check again.`,
        };
      }
      return {
        title: "Update the helper",
        lead: `The installed helper is version ${view.hostVersion}; this extension needs ` +
          `${MIN_HOST_VERSION} or newer. The same command updates it.`,
      };
    case "tools": {
      const actions = [];
      if (view.missingTools.length) actions.push(`install ${joinNames(view.missingTools)}`);
      if (view.brokenTools.length) actions.push(`repair ${joinNames(view.brokenTools)}`);
      if (view.unsupportedTools.length) actions.push("update Python");
      const title = actions.join(" and ");
      const guidance = [repairAdvice(view), "The setup command offers to install missing dependencies."].filter(Boolean).join(" ");
      return {
        title: title.charAt(0).toUpperCase() + title.slice(1),
        lead: `The helper is connected, but ${describeToolProblems(view)}. Downloads are blocked. ${guidance}`,
      };
    }
    default:
      return { title: "Ready to download", lead: "The helper, supported Python, yt-dlp, ffmpeg and ffprobe passed the required checks." };
  }
}

/**
 * @param {import("../shared/setup-info.js").CheckItem} check
 * @returns {HTMLLIElement}
 */
function checklistRow(check) {
  const row = document.createElement("li");
  row.dataset.key = check.key;
  row.dataset.status = check.status;
  const icon = document.createElement("span");
  icon.className = "check-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = STATUS_ICONS[check.status];
  const label = document.createElement("span");
  label.className = "check-label";
  label.textContent = check.label;
  const word = document.createElement("span");
  word.className = "check-status";
  word.textContent = STATUS_WORDS[check.status];
  const requirement = document.createElement("span");
  requirement.className = "check-requirement";
  requirement.textContent = check.requirement;
  const detail = document.createElement("span");
  detail.className = "check-detail";
  detail.textContent = check.detail;
  row.append(icon, label, word, requirement, detail);
  return row;
}

/**
 * Shows a setup view and announces it when the state changed.
 * @param {import("../shared/setup-info.js").SetupView} view
 */
function render(view) {
  const changed = JSON.stringify(view) !== JSON.stringify(current);
  current = view;
  const { title, lead } = describe(view);
  card.dataset.state = view.state;
  stateTitle.textContent = title;
  const toolProblems = describeToolProblems(view);
  stateLead.textContent = view.state === "outdated" && toolProblems
    ? `${lead} Required tools also need attention: ${toolProblems}. ${repairAdvice(view)}`.trim()
    : lead;
  checklist.replaceChildren(...view.checklist.map(checklistRow));
  const method = view.setupMethod === "unknown" ? "curl" : view.setupMethod;
  const nextCommand = setupCommand(VERSION, method);
  if (nextCommand !== displayedCommand) {
    clearTimeout(copiedTimer);
    copyStatus.textContent = "";
    delete copyStatus.dataset.state;
    copyButton.textContent = "Copy";
  }
  displayedCommand = nextCommand;
  commandCode.textContent = displayedCommand;
  document.getElementById("download-step").hidden = method !== "browser";
  // The numbered browser steps describe the download themselves; the hint would split steps 2 and 3.
  document.getElementById("command-hint").hidden = method === "browser";
  document.getElementById("command-label").textContent = method === "browser"
    ? "2. Open a terminal and paste or type this prefix (bash followed by one space). Do not press Enter yet:"
    : view.setupMethod === "unknown"
      ? "If curl is installed, open a terminal, paste this bootstrap command, and press Enter:"
      : "Open a terminal anywhere, paste this command, and press Enter:";
  const browserSave = "First use “Download setup.sh” above to save the script. In a terminal, paste or type bash followed by one space, " +
    "then drag the actual downloaded file into the terminal so its full path is inserted, and press Enter. " +
    "Find the file in your browser's downloads list or use its reveal-folder action, then drag the file from that folder.";
  const downloaderUnknown = view.state === "checking" || view.state === "missing"
    ? "Downloader availability cannot be checked until the helper answers."
    : "The helper has not reported which downloader is available.";
  document.getElementById("command-alternatives").textContent = method === "launcher"
    ? "Using the verified setup launcher to download and run this release's setup script. Setup still asks before installing dependencies."
    : method === "browser"
      ? "3. Drag the actual downloaded setup.sh file into the terminal so its full path is inserted after the space, then press Enter. " +
        "Find it in your browser's downloads list or use its reveal-folder action and drag the file from that folder. " +
        "Neither curl nor wget was found; the downloaded script can offer to install a downloader and asks before dependency changes."
      : view.setupMethod === "unknown"
        ? `${downloaderUnknown} A working setup launcher has not been confirmed. If wget is installed instead, use ${setupCommand(VERSION, "wget")}. Browser alternative: ${browserSave}`
        : `Using ${method} to bootstrap this release’s setup script; a working setup launcher has not been confirmed. Browser alternative: ${browserSave}`;
  const warningNames = view.checklist.filter((check) => view.warnings.includes(check.key)).map((check) => check.label);
  const unknownNames = view.checklist.filter((check) => view.unknownChecks.includes(check.key) &&
    !["python", "ytdlp", "ffmpeg", "ffprobe"].includes(check.key)).map((check) => check.label);
  const guidance = [];
  if (warningNames.length) {
    guidance.push(`Optional or setup tools unavailable: ${joinNames(warningNames)}. ` +
      "These warnings do not block downloads. The setup command offers to install missing dependencies.");
  }
  if (unknownNames.length) {
    guidance.push(`Optional or setup checks not confirmed: ${joinNames(unknownNames)}. ` +
      "Update or reinstall the helper and check again; these tools have not been reported missing.");
  }
  readyWarning.hidden = guidance.length === 0;
  warningText.textContent = guidance.join(" ");
  commandBlock.hidden = !COMMAND_STATES.has(view.state) && !(view.state === "ready" && view.needsAttention);
  errorDetails.hidden = !view.error;
  errorText.textContent = view.error ?? "";
  readyBlock.hidden = view.state !== "ready";
  if (changed) announce.textContent = `${title}. ${guidance.join(" ")}`;
  updatePollStatus();
}

function updatePollStatus() {
  pollStatus.hidden = !current.needsAttention;
  pollStatus.dataset.active = String(!document.hidden && current.needsAttention);
  if (document.hidden) pollText.textContent = "Paused while this tab is in the background.";
  else if (current.state === "checking") pollText.textContent = "Checking…";
  else if (current.state === "tools") {
    pollText.textContent = `Waiting for ${joinNames([...current.missingTools, ...current.brokenTools, ...current.unsupportedTools])}…`;
  } else if (current.updateReason === "diagnostics" || current.unknownChecks.length) {
    pollText.textContent = "Waiting for complete helper diagnostics…";
  } else if (current.state === "ready") pollText.textContent = "Waiting for optional or setup tools…";
  else if (current.state === "outdated") pollText.textContent = "Waiting for the updated helper…";
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
  // Reinstalling changes files, not an already running helper. Refresh its
  // connection for old versions, interpreter repairs or incomplete reports; busy jobs stay alive.
  const reconnect = current.state === "outdated" || current.unsupportedTools.length > 0 || current.unknownChecks.length > 0;
  let result;
  try {
    result = await browser.runtime.sendMessage({ type: "ping", reconnect });
  } catch (error) {
    result = { ok: false, error: `Background page unavailable: ${error?.message ?? "Unknown error"}` };
  }
  checking = false;
  render(deriveSetupState(result));
  schedulePoll();
}

/** Polls while actionable failures, warnings or unknown reports remain, in visible tabs only. */
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = null;
  if (current.needsAttention && !document.hidden) {
    pollTimer = setTimeout(() => void check(), POLL_INTERVAL_MS);
  }
  updatePollStatus();
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void check();
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
    await navigator.clipboard.writeText(displayedCommand);
    showCopyStatus(displayedCommand === "bash "
      ? "Prefix copied, including the trailing space. Paste it into a terminal, drag the downloaded file after it, then press Enter."
      : "Copied. Paste it into a terminal.", "ok");
  } catch {
    selectCommand();
    commandCode.focus();
    showCopyStatus(displayedCommand === "bash "
      ? "Could not copy automatically. The prefix is selected: press Ctrl+C, and make sure one space follows bash when you paste it."
      : "Could not copy automatically. The command is selected: press Ctrl+C.", "error");
  }
});

// Selecting on focus makes Tab + Ctrl+C copy the whole command without a mouse.
commandCode.addEventListener("focus", selectCommand);

document.getElementById("open-settings").addEventListener("click", () => void browser.runtime.openOptionsPage());

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

document.getElementById("script-link").href = setupScriptUrl(VERSION);
document.getElementById("extension-version").textContent = `v${VERSION}`;
document.getElementById("manual-link").href = MANUAL_INSTALL_URL;
render(current);
void check();
