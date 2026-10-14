import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

function setup(leads) {
  const data = { aoz_leads: leads };
  const dom = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only' });
  dom.window.__AOZ_EXPOSE_FOR_TESTS__ = true;
  dom.window.chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: { local: {
      get(keys, cb) { cb(structuredClone(data)); },
      set(values, cb) { Object.assign(data, structuredClone(values)); cb(); }
    } }
  };
  dom.window.eval(readFileSync(new URL('../content.js', import.meta.url), 'utf8'));
  return { dom, data, helpers: dom.window.__aozTestHelpers };
}

test('removed leads and completed or stale follow-ups cannot send', async () => {
  const { dom, helpers } = setup([{ id: 'a', sentAt: 1, followUps: [{}, {}, {}] }]);
  try {
    assert.equal(await helpers.leadStillEligible({ id: 'removed' }), false);
    assert.equal(await helpers.leadStillEligible({ id: 'a', followUpNumber: 4 }), false);
    assert.equal(await helpers.leadStillEligible({ id: 'a', followUpNumber: 2 }), false);
  } finally { dom.window.close(); }
});

test('follow-ups retain original email and advance only after sending', async () => {
  const original = { id: 'a', status: 'sent', sentAt: 1, subject: 'Original', body: 'First email' };
  const { dom, data, helpers } = setup([original]);
  const lead = { ...original, followUpNumber: 1 };
  try {
    assert.equal(await helpers.leadStillEligible(lead), true);
    await helpers.updateCampaignLead(lead, { status: 'injected', subject: 'Next', body: 'Follow-up' });
    assert.equal(data.aoz_leads[0].followUps, undefined);
    await helpers.updateCampaignLead(lead, { status: 'sent', sentAt: 2 });
    assert.equal(data.aoz_leads[0].subject, 'Original');
    assert.equal(data.aoz_leads[0].sentAt, 1);
    assert.equal(data.aoz_leads[0].followUps[0].body, 'Follow-up');
    assert.equal(await helpers.leadStillEligible(lead), false);
    assert.equal(await helpers.leadStillEligible({ ...lead, followUpNumber: 2 }), true);
  } finally { dom.window.close(); }
});
