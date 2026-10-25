"use strict";

const { CHOICES, loadSettings, saveSettings, validateSaveDir } = globalThis.YtdlpSettings;

const SAVED_FEEDBACK_MS = 2000;
const SELECT_KEYS = ["videoResolution", "videoFormat", "audioQuality", "audioFormat"];
const TOGGLE_KEYS = ["playlist", "notifications"];

const form = document.getElementById("settings-form");
const modeGroup = document.getElementById("mode-group");
const videoFields = document.getElementById("video-fields");
const audioFields = document.getElementById("audio-fields");
const saveDirInput = document.getElementById("saveDir");
const saveDirError = document.getElementById("saveDir-error");
const browseButton = document.getElementById("browse");
const saveStatus = document.getElementById("save-status");

let savedTimer = null;
/** Last saved saveDir; avoids re-saving when blur follows an Enter commit. */
let committedSaveDir = "";
/** Latest pong; null while the host is unknown or unreachable. */
let hostPong = null;

// ---------------------------------------------------------------------------
// Building controls from the canonical CHOICES
// ---------------------------------------------------------------------------

function buildControls() {
  for (const { value, label } of CHOICES.mode) {
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "mode";
    input.id = `mode-${value}`;
    input.value = value;
    const text = document.createElement("label");
    text.htmlFor = input.id;
    text.textContent = label;
    modeGroup.append(input, text);
  }
  for (const key of SELECT_KEYS) {
    const select = document.getElementById(key);
    for (const { value, label } of CHOICES[key]) select.add(new Option(label, value));
  }
}

/**
 * Writes settings into the form without saving.
 * @param {object} settings normalized settings from loadSettings
 */
function applyToForm(settings) {
  document.getElementById(`mode-${settings.mode}`).checked = true;
  for (const key of SELECT_KEYS) document.getElementById(key).value = settings[key];
  for (const key of TOGGLE_KEYS) document.getElementById(key).checked = settings[key];
  saveDirInput.value = settings.saveDir;
  committedSaveDir = settings.saveDir;
  updateModeDependentFields(settings.mode);
}

/**
 * Highlights the section the default action uses. Both stay editable because
 * "Download Audio" uses the audio settings regardless of the default action.
 * @param {string} mode
 */
function updateModeDependentFields(mode) {
  videoFields.classList.toggle("is-default", mode === "video");
  audioFields.classList.toggle("is-default", mode === "audio");
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * @param {"saving" | "saved" | "error"} state
 * @param {string} text
 */
function setSaveStatus(state, text) {
  clearTimeout(savedTimer);
  saveStatus.dataset.state = state;
  saveStatus.textContent = text;
  if (state === "saved") {
    savedTimer = setTimeout(() => {
      saveStatus.textContent = "";
      delete saveStatus.dataset.state;
    }, SAVED_FEEDBACK_MS);
  }
}

/**
 * Saves a partial settings update with visible feedback.
 * @param {object} patch
 * @returns {Promise<boolean>} true if saved
 */
async function save(patch) {
  setSaveStatus("saving", "Saving…");
  try {
    await saveSettings(patch);
    setSaveStatus("saved", "Saved ✓");
    return true;
  } catch (error) {
    setSaveStatus("error", `Not saved: ${error.message}`);
    return false;
  }
}

/**
 * Validates and saves the save-folder field.
 * @returns {Promise<void>}
 */
async function commitSaveDir() {
  const checked = validateSaveDir(saveDirInput.value);
  saveDirError.textContent = checked.ok ? "" : checked.error;
  saveDirInput.setAttribute("aria-invalid", String(!checked.ok));
  if (!checked.ok || checked.value === committedSaveDir) return;
  if (await save({ saveDir: checked.value })) {
    committedSaveDir = checked.value;
    saveDirInput.value = checked.value;
  }
}

form.addEventListener("change", (event) => {
  const target = event.target;
  if (target.name === "mode") {
    updateModeDependentFields(target.value);
    void save({ mode: target.value });
  } else if (SELECT_KEYS.includes(target.name)) {
    void save({ [target.name]: target.value });
  } else if (TOGGLE_KEYS.includes(target.name)) {
    void save({ [target.name]: target.checked });
  } else if (target === saveDirInput) {
    void commitSaveDir();
  }
});

// Enter in the path field would submit the form; treat it as "commit the path".
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void commitSaveDir();
});

