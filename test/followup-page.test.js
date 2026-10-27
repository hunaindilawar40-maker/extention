import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

function setup(leads, { groqKey = 'gsk_test', onRelay = null } = {}) {
  const dom = new JSDOM(readFileSync(new URL('../popup.html', import.meta.url), 'utf8'), {
    runScripts: 'outside-only'
  });
  const win = dom.window;
  let stored = structuredClone(leads);
  win.getLeads = async () => structuredClone(stored);
  win.saveLeads = async (next) => { stored = next; };
  win.updateLead = async (id, patch) => {
    stored = stored.map((l) => (l.id === id ? { ...l, ...patch } : l));
  };
  win.getSettings = async () => ({ sendMode: 'auto', groqApiKey: groqKey });
  let captured = null;
  win.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, cb) {
        if (message.type === 'ENSURE_ZOHO_CONNECTION') {
          cb({ ok: true, tab: { id: 1, title: 'Zoho Mail' } });
        } else if (message.type === 'RELAY_TO_ZOHO_TAB') {
          captured = message;
          if (onRelay) onRelay(message);
          cb({ ok: true, response: { ok: true } });
        } else {
          cb({ ok: false });
        }
      }
    }
  };
  win.confirm = () => true;
  const source = readFileSync(new URL('../popup.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?from ".*?";\n/gm, '')
    .replace('document.addEventListener("DOMContentLoaded", init);', '');
  win.eval(source);
  win.initFollowupsEvents();
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { dom, win, stored: () => stored, captured: () => captured, tick };
}

function makeLead(id, overrides = {}) {
  return {
    id,
    email: `${id}@example.com`,
    fullName: `Lead ${id.toUpperCase()}`,
    company: `Company ${id.toUpperCase()}`,
    status: 'sent',
    sentAt: 1000,
    subject: 'Original',
    body: 'Initial email',
    followUps: [],
    ...overrides
  };
}

test('follow-up table locks ineligible leads and shows each lead\u2019s next stage', async () => {
  const { dom, win } = setup([
    makeLead('a'), // ready for F1
    makeLead('b', { followUps: [{ number: 1, sentAt: 2000 }] }), // ready for F2
    makeLead('c', {
      followUps: [{ number: 1, sentAt: 2 }, { number: 2, sentAt: 3 }, { number: 3, sentAt: 4 }]
    }), // complete
    makeLead('d', { followUpsStopped: true, followUps: [{ number: 1, sentAt: 2 }] }), // stopped
    makeLead('e', { status: 'pending', sentAt: null }) // initial not sent
  ]);
  try {
    await win.renderFollowupsTable();
    const rows = win.document.querySelectorAll('#fuTbody tr');
    assert.equal(rows.length, 5);

    const checks = [...win.document.querySelectorAll('.fu-check')];
    assert.equal(checks[0].disabled, false); // a: F1 ready
    assert.equal(checks[1].disabled, false); // b: F2 ready
    assert.equal(checks[2].disabled, true); // c: complete
    assert.equal(checks[3].disabled, true); // d: stopped
    assert.equal(checks[4].disabled, true); // e: unsent

    const text = win.document.querySelector('#fuTbody').textContent;
    assert.match(text, /Follow-up 1\/3/);
    assert.match(text, /Follow-up 2\/3/);
    assert.match(text, /Complete 3\/3/);
    assert.match(text, /Stopped/);
    assert.match(text, /Initial not sent/);

    // Summary stats.
    assert.equal(win.document.querySelector('#fuStatReady').textContent, '2');
    assert.equal(win.document.querySelector('#fuStatF1').textContent, '3'); // b, c, d
    assert.equal(win.document.querySelector('#fuStatComplete').textContent, '1');
    assert.equal(win.document.querySelector('#fuStatStopped').textContent, '1');
  } finally {
    dom.window.close();
  }
});

test('memory pips reflect exactly which stages have been sent', async () => {
  const { dom, win } = setup([makeLead('a', { followUps: [{ number: 1, sentAt: 2 }, { number: 2, sentAt: 3 }] })]);
  try {
    await win.renderFollowupsTable();
    const pips = [...win.document.querySelectorAll('.fu-pip')];
    assert.equal(pips.length, 4); // Initial + F1 + F2 + F3
    assert.equal(pips.filter((p) => p.classList.contains('fu-pip-done')).length, 3);
    assert.equal(pips[0].textContent, 'Initial');
    assert.equal(pips[3].textContent, 'F3');
    assert.equal(pips[3].classList.contains('fu-pip-done'), false);
    assert.match(pips[1].title, /sent/);
  } finally {
    dom.window.close();
  }
});

test('Select first 25 checks exactly the first 25 eligible leads in queue order', async () => {
  const leads = [];
  for (let i = 0; i < 30; i++) leads.push(makeLead(`r${String(i).padStart(2, '0')}`));
  for (let i = 0; i < 5; i++) leads.push(makeLead(`u${i}`, { status: 'pending', sentAt: null }));
  const { dom, win } = setup(leads);
  try {
    await win.renderFollowupsTable();
    win.document.querySelector('#btnFuSelectFirst').click();
    const checked = [...win.document.querySelectorAll('.fu-check:checked')];
    assert.equal(checked.length, 25);
    assert.deepEqual(
      checked.map((c) => c.dataset.id),
      leads.slice(0, 25).map((l) => l.id)
    );
    assert.match(win.document.querySelector('#btnFuSend').textContent, /25 selected/);
    assert.equal(win.document.querySelector('#btnFuSend').disabled, false);

    // Changing the batch size changes how many "select first" picks.
    win.document.querySelector('#fuBatchSize').value = '10';
    win.document.querySelector('#fuBatchSize').dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.match(win.document.querySelector('#btnFuSelectFirst').textContent, /Select first 10/);
    win.document.querySelector('#btnFuSelectFirst').click();
    assert.equal(win.document.querySelectorAll('.fu-check:checked').length, 10);
    assert.match(win.document.querySelector('#btnFuSend').textContent, /10 selected/);
  } finally {
    dom.window.close();
  }
});

test('Select all ready ignores stopped, complete and unsent leads; Clear resets', async () => {
  const { dom, win } = setup([
    makeLead('a'),
    makeLead('b', { followUps: [{ number: 1, sentAt: 2 }] }),
    makeLead('c', {
      followUps: [{ number: 1, sentAt: 2 }, { number: 2, sentAt: 3 }, { number: 3, sentAt: 4 }]
    }),
    makeLead('d', { followUpsStopped: true }),
    makeLead('e', { status: 'pending', sentAt: null })
  ]);
  try {
    await win.renderFollowupsTable();
    win.document.querySelector('#btnFuSelectAll').click();
    await win.renderFollowupsTable();
    const checked = [...win.document.querySelectorAll('.fu-check:checked')].map((c) => c.dataset.id);
    assert.deepEqual(checked.sort(), ['a', 'b']);

    win.document.querySelector('#btnFuClear').click();
    await win.renderFollowupsTable();
    assert.equal(win.document.querySelectorAll('.fu-check:checked').length, 0);
    assert.equal(win.document.querySelector('#btnFuSend').disabled, true);
  } finally {
    dom.window.close();
  }
});

test('starting a batch tags every lead with its own correct next follow-up and forces review', async () => {
  const { dom, win, captured, tick } = setup([
    makeLead('a'), // next = 1
    makeLead('b', { followUps: [{ number: 1, sentAt: 2 }] }), // next = 2
    makeLead('c', {
      followUps: [{ number: 1, sentAt: 2 }, { number: 2, sentAt: 3 }, { number: 3, sentAt: 4 }]
    }) // complete — cannot be selected
  ]);
  try {
    await win.renderFollowupsTable();
    win.document.querySelector('#btnFuSelectAll').click();
    await win.renderFollowupsTable();
    win.document.querySelector('#btnFuSend').click();
    await tick();
    await tick();

    const payload = captured();
    assert.ok(payload, 'a START_CAMPAIGN relay should have been sent');
    assert.equal(payload.type, 'RELAY_TO_ZOHO_TAB');
    assert.equal(payload.payload.type, 'START_CAMPAIGN');
    // Full-Auto in settings must be downgraded to review for follow-ups.
    assert.equal(payload.payload.settings.sendMode, 'review');
    const byId = Object.fromEntries(payload.payload.leads.map((l) => [l.id, l.followUpNumber]));
    assert.deepEqual(byId, { a: 1, b: 2 });
  } finally {
    dom.window.close();
  }
});

test('batch cannot start without a Groq API key', async () => {
  const { dom, win, captured, tick } = setup([makeLead('a')], { groqKey: '' });
  try {
    await win.renderFollowupsTable();
    win.document.querySelector('#btnFuSelectAll').click();
    await win.renderFollowupsTable();
    win.document.querySelector('#btnFuSend').click();
    await tick();
    assert.equal(captured(), null);
    assert.match(win.document.querySelector('#toastHost').textContent, /Groq API key/);
  } finally {
    dom.window.close();
  }
});
