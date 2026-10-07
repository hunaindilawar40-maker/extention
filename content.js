/**
 * AI Outreach for Zoho Mail — content script.
 *
 * Runs on mail.zoho.com (and regional Zoho Mail domains). Responsible for:
 *  - Rendering the floating HUD overlay with live campaign status + controls.
 *  - Driving Zoho Mail's compose UI: opening compose, filling To/Subject/Body,
 *    and sending (or waiting for 1-click review approval).
 *  - Running the send loop with randomized human-like delays, pause/resume/stop/skip,
 *    and daily quota enforcement, coordinating with background.js for AI generation.
 *
 * NOTE ON SELECTORS: Zoho Mail's internal markup is not publicly documented and can
 * change without notice. Every DOM lookup below uses multiple, generous fallback
 * strategies (aria-label, placeholder, role, visible text) rather than brittle
 * auto-generated class names, and everything is centralized in the SELECTORS /
 * TEXT_HINTS objects right below so it's easy to extend if Zoho tweaks its UI.
 */
(function () {
  "use strict";

  if (window.__AOZ_CONTENT_LOADED__) return; // avoid double-init on SPA re-injection
  window.__AOZ_CONTENT_LOADED__ = true;

  // ---------------------------------------------------------------------
  // Config: selectors & text hints used to locate Zoho Mail UI elements
  // ---------------------------------------------------------------------
  const SELECTORS = {
    composeButton: [
      '[data-id="createMail"]',
      '[title="New Mail" i]',
      '[aria-label="New Mail" i]',
      '[aria-label="Compose" i]',
      '#cCompose',
      '.cCompose'
    ],
    toInput: [
      'textarea[aria-label="To" i]',
      'input[aria-label="To" i]',
      '[aria-label="To" i] input',
      '[aria-label="To" i] textarea',
      'textarea[placeholder="To" i]',
      'input[placeholder="To" i]',
      'input[placeholder*="recipient" i]',
      'input[placeholder*="email" i]',
      'input[name="to" i]',
      'input[name="toaddr" i]',
      '[role="combobox"][aria-label*="to" i]',
      '[role="combobox"][aria-label*="recipient" i]',
      '[contenteditable="true"][aria-label*="to" i]',
      '[contenteditable="true"][aria-label*="recipient" i]',
      '[data-cke-field="to"] input',
      '[id*="toaddr" i]',
      '[id*="recipient" i] input'
    ],
    subjectInput: [
      'input[aria-label="Subject" i]',
      'input[placeholder="Subject" i]',
      'input[name="subject" i]',
      '[data-cke-field="subject"] input',
      '[id*="subject" i] input'
    ],
    bodyEditable: [
      // Explicitly labelled editors (most reliable).
      '[aria-label="Body" i][contenteditable="true"]',
      '[aria-label*="email body" i][contenteditable="true"]',
      '[aria-label*="message" i][contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      '[role="textbox"][contenteditable="true"]',
      // CKEditor-style surfaces.
      'div.cke_editable[contenteditable="true"]',
      '.cke_editable.cke_editable_themed',
      // Zoho's in-house editor (class names are unstable — kept as fallbacks only).
      '.zeditor[contenteditable="true"]',
      '[class*="ze_body" i][contenteditable="true"]',
      '[class*="editor" i][contenteditable="true"][role="textbox"]',
      // Iframe-based editors: the editable node is the frame's own <body>.
      'body[contenteditable="true"]',
      'body[contenteditable=""]',
      'body[contenteditable]',
      // Generic fallbacks — any tag, including contenteditable="" (which means "true").
      'div[contenteditable="true"]',
      'div[contenteditable=""]',
      '[contenteditable="plaintext-only"]'
    ],
    sendButton: [
      'button[aria-label="Send" i]',
      '[title="Send" i]',
      'button[data-id="sendMail"]',
      '[role="button"][aria-label="Send" i]'
    ],
    composePanel: [
      '[role="dialog"]',
      '.compose-container',
      '[class*="compose" i]'
    ]
  };

  const TEXT_HINTS = {
    compose: /^(new mail|compose|new email|write)$/i,
    send: /^send$/i,
    discard: /^(discard|delete draft)$/i
  };

  // ---------------------------------------------------------------------
  // Small DOM / async utilities
  // ---------------------------------------------------------------------
  function isVisible(el) {
    // nodeType check (realm-safe) instead of `instanceof Element`: elements
    // inside same-origin iframes belong to another realm in some embeddings.
    if (!el || el.nodeType !== 1) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  }

  function queryFirst(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const nodes = root.querySelectorAll(sel);
        for (const node of nodes) {
          if (isVisible(node)) return node;
        }
      } catch (e) {
        /* invalid selector in this Chrome version, skip */
      }
    }
    return null;
  }

  function queryAllVisible(selectors, root = document) {
    const out = [];
    for (const sel of selectors) {
      try {
        root.querySelectorAll(sel).forEach((n) => {
          if (isVisible(n)) out.push(n);
        });
      } catch (e) {
        /* ignore */
      }
    }
    return out;
  }

  /** Finds a clickable element whose visible text matches `regex`, searching buttons/links/divs/spans. */
  function findByText(regex, root = document) {
    const candidates = root.querySelectorAll('button, a, div[role="button"], span[role="button"], li, div, span');
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || "").trim();
      if (text && text.length < 40 && regex.test(text)) {
        return el;
      }
    }
    return null;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(fn, { timeout = 8000, interval = 200 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = fn();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Collects same-origin iframe documents under a root (Element or Document),
   * recursively — Zoho sometimes nests the editor one or more frames deep.
   */
  function iframeDocsIn(root, depth = 0) {
    const docs = [];
    if (depth > 3 || !root || !root.querySelectorAll) return docs;
    root.querySelectorAll("iframe").forEach((frame) => {
      try {
        const doc = frame.contentDocument;
        if (doc) {
          docs.push(doc);
          docs.push(...iframeDocsIn(doc, depth + 1));
        }
      } catch (e) {
        /* cross-origin, skip */
      }
    });
    return docs;
  }

  /** Collects this page's document plus every same-origin iframe document reachable from it. */
  function accessibleDocuments() {
    return [document, ...iframeDocsIn(document)];
  }

  /**
   * Roots to search when a compose scope is known: the scope element itself
   * (top-document part of the compose UI) PLUS the documents of any same-origin
   * iframes mounted inside it. This matters because Zoho renders the email body
   * editor inside an iframe within the compose panel, and querySelectorAll can
   * never cross frame boundaries — without this the body editor is invisible to
   * a scoped lookup even though it is visually part of the compose window.
   */
  function scopedSearchRoots(scope) {
    if (!scope) return accessibleDocuments();
    return [scope, ...iframeDocsIn(scope)];
  }

  function queryFirstAcrossDocs(selectors, scope) {
    const roots = scopedSearchRoots(scope);
    for (const root of roots) {
      const found = queryFirst(selectors, root);
      if (found) return found;
    }
    return null;
  }

  function findByTextAcrossDocs(regex, scope) {
    const roots = scopedSearchRoots(scope);
    for (const root of roots) {
      const found = findByText(regex, root);
      if (found) return found;
    }
    return null;
  }

  /**
   * Walks up from a known compose-field element to find the smallest reasonable
   * container (dialog/panel) that wraps the whole compose window, so subsequent
   * lookups (subject, body, send button) don't accidentally pick up unrelated
   * elements elsewhere on the page (e.g. a second open compose window).
   */
  function getComposeScope(anchorEl) {
    if (!anchorEl) return null;
    let node = anchorEl;
    for (let i = 0; i < 14 && node; i++) {
      if (node.matches) {
        const cls = typeof node.className === "string" ? node.className : "";
        if (node.matches('[role="dialog"]') || /compose/i.test(cls)) {
          return node;
        }
      }
      node = node.parentElement;
    }
    return null; // fall back to document-wide search
  }

  // ---------------------------------------------------------------------
  // Native input setters (so framework-bound React/Angular-like listeners fire)
  // ---------------------------------------------------------------------
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  ).set;

  function setNativeValue(el, value) {
    if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
      el.textContent = value;
    } else {
      const setter = el.tagName === "TEXTAREA" ? nativeTextareaValueSetter : nativeInputValueSetter;
      setter.call(el, value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function dispatchKey(el, key, keyCode) {
    const opts = { key, keyCode, which: keyCode, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  /** Simulates realistic human typing into a text input/textarea, character by character. */
  async function simulateTyping(el, text, { minDelay = 18, maxDelay = 55 } = {}) {
    el.focus();
    setNativeValue(el, "");
    let buffer = "";
    for (const ch of text) {
      buffer += ch;
      setNativeValue(el, buffer);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      await sleep(randInt(minDelay, maxDelay));
    }
  }

  // ---------------------------------------------------------------------
  // HUD state + rendering
  // ---------------------------------------------------------------------
  const state = {
    running: false,
    paused: false,
    stopped: false,
    leads: [],
    settings: null,
    index: -1,
    currentLead: null,
    reviewResolve: null,
    skipDelayRequested: false,
    countdownTimer: null,
    minimized: false
  };

  let hudRoot = null;
  let elRefs = {};

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of [].concat(children)) {
      if (child) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function buildHUD() {
    if (hudRoot) return;

    const launcher = el("button", {
      id: "aoz-launcher",
      class: "aoz-launcher aoz-hidden",
      title: "Open AI Outreach HUD",
      text: "✉",
      onclick: () => {
        launcher.classList.add("aoz-hidden");
        hudRoot.classList.remove("aoz-hidden");
      }
    });

    const closeBtn = el("button", {
      class: "aoz-close-btn",
      title: "Minimize",
      text: "–",
      onclick: () => {
        hudRoot.classList.add("aoz-hidden");
        launcher.classList.remove("aoz-hidden");
      }
    });

    const minBtn = el("button", {
      class: "aoz-min-btn",
      title: "Collapse",
      text: "▾",
      onclick: () => {
        state.minimized = !state.minimized;
        hudRoot.classList.toggle("aoz-minimized", state.minimized);
        minBtn.textContent = state.minimized ? "▸" : "▾";
      }
    });

    const header = el(
      "div",
      { class: "aoz-header" },
      [el("div", { class: "aoz-logo-dot" }), el("div", { class: "aoz-title", text: "AI Outreach" }), minBtn, closeBtn]
    );
    makeDraggable(header, () => hudRoot);

    const avatar = el("div", { class: "aoz-avatar", text: "–" });
    const leadName = el("div", { class: "aoz-lead-name", text: "No campaign running" });
    const leadSub = el("div", { class: "aoz-lead-sub", text: "Start a campaign from the extension popup" });
    const leadRow = el("div", { class: "aoz-lead-row" }, [avatar, el("div", { class: "aoz-lead-info" }, [leadName, leadSub])]);

    const step = el("div", { class: "aoz-step" }, ["Idle"]);

    const countdownLabel = el("span", { text: "Next send in" });
    const countdownTime = el("span", { class: "aoz-countdown-time", text: "--:--" });
    const countdownWrap = el("div", { class: "aoz-countdown-wrap" }, [
      el("div", { class: "aoz-countdown-label" }, [countdownLabel, countdownTime]),
      el("div", { class: "aoz-progress-track" }, [el("div", { class: "aoz-progress-fill" })])
    ]);

    const skipDelayBtn = el("button", { class: "aoz-btn", text: "Skip Delay", onclick: onSkipDelay });
    const pauseResumeBtn = el("button", { class: "aoz-btn aoz-btn-warn", text: "Pause", onclick: onPauseResume });
    const stopBtn = el("button", { class: "aoz-btn aoz-btn-danger", text: "Stop", onclick: onStop });
    const btnRow = el("div", { class: "aoz-btn-row" }, [skipDelayBtn, pauseResumeBtn, stopBtn]);

    const approveBtn = el("button", { class: "aoz-btn aoz-btn-primary", text: "Approve & Send", onclick: onApproveSend });
    const skipLeadBtn = el("button", { class: "aoz-btn", text: "Skip Lead", onclick: onSkipLead });
    const reviewRow = el("div", { class: "aoz-review-row" }, [approveBtn, skipLeadBtn]);

    const quotaPill = el("span", { class: "aoz-quota-pill", text: "0 / 0 today" });
    const footer = el("div", { class: "aoz-footer" }, [el("span", { text: "mail.zoho.com" }), quotaPill]);

    const body = el("div", { class: "aoz-body" }, [leadRow, step, countdownWrap, btnRow, reviewRow, footer]);
    const card = el("div", { class: "aoz-card" }, [header, body]);

    hudRoot = el("div", { id: "aoz-hud-root", class: "aoz-hidden" }, [card]);

    document.documentElement.appendChild(hudRoot);
    document.documentElement.appendChild(launcher);

    elRefs = {
      launcher,
      avatar,
      leadName,
      leadSub,
      step,
      countdownWrap,
      countdownTime,
      progressFill: countdownWrap.querySelector(".aoz-progress-fill"),
      pauseResumeBtn,
      reviewRow,
      quotaPill
    };
  }

  function makeDraggable(handle, getTarget) {
    let dragging = false;
    let startX, startY, startRight, startTop;
    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      const target = getTarget();
      const rect = target.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startRight = window.innerWidth - rect.right;
      startTop = rect.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const target = getTarget();
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      target.style.right = `${Math.max(4, startRight - dx)}px`;
      target.style.top = `${Math.max(4, startTop + dy)}px`;
    });
    window.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  function showHUD() {
    buildHUD();
    hudRoot.classList.remove("aoz-hidden");
    elRefs.launcher.classList.add("aoz-hidden");
  }

  function setStep(text, kind) {
    buildHUD();
    elRefs.step.className = "aoz-step" + (kind === "error" ? " aoz-step-error" : kind === "success" ? " aoz-step-success" : "");
    elRefs.step.innerHTML = "";
    if (kind === "loading") elRefs.step.appendChild(el("div", { class: "aoz-spinner" }));
    elRefs.step.appendChild(document.createTextNode(text));
  }

  function setLeadCard(lead) {
    buildHUD();
    if (!lead) {
      elRefs.avatar.textContent = "–";
      elRefs.leadName.textContent = "No campaign running";
      elRefs.leadSub.textContent = "Start a campaign from the extension popup";
      return;
    }
    const initial = (lead.firstName || lead.fullName || lead.email || "?").trim().charAt(0).toUpperCase();
    elRefs.avatar.textContent = initial || "?";
    elRefs.leadName.textContent = lead.fullName || lead.email;
    elRefs.leadSub.textContent = [lead.company, lead.email].filter(Boolean).join(" · ");
  }

  function setReviewVisible(visible) {
    buildHUD();
    elRefs.reviewRow.classList.toggle("aoz-visible", !!visible);
  }

  function setQuotaText(count, max) {
    buildHUD();
    elRefs.quotaPill.textContent = `${count} / ${max} today`;
  }

  function showToast(message, ms = 3500) {
    const toast = el("div", { class: "aoz-toast", text: message });
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), ms);
  }

  // ---------------------------------------------------------------------
  // HUD button handlers
  // ---------------------------------------------------------------------
  function onSkipDelay() {
    state.skipDelayRequested = true;
  }

  function onPauseResume() {
    state.paused = !state.paused;
    elRefs.pauseResumeBtn.textContent = state.paused ? "Resume" : "Pause";
    setStep(state.paused ? "Paused by user" : "Resuming…");
  }

  function onStop() {
    state.stopped = true;
    state.paused = false;
    if (state.reviewResolve) {
      state.reviewResolve("stop");
      state.reviewResolve = null;
    }
    setStep("Stopping campaign…", "error");
  }

  function onApproveSend() {
    if (state.reviewResolve) {
      state.reviewResolve("send");
      state.reviewResolve = null;
      setReviewVisible(false);
    }
  }

  function onSkipLead() {
    if (state.reviewResolve) {
      state.reviewResolve("skip");
      state.reviewResolve = null;
      setReviewVisible(false);
    }
  }

  // ---------------------------------------------------------------------
  // Background messaging helper
  // ---------------------------------------------------------------------
  function sendBg(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: "No response" });
        });
      } catch (e) {
        resolve({ ok: false, error: e.message });
      }
    });
  }

  // ---------------------------------------------------------------------
  // chrome.storage helpers (content scripts can use chrome.storage directly)
  // ---------------------------------------------------------------------
  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, (res) => resolve(res || {})));
  }
  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, () => resolve()));
  }

  async function updateLeadInStorage(id, patch) {
    const { aoz_leads: leads = [] } = await storageGet(["aoz_leads"]);
    const idx = leads.findIndex((l) => l.id === id);
    if (idx !== -1) {
      leads[idx] = { ...leads[idx], ...patch };
      await storageSet({ aoz_leads: leads });
    }
  }

  async function appendLogEntry(entry) {
    const { aoz_logs: logs = [] } = await storageGet(["aoz_logs"]);
    logs.unshift(entry);
    await storageSet({ aoz_logs: logs.slice(0, 5000) });
  }

  async function refreshQuotaPill() {
    const res = await sendBg({ type: "GET_QUOTA" });
    if (res.ok) setQuotaText(res.quota.count, res.dailyQuota);
  }

  // ---------------------------------------------------------------------
  // Zoho Mail DOM automation
  // ---------------------------------------------------------------------
  async function openCompose() {
    // Reuse an already-open compose, including Zoho's newer layout where the
    // recipient control is mounted only after the compose shell appears.
    let toInput = queryFirstAcrossDocs(SELECTORS.toInput);
    if (toInput) return;
    const composeAlreadyOpen = queryFirstAcrossDocs(SELECTORS.composePanel) ||
      queryFirstAcrossDocs(SELECTORS.subjectInput) ||
      queryFirstAcrossDocs(SELECTORS.bodyEditable);
    if (composeAlreadyOpen) {
      toInput = await waitFor(() => queryFirstAcrossDocs(SELECTORS.toInput), { timeout: 60000 });
      if (toInput) return;
    }

    // No compose is open, so open a fresh one automatically for this lead.
    let btn = queryFirstAcrossDocs(SELECTORS.composeButton) || findByTextAcrossDocs(TEXT_HINTS.compose);
    if (btn) {
      btn.click();
    } else {
      // Fallback: Zoho Mail's default keyboard shortcut for compose is "c".
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    }

    toInput = await waitFor(() => queryFirstAcrossDocs(SELECTORS.toInput), { timeout: 10000 });
    if (!toInput) {
      throw new Error("Could not find or open the Zoho Mail compose window. Open 'New Mail' manually and retry.");
    }
    // Give Zoho's compose panel a moment to fully mount (subject/body fields render async).
    await sleep(500);
  }

  async function fillRecipient(email, scope) {
    const toInput = await waitFor(() => queryFirstAcrossDocs(SELECTORS.toInput, scope), { timeout: 6000 });
    if (!toInput) throw new Error('Could not find the "To" field in the Zoho compose window.');

    toInput.click();
    toInput.focus();
    await simulateTyping(toInput, email);
    await sleep(250);
    // Force pill/token creation.
    dispatchKey(toInput, "Enter", 13);
    await sleep(200);
    const recipientValue = () => (toInput.value || toInput.textContent || "").trim();
    if (recipientValue().length > 0) {
      // Some Zoho layouts use comma instead of Enter to tokenize.
      dispatchKey(toInput, ",", 188);
      await sleep(200);
    }
    if (recipientValue().length > 0) {
      toInput.blur();
      await sleep(200);
    }
    return toInput;
  }

  async function fillSubject(subject, scope) {
    const subjectInput = await waitFor(() => queryFirstAcrossDocs(SELECTORS.subjectInput, scope), { timeout: 6000 });
    if (!subjectInput) throw new Error("Could not find the Subject field in the Zoho compose window.");
    subjectInput.click();
    subjectInput.focus();
    await simulateTyping(subjectInput, subject, { minDelay: 10, maxDelay: 30 });
  }

  /**
   * True for compose header controls (To/Cc/Bcc/Subject). Some Zoho layouts
   * render these as contenteditable divs, so the generic "any contenteditable"
   * fallbacks must never mistake them for the body editor.
   */
  function looksLikeComposeField(el) {
    // nodeType check (realm-safe) — see isVisible(). Non-elements can never be
    // the body editor, so they are treated as compose-field-like (rejected).
    if (!el || el.nodeType !== 1) return true;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true;
    const hints = [
      el.getAttribute("aria-label") || "",
      el.getAttribute("placeholder") || "",
      el.getAttribute("data-cke-field") || "",
      el.getAttribute("name") || ""
    ].join(" ");
    return /\b(to|cc|bcc|subject|recipient|attendee)\b/i.test(hints);
  }

  /**
   * Locates the email body editor for the current compose window.
   *
   * Strategy (in order):
   *  1. Known selectors, searched inside the compose scope AND inside every
   *     same-origin iframe mounted within it (Zoho renders the editor surface
   *     in a nested iframe — querySelectorAll alone can never reach it).
   *  2. Iframe editors whose editable node is the frame's <body>: matches
   *     contenteditable bodies, plus designMode="on" documents (older Zoho
   *     editor style, which sets no contenteditable attribute at all).
   * Anything that looks like a To/Cc/Bcc/Subject control is rejected.
   */
  function findBodyEditor(scope) {
    const roots = scopedSearchRoots(scope);

    // Pass 1: selector-based lookup.
    for (const root of roots) {
      for (const sel of SELECTORS.bodyEditable) {
        try {
          const nodes = root.querySelectorAll(sel);
          for (const node of nodes) {
            if (isVisible(node) && !looksLikeComposeField(node)) return node;
          }
        } catch (e) {
          /* invalid selector in this Chrome version, skip */
        }
      }
    }

    // Pass 2: iframe-body editors (contenteditable <body>, or designMode frames).
    for (const doc of roots) {
      if (!doc || doc.nodeType !== 9) continue;
      try {
        const frameBody = doc.body;
        if (frameBody && frameBody !== document.body && !looksLikeComposeField(frameBody)) {
          if (frameBody.isContentEditable || doc.designMode === "on") return frameBody;
        }
      } catch (e) {
        /* skip */
      }
    }

    return null;
  }

  async function fillBody(html, keepSignature, scope) {
    // The editor iframe mounts asynchronously — give it a generous window.
    const body = await waitFor(() => findBodyEditor(scope), { timeout: 15000, interval: 250 });
    if (!body) {
      throw new Error(
        "Could not find the email body editor in the Zoho compose window. " +
          "Try switching Zoho Mail's compose editor to 'Plain text' and back (Settings > Compose), or click into the email body once, then restart the campaign."
      );
    }

    // For iframe-based editors, focus the frame's window before the element.
    const ownerDoc = body.ownerDocument;
    if (ownerDoc && ownerDoc !== document && ownerDoc.defaultView) {
      try {
        ownerDoc.defaultView.focus();
      } catch (e) {
        /* ignore */
      }
    }
    body.focus();

    if (!keepSignature) {
      body.innerHTML = html;
    } else {
      // Preserve whatever Zoho already inserted (e.g. the user's default signature)
      // by prepending our generated content rather than overwriting the editor.
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html + "<div><br></div>";
      body.insertBefore(wrapper, body.firstChild);
    }

    body.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    await sleep(200);
  }

  async function clickSendButton(scope) {
    const sendBtn =
      queryFirstAcrossDocs(SELECTORS.sendButton, scope) || findByTextAcrossDocs(TEXT_HINTS.send, scope);
    if (!sendBtn) throw new Error("Could not find the Send button in the Zoho compose window.");
    sendBtn.click();
    await sleep(600);
  }

  function closeComposeIfOpen(scope) {
    // Best-effort: try the discard/close control so skipped drafts don't pile up.
    const discardBtn = findByTextAcrossDocs(TEXT_HINTS.discard, scope);
    if (discardBtn) discardBtn.click();
  }

  let activeComposeScope = null;

  async function openComposeAndFill(lead, subject, bodyHtml, keepSignature) {
    await openCompose();
    const toInput = await waitFor(() => queryFirstAcrossDocs(SELECTORS.toInput), { timeout: 6000 });
    const scope = getComposeScope(toInput);
    activeComposeScope = scope;
    await fillRecipient(lead.email, scope);
    await fillSubject(subject, scope);
    await fillBody(bodyHtml, keepSignature, scope);
    return scope;
  }

  // ---------------------------------------------------------------------
  // Campaign loop
  // ---------------------------------------------------------------------
  async function waitWhilePaused() {
    while (state.paused && !state.stopped) {
      await sleep(300);
    }
  }

  async function cooldown(minSec, maxSec) {
    const totalMs = randInt(minSec, maxSec) * 1000;
    const start = Date.now();
    state.skipDelayRequested = false;
    elRefs.countdownWrap.classList.add("aoz-visible");

    while (Date.now() - start < totalMs) {
      if (state.stopped) break;
      if (state.skipDelayRequested) break;
      if (state.paused) {
        await sleep(300);
        continue;
      }
      const remainingMs = totalMs - (Date.now() - start);
      const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
      const mm = String(Math.floor(remainingSec / 60)).padStart(2, "0");
      const ss = String(remainingSec % 60).padStart(2, "0");
      elRefs.countdownTime.textContent = `${mm}:${ss}`;
      elRefs.progressFill.style.width = `${Math.min(100, ((Date.now() - start) / totalMs) * 100)}%`;
      await sleep(250);
    }
    elRefs.countdownWrap.classList.remove("aoz-visible");
    elRefs.progressFill.style.width = "0%";
  }

  function waitForReviewDecision() {
    setReviewVisible(true);
    return new Promise((resolve) => {
      state.reviewResolve = resolve;
    });
  }

  async function runCampaign(leads, settings) {
    state.running = true;
    state.stopped = false;
    state.paused = false;
    state.leads = leads;
    state.settings = settings;
    showHUD();
    await refreshQuotaPill();

    for (let i = 0; i < leads.length; i++) {
      state.index = i;
      const lead = leads[i];
      if (state.stopped) break;
      if (lead.status === "sent") continue;

      await waitWhilePaused();
      if (state.stopped) break;

      setLeadCard(lead);

      const quotaRes = await sendBg({ type: "GET_QUOTA" });
      if (quotaRes.ok && quotaRes.quota.count >= quotaRes.dailyQuota) {
        setStep(`Daily quota of ${quotaRes.dailyQuota} reached — campaign stopped to protect your Zoho account.`, "error");
        showToast("Daily sending quota reached. Campaign stopped.");
        break;
      }

      setStep("Generating AI draft…", "loading");
      await updateLeadInStorage(lead.id, { status: "generating" });
      const gen = await sendBg({ type: "GENERATE_EMAIL", lead });

      if (!gen.ok) {
        await updateLeadInStorage(lead.id, { status: "failed", error: gen.error });
        await appendLogEntry(logRow(lead, "", "failed", gen.error));
        setStep(`AI generation failed: ${gen.error}`, "error");
        await sleep(1500);
        continue;
      }

      setStep("Opening compose & injecting email…", "loading");
      try {
        await openComposeAndFill(lead, gen.subject, gen.bodyHtml, settings.keepSignature);
      } catch (err) {
        await updateLeadInStorage(lead.id, { status: "failed", error: err.message, subject: gen.subject, body: gen.bodyText });
        await appendLogEntry(logRow(lead, gen.subject, "failed", err.message));
        setStep(err.message, "error");
        await sleep(2000);
        continue;
      }

      await updateLeadInStorage(lead.id, { status: "injected", subject: gen.subject, body: gen.bodyText });

      if (settings.sendMode === "auto") {
        setStep("Sending…", "loading");
        try {
          await clickSendButton(activeComposeScope);
          await updateLeadInStorage(lead.id, { status: "sent", sentAt: Date.now() });
          await sendBg({ type: "INCREMENT_QUOTA" });
          await appendLogEntry(logRow(lead, gen.subject, "sent", ""));
          setStep("Sent!", "success");
          await refreshQuotaPill();
        } catch (err) {
          await updateLeadInStorage(lead.id, { status: "failed", error: err.message });
          await appendLogEntry(logRow(lead, gen.subject, "failed", err.message));
          setStep(err.message, "error");
        }
      } else {
        setStep("Draft ready — review in Zoho Mail, then Approve & Send.", "success");
        const decision = await waitForReviewDecision();
        if (decision === "stop") {
          state.stopped = true;
          break;
        } else if (decision === "send") {
          setStep("Sending…", "loading");
          try {
            await clickSendButton(activeComposeScope);
            await updateLeadInStorage(lead.id, { status: "sent", sentAt: Date.now() });
            await sendBg({ type: "INCREMENT_QUOTA" });
            await appendLogEntry(logRow(lead, gen.subject, "sent", ""));
            setStep("Sent!", "success");
            await refreshQuotaPill();
          } catch (err) {
            await updateLeadInStorage(lead.id, { status: "failed", error: err.message });
            await appendLogEntry(logRow(lead, gen.subject, "failed", err.message));
            setStep(err.message, "error");
          }
        } else {
          await updateLeadInStorage(lead.id, { status: "skipped" });
          await appendLogEntry(logRow(lead, gen.subject, "skipped", "Skipped by user during review"));
          closeComposeIfOpen(activeComposeScope);
          setStep("Lead skipped.", "error");
        }
      }

      if (!state.stopped && i < leads.length - 1) {
        setStep("Cooldown before next lead…");
        await cooldown(settings.delayMinSec, settings.delayMaxSec);
      }
    }

    state.running = false;
    setLeadCard(null);
    setReviewVisible(false);
    setStep(state.stopped ? "Campaign stopped." : "Campaign complete 🎉", state.stopped ? "error" : "success");
  }

  function logRow(lead, subject, status, error) {
    return {
      timestamp: new Date().toISOString(),
      email: lead.email,
      name: lead.fullName,
      company: lead.company,
      subject: subject || "",
      status,
      error: error || ""
    };
  }

  // ---------------------------------------------------------------------
  // Message listener (popup -> content script)
  // ---------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      switch (message?.type) {
        case "PING":
          sendResponse({ ok: true, running: state.running });
          break;
        case "START_CAMPAIGN":
          if (state.running) {
            sendResponse({ ok: false, error: "A campaign is already running in this tab." });
            return;
          }
          showHUD();
          runCampaign(message.leads, message.settings);
          sendResponse({ ok: true });
          break;
        case "PAUSE_CAMPAIGN":
          state.paused = true;
          if (elRefs.pauseResumeBtn) elRefs.pauseResumeBtn.textContent = "Resume";
          setStep("Paused by user");
          sendResponse({ ok: true });
          break;
        case "RESUME_CAMPAIGN":
          state.paused = false;
          if (elRefs.pauseResumeBtn) elRefs.pauseResumeBtn.textContent = "Pause";
          setStep("Resuming…");
          sendResponse({ ok: true });
          break;
        case "STOP_CAMPAIGN":
          onStop();
          sendResponse({ ok: true });
          break;
        case "SKIP_DELAY":
          onSkipDelay();
          sendResponse({ ok: true });
          break;
        case "APPROVE_SEND":
          onApproveSend();
          sendResponse({ ok: true });
          break;
        case "SKIP_LEAD":
          onSkipLead();
          sendResponse({ ok: true });
          break;
        case "GET_STATUS":
          sendResponse({
            ok: true,
            running: state.running,
            paused: state.paused,
            index: state.index,
            total: state.leads.length
          });
          break;
        default:
          sendResponse({ ok: false, error: "Unknown message type" });
      }
    })();
    return true;
  });

  // Build the (hidden) HUD shell early so the launcher button is ready once a campaign starts.
  buildHUD();

  // Test seam: exposes internals for the automated DOM tests in test/.
  // Opt-in only (never set on real pages), so this is inert in production.
  if (window.__AOZ_EXPOSE_FOR_TESTS__) {
    window.__aozTestHelpers = {
      SELECTORS,
      findBodyEditor,
      queryFirstAcrossDocs,
      getComposeScope,
      iframeDocsIn,
      accessibleDocuments
    };
  }
})();
