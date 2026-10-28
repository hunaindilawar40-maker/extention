/* Agnes Studio — front end. Talks only to our own local server (/api/*). */
(() => {
  const $ = (id) => document.getElementById(id);

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
  };

  const PRESETS = [
    ['Cinematic', 'cinematic lighting, shallow depth of field, 35mm film grain, slow dolly-in'],
    ['Neon night', 'rain-soaked neon city at night, reflections on wet asphalt, anamorphic flares'],
    ['Product', 'clean studio product shot, soft gradient backdrop, gentle orbit, crisp detail'],
    ['Aerial', 'sweeping aerial drone shot, golden hour haze, smooth forward flight'],
    ['Dreamy', 'soft pastel palette, dreamlike haze, gentle handheld camera drift'],
    ['Macro', 'extreme macro, tiny depth of field, dew and dust motes drifting'],
  ];

  const state = { polling: false, abort: false, startedAt: 0, timer: null, job: null, items: [] };

  // ---------------------------------------------------------------- presets
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

  // ------------------------------------------------------------------ state
  els.seconds.oninput = () => { els.secondsOut.textContent = `${els.seconds.value}s`; updateCost(); };
  els.model.onchange = () => {
    if (els.model.value === 'agnes-video-2.5-flash') els.size.value = '720P';
    els.size.disabled = els.model.value === 'agnes-video-2.5-flash';
    updateCost();
  };
  els.size.onchange = updateCost;

  function updateCost() {
    const secs = Number(els.seconds.value);
    const px = els.size.value === '720P' ? '720P' : els.size.value === '1080P' ? '1080P' : els.size.value;
    els.cost.textContent = `${px} · ${secs}s · ${els.aspect.value}`;
  }

  els.mode.onchange = () => {
    els.keyframeFields.classList.toggle('hidden', els.mode.value !== 'keyframe');
    els.referenceFields.classList.toggle('hidden', els.mode.value !== 'reference');
  };

  function showError(msg) {
    if (!msg) { els.error.classList.add('hidden'); els.error.textContent = ''; return; }
    els.error.textContent = msg;
    els.error.classList.remove('hidden');
  }

  async function req(path, opts = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  // -------------------------------------------------------------------- key
  async function refreshKeyState() {
    try {
      const health = await req('/api/health');
      const on = !!health.key_configured;
      els.keyPill.textContent = on ? 'key ready' : 'no API key';
      els.keyPill.className = `pill ${on ? 'pill-on' : 'pill-off'}`;
      if (on) els.keyHint.textContent = 'A key is already configured — saving a new one replaces it.';
      return health;
    } catch (e) {
      els.keyPill.textContent = 'server offline';
      els.keyPill.className = 'pill pill-off';
    }
  }

  els.keyBtn.onclick = () => { els.keyHint.textContent = ''; els.keyInput.value = ''; els.keyDialog.showModal(); };

  els.keyForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (ev.submitter && ev.submitter.value === 'cancel') { els.keyDialog.close(); return; }
    const btn = $('keySave');
    const key = els.keyInput.value.trim();
    if (!key) return;
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      await req('/api/key', { method: 'POST', body: JSON.stringify({ key }) });
      els.keyDialog.close();
      await refreshKeyState();
      showError('');
    } catch (e) {
      els.keyHint.textContent = e.message;
      els.keyHint.style.color = '#ffc9d1';
    } finally {
      btn.disabled = false; btn.textContent = 'Save key';
    }
  });

  // ---------------------------------------------------------------- generate
  els.go.onclick = generate;
  els.again.onclick = generate;

  els.prompt.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate();
  });

  async function generate() {
    if (state.polling) return;
    showError('');

    const prompt = els.prompt.value.trim();
    if (!prompt) { showError('Write a prompt first. What should happen on screen?'); els.prompt.focus(); return; }

    const body = {
      prompt,
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
      const isAudio = (u) => /\.(mp3|wav|m4a|ogg|opus)(\?|$)/i.test(u);
      const isVideo = (u) => /\.(mp4|mov|webm|m4v)(\?|$)/i.test(u);
      body.audios = urls.filter(isAudio);
      body.videos = urls.filter(isVideo);
      body.images = urls.filter((u) => !isAudio(u) && !isVideo(u));
    }

    startUi();
    try {
      const created = await req('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
      state.job = { video_id: created.video_id, model_name: created.model_name, prompt, started: Date.now() };
      els.vidId.textContent = created.video_id;
      await poll(created.video_id, created.model_name, prompt);
    } catch (e) {
      showError(e.message);
      stopUi();
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

  els.stop.onclick = () => { state.abort = true; stopUi(); els.statusText.textContent = 'stopped polling — task may still finish on the server'; };

  async function poll(videoId, modelName, prompt) {
    const q = new URLSearchParams({ video_id: videoId, model_name: modelName });
    while (!state.abort) {
      let snap;
      try {
        snap = await req(`/api/tasks?${q}`);
      } catch (e) {
        showError(`Polling failed: ${e.message}`);
        stopUi();
        return;
      }
      els.statusText.textContent = snap.status;
      if (typeof snap.progress === 'number') els.barFill.style.width = `${Math.min(100, Math.max(4, snap.progress))}%`;

      if (snap.error) { showError(snap.error); stopUi(); return; }

      if (snap.video_url) {
        els.barFill.style.width = '100%';
        finish(snap.video_url, videoId, prompt);
        stopUi();
        return;
      }
      await new Promise((r) => setTimeout(r, 6000));
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
    els.dl.href = `/api/file?url=${encodeURIComponent(url)}`;
    addHistory({ url, videoId, prompt });
  }

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
        els.dl.href = `/api/file?url=${encodeURIComponent(it.url)}`;
      };
      els.history.appendChild(li);
    }
  }

  // ------------------------------------------------------------------ boot
  updateCost();
  refreshKeyState();
})();
