import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

function setup(leads) {
  const dom = new JSDOM(readFileSync(new URL('../popup.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' });
  const win = dom.window;
  let stored = structuredClone(leads);
  win.getLeads = async () => structuredClone(stored);
  win.saveLeads = async (next) => { stored = next; };
  win.updateLead = async (id, patch) => { stored = stored.map((l) => l.id === id ? { ...l, ...patch } : l); };
  win.getSettings = async () => ({ sendMode: 'review' });
  win.chrome = { runtime: { sendMessage(message, cb) { cb({ ok: false }); } } };
  win.confirm = () => true;
  const source = readFileSync(new URL('../popup.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from ".*?";\n/gm, '')
    .replace('document.addEventListener("DOMContentLoaded", init);', '');
  win.eval(source);
  win.initLeadsTableEvents();
  return { dom, win, stored: () => stored };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('lead controls always show labeled actions and disable ineligible follow-ups', async () => {
  const { dom, win } = setup([
    { id: 'a', email: 'a@example.com', status: 'sent', sentAt: 1, followUps: [{}] },
    { id: 'b', email: 'b@example.com', status: 'sent', sentAt: 1, followUps: [{}, {}, {}] },
    { id: 'c', email: 'c@example.com', status: 'sent', sentAt: 1, followUpsStopped: true }
  ]);
  try {
    await win.renderLeadsTable();
    const buttons = win.document.querySelectorAll('[data-action="followup"]');
    assert.equal(buttons.length, 3);
    assert.equal(buttons[0].disabled, false);
    assert.equal(buttons[1].disabled, true);
    assert.equal(buttons[2].disabled, true);
    assert.equal(win.document.querySelectorAll('[data-action="remove"]').length, 3);
    assert.equal(buttons[0].textContent, 'Follow-up 2/3');
    assert.match(win.document.querySelector('#leadsTbody').textContent, /complete/);
    assert.match(win.document.querySelector('#leadsTbody').textContent, /stopped/);
  } finally { dom.window.close(); }
});

test('preview displays original email and follow-up history as text', async () => {
  const { dom, win } = setup([{ id: 'a', email: 'a@example.com', status: 'sent', sentAt: 1,
    subject: 'Original', body: 'Initial message', followUps: [{ subject: 'Next', body: '<img src=x onerror=alert(1)>', sentAt: 2 }] }]);
  try {
    await win.renderLeadsTable();
    win.document.querySelector('[data-action="preview"]').click();
    const content = win.document.querySelector('#previewContent');
    assert.match(content.textContent, /Initial message/);
    assert.match(content.textContent, /Follow-up 1\/3/);
    assert.match(content.textContent, /<img/);
    assert.equal(content.querySelector('img'), null);
  } finally { dom.window.close(); }
});

test('remove only deletes the selected person and respects cancellation', async () => {
  const { dom, win, stored } = setup([{ id: 'a', email: 'a@example.com' }, { id: 'b', email: 'b@example.com' }]);
  try {
    await win.renderLeadsTable();
    win.confirm = () => false;
    win.document.querySelector('[data-action="remove"]').click();
    await tick();
    assert.equal(stored().length, 2);
    win.confirm = () => true;
    win.document.querySelector('[data-action="remove"]').click();
    await tick();
    assert.deepEqual(stored().map((l) => l.id), ['b']);
  } finally { dom.window.close(); }
});

test('stop follow-ups retains the person and disables the send control', async () => {
  const { dom, win, stored } = setup([{ id: 'a', email: 'a@example.com', status: 'sent', sentAt: 1 }]);
  try {
    await win.renderLeadsTable();
    win.document.querySelector('[data-action="stop-followups"]').click();
    await tick();
    assert.equal(stored()[0].followUpsStopped, true);
    assert.equal(win.document.querySelector('[data-action="followup"]').disabled, true);
  } finally { dom.window.close(); }
});


test('unsent leads show Remove lead and a disabled follow-up with an explanation', async () => {
  const { dom, win } = setup([{ id: 'a', email: 'very-long-address@example.com', status: 'pending' }]);
  try {
    await win.renderLeadsTable();
    assert.equal(win.document.querySelector('[data-action="remove"]').textContent, 'Remove lead');
    assert.equal(win.document.querySelector('[data-action="followup"]').disabled, true);
    assert.match(win.document.querySelector('.lead-actions-row').textContent, /Send the initial email first/);
    assert.equal(win.document.querySelector('.lead-actions-row td').colSpan, 4);
  } finally { dom.window.close(); }
});