browseButton.addEventListener("click", async () => {
  browseButton.disabled = true;
  try {
    const result = await browser.runtime.sendMessage({ type: "pickDirectory", start: saveDirInput.value });
    if (!result?.ok) {
      saveDirError.textContent = result?.error ?? "The folder dialog failed.";
      return;
    }
    if (result.path) {
      saveDirInput.value = result.path;
      await commitSaveDir();
    }
  } catch (error) {
    saveDirError.textContent = `Background page unavailable: ${error.message}`;
  } finally {
    updateBrowseAvailability();
    saveDirInput.focus();
  }
});

// ---------------------------------------------------------------------------
// Native host status
// ---------------------------------------------------------------------------

const hostSummary = document.getElementById("host-summary");
const hostSummaryText = document.getElementById("host-summary-text");
const hostDetails = document.getElementById("host-details");
const hostInstallHint = document.getElementById("host-install-hint");
const retryButton = document.getElementById("host-retry");

/**
 * Fills a definition cell with plain text, optionally marked as a problem.
 * @param {string} id
 * @param {string} text
 * @param {boolean} [problem]
 */
function setDetail(id, text, problem = false) {
  const cell = document.getElementById(id);
  const span = document.createElement("span");
  span.textContent = text;
  if (problem) span.className = "missing";
  cell.replaceChildren(span);
}

function updateBrowseAvailability() {
  const pickerMissing = hostPong !== null && !hostPong.picker;
  browseButton.disabled = hostPong === null || pickerMissing;
  browseButton.title = pickerMissing
    ? "No folder dialog found. Install zenity, kdialog, or yad."
    : hostPong === null
      ? "The native host is not reachable."
      : "";
  saveDirInput.placeholder = hostPong?.defaultSaveDir ? `Default: ${hostPong.defaultSaveDir}` : "Host default";
}

/**
 * @param {object} pong host `pong` message
 */
function renderHostOk(pong) {
  const ytDlp = pong.ytDlp ?? {};
  const ffmpeg = pong.ffmpeg ?? {};
  const problems = [];
  if (!ytDlp.found) problems.push("yt-dlp not found");
  if (!ffmpeg.found) problems.push("ffmpeg missing (needed for video merging and all audio downloads)");

  hostSummary.dataset.state = problems.length > 0 ? "warn" : "ok";
  hostSummaryText.textContent = problems.length > 0 ? `Connected, but ${problems.join("; ")}.` : "Connected";

  setDetail("host-version", String(pong.hostVersion ?? "unknown"));
  setDetail(
    "host-ytdlp",
    ytDlp.found ? `${ytDlp.version ?? "unknown version"} — ${ytDlp.path ?? ""}` : "Not found. Install yt-dlp.",
    !ytDlp.found,
  );
  setDetail("host-ffmpeg", ffmpeg.found ? `Found — ${ffmpeg.path ?? ""}` : "Missing. Install ffmpeg.", !ffmpeg.found);
  setDetail(
    "host-picker",
    pong.picker ? String(pong.picker) : "None found. Install zenity, kdialog, or yad for Browse…",
    !pong.picker,
  );
  setDetail("host-default-dir", String(pong.defaultSaveDir ?? "unknown"));
  hostDetails.hidden = false;
  hostInstallHint.hidden = true;
}

/**
 * @param {string} message
 */
function renderHostError(message) {
  hostSummary.dataset.state = "error";
  hostSummaryText.textContent = message;
  hostDetails.hidden = true;
  hostInstallHint.hidden = false;
}

async function checkHost() {
  retryButton.disabled = true;
  hostSummary.dataset.state = "pending";
  hostSummaryText.textContent = "Checking…";
  try {
    const result = await browser.runtime.sendMessage({ type: "ping" });
    if (result?.ok && result.pong) {
      hostPong = result.pong;
      renderHostOk(result.pong);
    } else {
      hostPong = null;
      renderHostError(result?.error ?? "The native host did not answer.");
    }
  } catch (error) {
    hostPong = null;
    renderHostError(`Background page unavailable: ${error.message}`);
  } finally {
    retryButton.disabled = false;
    updateBrowseAvailability();
  }
}

retryButton.addEventListener("click", () => void checkHost());

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async () => {
  buildControls();
  updateBrowseAvailability();
  try {
    applyToForm(await loadSettings());
  } catch (error) {
    setSaveStatus("error", `Could not load settings: ${error.message}`);
  }
  requestAnimationFrame(() => document.body.classList.add("ready"));
  await checkHost();
})();
