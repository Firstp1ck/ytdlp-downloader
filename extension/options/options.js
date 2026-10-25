"use strict";

const { CHOICES, loadSettings, saveSettings, validateSaveDir } = globalThis.YtdlpSettings;
const { MIN_HOST_VERSION, deriveSetupState, describeToolProblems, isHostVersionSupported } = globalThis.YtdlpSetup;

const SAVED_FEEDBACK_MS = 2000;
const SELECT_KEYS = ["videoResolution", "videoFormat", "audioQuality", "audioFormat"];
const TOGGLE_KEYS = ["videoPlaylist", "audioPlaylist", "notifications"];
const SAVE_DIR_KEYS = ["videoSaveDir", "audioSaveDir"];

const form = document.getElementById("settings-form");
const browseButtons = [...document.querySelectorAll("[data-browse]")];
const saveStatus = document.getElementById("save-status");

let savedTimer = null;
/** Last saved value per save-folder key; avoids re-saving when blur follows an Enter commit. */
const committedSaveDirs = { videoSaveDir: "", audioSaveDir: "" };
/** Latest pong; null while the host is unknown or unreachable. */
let hostPong = null;

// ---------------------------------------------------------------------------
// Building controls from the canonical CHOICES
// ---------------------------------------------------------------------------

function buildControls() {
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
  for (const key of SELECT_KEYS) document.getElementById(key).value = settings[key];
  for (const key of TOGGLE_KEYS) document.getElementById(key).checked = settings[key];
  for (const key of SAVE_DIR_KEYS) {
    document.getElementById(key).value = settings[key];
    committedSaveDirs[key] = settings[key];
  }
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
 * Validates and saves one save-folder field.
 * @param {string} key "videoSaveDir" or "audioSaveDir"
 * @returns {Promise<void>}
 */
async function commitSaveDir(key) {
  const input = document.getElementById(key);
  const checked = validateSaveDir(input.value);
  document.getElementById(`${key}-error`).textContent = checked.ok ? "" : checked.error;
  input.setAttribute("aria-invalid", String(!checked.ok));
  if (!checked.ok || checked.value === committedSaveDirs[key]) return;
  if (await save({ [key]: checked.value })) {
    committedSaveDirs[key] = checked.value;
    input.value = checked.value;
  }
}

form.addEventListener("change", (event) => {
  const target = event.target;
  if (SELECT_KEYS.includes(target.name)) {
    void save({ [target.name]: target.value });
  } else if (TOGGLE_KEYS.includes(target.name)) {
    void save({ [target.name]: target.checked });
  } else if (SAVE_DIR_KEYS.includes(target.name)) {
    void commitSaveDir(target.name);
  }
});

// Enter in a path field would submit the form; treat it as "commit that path".
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const active = document.activeElement;
  if (active && SAVE_DIR_KEYS.includes(active.name)) void commitSaveDir(active.name);
});

