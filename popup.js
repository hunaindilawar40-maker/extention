import { parseCSV, autoMapColumns, buildLeads, toCSV } from "./lib/csv.js";
import {
  getSettings,
  saveSettings,
  getLeads,
  saveLeads,
  getLogs,
  clearLogs,
  getQuota
} from "./lib/storage.js";
import { GROQ_MODELS, DEFAULT_PROMPT_TEMPLATE, DEFAULT_BANNED_PHRASES } from "./lib/constants.js";

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(message, kind = "") {
  const host = $("#toastHost");
  const node = document.createElement("div");
  node.className = `toast ${kind ? "toast-" + kind : ""}`.trim();
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), 3500);
}

function sendBg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response" });
    });
  });
}

function escapeHtml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------
function initTabs() {
  $$(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$(".tab-btn").forEach((b) => b.classList.remove("active"));
      $$(".tab-pane").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $(`#tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

// ---------------------------------------------------------------------
// Settings & Compose tabs
// ---------------------------------------------------------------------
function populateModelSelect(selected, models = GROQ_MODELS) {
  const sel = $("#modelSelect");
  sel.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label || m.id;
    sel.appendChild(opt);
  }

  const availableIds = models.map((model) => model.id);
  const preferred = [selected, "llama-3.1-8b-instant", "llama-3.3-70b-versatile"];
  sel.value = preferred.find((id) => availableIds.includes(id)) || availableIds[0] || "";
}

function modelLabel(model) {
  const known = GROQ_MODELS.find((item) => item.id === model.id);
  const context = model.contextWindow ? ` · ${(model.contextWindow / 1000).toFixed(0)}k context` : "";
  return known ? `${known.label}${context}` : `${model.id}${context}`;
}

async function refreshGroqModels() {
  const apiKey = $("#groqApiKey").value.trim();
  const status = $("#modelStatus");
  const button = $("#btnRefreshModels");
  if (!apiKey) {
    status.textContent = "Enter your Groq API key first.";
    return false;
  }

  const selected = $("#modelSelect").value;
  button.disabled = true;
  status.textContent = "Loading models from Groq…";
  const res = await sendBg({ type: "LIST_GROQ_MODELS", apiKey });
  button.disabled = false;

  if (!res.ok) {
    status.textContent = `Could not load models: ${res.error}`;
    return false;
  }
  if (!res.models?.length) {
    status.textContent = "Groq returned no compatible chat models for this key.";
    return false;
  }

  populateModelSelect(
    selected,
    res.models.map((model) => ({ ...model, label: modelLabel(model) }))
  );
  status.textContent = `${res.models.length} live chat model${res.models.length === 1 ? "" : "s"} available for this key. The list comes directly from Groq.`;
  return true;
}

async function loadSettingsIntoForm() {
  const s = await getSettings();

  $("#groqApiKey").value = s.groqApiKey || "";
  await populateModelSelect(s.model);
  $$('input[name="sendMode"]').forEach((r) => (r.checked = r.value === s.sendMode));
  $$('input[name="sendModeQuick"]').forEach((r) => (r.checked = r.value === s.sendMode));
  $("#delayMin").value = s.delayMinSec;
  $("#delayMax").value = s.delayMaxSec;
  $("#dailyQuota").value = s.dailyQuota;

  $("#senderName").value = s.senderName || "";
  $("#senderCompany").value = s.senderCompany || "";
  $("#offer").value = s.offer || "";
  $("#maxWords").value = s.maxWords;
  $("#maxWordsVal").textContent = s.maxWords;
  $("#temperature").value = s.temperature;
  $("#temperatureVal").textContent = Number(s.temperature).toFixed(2);
  $("#keepSignature").checked = !!s.keepSignature;
  $("#bannedPhrases").value = (s.bannedPhrases || []).join("\n");
  $("#promptTemplate").value = s.promptTemplate || DEFAULT_PROMPT_TEMPLATE;

  return s;
}

function initSettingsEvents() {
  $("#maxWords").addEventListener("input", (e) => ($("#maxWordsVal").textContent = e.target.value));
  $("#temperature").addEventListener("input", (e) => ($("#temperatureVal").textContent = Number(e.target.value).toFixed(2)));

  $("#btnToggleKey").addEventListener("click", () => {
    const input = $("#groqApiKey");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("#btnToggleKey").textContent = show ? "Hide" : "Show";
  });

  $("#btnRefreshModels").addEventListener("click", refreshGroqModels);

  $("#groqApiKey").addEventListener("change", () => {
    if ($("#groqApiKey").value.trim()) refreshGroqModels();
  });

  $("#btnTestKey").addEventListener("click", async () => {
    const apiKey = $("#groqApiKey").value.trim();
    const resultEl = $("#testKeyResult");
    if (!apiKey) {
      resultEl.textContent = "Enter an API key first.";
      return;
    }

    const preferredModel = $("#modelSelect").value;
    resultEl.textContent = "Finding a model your Groq key can use…";
    const res = await sendBg({
      type: "FIND_WORKING_GROQ_MODEL",
      apiKey,
      model: preferredModel
    });
    if (!res.ok) {
      resultEl.textContent = `❌ ${res.error}`;
      return;
    }

    populateModelSelect(
      res.model,
      res.models.map((model) => ({ ...model, label: modelLabel(model) }))
    );
    $("#modelStatus").textContent = `${res.models.length} live chat model${res.models.length === 1 ? "" : "s"} found. ${res.model} was verified with a real completion.`;
    await saveSettings({ groqApiKey: apiKey, model: res.model });
    resultEl.textContent = `✅ Verified and saved: ${res.model}`;
  });

  $("#btnResetPrompt").addEventListener("click", () => {
    $("#promptTemplate").value = DEFAULT_PROMPT_TEMPLATE;
    $("#bannedPhrases").value = DEFAULT_BANNED_PHRASES.join("\n");
  });

  $("#btnSaveSettings").addEventListener("click", async () => {
    const sendMode = $$('input[name="sendMode"]').find((r) => r.checked)?.value || "review";
    const delayMinSec = Math.max(5, Number($("#delayMin").value) || 30);
    const delayMaxSec = Math.max(delayMinSec, Number($("#delayMax").value) || 60);
    await saveSettings({
      groqApiKey: $("#groqApiKey").value.trim(),
      model: $("#modelSelect").value,
      sendMode,
      delayMinSec,
      delayMaxSec,
      dailyQuota: Math.max(1, Number($("#dailyQuota").value) || 60)
    });
    $("#saveSettingsResult").textContent = "Saved ✅";
    setTimeout(() => ($("#saveSettingsResult").textContent = ""), 2000);
    syncQuickSendMode(sendMode);
    toast("Settings saved", "success");
  });

  $("#btnSaveCompose").addEventListener("click", async () => {
    const bannedPhrases = $("#bannedPhrases")
      .value.split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    await saveSettings({
      senderName: $("#senderName").value.trim(),
      senderCompany: $("#senderCompany").value.trim(),
      offer: $("#offer").value.trim(),
      maxWords: Number($("#maxWords").value) || 110,
      temperature: Number($("#temperature").value) || 0.8,
      keepSignature: $("#keepSignature").checked,
      bannedPhrases,
      promptTemplate: $("#promptTemplate").value.trim() || DEFAULT_PROMPT_TEMPLATE
    });
    toast("Compose settings saved", "success");
  });

  $$('input[name="sendModeQuick"]').forEach((radio) => {
    radio.addEventListener("change", async () => {
      await saveSettings({ sendMode: radio.value });
      $$('input[name="sendMode"]').forEach((r) => (r.checked = r.value === radio.value));
    });
  });
  $$('input[name="sendMode"]').forEach((radio) => {
    radio.addEventListener("change", () => syncQuickSendMode(radio.value, true));
  });
}

function syncQuickSendMode(mode, fromSettingsTab) {
  $$('input[name="sendModeQuick"]').forEach((r) => (r.checked = r.value === mode));
  if (!fromSettingsTab) return;
  saveSettings({ sendMode: mode });
}

// ---------------------------------------------------------------------
// Leads tab: CSV import
// ---------------------------------------------------------------------
const MAP_FIELDS = [
  ["firstName", "First Name"],
  ["lastName", "Last Name"],
  ["fullName", "Full Name"],
  ["email", "Email *"],
  ["title", "Job Title"],
  ["company", "Company"],
  ["industry", "Industry"],
  ["description", "Description / Keywords / Tech"],
  ["city", "City"],
  ["state", "State"],
  ["country", "Country"],
  ["website", "Website"],
  ["linkedin", "LinkedIn URL"]
];

let pendingCsv = null; // { headers, rows }

function initCsvImport() {
  const dropZone = $("#dropZone");
  const fileInput = $("#csvFileInput");

  $("#btnBrowseCsv").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleCsvFile(file);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove("dragover");
    })
  );
  dropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files[0];
    if (file) handleCsvFile(file);
  });
}

function handleCsvFile(file) {
  if (!file.name.toLowerCase().endsWith(".csv")) {
    toast("Please upload a .csv file exported from Apollo.io", "error");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const { headers, rows } = parseCSV(String(reader.result));
    if (!headers.length || !rows.length) {
      toast("Could not read any rows from that CSV.", "error");
      return;
    }
    pendingCsv = { headers, rows };
    openMapModal(headers, autoMapColumns(headers));
  };
  reader.readAsText(file);
}

function openMapModal(headers, mapping) {
  const container = $("#mapFields");
  container.innerHTML = "";
  for (const [field, label] of MAP_FIELDS) {
    const wrap = document.createElement("div");
    wrap.className = "map-field";
    const labelEl = document.createElement("label");
    labelEl.textContent = label;
    const select = document.createElement("select");
    select.dataset.field = field;

    const noneOpt = document.createElement("option");
    noneOpt.value = "-1";
    noneOpt.textContent = "— None —";
    select.appendChild(noneOpt);

    headers.forEach((h, idx) => {
      const opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = h;
      select.appendChild(opt);
    });

    const chosen = mapping[field];
    select.value = chosen === null || chosen === undefined ? "-1" : String(chosen);

    wrap.appendChild(labelEl);
    wrap.appendChild(select);
    container.appendChild(wrap);
  }
  $("#mapModal").classList.remove("hidden");
}

function closeMapModal() {
  $("#mapModal").classList.add("hidden");
  pendingCsv = null;
}

function initMapModal() {
  $("#btnMapCancel").addEventListener("click", closeMapModal);
  $("#btnMapConfirm").addEventListener("click", async () => {
    if (!pendingCsv) return;
    const mapping = {};
    $$("#mapFields select").forEach((sel) => {
      mapping[sel.dataset.field] = sel.value === "-1" ? null : Number(sel.value);
    });
    if (mapping.email === null || mapping.email === undefined) {
      toast("Please map the Email column before importing.", "error");
      return;
    }
    const newLeads = buildLeads(pendingCsv.headers, pendingCsv.rows, mapping);
    if (!newLeads.length) {
      toast("No valid rows with an email address were found.", "error");
      return;
    }
    const existing = await getLeads();
    const existingEmails = new Set(existing.map((l) => l.email.toLowerCase()));
    const deduped = newLeads.filter((l) => !existingEmails.has(l.email.toLowerCase()));
    const skipped = newLeads.length - deduped.length;
    const merged = [...existing, ...deduped];
    await saveLeads(merged);
    closeMapModal();
    toast(`Imported ${deduped.length} lead(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ""}.`, "success");
    await renderLeadsTable();
    await renderDashboard();
  });
}

// ---------------------------------------------------------------------
// Leads table
// ---------------------------------------------------------------------
let leadsCache = [];

function statusBadge(status) {
  return `<span class="status-badge status-${status}">${status}</span>`;
}

async function renderLeadsTable() {
  leadsCache = await getLeads();
  applyLeadsFilter();
}

function applyLeadsFilter() {
  const q = $("#leadSearch").value.trim().toLowerCase();
  const filter = $("#leadFilter").value;
  const tbody = $("#leadsTbody");
  tbody.innerHTML = "";

  const filtered = leadsCache.filter((l) => {
    const matchesQ =
      !q ||
      [l.fullName, l.email, l.company, l.title].some((v) => (v || "").toLowerCase().includes(q));
    const matchesStatus = filter === "all" || l.status === filter;
    return matchesQ && matchesStatus;
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">No leads match your search/filter.</td></tr>`;
    return;
  }

  for (const lead of filtered) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div class="lead-name">${escapeHtml(lead.fullName || lead.email)}</div>
        <div class="lead-email">${escapeHtml(lead.email)}</div>
      </td>
      <td>${escapeHtml(lead.company || "—")}</td>
      <td>${statusBadge(lead.status)}</td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" data-action="preview" data-id="${lead.id}" title="Preview email">👁</button>
          <button class="icon-btn" data-action="remove" data-id="${lead.id}" title="Remove lead">✕</button>
        </div>
      </td>`;
    tbody.appendChild(tr);
  }
}

function initLeadsTableEvents() {
  $("#leadSearch").addEventListener("input", applyLeadsFilter);
  $("#leadFilter").addEventListener("change", applyLeadsFilter);

  $("#leadsTbody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === "remove") {
      const leads = await getLeads();
      await saveLeads(leads.filter((l) => l.id !== id));
      await renderLeadsTable();
      await renderDashboard();
    } else if (btn.dataset.action === "preview") {
      const lead = leadsCache.find((l) => l.id === id);
      if (!lead) return;
      const content = $("#previewContent");
      if (lead.subject || lead.body) {
        content.innerHTML = `<div class="pv-subject">${escapeHtml(lead.subject || "(no subject yet)")}</div><div>${escapeHtml(
          lead.body || "(no draft generated yet)"
        ).replace(/\n/g, "<br>")}</div>`;
      } else {
        content.innerHTML = `<div class="hint">No AI draft generated yet for this lead. Start the campaign to generate it.</div>`;
      }
      $("#previewModal").classList.remove("hidden");
    }
  });

  $("#btnPreviewClose").addEventListener("click", () => $("#previewModal").classList.add("hidden"));

  $("#btnClearLeads").addEventListener("click", async () => {
    if (!confirm("Remove all leads from the queue?")) return;
    await saveLeads([]);
    await renderLeadsTable();
    await renderDashboard();
  });
}

// ---------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------
async function renderDashboard() {
  const leads = await getLeads();
  const total = leads.length;
  const sent = leads.filter((l) => l.status === "sent").length;
  const pending = leads.filter((l) => l.status === "pending").length;
  const failed = leads.filter((l) => l.status === "failed").length;

  $("#statTotal").textContent = total;
  $("#statSent").textContent = sent;
  $("#statPending").textContent = pending;
  $("#statFailed").textContent = failed;

  const quotaRes = await sendBg({ type: "GET_QUOTA" });
  if (quotaRes.ok) {
    const pct = Math.min(100, (quotaRes.quota.count / quotaRes.dailyQuota) * 100);
    $("#quotaBarFill").style.width = `${pct}%`;
    $("#quotaText").textContent = `${quotaRes.quota.count} / ${quotaRes.dailyQuota} sent today`;
  }

  const settings = await getSettings();
  syncQuickSendMode(settings.sendMode);
}

async function checkZohoConnection() {
  const badge = $("#connStatus");
  const hint = $("#zohoTabHint");
  badge.className = "conn-badge conn-unknown";
  hint.textContent = "Checking for an open mail.zoho.com tab…";

  const res = await sendBg({ type: "ENSURE_ZOHO_CONNECTION" });
  if (res.ok) {
    badge.className = "conn-badge conn-connected";
    badge.title = "Connected to Zoho Mail tab";
    hint.textContent = `Connected: ${res.tab.title || res.tab.url}`;
  } else {
    badge.className = "conn-badge conn-disconnected";
    badge.title = res.error;
    hint.textContent = res.error || "Not connected. Open mail.zoho.com in a tab.";
  }
  return res;
}

function initDashboardEvents() {
  $("#btnFindTab").addEventListener("click", checkZohoConnection);

  $("#btnStart").addEventListener("click", async () => {
    const settings = await getSettings();
    if (!settings.groqApiKey) {
      toast("Add your Groq API key in Settings first.", "error");
      return;
    }
    const leads = await getLeads();
    const toSend = leads.filter((l) => l.status !== "sent");
    if (!toSend.length) {
      toast("No pending leads to send. Import a CSV in the Leads tab.", "error");
      return;
    }
    const conn = await checkZohoConnection();
    if (!conn.ok) {
      toast(conn.error, "error");
      return;
    }
    const res = await sendBg({ type: "RELAY_TO_ZOHO_TAB", payload: { type: "START_CAMPAIGN", leads: toSend, settings } });
    if (res.ok && res.response?.ok) {
      toast("Campaign started! Watch the HUD inside Zoho Mail.", "success");
    } else {
      toast(res.response?.error || res.error || "Failed to start campaign.", "error");
    }
  });

  $("#btnPause").addEventListener("click", () => relayControl("PAUSE_CAMPAIGN"));
  $("#btnResume").addEventListener("click", () => relayControl("RESUME_CAMPAIGN"));
  $("#btnStop").addEventListener("click", () => relayControl("STOP_CAMPAIGN"));
  $("#btnSkipDelay").addEventListener("click", () => relayControl("SKIP_DELAY"));
}

async function relayControl(type) {
  const res = await sendBg({ type: "RELAY_TO_ZOHO_TAB", payload: { type } });
  if (!res.ok) {
    toast(res.error || "Could not reach the Zoho Mail tab.", "error");
  } else {
    toast(type.replace("_", " ").toLowerCase(), "success");
  }
}

// ---------------------------------------------------------------------
// Logs tab
// ---------------------------------------------------------------------
let logsCache = [];

async function renderLogsTable() {
  logsCache = await getLogs();
  applyLogsFilter();
}

function applyLogsFilter() {
  const q = $("#logSearch").value.trim().toLowerCase();
  const tbody = $("#logsTbody");
  tbody.innerHTML = "";
  const filtered = logsCache.filter(
    (l) => !q || [l.email, l.company, l.subject, l.status].some((v) => (v || "").toLowerCase().includes(q))
  );
  if (!filtered.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="4">No activity yet.</td></tr>`;
    return;
  }
  for (const entry of filtered) {
    const tr = document.createElement("tr");
    const time = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "";
    tr.innerHTML = `
      <td>${escapeHtml(time)}</td>
      <td><div class="lead-name">${escapeHtml(entry.name || entry.email)}</div><div class="lead-email">${escapeHtml(
      entry.email
    )}</div></td>
      <td>${escapeHtml(entry.subject || "—")}</td>
      <td>${statusBadge(entry.status)}</td>`;
    tbody.appendChild(tr);
  }
}

