/**
 * Thin wrapper around chrome.storage.local with sane defaults and helpers.
 * ES module — imported by background.js and popup.js.
 */
import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  todayStr
} from "./constants.js";

export function getAll(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

export function set(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

export async function getSettings() {
  const { [STORAGE_KEYS.SETTINGS]: settings } = await getAll([STORAGE_KEYS.SETTINGS]);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const merged = { ...current, ...partial };
  await set({ [STORAGE_KEYS.SETTINGS]: merged });
  return merged;
}

export async function getLeads() {
  const { [STORAGE_KEYS.LEADS]: leads } = await getAll([STORAGE_KEYS.LEADS]);
  return leads || [];
}

export async function saveLeads(leads) {
  await set({ [STORAGE_KEYS.LEADS]: leads });
  return leads;
}

export async function updateLead(id, patch) {
  const leads = await getLeads();
  const idx = leads.findIndex((l) => l.id === id);
  if (idx === -1) return leads;
  leads[idx] = { ...leads[idx], ...patch };
  await saveLeads(leads);
  return leads;
}

export async function getLogs() {
  const { [STORAGE_KEYS.LOGS]: logs } = await getAll([STORAGE_KEYS.LOGS]);
  return logs || [];
}

export async function appendLog(entry) {
  const logs = await getLogs();
  logs.unshift(entry);
  await set({ [STORAGE_KEYS.LOGS]: logs.slice(0, 5000) });
  return logs;
}

export async function clearLogs() {
  await set({ [STORAGE_KEYS.LOGS]: [] });
}

export async function getQuota() {
  const { [STORAGE_KEYS.QUOTA]: quota } = await getAll([STORAGE_KEYS.QUOTA]);
  const today = todayStr();
  if (!quota || quota.date !== today) {
    const fresh = { date: today, count: 0 };
    await set({ [STORAGE_KEYS.QUOTA]: fresh });
    return fresh;
  }
  return quota;
}

export async function incrementQuota() {
  const quota = await getQuota();
  quota.count += 1;
  await set({ [STORAGE_KEYS.QUOTA]: quota });
  return quota;
}

export async function getCampaign() {
  const { [STORAGE_KEYS.CAMPAIGN]: campaign } = await getAll([STORAGE_KEYS.CAMPAIGN]);
  return campaign || { running: false, paused: false, currentLeadId: null, tabId: null };
}

export async function saveCampaign(partial) {
  const current = await getCampaign();
  const merged = { ...current, ...partial };
  await set({ [STORAGE_KEYS.CAMPAIGN]: merged });
  return merged;
}