for (const button of browseButtons) {
  const key = button.dataset.browse;
  const input = document.getElementById(key);
  const error = document.getElementById(`${key}-error`);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const result = await browser.runtime.sendMessage({ type: "pickDirectory", start: input.value });
      if (!result?.ok) {
        error.textContent = result?.error ?? "The folder dialog failed.";
        return;
      }
      if (result.path) {
        input.value = result.path;
        await commitSaveDir(key);
      }
    } catch (failure) {
      error.textContent = `Background page unavailable: ${failure.message}`;
    } finally {
      updateBrowseAvailability();
      input.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Native host status
// ---------------------------------------------------------------------------

const hostSummary = document.getElementById("host-summary");
const hostSummaryText = document.getElementById("host-summary-text");
const hostDetails = document.getElementById("host-details");
const hostInstallHint = document.getElementById("host-install-hint");
const hostInstallText = document.getElementById("host-install-text");
const openSetupButton = document.getElementById("open-setup");
const retryButton = document.getElementById("host-retry");

/**
 * What running the setup command again does about the tool problems in `view`.
 * @param {import("../shared/setup-info.js").SetupView} view
 * @returns {string}
 */
function toolRemedy(view) {
  // setup.sh skips tools that exist, so a broken yt-dlp must be updated or removed first.
  if (view.brokenTools.length > 0) {
    return view.missingTools.length > 0
      ? "installs a working yt-dlp after you update or remove the broken one, and offers to install the rest"
      : "installs a working yt-dlp after you update or remove the broken one";
  }
  return `offers to install ${view.missingTools.length > 1 ? "them" : "it"}`;
}

/**
 * Shows the "Open setup" hint for setup states the setup command fixes, or hides it.
 * @param {import("../shared/setup-info.js").SetupView} view
 */
function renderSetupHint(view) {
  const texts = {
    missing: "The setup page shows the one command that installs or repairs the helper.",
    outdated: `Update helper: version ${view.hostVersion ?? "unknown"} is older than this extension needs (${MIN_HOST_VERSION} or newer). The setup page shows the command that updates it.`,
    tools: `Not ready yet: ${describeToolProblems(view)}. Running the setup command again ${toolRemedy(view)}.`,
    ready: view.warnings.includes("jsRuntime")
      ? "No JavaScript runtime found (Deno, or Node 22 or newer). Downloads work, but yt-dlp can miss some YouTube formats without one. Running the setup command again installs Deno."
      : undefined,
  };
  const text = texts[view.state];
  hostInstallText.textContent = text ?? "";
  hostInstallHint.hidden = !text;
}

/**
 * Fills a definition cell with plain text, optionally marked as a problem.
 * @param {string} id
 * @param {string} text
 * @param {boolean | "warn"} [problem] "warn" marks something recommended but not required
 */
function setDetail(id, text, problem = false) {
  const cell = document.getElementById(id);
  const span = document.createElement("span");
  span.textContent = text;
  if (problem) span.className = problem === "warn" ? "recommended" : "missing";
  cell.replaceChildren(span);
}

function updateBrowseAvailability() {
  const pickerMissing = hostPong !== null && !hostPong.picker;
  const title = pickerMissing
    ? "No folder dialog found. Install zenity, kdialog, or yad."
    : hostPong === null
      ? "The native host is not reachable."
      : "";
  for (const button of browseButtons) {
    button.disabled = hostPong === null || pickerMissing;
    button.title = title;
  }
  const placeholder = hostPong?.defaultSaveDir ? `Default: ${hostPong.defaultSaveDir}` : "Host default";
  for (const key of SAVE_DIR_KEYS) document.getElementById(key).placeholder = placeholder;
}

/**
 * @param {object} pong host `pong` message
 */
function renderHostOk(pong) {
  const ytDlp = pong.ytDlp ?? {};
  const ffmpeg = pong.ffmpeg ?? {};
  const supported = isHostVersionSupported(pong.hostVersion);
  const view = deriveSetupState({ ok: true, pong });
  const ytDlpBroken = view.brokenTools.includes("yt-dlp");
  const runtimeCheck = view.checklist.find((check) => check.key === "jsRuntime");
  const problems = [];
  if (!supported) problems.push(`the helper needs an update to ${MIN_HOST_VERSION} or newer`);
  if (!ytDlp.found) problems.push("yt-dlp not found");
  if (ytDlpBroken) problems.push("yt-dlp doesn't run");
  if (!ffmpeg.found) problems.push("ffmpeg missing (needed for video merging and all audio downloads)");
  if (runtimeCheck.status === "warn") problems.push("no JavaScript runtime (recommended for YouTube)");

  hostSummary.dataset.state = problems.length > 0 ? "warn" : "ok";
  hostSummaryText.textContent = problems.length > 0 ? `Connected, but ${problems.join("; ")}.` : "Connected";

  setDetail(
    "host-version",
    supported ? String(pong.hostVersion) : `${pong.hostVersion ?? "unknown"} (needs ${MIN_HOST_VERSION} or newer)`,
    !supported,
  );
  setDetail(
    "host-ytdlp",
    !ytDlp.found
      ? "Not found. Install yt-dlp."
      : ytDlpBroken
        ? `Installed but doesn't run — ${ytDlp.path ?? ""}`
        : `${ytDlp.version} — ${ytDlp.path ?? ""}`,
    !ytDlp.found || ytDlpBroken,
  );
  setDetail("host-ffmpeg", ffmpeg.found ? `Found — ${ffmpeg.path ?? ""}` : "Missing. Install ffmpeg.", !ffmpeg.found);
  setDetail(
    "host-jsruntime",
    runtimeCheck.status === "warn" ? "None found (Deno, or Node 22+). Recommended for YouTube: the setup command installs Deno." : runtimeCheck.detail,
    runtimeCheck.status === "warn" && "warn",
  );
  setDetail(
    "host-picker",
    pong.picker ? String(pong.picker) : "None found. Install zenity, kdialog, or yad for Browse…",
    !pong.picker,
  );
  setDetail("host-default-dir", String(pong.defaultSaveDir ?? "unknown"));
  hostDetails.hidden = false;
  renderSetupHint(view);
}

/**
 * @param {string} message
 */
function renderHostError(message) {
  hostSummary.dataset.state = "error";
  hostSummaryText.textContent = message;
  hostDetails.hidden = true;
  renderSetupHint(deriveSetupState({ ok: false, error: message }));
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

async function openSetupPage() {
  try {
    const result = await browser.runtime.sendMessage({ type: "openSetup" });
    if (!result?.ok) renderHostError(result?.error ?? "Could not open the setup page.");
  } catch (error) {
    renderHostError(`Background page unavailable: ${error.message}`);
  }
}

openSetupButton.addEventListener("click", () => void openSetupPage());
// Always available: the page also shows the status checklist when everything works.
document.getElementById("show-setup").addEventListener("click", () => void openSetupPage());

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
