'use strict';
// Cortes virais: análise automática de um vídeo no navegador (áudio + imagem),
// escolha dos melhores trechos, render com enquadramento, gancho, legendas e exportação.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const once = (el, ev) => new Promise((res) => el.addEventListener(ev, res, { once: true }));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (t) => {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  };
  const mean = (a, i0 = 0, i1 = a.length) => {
    let s = 0, n = 0;
    for (let i = Math.max(0, i0); i < Math.min(a.length, i1); i++) { s += a[i]; n++; }
    return n ? s / n : 0;
  };
  const quantile = (arr, q) => {
    if (!arr.length) return 0;
    const s = Float32Array.from(arr).sort();
    return s[clamp(Math.floor(q * (s.length - 1)), 0, s.length - 1)];
  };
  // z-score robusto (mediana e MAD), limitado a ±3
  const zscore = (arr) => {
    const med = quantile(arr, 0.5);
    const mad = quantile(Array.from(arr, (x) => Math.abs(x - med)), 0.5) * 1.4826 || 1;
    return Float32Array.from(arr, (x) => clamp((x - med) / mad, -3, 3));
  };
  const smooth01 = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

  const SIZES = { '9:16': [1080, 1920], '1:1': [1080, 1080], '4:5': [1080, 1350], '16:9': [1920, 1080] };
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const HOOKS = [
    'Ninguém esperava por isso 😳', 'Espera até o final…', 'A parte que ninguém te conta', 'Isso mudou tudo 🤯',
    'Repara nesse detalhe 👀', 'O momento mais forte 🔥', 'Não acreditei quando ouvi isso', 'Salva esse vídeo 📌',
    'Escuta bem isso…', 'Foi aqui que tudo virou', 'Ele falou mesmo isso?!', 'A verdade sobre isso 👇',
  ];
  const DEFAULTS = {
    ratio: '9:16', fit: 'crop', reframe: 'auto', offset: 0.5, zoom: true, progress: true, hook: 'intro',
    speed: 1, handle: '', capStyle: 'karaoke', capColor: '#ffd400', capPos: 0.7, quality: 1080,
  };
  const opts = Object.assign({}, DEFAULTS, (() => { try { return JSON.parse(localStorage.getItem('cortes-opts')) || {}; } catch (e) { return {}; } })());
  const saveOpts = () => { try { localStorage.setItem('cortes-opts', JSON.stringify(opts)); } catch (e) { /* sem armazenamento */ } };

  const S = {
    file: null, url: null, duration: 0, token: 0, skipVisual: false,
    hop: 0.05, db: null, dbLo: -60, dbHi: 0, voiced: null, // áudio, por janela de 50 ms
    sc: null, dist: null,                                   // notas por segundo e distribuição das janelas
    clips: [], sel: null, nextId: 1, cues: [], dirty: true, hookIdx: 0,
  };

  const video = $('#src'), xv = $('#xv');
  const view = $('#view'), vctx = view.getContext('2d');
  const tl = $('#timeline'), tctx = tl.getContext('2d');

  let toastTimer = 0;
  function toast(msg, ms = 4200) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function seek(v, t) {
    return new Promise((res) => {
      let done = false;
      const fin = () => { if (done) return; done = true; v.removeEventListener('seeked', fin); clearTimeout(to); res(); };
      const to = setTimeout(fin, 4000);
      v.addEventListener('seeked', fin);
      v.currentTime = t;
    });
  }

  // ---------- carregar ----------
  async function loadFile(file) {
    if (!file) return;
    if (!/^video\//.test(file.type) && !/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(file.name)) { toast('Escolha um arquivo de vídeo.'); return; }
    S.token++;
    if (S.url) URL.revokeObjectURL(S.url);
    Object.assign(S, { file, url: URL.createObjectURL(file), db: null, voiced: null, sc: null, dist: null, clips: [], sel: null, cues: [], skipVisual: false });
    video.src = S.url; xv.src = S.url;
    try {
      await Promise.race([once(video, 'loadedmetadata'), once(video, 'error').then(() => { throw new Error('formato'); })]);
    } catch (e) {
      toast('O navegador não consegue abrir esse formato. Tente um MP4 (H.264).', 6000);
      return;
    }
    if (!isFinite(video.duration)) { video.currentTime = 1e9; await once(video, 'durationchange'); video.currentTime = 0; }
    S.duration = video.duration;
    $('#intro').hidden = true; $('#work').hidden = false;
    $('#fileName').textContent = file.name;
    video.playbackRate = opts.speed;
    sizeView(); renderClips(); renderEditor(); updateSubsInfo();
    S.dirty = true;
    analyze();
  }

  // ---------- análise ----------
  function busy(text, p) {
    $('#busy').hidden = text == null;
    if (text != null) { $('#busyText').textContent = text; $('#busyBar').style.width = Math.round(p * 100) + '%'; }
  }

  async function analyze() {
    const token = S.token;
    $('#regen').disabled = $('#addClip').disabled = $('#exportAll').disabled = true;
    busy('Ouvindo o áudio…', 0.03);
    try {
      if (S.file.size > 1.5e9) throw new Error('grande');
      const buf = await S.file.arrayBuffer();
      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const audio = await new Promise((res, rej) => ac.decodeAudioData(buf, res, rej));
      ac.close && ac.close();
      if (token !== S.token) return;
      loudness(audio);
    } catch (e) {
      if (token !== S.token) return;
      toast('Não deu para ler o áudio deste arquivo; a análise vai usar só a imagem.', 6000);
    }
    busy('Procurando ação e mudanças de cena…', 0.25);
    $('#skipVisual').hidden = false;
    const vis = await visual(token, (p) => busy('Procurando ação e mudanças de cena…', 0.25 + 0.7 * p));
    $('#skipVisual').hidden = true;
    if (token !== S.token) return;
    scoreSeconds(vis);
    busy(null);
    $('#regen').disabled = $('#addClip').disabled = false;
    regen();
  }

  function loudness(audio) {
    const hop = S.hop, n = Math.max(1, Math.floor(audio.duration / hop)), sr = audio.sampleRate;
    const chans = [];
    for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) chans.push(audio.getChannelData(c));
    const per = Math.floor(sr * hop), stride = 4;
    const db = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0;
      const a = i * per, b = Math.min(chans[0].length, a + per);
      for (const ch of chans) for (let j = a; j < b; j += stride) { sum += ch[j] * ch[j]; cnt++; }
      db[i] = 10 * Math.log10(sum / Math.max(1, cnt) + 1e-10);
    }
    const floor = quantile(db, 0.15), top = quantile(db, 0.9);
    const thr = floor + Math.max(4, 0.3 * (top - floor));
    S.db = db;
    S.dbLo = quantile(db, 0.3);
    S.dbHi = Math.max(S.dbLo + 1, quantile(db, 0.99));
    S.voiced = Uint8Array.from(db, (x) => (x > thr ? 1 : 0));
  }

  async function visual(token, onp) {
    S.skipVisual = false;
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = S.url;
    try { await once(v, 'loadedmetadata'); } catch (e) { return null; }
    const N = clamp(Math.floor(S.duration / 0.5), 20, 600);
    const step = S.duration / N, W = 48, H = 27;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const motion = new Float32Array(N);
    let prev = null, done = 0;
    for (let i = 0; i < N; i++) {
      if (token !== S.token) return null;
      if (S.skipVisual) break;
      await seek(v, Math.min(S.duration - 0.05, (i + 0.5) * step));
      ctx.drawImage(v, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H).data;
      const cur = new Uint8Array(W * H);
      let diff = 0;
      for (let p = 0, q = 0; q < cur.length; p += 4, q++) {
        cur[q] = (d[p] * 2 + d[p + 1] * 5 + d[p + 2]) >> 3;
        if (prev) diff += Math.abs(cur[q] - prev[q]);
      }
      motion[i] = prev ? diff / cur.length : 0;
      prev = cur; done = i + 1;
      if (i % 4 === 0) onp(i / N);
    }
    v.removeAttribute('src'); v.load();
    if (done < 3) return null;
    // o que não chegou a ser visto fica na média
    const m = mean(motion, 1, done);
    for (let i = done; i < N; i++) motion[i] = m;
    motion[0] = motion[1];
    return { step, motion };
  }

  // nota por segundo: energia da voz, reações (subidas bruscas), movimento e cortes de cena
  function scoreSeconds(vis) {
    const T = Math.max(1, Math.floor(S.duration));
    const loud = new Float32Array(T), vf = new Float32Array(T), onset = new Float32Array(T);
    const motion = new Float32Array(T), cuts = new Float32Array(T);
    const hasA = !!S.db, hasV = !!vis;
    if (hasA) {
      const per = Math.round(1 / S.hop);
      for (let t = 0; t < T; t++) { loud[t] = mean(S.db, t * per, (t + 1) * per) || S.dbLo; vf[t] = mean(S.voiced, t * per, (t + 1) * per); }
      for (let t = 1; t < T; t++) onset[t] = loud[t] - mean(loud, t - 3, t);
    }
    if (hasV) {
      const { step, motion: mv } = vis, N = mv.length;
      const cutThr = Math.max(14, quantile(mv, 0.5) * 3);
      for (let t = 0; t < T; t++) motion[t] = mv[clamp(Math.floor((t + 0.5) / step), 0, N - 1)];
      for (let i = 0; i < N; i++) if (mv[i] > cutThr) cuts[clamp(Math.floor((i + 0.5) * step), 0, T - 1)]++;
    }
    const zL = zscore(loud), zO = zscore(onset), zM = zscore(motion);
    const wA = hasA ? (hasV ? 0.7 : 1) : 0, wV = hasV ? (hasA ? 0.3 : 1) : 0;
    const score = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      score[t] = wA * (0.6 * zL[t] + 0.4 * Math.max(0, zO[t])) + wV * (0.7 * zM[t] + 0.3 * Math.min(cuts[t], 2));
    }
    S.sc = { T, score, zL, zO, zM, cuts, vf, hasA, hasV };
  }

  function rangeRaw(s, e) {
    const sc = S.sc;
    if (!sc) return 0;
    const a = clamp(Math.floor(s), 0, sc.T - 1), b = clamp(Math.ceil(e), a + 1, sc.T);
    let r = mean(sc.score, a, b) + 0.5 * mean(sc.score, a, Math.min(b, a + 3)); // gancho: os 3 primeiros segundos contam a dobrar
    if (sc.hasA) r += 0.4 * (mean(sc.vf, a, b) - 0.5);                          // pouco silêncio
    return r;
  }
  function toPct(raw) {
    const d = S.dist;
    if (!d || !d.length) return 50;
    let lo = 0, hi = d.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (d[m] < raw) lo = m + 1; else hi = m; }
    return Math.round(52 + 47 * lo / d.length);
  }
  function reasons(s, e) {
    const sc = S.sc, out = [];
    if (!sc) return out;
    const a = clamp(Math.floor(s), 0, sc.T - 1), b = clamp(Math.ceil(e), a + 1, sc.T);
    let maxO = 0;
    for (let t = a; t < b; t++) maxO = Math.max(maxO, sc.zO[t]);
    let cuts = 0;
    for (let t = a; t < b; t++) cuts += sc.cuts[t];
    if (sc.hasA && mean(sc.zL, a, b) > 0.4) out.push('🔊 Energia alta');
    if (sc.hasA && maxO > 1.6) out.push('⚡ Pico de reação');
    if (mean(sc.score, a, Math.min(b, a + 3)) > mean(sc.score, a, b) + 0.15) out.push('🎣 Começo forte');
    if (sc.hasV && mean(sc.zM, a, b) > 0.4) out.push('🎬 Muita ação');
    if (sc.hasV && cuts >= (b - a) / 6) out.push('✂️ Ritmo rápido');
    if (sc.hasA && mean(sc.vf, a, b) > 0.75) out.push('🗣️ Fala contínua');
    return out.slice(0, 4);
  }

  // ponto mais silencioso perto de t: o corte não começa nem acaba no meio de uma palavra
  function quietest(t0, t1) {
    if (!S.db) return null;
    const db = S.db, i0 = clamp(Math.floor(t0 / S.hop), 1, db.length - 2), i1 = clamp(Math.ceil(t1 / S.hop), 1, db.length - 2);
    let best = null, bv = Infinity;
    for (let i = i0; i <= i1; i++) {
      const v = db[i - 1] + db[i] + db[i + 1];
      if (v < bv) { bv = v; best = i; }
    }
    return best == null ? null : best * S.hop;
  }

  function makeClip(s, e, title) {
    return { id: S.nextId++, start: s, end: e, title: title || HOOKS[S.hookIdx++ % HOOKS.length], score: toPct(rangeRaw(s, e)), reasons: reasons(s, e), thumb: null, transcript: '' };
  }

  function pickClips(L, N) {
    const T = S.sc ? S.sc.T : Math.floor(S.duration);
    if (S.duration <= L * 1.15 || !S.sc) {
      S.dist = [rangeRaw(0, S.duration)];
      const c = makeClip(0, S.duration);
      return [c];
    }
    const cands = [];
    for (let a = 0; a + L <= T; a++) cands.push({ a, r: rangeRaw(a, a + L) });
    S.dist = cands.map((c) => c.r).sort((x, y) => x - y);
    cands.sort((x, y) => y.r - x.r);
    const chosen = [];
    for (const c of cands) {
      if (chosen.length >= N) break;
      if (chosen.every((o) => c.a + L <= o.a || c.a >= o.a + L)) chosen.push(c);
    }
    S.hookIdx = 0;
    return chosen.map((c) => {
      let s = quietest(c.a - 1.5, c.a + 0.8), e = quietest(c.a + L - 1.5, c.a + L + 1.5);
      s = clamp(s == null ? c.a : s, 0, S.duration);
      e = clamp(e == null ? c.a + L : e, s + 3, S.duration);
      return makeClip(s, e);
    });
  }

  function regen() {
    if (!S.duration) return;
    const L = +$('#genLen').value, N = +$('#genCount').value;
    S.clips = pickClips(L, N);
    $('#exportAll').disabled = !S.clips.length;
    renderClips();
    if (S.clips.length) select(S.clips[0].id);
    makeThumbs(S.token);
  }

  async function makeThumbs(token) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = S.url;
    await once(v, 'loadedmetadata');
    const c = document.createElement('canvas'); c.width = 192; c.height = 108;
    const ctx = c.getContext('2d');
    for (const clip of S.clips.slice()) {
      if (token !== S.token) break;
      if (clip.thumb) continue;
      await seek(v, Math.min(clip.end - 0.1, clip.start + Math.min(2, (clip.end - clip.start) / 3)));
      const s = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(v, (c.width - v.videoWidth * s) / 2, (c.height - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
      try { clip.thumb = c.toDataURL('image/jpeg', 0.75); } catch (e) { /* sem miniatura */ }
      renderClips();
    }
    v.removeAttribute('src'); v.load();
  }

  // ---------- render (pré-visualização e exportação usam o mesmo desenho) ----------
  const TW = 64, TH = 36;
  const tcan = document.createElement('canvas'); tcan.width = TW; tcan.height = TH;
  const tc = tcan.getContext('2d', { willReadFrequently: true });
  const bcan = document.createElement('canvas');
  const bc = bcan.getContext('2d');

  // enquadramento automático: segue o centro do movimento entre quadros
  function track(st, v) {
    st.n = (st.n || 0) + 1;
    if (st.n % 3 === 0) {
      tc.drawImage(v, 0, 0, TW, TH);
      const d = tc.getImageData(0, 0, TW, TH).data;
      const cur = new Uint8Array(TW * TH);
      for (let p = 0, q = 0; q < cur.length; p += 4, q++) cur[q] = (d[p] * 2 + d[p + 1] * 5 + d[p + 2]) >> 3;
      if (st.prev) {
        const col = new Float32Array(TW);
        let tot = 0, all = 0;
        for (let q = 0; q < cur.length; q++) {
          const df = Math.abs(cur[q] - st.prev[q]);
          all += df;
          if (df > 12) { col[q % TW] += df; tot += df; }
        }
        if (all / cur.length > 28) st.snap = true; // mudança de cena
        else if (tot > TW * TH * 0.5) {
          let cx = 0;
          for (let x = 0; x < TW; x++) cx += col[x] * (x + 0.5);
          st.tx = 0.5 + (cx / tot / TW - 0.5) * 0.9;
          if (st.snap) { st.cx = st.tx; st.snap = false; }
        }
      }
      st.prev = cur;
    }
    st.cx += (st.tx - st.cx) * 0.035;
  }

  function energyAt(t) {
    if (!S.db) return 0;
    const i = Math.floor(t / S.hop);
    return clamp((mean(S.db, i - 2, i + 3) - S.dbLo) / (S.dbHi - S.dbLo), 0, 1);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrap(ctx, words, maxW) {
    const sp = ctx.measureText(' ').width, lines = [];
    let line = [], w = 0;
    words.forEach((t, i) => {
      const ww = ctx.measureText(t).width;
      if (line.length && w + sp + ww > maxW) { lines.push({ words: line, w }); line = []; w = 0; }
      w += (line.length ? sp : 0) + ww;
      line.push({ t, w: ww, i });
    });
    if (line.length) lines.push({ words: line, w });
    return { lines, sp };
  }

  function drawHook(ctx, W, H, u, text, tRel) {
    let alpha = clamp(tRel / 0.25, 0, 1);
    if (opts.hook === 'intro') alpha *= clamp((4 - tRel) / 0.4, 0, 1);
    if (alpha <= 0 || !text.trim()) return;
    const pop = 0.86 + 0.14 * smooth01(tRel / 0.3);
    ctx.save();
    ctx.font = `800 ${56 * u}px ${FONT}`;
    const { lines, sp } = wrap(ctx, text.trim().split(/\s+/), W * 0.78);
    const lh = 68 * u, padX = 30 * u, padY = 20 * u;
    const bw = Math.max(...lines.map((l) => l.w)) + padX * 2, bh = lines.length * lh + padY * 2;
    const y0 = H * (W < H ? 0.12 : 0.07);
    ctx.globalAlpha = alpha;
    ctx.translate(W / 2, y0 + bh / 2);
    ctx.scale(pop, pop);
    ctx.rotate(-0.012);
    ctx.fillStyle = '#fff';
    roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 18 * u);
    ctx.fill();
    ctx.fillStyle = '#0b0b0f';
    ctx.textBaseline = 'middle';
    lines.forEach((l, k) => {
      let x = -l.w / 2;
      const y = -bh / 2 + padY + lh * (k + 0.5);
      for (const w of l.words) { ctx.fillText(w.t, x, y); x += w.w + sp; }
    });
    ctx.restore();
  }

  function cueAt(t) {
    for (const c of S.cues) { if (t >= c.s && t < c.e) return c; if (c.s > t) break; }
    return null;
  }

  function drawCaption(ctx, W, H, u, t) {
    if (opts.capStyle === 'none') return;
    const cue = cueAt(t);
    if (!cue) return;
    const words = cue.text.toUpperCase().split(/\s+/).filter(Boolean);
    const p = (t - cue.s) / Math.max(0.01, cue.e - cue.s);
    const active = opts.capStyle === 'karaoke' ? Math.floor(p * words.length) : -1;
    const pop = 1 + 0.1 * (1 - smooth01((t - cue.s) / 0.12));
    ctx.save();
    ctx.font = `900 ${88 * u}px ${FONT}`;
    const { lines, sp } = wrap(ctx, words, W * 0.84);
    const lh = 104 * u;
    ctx.translate(W / 2, H * opts.capPos);
    ctx.scale(pop, pop);
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 13 * u;
    ctx.strokeStyle = '#000';
    const top = -lines.length * lh / 2;
    lines.forEach((l, k) => {
      let x = -l.w / 2;
      const y = top + lh * (k + 0.5);
      for (const w of l.words) {
        ctx.strokeText(w.t, x, y);
        ctx.fillStyle = w.i === active ? opts.capColor : '#fff';
        ctx.fillText(w.t, x, y);
        x += w.w + sp;
      }
    });
    ctx.restore();
  }

  function render(ctx, W, H, v, t, clip, st, live) {
    const u = Math.min(W, H) / 1080;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    if (v.readyState < 2 || !v.videoWidth) return;
    const vw = v.videoWidth, vh = v.videoHeight, ar = W / H;
    if (live && opts.fit === 'crop' && opts.reframe === 'auto' && vw / vh > ar) track(st, v);
    const zt = opts.zoom ? 1 + 0.12 * smooth01((energyAt(t) - 0.72) / 0.25) : 1;
    st.zoom = live ? st.zoom + (zt - st.zoom) * 0.1 : zt;

    if (opts.fit === 'crop') {
      let sw, sh;
      if (vw / vh > ar) { sh = vh; sw = vh * ar; } else { sw = vw; sh = vw / ar; }
      sw /= st.zoom; sh /= st.zoom;
      const cx = opts.reframe === 'auto' ? st.cx : opts.reframe === 'manual' ? opts.offset : 0.5;
      const sx = clamp(cx * vw - sw / 2, 0, vw - sw), sy = clamp(vh * 0.45 - sh / 2, 0, vh - sh);
      ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
    } else {
      // fundo: a mesma imagem em miniatura, ampliada (fica desfocada) e escurecida
      const bw = 20, bh = Math.max(1, Math.round(20 / ar));
      if (bcan.width !== bw || bcan.height !== bh) { bcan.width = bw; bcan.height = bh; }
      const s = Math.max(bw / vw, bh / vh);
      bc.drawImage(v, (bw - vw * s) / 2, (bh - vh * s) / 2, vw * s, vh * s);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(bcan, 0, 0, W, H);
      ctx.fillStyle = 'rgba(0,0,0,.42)';
      ctx.fillRect(0, 0, W, H);
      const f = Math.min(W / vw, H / vh) * st.zoom, dw = vw * f, dh = vh * f;
      ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }

    const tRel = clip ? t - clip.start : 0;
    if (clip && opts.hook !== 'off') drawHook(ctx, W, H, u, clip.title || '', tRel);
    drawCaption(ctx, W, H, u, t);
    if (opts.handle.trim()) {
      ctx.save();
      ctx.font = `700 ${32 * u}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.globalAlpha = 0.8;
      ctx.lineWidth = 6 * u; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineJoin = 'round';
      const y = H - (opts.progress ? 64 : 48) * u;
      ctx.strokeText(opts.handle.trim(), W / 2, y);
      ctx.fillStyle = '#fff';
      ctx.fillText(opts.handle.trim(), W / 2, y);
      ctx.restore();
    }
    if (clip && opts.progress) {
      const h = 12 * u, p = clamp(tRel / (clip.end - clip.start), 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,.22)';
      ctx.fillRect(0, H - h, W, h);
      ctx.fillStyle = opts.capColor;
      ctx.fillRect(0, H - h, W * p, h);
    }
  }

  // ---------- pré-visualização ----------
  const P = { cx: 0.5, tx: 0.5, zoom: 1 };
  const curClip = () => S.clips.find((c) => c.id === S.sel) || null;

  function sizeView() {
    const [W, H] = SIZES[opts.ratio];
    view.width = W / 2; view.height = H / 2;
    const r = $('#previewWrap').getBoundingClientRect();
    const s = Math.min((r.width - 24) / W, (r.height - 24) / H);
    view.style.width = Math.max(1, W * s) + 'px';
    view.style.height = Math.max(1, H * s) + 'px';
    S.dirty = true;
  }

  function frame() {
    requestAnimationFrame(frame);
    if (!S.url) return;
    const clip = curClip();
    if (!video.paused && clip && video.currentTime >= clip.end) {
      if ($('#loop').checked) video.currentTime = clip.start; else video.pause();
    }
    if (!video.paused || S.dirty) {
      S.dirty = false;
      render(vctx, view.width, view.height, video, video.currentTime, clip, P, !video.paused);
      drawTimeline();
      $('#time').textContent = clip
        ? fmt(video.currentTime - clip.start) + ' / ' + fmt(clip.end - clip.start)
        : fmt(video.currentTime) + ' / ' + fmt(S.duration);
    }
  }

  function togglePlay() {
    if (!S.url) return;
    if (video.paused) {
      const c = curClip();
      if (c && (video.currentTime < c.start || video.currentTime >= c.end - 0.05)) video.currentTime = c.start;
      video.play().catch(() => {});
    } else video.pause();
  }

  // ---------- linha do tempo ----------
  const DRAG = { edge: null, clip: null };
  function drawTimeline() {
    const dpr = window.devicePixelRatio || 1, w = tl.clientWidth, h = tl.clientHeight;
    if (!w || !h) return;
    if (tl.width !== Math.round(w * dpr) || tl.height !== Math.round(h * dpr)) { tl.width = Math.round(w * dpr); tl.height = Math.round(h * dpr); }
    const c = tctx, D = S.duration || 1, X = (t) => t / D * w;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#101017';
    c.fillRect(0, 0, w, h);
    const wt = 20, wh = h - 20 - 16;
    if (S.db) {
      const db = S.db, n = db.length, lo = quantile(db, 0.05);
      c.fillStyle = '#4b4b62';
      for (let px = 0; px < w; px++) {
        const i0 = Math.floor(px / w * n), i1 = Math.max(i0 + 1, Math.floor((px + 1) / w * n));
        let m = -200;
        for (let i = i0; i < i1; i++) if (db[i] > m) m = db[i];
        const bh = Math.max(1, clamp((m - lo) / (S.dbHi - lo), 0, 1) * wh);
        c.fillRect(px, wt + (wh - bh) / 2, 1, bh);
      }
    } else {
      c.fillStyle = '#2a2a38';
      c.fillRect(0, wt + wh / 2, w, 1);
    }
    if (S.sc) {
      const sc = S.sc.score, lo = quantile(sc, 0.05), hi = quantile(sc, 0.98) || 1;
      const bw = Math.max(1, w / sc.length);
      for (let t = 0; t < sc.length; t++) {
        const k = clamp((sc[t] - lo) / (hi - lo || 1), 0, 1);
        c.fillStyle = `hsl(${230 + k * 175}, ${55 + k * 45}%, ${22 + k * 38}%)`;
        c.fillRect(X(t), h - 10, bw + 0.5, 6);
      }
    }
    c.font = '600 11px ' + FONT;
    S.clips.forEach((cl, i) => {
      const x0 = X(cl.start), x1 = X(cl.end), on = cl.id === S.sel;
      c.fillStyle = on ? 'rgba(255,46,99,.26)' : 'rgba(255,154,60,.12)';
      c.fillRect(x0, 0, x1 - x0, h - 14);
      c.fillStyle = on ? '#ff2e63' : '#ff9a3c';
      c.fillRect(x0, 0, x1 - x0, 3);
      c.fillText('#' + (i + 1), x0 + 4, 15);
      if (on) { c.fillRect(x0 - 2, wt, 4, wh); c.fillRect(x1 - 2, wt, 4, wh); }
    });
    c.fillStyle = '#fff';
    c.fillRect(X(video.currentTime) - 1, 0, 2, h);
  }

  function tlTime(e) {
    const r = tl.getBoundingClientRect();
    return clamp((e.clientX - r.left) / r.width, 0, 1) * S.duration;
  }
  tl.addEventListener('pointerdown', (e) => {
    if (!S.duration) return;
    const t = tlTime(e), r = tl.getBoundingClientRect(), px = S.duration / r.width;
    const sel = curClip();
    if (sel && Math.abs(t - sel.start) < 8 * px) DRAG.edge = 'start';
    else if (sel && Math.abs(t - sel.end) < 8 * px) DRAG.edge = 'end';
    if (DRAG.edge) { DRAG.clip = sel; tl.setPointerCapture(e.pointerId); return; }
    const hit = S.clips.find((c) => t >= c.start && t <= c.end);
    if (hit && hit.id !== S.sel) select(hit.id, false);
    video.currentTime = t;
    S.dirty = true;
  });
  tl.addEventListener('pointermove', (e) => {
    if (!DRAG.edge) {
      const sel = curClip();
      if (sel && S.duration) {
        const t = tlTime(e), px = S.duration / tl.getBoundingClientRect().width;
        tl.style.cursor = Math.abs(t - sel.start) < 8 * px || Math.abs(t - sel.end) < 8 * px ? 'ew-resize' : 'pointer';
      }
      return;
    }
    setEdge(DRAG.clip, DRAG.edge, tlTime(e), true);
  });
  const endDrag = () => { if (DRAG.edge) { DRAG.edge = null; refreshClip(DRAG.clip); } };
  tl.addEventListener('pointerup', endDrag);
  tl.addEventListener('pointercancel', endDrag);

  function setEdge(clip, edge, t, seekTo) {
    if (edge === 'start') clip.start = clamp(t, 0, clip.end - 2);
    else clip.end = clamp(t, clip.start + 2, S.duration);
    if (seekTo) video.currentTime = clip[edge];
    renderEditor();
    S.dirty = true;
  }
  function refreshClip(clip) {
    clip.score = toPct(rangeRaw(clip.start, clip.end));
    clip.reasons = reasons(clip.start, clip.end);
    renderClips(); renderEditor();
  }

  // ---------- lista e editor ----------
  function select(id, seekTo = true) {
    S.sel = id;
    const c = curClip();
    if (c && seekTo) { video.pause(); video.currentTime = c.start; }
    renderClips(); renderEditor(); updateSubsInfo();
    $('#transcript').value = c ? c.transcript : '';
    S.dirty = true;
  }

  function renderClips() {
    const list = $('#clipList');
    if (!S.clips.length) {
      list.innerHTML = S.sc ? '<p class="empty">Nenhum corte. Toque em <b>Gerar cortes</b> ou crie um manual.</p>' : '';
      return;
    }
    list.innerHTML = S.clips.map((c, i) => `
      <article class="clip${c.id === S.sel ? ' on' : ''}" data-id="${c.id}">
        <div class="thumb">${c.thumb ? `<img src="${c.thumb}" alt="">` : ''}<span class="dur">${Math.round(c.end - c.start)}s</span></div>
        <div class="meta">
          <div class="row1"><b>#${i + 1}</b><span class="time">${fmt(c.start)} – ${fmt(c.end)}</span>
            <span class="score${c.score < 70 ? ' low' : c.score < 85 ? ' mid' : ''}" title="Potencial viral estimado">${c.score}</span></div>
          <div class="title">${esc(c.title)}</div>
          <div class="tags">${c.reasons.map((r) => `<span>${esc(r)}</span>`).join('')}</div>
        </div>
        <div class="acts">
          <button data-act="play" title="Assistir">▶</button>
          <button data-act="export" title="Exportar">⬇</button>
          <button data-act="del" title="Apagar">✕</button>
        </div>
      </article>`).join('');
  }

  $('#clipList').addEventListener('click', (e) => {
    const el = e.target.closest('.clip');
    if (!el) return;
    const id = +el.dataset.id, act = e.target.closest('[data-act]');
    const clip = S.clips.find((c) => c.id === id);
    if (!act) { select(id); return; }
    if (act.dataset.act === 'play') { select(id); togglePlay(); }
    if (act.dataset.act === 'export') exportClips([clip]);
    if (act.dataset.act === 'del') {
      S.clips = S.clips.filter((c) => c.id !== id);
      if (S.sel === id) S.sel = S.clips[0] ? S.clips[0].id : null;
      $('#exportAll').disabled = !S.clips.length;
      select(S.sel, false);
    }
  });

  function renderEditor() {
    const c = curClip();
    $('#clipEdit').hidden = !c;
    if (!c) return;
    $('#ceName').textContent = 'Corte #' + (S.clips.indexOf(c) + 1);
    $('#ceDur').textContent = (c.end - c.start).toFixed(1) + ' s' + (opts.speed !== 1 ? ` → ${((c.end - c.start) / opts.speed).toFixed(1)} s no vídeo final` : '');
    if (document.activeElement !== $('#ceTitle')) $('#ceTitle').value = c.title;
    $('#ceStart').textContent = fmt(c.start);
    $('#ceEnd').textContent = fmt(c.end);
  }

  $('#ceTitle').addEventListener('input', (e) => {
    const c = curClip();
    if (!c) return;
    c.title = e.target.value;
    S.dirty = true;
    const card = $(`.clip[data-id="${c.id}"] .title`);
    if (card) card.textContent = c.title;
  });
  $('#ceShuffle').addEventListener('click', () => {
    const c = curClip();
    if (!c) return;
    const i = HOOKS.indexOf(c.title);
    c.title = HOOKS[(i + 1 + Math.floor(Math.random() * (HOOKS.length - 1))) % HOOKS.length];
    $('#ceTitle').value = c.title;
    renderClips(); S.dirty = true;
  });
  $$('.nudge button').forEach((b) => b.addEventListener('click', () => {
    const c = curClip();
    if (!c) return;
    const edge = b.dataset.edge;
    const t = b.dataset.d === 'here' ? video.currentTime : c[edge] + +b.dataset.d;
    setEdge(c, edge, t, true);
    refreshClip(c);
  }));
  $('#ceExport').addEventListener('click', () => { const c = curClip(); if (c) exportClips([c]); });

  $('#regen').addEventListener('click', regen);
  $('#addClip').addEventListener('click', () => {
    const L = +$('#genLen').value, s = clamp(video.currentTime, 0, Math.max(0, S.duration - 2));
    const c = makeClip(s, Math.min(S.duration, s + L));
    S.clips.push(c);
    $('#exportAll').disabled = false;
    select(c.id);
    makeThumbs(S.token);
  });
  $('#prevClip').addEventListener('click', () => stepClip(-1));
  $('#nextClip').addEventListener('click', () => stepClip(1));
  function stepClip(d) {
    if (!S.clips.length) return;
    const i = S.clips.findIndex((c) => c.id === S.sel);
    select(S.clips[(i + d + S.clips.length) % S.clips.length].id);
  }

  // ---------- legendas ----------
  // divide o texto em blocos de até 3 palavras (ou até uma pontuação)
  function chunks(words) {
    const out = [];
    let cur = [];
    for (const w of words) {
      cur.push(w);
      if (cur.length >= 3 || /[.!?,;:…]$/.test(w)) { out.push(cur); cur = []; }
    }
    if (cur.length) out.push(cur);
    return out;
  }

  // espalha as palavras pelos trechos com voz do corte
  function syncTranscript(clip, text) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    S.cues = S.cues.filter((c) => c.e <= clip.start || c.s >= clip.end);
    clip.transcript = text;
    if (words.length) {
      const segs = [];
      if (S.voiced) {
        const i0 = Math.floor(clip.start / S.hop), i1 = Math.ceil(clip.end / S.hop);
        let a = null;
        for (let i = i0; i <= i1; i++) {
          // pausas curtas (menos de 0,3 s) contam como fala
          let on = S.voiced[i] === 1;
          if (!on && a != null) for (let k = 1; k <= 6 && i + k <= i1; k++) if (S.voiced[i + k]) { on = true; break; }
          if (on && a == null) a = i;
          if ((!on || i === i1) && a != null) { segs.push([Math.max(clip.start, a * S.hop), Math.min(clip.end, i * S.hop)]); a = null; }
        }
      }
      if (!segs.length) segs.push([clip.start, clip.end]);
      const V = segs.reduce((s, g) => s + g[1] - g[0], 0);
      const at = (off) => {
        for (const [a, b] of segs) { if (off <= b - a) return a + off; off -= b - a; }
        return segs[segs.length - 1][1];
      };
      // palavras longas levam mais tempo
      const weights = words.map((w) => 1 + w.length / 6), total = weights.reduce((a, b) => a + b, 0);
      let k = 0, acc = 0;
      for (const ch of chunks(words)) {
        const s = at(acc / total * V);
        for (let j = 0; j < ch.length; j++) acc += weights[k++];
        S.cues.push({ s, e: Math.max(s + 0.2, at(acc / total * V)), text: ch.join(' ') });
      }
    }
    S.cues.sort((a, b) => a.s - b.s);
    updateSubsInfo();
    S.dirty = true;
  }

  function parseSubs(txt) {
    const ts = (s) => { const m = s.trim().replace(',', '.').match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/); return m ? (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3] : null; };
    const out = [];
    for (const block of txt.replace(/\r/g, '').split(/\n\s*\n/)) {
      const lines = block.split('\n');
      const li = lines.findIndex((l) => l.includes('-->'));
      if (li < 0) continue;
      const [a, b] = lines[li].split('-->');
      const s = ts(a), e = ts(b);
      const text = lines.slice(li + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\{[^}]+\}/g, '').trim();
      if (s == null || e == null || !text || e <= s) continue;
      // falas longas viram blocos curtos, com o tempo dividido pelas palavras
      const parts = chunks(text.split(/\s+/)), n = text.split(/\s+/).length;
      let k = 0;
      for (const p of parts) {
        out.push({ s: s + (e - s) * k / n, e: s + (e - s) * (k + p.length) / n, text: p.join(' ') });
        k += p.length;
      }
    }
    return out.sort((x, y) => x.s - y.s);
  }

  function updateSubsInfo() {
    const c = curClip();
    $('#trLabel').textContent = c ? `Texto falado no corte #${S.clips.indexOf(c) + 1}` : 'Selecione um corte';
    $('#applyTr').disabled = $('#clearTr').disabled = $('#exportSrt').disabled = !c;
    const inClip = c ? S.cues.filter((q) => q.e > c.start && q.s < c.end).length : 0;
    $('#subsInfo').textContent = S.cues.length
      ? `${S.cues.length} blocos de legenda no vídeo${c ? `, ${inClip} neste corte` : ''}.`
      : 'Ainda sem legendas.';
  }

  $('#applyTr').addEventListener('click', () => {
    const c = curClip();
    if (!c) return;
    syncTranscript(c, $('#transcript').value);
    if (opts.capStyle === 'none') toast('As legendas estão desligadas em Estilo → Legendas.');
    else toast('Legendas sincronizadas com a fala.');
  });
  $('#clearTr').addEventListener('click', () => { const c = curClip(); if (c) { $('#transcript').value = ''; syncTranscript(c, ''); } });
  $('#srtFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const cues = parseSubs(await f.text());
    if (!cues.length) { toast('Não encontrei legendas nesse arquivo.'); return; }
    S.cues = cues;
    updateSubsInfo();
    S.dirty = true;
    toast(`${cues.length} blocos de legenda importados.`);
  });
  $('#exportSrt').addEventListener('click', () => {
    const c = curClip();
    if (!c) return;
    const t2 = (t) => {
      const ms = Math.round(Math.max(0, t) * 1000), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
      return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':') + ',' + String(ms % 1000).padStart(3, '0');
    };
    const cues = S.cues.filter((q) => q.e > c.start && q.s < c.end);
    if (!cues.length) { toast('Este corte ainda não tem legendas.'); return; }
    const srt = cues.map((q, i) => `${i + 1}\n${t2((Math.max(q.s, c.start) - c.start) / opts.speed)} --> ${t2((Math.min(q.e, c.end) - c.start) / opts.speed)}\n${q.text}\n`).join('\n');
    download(new Blob([srt], { type: 'text/plain' }), `corte-${String(S.clips.indexOf(c) + 1).padStart(2, '0')}.srt`);
  });

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return a.href;
  }

  // ---------- exportação ----------
  const X = { ac: null, cancel: false };
  function pickMime() {
    const list = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    return list.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  }
  function outSize() {
    const [W, H] = SIZES[opts.ratio], k = opts.quality === 720 ? 2 / 3 : 1;
    return [Math.round(W * k / 2) * 2, Math.round(H * k / 2) * 2];
  }

  async function recordClip(clip, onp) {
    const [W, H] = outSize();
    const can = document.createElement('canvas');
    can.width = W; can.height = H;
    const ctx = can.getContext('2d');
    if (!X.ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      X.ac = new AC();
      X.dest = X.ac.createMediaStreamDestination();
      X.ac.createMediaElementSource(xv).connect(X.dest); // o som vai só para o arquivo, não para as colunas
    }
    await X.ac.resume();
    xv.playbackRate = opts.speed;
    await seek(xv, clip.start);
    const st = { cx: 0.5, tx: 0.5, zoom: 1 };
    render(ctx, W, H, xv, xv.currentTime, clip, st, false);
    const stream = can.captureStream(30);
    X.dest.stream.getAudioTracks().forEach((tr) => stream.addTrack(tr));
    const mime = pickMime();
    const rec = new MediaRecorder(stream, Object.assign(mime ? { mimeType: mime } : {}, { videoBitsPerSecond: W * H > 1.5e6 ? 10e6 : 6e6, audioBitsPerSecond: 160000 }));
    const chunksOut = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksOut.push(e.data); };
    const stopped = once(rec, 'stop');
    rec.start(500);
    await xv.play();
    await new Promise((res) => {
      const tick = () => {
        if (X.cancel || xv.ended || xv.currentTime >= clip.end) { res(); return; }
        render(ctx, W, H, xv, xv.currentTime, clip, st, true);
        onp((xv.currentTime - clip.start) / (clip.end - clip.start));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    xv.pause();
    rec.stop();
    await stopped;
    stream.getVideoTracks().forEach((t) => t.stop());
    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    return { blob: new Blob(chunksOut, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm' };
  }

  async function exportClips(list) {
    if (!list.length) return;
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
      toast('Este navegador não consegue gravar vídeo. Use Chrome, Edge, Firefox ou Safari atualizado.', 6000);
      return;
    }
    video.pause();
    X.cancel = false;
    $('#xModal').hidden = false;
    $('#xList').innerHTML = '';
    $('#xCancel').hidden = false; $('#xClose').hidden = true;
    $('#xTitle').textContent = 'Exportando';
    for (let k = 0; k < list.length && !X.cancel; k++) {
      const c = list[k], idx = S.clips.indexOf(c) + 1;
      $('#xText').textContent = `Corte #${idx}${list.length > 1 ? ` (${k + 1} de ${list.length})` : ''} · ${((c.end - c.start) / opts.speed).toFixed(0)} s`;
      try {
        const { blob, ext } = await recordClip(c, (p) => { $('#xBar').style.width = Math.round(clamp((k + p) / list.length, 0, 1) * 100) + '%'; });
        if (X.cancel) break;
        const name = `corte-${String(idx).padStart(2, '0')}.${ext}`;
        const href = download(blob, name);
        $('#xList').insertAdjacentHTML('beforeend', `<a href="${href}" download="${name}"><span>${name}</span><b>${(blob.size / 1048576).toFixed(1)} MB ⬇</b></a>`);
      } catch (e) {
        console.error(e);
        $('#xList').insertAdjacentHTML('beforeend', `<div class="err">Corte #${idx}: não foi possível exportar.</div>`);
      }
    }
    $('#xBar').style.width = X.cancel ? '0%' : '100%';
    $('#xTitle').textContent = X.cancel ? 'Exportação cancelada' : 'Pronto!';
    $('#xText').textContent = X.cancel ? '' : 'Os arquivos foram baixados. Também pode baixar de novo aqui:';
    $('#xCancel').hidden = true; $('#xClose').hidden = false;
  }
  $('#xCancel').addEventListener('click', () => { X.cancel = true; });
  $('#xClose').addEventListener('click', () => { $('#xModal').hidden = true; });
  $('#exportAll').addEventListener('click', () => exportClips(S.clips.slice()));

  // ---------- opções de estilo ----------
  function syncOpts() {
    $$('[data-opt]').forEach((el) => {
      const k = el.dataset.opt;
      if (el.classList.contains('seg')) el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(opts[k]) === b.dataset.v));
      else if (el.type === 'checkbox') el.checked = !!opts[k];
      else el.value = opts[k];
    });
    $$('[data-show]').forEach((el) => { const [k, v] = el.dataset.show.split(':'); el.hidden = String(opts[k]) !== v; });
  }
  function setOpt(k, v) {
    opts[k] = v;
    saveOpts(); syncOpts();
    if (k === 'ratio') sizeView();
    if (k === 'speed') { video.playbackRate = v; renderEditor(); }
    if (k === 'reframe' || k === 'fit') { P.cx = P.tx = 0.5; P.prev = null; }
    S.dirty = true;
  }
  $$('[data-opt]').forEach((el) => {
    const k = el.dataset.opt, num = el.hasAttribute('data-num');
    if (el.classList.contains('seg')) {
      el.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setOpt(k, num ? +b.dataset.v : b.dataset.v); });
    } else {
      el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
        setOpt(k, el.type === 'checkbox' ? el.checked : num ? +el.value : el.value);
      });
    }
  });

  // ---------- interface geral ----------
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => {
    $$('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $$('.tab').forEach((t) => { t.hidden = t.id !== 'tab-' + b.dataset.tab; });
  }));
  $('#file').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  $('#play').addEventListener('click', togglePlay);
  $('#skipVisual').addEventListener('click', () => { S.skipVisual = true; });
  video.addEventListener('play', () => { $('#play').textContent = '⏸'; });
  video.addEventListener('pause', () => { $('#play').textContent = '▶'; S.dirty = true; });
  video.addEventListener('seeking', () => { P.prev = null; });
  video.addEventListener('seeked', () => { S.dirty = true; });
  video.addEventListener('loadeddata', () => { S.dirty = true; });

  const drop = $('#drop');
  document.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });
  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || !S.url || !$('#xModal').hidden) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowLeft') { video.currentTime = Math.max(0, video.currentTime - 1); }
    if (e.code === 'ArrowRight') { video.currentTime = Math.min(S.duration, video.currentTime + 1); }
  });
  new ResizeObserver(() => { if (S.url) sizeView(); }).observe($('#previewWrap'));
  new ResizeObserver(() => { S.dirty = true; }).observe(tl);

  syncOpts();
  requestAnimationFrame(frame);
})();
