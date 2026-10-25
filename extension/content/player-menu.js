/*
 * Adds "Download Video" and "Download Audio" to YouTube's own player menu.
 *
 * Right-clicking the player opens YouTube's custom menu instead of the
 * browser's, so the menus API cannot reach it. This script adds rows to that
 * menu (.ytp-contextmenu .ytp-panel-menu) and asks the background page to
 * download the current page's video. The background page re-validates the URL;
 * this script never talks to the native host.
 *
 * Observed YouTube behaviour this relies on (checked 2026-10-25):
 * - The popup is appended to <body> on the first right-click, measured, then
 *   shown. Later opens re-measure, so rows present beforehand are sized correctly.
 * - The popup, its .ytp-panel and the .ytp-panel-menu carry inline pixel heights.
 * - A click outside the popup (on <body>) closes it and keeps YouTube's open/closed
 *   state in sync. Two other ways were rejected: an Escape key event reaches
 *   YouTube's page-wide shortcuts and dropped users out of theater mode, and
 *   hiding the popup with CSS leaves YouTube thinking it is open, so the next
 *   right-click does nothing.
 * If YouTube changes this markup, the rows simply do not appear; the regular
 * right-click menu on links and pages keeps working.
 */
(function () {
  "use strict";

  // Stored as data-ytdlp-downloader="<action>" on each added row.
  const MARKER = "ytdlpDownloader";
  const MARKER_SELECTOR = "[data-ytdlp-downloader]";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ITEMS = [
    {
      action: "video",
      label: "Download Video",
      // Arrow into a tray.
      path: "M11 3h2v9.17l3.59-3.58L18 10l-6 6-6-6 1.41-1.41L11 12.17V3zM5 18h14v2H5v-2z",
    },
    {
      action: "audio",
      label: "Download Audio",
      // Music note.
      path: "M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z",
    },
  ];

  /**
   * Builds one menu row with the same structure as YouTube's own rows.
   * @param {{action: string, label: string, path: string}} item
   * @returns {HTMLDivElement}
   */
  function createRow(item) {
    const row = document.createElement("div");
    row.className = "ytp-menuitem";
    row.setAttribute("role", "menuitem");
    row.tabIndex = 0;
    row.dataset[MARKER] = item.action;

    const icon = document.createElement("div");
    icon.className = "ytp-menuitem-icon";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", item.path);
    path.setAttribute("fill", "white");
    svg.append(path);
    icon.append(svg);

    const label = document.createElement("div");
    label.className = "ytp-menuitem-label";
    label.textContent = item.label;

    const content = document.createElement("div");
    content.className = "ytp-menuitem-content";

    row.append(icon, label, content);
    row.addEventListener("click", (event) => activate(event, row, item.action));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event, row, item.action);
    });
    return row;
  }

  /**
   * Starts a download for the page's video and closes YouTube's menu.
   * @param {Event} event
   * @param {HTMLElement} row
   * @param {string} action "video" or "audio"
   */
  function activate(event, row, action) {
    // Page scripts can synthesize clicks on this row; only a real user starts a download.
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    browser.runtime.sendMessage({ type: "downloadFromPage", action, url: location.href }).catch(() => {
      // The background page reports failures with a notification; nothing to show here.
    });
  }

  /**
   * Adds the rows to the menu once; returns the total height added (0 if already present).
   * @param {Element} menu the .ytp-panel-menu element
   * @returns {number}
   */
  function ensureRows(menu) {
    if (menu.querySelector(MARKER_SELECTOR)) return 0;
    const rows = ITEMS.map(createRow);
    menu.prepend(...rows);
    return rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
  }

  /**
   * Grows the inline heights YouTube set before our rows existed (first open only).
   * @param {Element} menu
   * @param {number} added
   */
  function growMenu(menu, added) {
    const popup = menu.closest(".ytp-popup");
    const panel = menu.closest(".ytp-panel");
    for (const element of [popup, panel, menu]) {
      const height = parseFloat(element?.style.height ?? "");
      if (element && Number.isFinite(height)) element.style.height = `${height + added}px`;
    }
    // Keep the taller popup inside the window instead of running off its bottom edge.
    const top = parseFloat(popup?.style.top ?? "");
    if (popup && Number.isFinite(top)) {
      const overflow = popup.getBoundingClientRect().bottom - window.innerHeight;
      if (overflow > 0) popup.style.top = `${Math.max(0, top - overflow)}px`;
    }
  }

  function findMenu() {
    return document.querySelector(".ytp-contextmenu .ytp-panel-menu");
  }

  /**
   * Calls back once YouTube has built its menu during the current right-click.
   * YouTube appends the popup to <body>; a MutationObserver fires after YouTube's
   * handler but before the next paint, so the corrected height shows from the
   * first frame. The timeout covers a menu that appears some other way.
   * @param {(menu: Element) => void} callback must tolerate running twice
   */
  function whenMenuBuilt(callback) {
    const observer = new MutationObserver(() => {
      const menu = findMenu();
      if (!menu) return;
      observer.disconnect();
      callback(menu);
    });
    observer.observe(document.body, { childList: true });
    setTimeout(() => {
      observer.disconnect();
      const menu = findMenu();
      if (menu) callback(menu);
    }, 100);
  }

  // Capture phase runs before YouTube's own handler, so on every open after the
  // first one the rows are already in place when YouTube measures the menu.
  document.addEventListener(
    "contextmenu",
    (event) => {
      if (!(event.target instanceof Element) || !event.target.closest(".html5-video-player")) return;
      const menu = findMenu();
      if (menu) {
        ensureRows(menu);
        return;
      }
      // First open: YouTube creates and sizes the menu during this event.
      whenMenuBuilt((created) => {
        const added = ensureRows(created);
        if (added > 0) growMenu(created, added);
      });
    },
    true,
  );
})();