function initLogsEvents() {
  $("#logSearch").addEventListener("input", applyLogsFilter);

  $("#btnExportLogs").addEventListener("click", async () => {
    const logs = await getLogs();
    if (!logs.length) {
      toast("No logs to export yet.", "error");
      return;
    }
    const csv = toCSV(["timestamp", "name", "email", "company", "subject", "status", "error"], logs);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ai-outreach-campaign-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $("#btnClearLogs").addEventListener("click", async () => {
    if (!confirm("Clear all campaign logs?")) return;
    await clearLogs();
    await renderLogsTable();
  });
}

// ---------------------------------------------------------------------
// Live sync while popup is open
// ---------------------------------------------------------------------
function initStorageSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.aoz_leads) {
      renderLeadsTable();
      renderDashboard();
    }
    if (changes.aoz_logs) {
      renderLogsTable();
    }
    if (changes.aoz_quota) {
      renderDashboard();
    }
  });
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
async function init() {
  initTabs();
  initSettingsEvents();
  initCsvImport();
  initMapModal();
  initLeadsTableEvents();
  initDashboardEvents();
  initLogsEvents();
  initStorageSync();

  const settings = await loadSettingsIntoForm();
  if (settings.groqApiKey) await refreshGroqModels();
  await renderLeadsTable();
  await renderDashboard();
  await renderLogsTable();
  await checkZohoConnection();
}

document.addEventListener("DOMContentLoaded", init);
