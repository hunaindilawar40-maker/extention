/* Agnes Studio — front end.
 *
 * Two transports:
 *   server  → /api/* on the local Python server (key lives in the server process)
 *   direct  → talks straight to apihub.agnes-ai.com from this page
 *             (needed when the page is served from a machine that cannot reach
 *             the API, e.g. a locked-down sandbox; also the mode used by the
 *             packaged Chrome extension)
 */
(() => {
  const $ = (id) => document.getElementById(id);

  const BASE = 'https://apihub.agnes-ai.com';
  const EXTS = {
    audio: /\.(mp3|wav|m4a|ogg|opus)(\?|$)/i,
    video: /\.(mp4|mov|webm|m4v)(\?|$)/i,
  };

  const els = {
    prompt: $('prompt'), chips: $('chips'), model: $('model'), aspect: $('aspect'),
    seconds: $('seconds'), secondsOut: $('secondsOut'), size: $('size'), mode: $('mode'),
    seed: $('seed'), firstFrame: $('firstFrame'), lastFrame: $('lastFrame'), refs: $('refs'),
    keyframeFields: $('keyframeFields'), referenceFields: $('referenceFields'),
    go: $('go'), goLabel: $('goLabel'), goSpin: $('goSpin'), stop: $('stop'),
    error: $('error'), stage: $('stage'), empty: $('empty'), video: $('video'),
    progress: $('progress'), barFill: $('barFill'), statusText: $('statusText'),
    elapsed: $('elapsed'), meta: $('meta'), vidId: $('vidId'), vidUrl: $('vidUrl'),
    dl: $('dl'), copy: $('copy'), again: $('again'), history: $('history'),
    keyPill: $('keyPill'), keyBtn: $('keyBtn'), keyDialog: $('keyDialog'),
    keyForm: $('keyForm'), keyInput: $('keyInput'), keyHint: $('keyHint'), cost: $('cost'),
    transport: $('transport'), transportHint: $('transportHint'), popOut: $('popOut'),
  };

  const PRESETS = [
    ['Cinematic', 'cinematic lighting, shallow depth of field, 35mm film grain, slow dolly-in'],
    ['Neon night', 'rain-soaked neon city at night, reflections on wet asphalt, anamorphic flares'],
    ['Product', 'clean studio product shot, soft gradient backdrop, gentle orbit, crisp detail'],
    ['Aerial', 'sweeping aerial drone shot, golden hour haze, smooth forward flight'],
    ['Dreamy', 'soft pastel palette, dreamlike haze, gentle handheld camera drift'],
    ['Macro', 'extreme macro, tiny depth of field, dew and dust motes drifting'],
  ];

  const state = {
    polling: false, abort: false, startedAt: 0, timer: null, items: [],
    transport: 'server', serverKey: false, directKey: sessionStorage.getItem('agnesKey') || '',
  };

  // ============================================================== transport
  const isExtension = location.protocol === 'chrome-extension:';
  const forced = new URLSearchParams(location.search).get('mode');

  async function jsonRes(res, what) {
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || text.slice(0, 300) || `HTTP ${res.status}`;
      const err = new Error(`${what} failed: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // --- shared response parsing (mirrors agnes_api.find_first) --------------
  function findFirst(obj, keys, maxDepth = 6) {
    for (const wanted of keys) {
      const w = wanted.toLowerCase();
      const queue = [[obj, 0]];
      while (queue.length) {
        const [node, depth] = queue.shift();
        if (depth > maxDepth) continue;
        if (node && typeof node === 'object' && !Array.isArray(node)) {
          for (const [k, v] of Object.entries(node)) {
            if (k.toLowerCase() === w && v != null && String(v).trim() !== '' &&
                typeof v !== 'object') return v;
          }
          for (const v of Object.values(node)) {
            if (v && typeof v === 'object') queue.push([v, depth + 1]);
          }
        } else if (Array.isArray(node)) {
          for (const v of node) if (v && typeof v === 'object') queue.push([v, depth + 1]);
        }
      }
    }
    return null;
  }

  function snapshot(task) {
    const status = String(findFirst(task, ['status', 'state', 'task_status']) || 'unknown').toLowerCase();
    let progress = findFirst(task, ['progress', 'percent', 'percentage']);
    progress = progress == null ? (['completed', 'succeeded', 'success', 'done'].includes(status) ? 100 : 0)
                                : Number(String(progress).replace('%', '')) || 0;
    let url = null;
    for (const keys of [['video_url', 'videoUrl', 'download_url', 'downloadUrl', 'video'],
                        ['url', 'file_url', 'fileUrl', 'output', 'result_url']]) {
      const c = findFirst(task, keys);
      if (c && String(c).startsWith('http')) { url = String(c); break; }
    }
    const failed = ['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected'].includes(status);
    return {
      status, progress, video_url: url,
      error: failed ? String(findFirst(task, ['error', 'fail_reason', 'error_message', 'reason', 'message']) || 'generation failed') : null,
    };
  }

  // --- server transport ----------------------------------------------------
  async function srv(path, opts = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    return jsonRes(res, 'Local server');
  }

  const serverTransport = {
    label: 'Local server',
    async health() { return srv('/api/health'); },
    async saveKey(key) { return srv('/api/key', { method: 'POST', body: JSON.stringify({ key }) }); },
    async create(body) {
      const r = await srv('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
      return { video_id: r.video_id, model_name: r.model_name };
    },
    async poll(id, model) {
      return srv(`/api/tasks?${new URLSearchParams({ video_id: id, model_name: model })}`);
    },
    async download(url) {
      const a = document.createElement('a');
      a.href = `/api/file?url=${encodeURIComponent(url)}`;
      a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
    },
  };

  // --- direct browser transport -------------------------------------------
  async function agnes(path, opts = {}) {
    let res;
    try {
      res = await fetch(BASE + path, {
        ...opts,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${state.directKey}`,
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
    } catch (e) {
      throw new Error(
        `This browser could not reach ${BASE} (${e.message}). That is a network/CORS ` +
        'problem, not a bad key — try again, or run the server on your own machine.'
      );
    }
    return jsonRes(res, 'Agnes API');
  }

  const directTransport = {
    label: 'Browser direct',
    async health() { return { ok: true, key_configured: !!state.directKey, base_url: BASE }; },
    async saveKey(key) {
      state.directKey = key;
      sessionStorage.setItem('agnesKey', key);
      try {
        await agnes('/v1/models');
        return { ok: true, key_configured: true, verified: true };
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          state.directKey = ''; sessionStorage.removeItem('agnesKey');
          throw new Error(`That key was rejected (${e.message}).`);
        }
        return {
          ok: true, key_configured: true, verified: false,
          warning: `Key kept in this tab, but it could not be verified: ${e.message}`,
        };
      }
    },
    async create(body) {
      const task = await agnes('/v1/videos', { method: 'POST', body: JSON.stringify(body) });
      const id = findFirst(task, ['video_id', 'videoId', 'task_id', 'taskId', 'id']);
      if (!id) throw new Error(`The API returned no video id. ${JSON.stringify(task).slice(0, 300)}`);
      const model = findFirst(task, ['model', 'model_name']) || body.model;
      return { video_id: String(id), model_name: String(model) };
    },
    async poll(id, model) {
      const q = new URLSearchParams({ video_id: id });
      if (model) q.set('model_name', model);
      return snapshot(await agnes(`/agnesapi?${q}`));
    },
    async download(url) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `agnes-${Date.now()}.mp4`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 15000);
      } catch {
        window.open(url, '_blank', 'noopener'); // last resort: open the CDN file
      }
    },
  };

  const api = () => (state.transport === 'direct' ? directTransport : serverTransport);

  // ==================================================================== key
  async function refreshKeyState() {
    try {
      const health = await api().health();
      const on = !!health.key_configured;
      els.keyPill.textContent = on ? 'key ready' : 'no API key';
      els.keyPill.className = `pill ${on ? 'pill-on' : 'pill-off'}`;
      if (on) els.keyHint.textContent = 'A key is already configured — saving a new one replaces it.';
    } catch {
      els.keyPill.textContent = state.transport === 'server' ? 'server offline' : 'no API key';
      els.keyPill.className = 'pill pill-off';
    }
  }

  els.keyBtn.onclick = () => {
    els.keyHint.textContent = state.transport === 'direct'
      ? 'Held in this tab only (session storage).'
      : 'Held by the local server in memory — never written to disk.';
    els.keyHint.style.color = '';
    els.keyInput.value = '';
    els.keyDialog.showModal();
  };

  els.keyForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (ev.submitter && ev.submitter.value === 'cancel') { els.keyDialog.close(); return; }
    const btn = $('keySave');
    const key = els.keyInput.value.trim();
    if (!key) return;
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const r = await api().saveKey(key);
      // Keep the key in this tab too, so switching Network → direct just works.
      state.directKey = key;
      try { sessionStorage.setItem('agnesKey', key); } catch { /* private mode */ }
      els.keyDialog.close();
      await refreshKeyState();
      if (r && r.warning) {
        showError(`⚠ ${r.warning}`);
        els.keyPill.textContent = 'key unverified';
      } else {
        showError('');
      }
    } catch (e) {
      els.keyHint.textContent = e.message;
      els.keyHint.style.color = '#ffc9d1';
    } finally {
      btn.disabled = false; btn.textContent = 'Save key';
    }
  });

  // ============================================================== transport UI
  async function setTransport(name, { probe = true } = {}) {
    state.transport = name === 'direct' ? 'direct' : 'server';
    els.transport.value = state.transport;
    els.transportHint.textContent = state.transport === 'direct'
      ? `Calls go from this tab straight to ${BASE}.`
      : 'Calls go to the local Python server on this machine.';
    await refreshKeyState();
    if (probe && state.transport === 'server') {
      try { await srv('/api/health'); } catch {
        els.transportHint.textContent =
          'Local server not reachable — switch Network to “Browser direct”.';
      }
    }
  }

  els.transport.onchange = () => setTransport(els.transport.value);

  // ================================================================ generate
  for (const [name, text] of PRESETS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = name;
    b.onclick = () => {
      const cur = els.prompt.value.trim();
      els.prompt.value = cur ? (cur.includes(text) ? cur : `${cur}, ${text}`) : text;
      els.prompt.focus();
    };
    els.chips.appendChild(b);
  }

  els.seconds.oninput = () => { els.secondsOut.textContent = `${els.seconds.value}s`; updateCost(); };
  els.model.onchange = () => {
    if (els.model.value === 'agnes-video-2.5-flash') els.size.value = '720P';
    els.size.disabled = els.model.value === 'agnes-video-2.5-flash';
    updateCost();
  };
  els.size.onchange = updateCost;
  els.aspect.onchange = updateCost;
  els.mode.onchange = () => {
    els.keyframeFields.classList.toggle('hidden', els.mode.value !== 'keyframe');
    els.referenceFields.classList.toggle('hidden', els.mode.value !== 'reference');
  };

  function updateCost() {
    els.cost.textContent = `${els.size.value} · ${els.seconds.value}s · ${els.aspect.value}`;
  }

  function showError(msg) {
    if (!msg) { els.error.classList.add('hidden'); els.error.textContent = ''; return; }
    els.error.textContent = msg;
    els.error.classList.remove('hidden');
  }

  function buildBody() {
    const body = {
      prompt: els.prompt.value.trim(),
      model: els.model.value,
      mode: els.mode.value,
      seconds: els.seconds.value,
      size: els.size.value,
      aspect_ratio: els.aspect.value,
      seed: els.seed.value ? Number(els.seed.value) : null,
      first_frame: els.firstFrame.value.trim(),
      last_frame: els.lastFrame.value.trim(),
    };
    if (body.mode === 'reference') {
      const urls = els.refs.value.split('\n').map((s) => s.trim()).filter(Boolean);
      body.audios = urls.filter((u) => EXTS.audio.test(u));
      body.videos = urls.filter((u) => EXTS.video.test(u));
      body.images = urls.filter((u) => !EXTS.audio.test(u) && !EXTS.video.test(u));
    }
    return body;
  }

  els.go.onclick = generate;
  els.again.onclick = generate;
  els.prompt.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate();
  });

  async function generate() {
    if (state.polling) return;
    showError('');

    const body = buildBody();
    if (!body.prompt) {
      showError('Write a prompt first. What should happen on screen?');
      els.prompt.focus();
      return;
    }

    startUi();
    try {
      const created = await api().create(body);
      els.vidId.textContent = created.video_id;
      await poll(created.video_id, created.model_name, body.prompt);
    } catch (e) {
      showError(e.message);
      stopUi();
      if (state.transport === 'server' && /reach|ECONN|blocked|TLS|timed out/i.test(e.message)) {
        els.transportHint.textContent =
          'This machine cannot reach the API. Switch Network to “Browser direct” and try again.';
      }
    }
  }

  function startUi() {
    state.polling = true;
    state.abort = false;
    state.startedAt = Date.now();
    els.go.disabled = true;
    els.goSpin.classList.remove('hidden');
    els.goLabel.textContent = 'Generating…';
    els.stop.classList.remove('hidden');
    els.meta.classList.add('hidden');
    els.progress.classList.remove('hidden');
    els.empty.classList.add('hidden');
    els.video.classList.add('hidden');
    els.video.pause();
    els.barFill.style.width = '0%';
    els.statusText.textContent = 'creating task…';
    els.elapsed.textContent = '0s';
    state.timer = setInterval(() => {
      els.elapsed.textContent = `${Math.round((Date.now() - state.startedAt) / 1000)}s`;
    }, 500);
  }

  function stopUi() {
    state.polling = false;
    els.go.disabled = false;
    els.goSpin.classList.add('hidden');
    els.goLabel.textContent = 'Generate video';
    els.stop.classList.add('hidden');
    clearInterval(state.timer);
    state.timer = null;
  }

  els.stop.onclick = () => {
    state.abort = true;
    stopUi();
    els.statusText.textContent = 'stopped polling — the task may still finish on Agnes’ side';
  };

  async function poll(videoId, modelName, prompt) {
    while (!state.abort) {
      let snap;
      try {
        snap = await api().poll(videoId, modelName);
      } catch (e) {
        showError(`Polling failed: ${e.message}`);
        stopUi();
        return;
      }
      els.statusText.textContent = snap.status;
      if (typeof snap.progress === 'number') {
        els.barFill.style.width = `${Math.min(100, Math.max(4, snap.progress))}%`;
      }
      if (snap.error) { showError(snap.error); stopUi(); return; }
      if (snap.status === 'completed' && !snap.video_url) {
        els.statusText.textContent = 'completed — waiting for the file url…';
      }
      if (snap.video_url) {
        els.barFill.style.width = '100%';
        finish(snap.video_url, videoId, prompt);
        stopUi();
        return;
      }
      await new Promise((r) => setTimeout(r, state.transport === 'direct' ? 8000 : 6000));
    }
  }

  function finish(url, videoId, prompt) {
    els.progress.classList.add('hidden');
    els.meta.classList.remove('hidden');
    els.video.classList.remove('hidden');
    els.video.src = url;
    els.video.play().catch(() => {});
    els.vidId.textContent = videoId;
    els.vidUrl.textContent = url;
    els.vidUrl.title = url;
    els.dl.dataset.url = url;
    addHistory({ url, videoId, prompt });
  }

  els.dl.addEventListener('click', (ev) => {
    ev.preventDefault();
    const url = els.dl.dataset.url;
    if (url) api().download(url);
  });

  els.copy.onclick = async () => {
    try { await navigator.clipboard.writeText(els.vidUrl.textContent); els.copy.textContent = 'Copied'; }
    catch { els.copy.textContent = 'Copy failed'; }
    setTimeout(() => { els.copy.textContent = 'Copy link'; }, 1400);
  };

  function addHistory(item) {
    state.items.unshift(item);
    els.history.innerHTML = '';
    for (const it of state.items) {
      const li = document.createElement('li');
      const v = document.createElement('video');
      v.className = 'thumb'; v.src = it.url; v.muted = true; v.playsInline = true;
      v.addEventListener('mouseenter', () => v.play().catch(() => {}));
      v.addEventListener('mouseleave', () => v.pause());
      const span = document.createElement('span');
      span.className = 'hist-text';
      span.textContent = it.prompt.length > 66 ? `${it.prompt.slice(0, 66)}…` : it.prompt;
      li.append(v, span);
      li.title = it.prompt;
      li.onclick = () => {
        els.video.classList.remove('hidden');
        els.empty.classList.add('hidden');
        els.video.src = it.url;
        els.video.play().catch(() => {});
        els.meta.classList.remove('hidden');
        els.vidId.textContent = it.videoId;
        els.vidUrl.textContent = it.url;
        els.dl.dataset.url = it.url;
      };
      els.history.appendChild(li);
    }
  }

  // ==================================================================== boot
  updateCost();

  // Inside the packaged extension the popup is cramped — offer the full tab.
  if (isExtension && typeof chrome !== 'undefined' && chrome.tabs) {
    els.popOut.classList.remove('hidden');
    els.popOut.onclick = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('web/index.html') });
      window.close();
    };
  }

  // Extension pages have no local Python server behind them → go direct.
  const initial = forced === 'server' ? 'server'
                : isExtension || forced === 'direct' ? 'direct'
                : 'server';
  setTransport(initial);
})();
