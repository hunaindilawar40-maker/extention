/**
 * Background service worker for AI Outreach for Zoho Mail.
 *
 * Responsibilities:
 *  - Owns all Groq API calls (keeps the API key out of the Zoho Mail page context).
 *  - Keeps chrome.storage.local in sync (quota resets, settings defaults).
 *  - Acts as a thin message router between the popup and the content script
 *    running inside the Zoho Mail tab (finding the right tab, relaying commands).
 */
import {
  generateColdEmail,
  bodyToHtml,
  testGroqKey,
  listGroqModels,
  findWorkingGroqModel
} from "./lib/groq.js";
import {
  getSettings,
  saveSettings,
  getQuota,
  incrementQuota,
  appendLog,
  saveCampaign,
  getCampaign
} from "./lib/storage.js";
import { DEFAULT_SETTINGS } from "./lib/constants.js";

const ZOHO_URL_PATTERNS = [
  "*://mail.zoho.com/*",
  "*://mail.zoho.eu/*",
  "*://mail.zoho.in/*",
  "*://mail.zoho.com.au/*",
  "*://mail.zoho.com.cn/*",
  "*://mail.zoho.jp/*",
  "*://mail.zohocloud.ca/*",
  "*://mail.zoho.uk/*",
  "*://mail.zoho.sa/*",
  "*://mail.zoho.ca/*"
];

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await getSettings();
  await saveSettings({ ...DEFAULT_SETTINGS, ...existing });
});

async function findZohoTab() {
  const tabs = await chrome.tabs.query({ url: ZOHO_URL_PATTERNS });
  if (!tabs.length) return null;
  // Prefer the currently active/focused Zoho tab if there is one.
  const active = tabs.find((t) => t.active);
  return active || tabs[0];
}

function pingTab(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "PING" }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(!!response?.ok);
      });
    } catch (e) {
      resolve(false);
    }
  });
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "PING": {
      return { ok: true };
    }

    case "FIND_ZOHO_TAB": {
      const tab = await findZohoTab();
      return { ok: true, tab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null };
    }

    case "GENERATE_EMAIL": {
      try {
        const settings = await getSettings();
        const result = await generateColdEmail(message.lead, settings);
        const html = bodyToHtml(result.body);
        return { ok: true, subject: result.subject, bodyText: result.body, bodyHtml: html };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }

    case "LIST_GROQ_MODELS": {
      try {
        const models = await listGroqModels(message.apiKey);
        return { ok: true, models };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }

    case "TEST_API_KEY": {
      try {
        await testGroqKey(message.apiKey, message.model);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }

    case "FIND_WORKING_GROQ_MODEL": {
      try {
        const result = await findWorkingGroqModel(message.apiKey, message.model);
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }

    case "GET_QUOTA": {
      const quota = await getQuota();
      const settings = await getSettings();
      return { ok: true, quota, dailyQuota: settings.dailyQuota };
    }

    case "INCREMENT_QUOTA": {
      const quota = await incrementQuota();
      return { ok: true, quota };
    }

    case "APPEND_LOG": {
      await appendLog(message.entry);
      return { ok: true };
    }

    case "RELAY_TO_ZOHO_TAB": {
      // Popup asks background to forward a control command to the active Zoho tab's content script.
      try {
        const tab = await findZohoTab();
        if (!tab) return { ok: false, error: "No open Zoho Mail tab was found. Open mail.zoho.com first." };
        const response = await chrome.tabs.sendMessage(tab.id, message.payload);
        return { ok: true, response, tabId: tab.id };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }

    case "ENSURE_ZOHO_CONNECTION": {
      try {
        const tab = await findZohoTab();
        if (!tab) {
          return { ok: false, error: "No open Zoho Mail tab found. Open mail.zoho.com in a tab first." };
        }
        const ping = await pingTab(tab.id);
        if (ping) return { ok: true, tab: { id: tab.id, url: tab.url, title: tab.title } };

        // Content script not yet injected (e.g. tab was open before install/reload) — inject it now.
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] });
        const ping2 = await pingTab(tab.id);
        if (ping2) return { ok: true, tab: { id: tab.id, url: tab.url, title: tab.title } };
        return { ok: false, error: "Zoho Mail tab found, but the content script did not respond. Try reloading the Zoho Mail tab." };
      } catch (err) {
        return { ok: false, error: err?.message || String(err) };
      }
    }

    case "SET_CAMPAIGN_TAB": {
      await saveCampaign({ tabId: message.tabId, running: message.running, paused: false });
      return { ok: true };
    }

    case "GET_CAMPAIGN": {
      const campaign = await getCampaign();
      return { ok: true, campaign };
    }

    default:
      return { ok: false, error: `Unknown message type: ${message?.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true; // keep the message channel open for the async response
});
