'use strict';
// Aprendizado: o site analisa os Reels já publicados, os cortes exportados e cortes virais de
// outros perfis (referências) junto com as métricas de cada um, descobre que características dão
// resultado e passa essa previsão para a escolha automática dos cortes (app.js → pickClips).
(() => {
  const C = window.Cortes;
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KEY = 'cortes-learn', MIN = 5;
  const METRICS = [['views', '👁 Visualiz.'], ['likes', '❤️ Curtidas'], ['comments', '💬 Coment.'], ['shares', '↗️ Compart.'], ['saves', '🔖 Salvam.']];
  const METRICS_REF = [['views', '👁 Visualiz.'], ['followers', '👥 Seguidores'], ['likes', '❤️ Curtidas'], ['comments', '💬 Coment.']];
  const isRef = (it) => it.source === 'ref';
  // referências pesam menos quando já há vídeos seus suficientes
  const refWeight = (own) => (own >= MIN ? 0.6 : 1);
  // como explicar cada característica quando ela ajuda (peso positivo / negativo)
  const LABELS = {
    dur: ['Vídeos mais longos', 'Vídeos mais curtos'],
    hook: ['Começo mais forte (voz mais alta que o resto)', 'Começo mais calmo'],
    vf: ['Mais tempo de fala, poucas pausas', 'Mais pausas e respiros'],
    dyn: ['Voz com altos e baixos', 'Voz constante, sem variação'],
    peaks: ['Mais picos de reação', 'Menos picos de reação'],
    motion: ['Imagem com mais movimento', 'Imagem mais parada'],
    hookMotion: ['Mais ação nos 3 primeiros segundos', 'Começo visualmente calmo'],
    cuts: ['Mais cortes de cena', 'Menos cortes de cena'],
    quietStart: ['Um respiro antes de começar a falar', 'Fala logo no primeiro segundo'],
    bursts: ['Fala picotada, frases curtas', 'Fala corrida, frases longas'],
  };

  let lib = load(), model = null;
  function load() {
    try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && Array.isArray(d.items)) return d; } catch (e) { /* vazio */ }
    return { target: 'views', items: [] };
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(lib)); } catch (e) { C.toast('Não foi possível guardar o aprendizado neste navegador. Faça um backup.', 6000); }
  }

  // "12 mil", "1,5 mi", "12.300", "3k" → número
  function parseNum(str) {
    let s = String(str).toLowerCase().trim();
    if (!s) return null;
    let mult = 1;
    if (/mil\b|k\s*$/.test(s)) mult = 1e3;
    else if (/mi|milh|m\s*$/.test(s)) mult = 1e6;
    s = s.replace(/[^\d.,]/g, '');
    s = mult > 1 ? s.replace(',', '.') : s.replace(/[.,\s]/g, '');
    const n = parseFloat(s);
    return isFinite(n) ? Math.round(n * mult) : null;
  }
  const fmtNum = (n) => (n == null || n === '' ? '' : Number(n).toLocaleString('pt-BR'));
  const fmtShort = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' mi' : n >= 1e3 ? Math.round(n / 1e3) + ' mil' : String(n);

  // ---------- modelo: regressão ridge sobre as características padronizadas ----------
  const complete = (it) => it.metrics.views > 0 && (!isRef(it) || it.metrics.followers > 0);
  // resultado de cada vídeo; nas referências, as visualizações são comparadas com o tamanho do perfil
  function targetOf(it) {
    const m = it.metrics || {}, v = m.views;
    if (!complete(it)) return null;
    if (lib.target === 'views') return isRef(it) ? Math.log10((v + 1) / (m.followers + 1)) : Math.log10(1 + v);
    if (m.likes == null) return null;
    const eng = m.likes + 2 * (m.comments || 0) + (isRef(it) ? 0 : 3 * (m.shares || 0) + 3 * (m.saves || 0));
    return Math.log10((eng + 1) / v);
  }

  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => r.concat(b[i]));
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      const d = M[c][c];
      if (Math.abs(d) < 1e-12) continue;
      for (let k = c; k <= n; k++) M[c][k] /= d;
      for (let r = 0; r < n; r++) if (r !== c && M[r][c]) { const f = M[r][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r) => r[n]);
  }
  function fit(X, y, lambda, wt) {
    const p = X[0].length, A = Array.from({ length: p }, () => new Array(p).fill(0)), b = new Array(p).fill(0);
    X.forEach((x, i) => { for (let j = 0; j < p; j++) { b[j] += wt[i] * x[j] * y[i]; for (let k = 0; k < p; k++) A[j][k] += wt[i] * x[j] * x[k]; } });
    for (let j = 0; j < p; j++) A[j][j] += lambda;
    return solve(A, b);
  }
  const dot = (w, x) => w.reduce((s, v, j) => s + v * x[j], 0);
  function corr(a, b) {
    const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
    let sab = 0, saa = 0, sbb = 0;
    a.forEach((x, i) => { sab += (x - ma) * (b[i] - mb); saa += (x - ma) ** 2; sbb += (b[i] - mb) ** 2; });
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
  }

  function train() {
    const F = C.FEATS;
    const rows = lib.items.map((it) => ({ it, y: targetOf(it) })).filter((r) => r.y != null && r.it.feats);
    const n = rows.length, own = rows.filter((r) => !isRef(r.it)).length, refs = n - own;
    if (n < MIN) return { ready: false, n, own, refs };
    // seus vídeos e as referências medem coisas diferentes: cada grupo é padronizado à parte
    for (const grp of [rows.filter((r) => !isRef(r.it)), rows.filter((r) => isRef(r.it))]) {
      const m = grp.reduce((a, r) => a + r.y, 0) / (grp.length || 1);
      const d = Math.sqrt(grp.reduce((a, r) => a + (r.y - m) ** 2, 0) / (grp.length || 1)) || 1;
      grp.forEach((r) => { r.raw = r.y; r.y = (r.y - m) / d; });
    }
    const wt = rows.map((r) => (isRef(r.it) ? refWeight(own) : 1));
    const mu = F.map((k) => rows.reduce((s, r) => s + (r.it.feats[k] || 0), 0) / n);
    const sd = F.map((k, j) => Math.sqrt(rows.reduce((s, r) => s + ((r.it.feats[k] || 0) - mu[j]) ** 2, 0) / n) || 1);
    const X = rows.map((r) => F.map((k, j) => ((r.it.feats[k] || 0) - mu[j]) / sd[j]));
    const y = rows.map((r) => r.y), ym = 0;
    const lambda = 2 + 40 / n; // poucos vídeos → modelo mais cauteloso
    const w = fit(X, y, lambda, wt);
    // confiança: cada vídeo é previsto por um modelo treinado sem ele
    const skip = (arr, i) => arr.filter((_, k) => k !== i);
    const loo = X.map((x, i) => dot(fit(skip(X, i), skip(y, i), lambda, skip(wt, i)), x));
    const conf = Math.max(0, corr(loo, y));
    const ranked = rows.slice().sort((a, b) => b.y - a.y), top = ranked.slice(0, Math.ceil(n / 3));
    const durs = top.map((r) => r.it.feats.dur).sort((a, b) => a - b);
    const bestOf = (ref) => { const r = rows.filter((x) => isRef(x.it) === ref).sort((a, b) => b.raw - a.raw)[0]; return r ? r.it : null; };
    return {
      ready: true, n, own, refs, conf, w, bestOwn: bestOf(false), bestRef: bestOf(true),
      idealDur: durs[Math.floor(durs.length / 2)],
      factors: F.map((k, j) => ({ k, w: w[j] })).filter((f) => Math.abs(f.w) > 0.03).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)),
      predict: (f) => ym + F.reduce((s, k, j) => s + w[j] * ((f[k] || 0) - mu[j]) / sd[j], 0),
    };
  }
  function retrain(list = true) { model = train(); renderSummary(); if (list) renderList(); }

  // usado pelo editor ao escolher os cortes
  window.CortesLearn = {
    model() {
      if (!model || !model.ready || model.conf < 0.1) return null;
      return { predict: model.predict, weight: clamp(model.conf, 0, 0.7) };
    },
    status() {
      return { n: model ? model.n : 0, own: model ? model.own : 0, refs: model ? model.refs : 0, min: MIN, conf: model && model.ready ? Math.round(model.conf * 100) : 0 };
    },
    addExport({ name, title, thumb, feats }) {
      lib.items.unshift({ id: newId(), name, title, source: 'export', thumb: thumb || null, feats: round(feats), metrics: {}, added: today() });
      save(); retrain();
    },
  };

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const today = () => new Date().toISOString().slice(0, 10);
  const round = (f) => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));

  // ---------- análise dos Reels enviados ----------
  const queue = [];
  let working = false, progress = 0;
  function addFiles(files, source) {
    for (const f of files) {
      const key = f.name + ':' + f.size;
      if (lib.items.some((it) => it.key === key) || queue.some((q) => q.file.name + ':' + q.file.size === key)) continue;
      queue.push({ file: f, source });
    }
    if (source === 'ref') C.toast('Depois da análise, preencha as visualizações e os seguidores do perfil de cada referência.', 6000);
    renderQueue();
    if (!working) run();
  }
  async function run() {
    working = true;
    while (queue.length) {
      const { file: f, source } = queue[0];
      progress = 0;
      renderQueue();
      try {
        const it = await analyzeReel(f, (p) => { progress = p; renderQueue(); }, source);
        lib.items.unshift(it);
        save(); retrain();
      } catch (e) {
        console.error(e);
        C.toast(`Não consegui analisar “${f.name}”. Tente um MP4.`, 5000);
      }
      queue.shift();
    }
    working = false;
    renderQueue();
  }
  async function analyzeReel(file, onp, source) {
    const url = URL.createObjectURL(file);
    try {
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
      await Promise.race([C.once(v, 'loadedmetadata'), C.once(v, 'error').then(() => { throw new Error('formato'); })]);
      const duration = v.duration;
      if (!isFinite(duration) || duration <= 0) throw new Error('duração');
      await C.seek(v, Math.min(1, duration / 3));
      const c = document.createElement('canvas');
      c.width = 108; c.height = 192;
      const ctx = c.getContext('2d'), s = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
      ctx.drawImage(v, (c.width - v.videoWidth * s) / 2, (c.height - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
      let thumb = null;
      try { thumb = c.toDataURL('image/jpeg', 0.6); } catch (e) { /* sem miniatura */ }
      v.removeAttribute('src'); v.load();
      onp(0.1);
      let aud = null;
      try { aud = C.audioStats(await C.decodeAudio(file)); } catch (e) { /* sem áudio */ }
      onp(0.3);
      const vis = await C.visualScan(url, duration, (p) => onp(0.3 + 0.7 * p), () => false);
      const feats = C.features(C.buildSeries(duration, aud, vis), 0, duration);
      return { id: newId(), key: file.name + ':' + file.size, name: file.name.replace(/\.[^.]+$/, ''), source, profile: '', thumb, feats: round(feats), metrics: {}, added: today() };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---------- tela ----------
  function renderQueue() {
    $('#lQueue').textContent = queue.length
      ? `Analisando “${queue[0].file.name}” (${Math.round(progress * 100)}%)${queue.length > 1 ? ` · mais ${queue.length - 1} na fila` : ''}…`
      : '';
  }

  function renderSummary() {
    const m = model || { ready: false, n: 0 };
    const pend = lib.items.filter((it) => !complete(it)).length;
    const mix = m.n ? ` <span class="muted" style="display:inline;font-size:14px;font-weight:400">(${m.own} seus · ${m.refs} referências)</span>` : '';
    let st;
    if (!m.ready) {
      st = `<b>Aprendendo: ${m.n} de ${MIN} vídeos${mix}</b><span class="muted">Adicione seus Reels ou cortes virais de outros perfis e preencha os números. Com ${MIN} já começa; com 15 ou mais o padrão fica bem mais confiável.</span>
        <div class="dots">${Array.from({ length: MIN }, (_, i) => `<i class="${i < m.n ? 'on' : ''}"></i>`).join('')}</div>`;
    } else if (m.conf < 0.1) {
      st = `<b>${m.n} vídeos · ainda sem padrão${mix}</b><span class="muted">Os resultados ainda não seguem um padrão claro. Os cortes usam só a análise geral até haver mais vídeos.</span>`;
    } else {
      st = `<b>Ativo · ${m.n} vídeos${mix}</b><span class="muted">A escolha automática dos cortes já usa o que aprendeu.${m.refs && m.own >= MIN ? ' Seus vídeos contam mais que as referências.' : ''}</span>`;
    }
    if (pend) st += `<p class="hint tag-pend" style="margin:10px 0 0">${pend} ${pend > 1 ? 'vídeos aguardam' : 'vídeo aguarda'} os números.</p>`;
    $('#lStatus').innerHTML = st;
    $('#lTarget').value = lib.target;

    let ins;
    if (!m.ready) {
      ins = '<p class="hint">Aqui vão aparecer as características que mais aumentam o resultado dos vídeos, a duração ideal, o seu melhor Reel e a melhor referência.</p>';
    } else {
      const max = Math.max(...m.factors.map((f) => Math.abs(f.w)), 1e-6);
      ins = `<div class="conf"><span>Confiança</span><div class="bar"><i style="width:${Math.round(m.conf * 100)}%"></i></div><b>${Math.round(m.conf * 100)}%</b></div>`;
      ins += m.factors.length
        ? m.factors.slice(0, 6).map((f) => `<div class="factor"><span>✅ ${esc(LABELS[f.k][f.w > 0 ? 0 : 1])}</span><div class="fbar"><i style="width:${Math.round(Math.abs(f.w) / max * 100)}%"></i></div></div>`).join('')
        : '<p class="hint">Nenhuma característica se destaca ainda.</p>';
      const name = (it) => esc(it.title || it.name) + (it.profile ? ` (${esc(it.profile)})` : '');
      ins += `<div class="facts">
        <span>⏱ Duração dos melhores: <b>~${Math.round(m.idealDur)} s</b><button id="lUseDur" class="btn ghost small">Usar nos cortes</button></span>
        ${m.bestOwn ? `<span>🏆 Seu melhor: <b>${name(m.bestOwn)}</b> · ${fmtShort(m.bestOwn.metrics.views)} visualizações</span>` : ''}
        ${m.bestRef ? `<span>🌟 Melhor referência: <b>${name(m.bestRef)}</b> · ${(m.bestRef.metrics.views / m.bestRef.metrics.followers).toFixed(1).replace('.', ',')}× os seguidores</span>` : ''}
      </div>`;
      ins += '<p class="hint" style="margin:12px 0 0">A confiança mede o quanto o modelo acerta vídeos que não viu no treino. Correlação não é garantia: use como guia.</p>';
    }
    $('#lInsights').innerHTML = ins;
    const use = $('#lUseDur');
    if (use) use.addEventListener('click', () => {
      const opts = [15, 30, 45, 60, 90], d = model.idealDur;
      const best = opts.reduce((a, b) => (Math.abs(b - d) < Math.abs(a - d) ? b : a));
      $('#genLen').value = String(best);
      C.toast(`Duração dos cortes: ${best} s. Toque em Gerar cortes para aplicar.`);
    });

  }

  const footOf = (it) => complete(it) ? 'Adicionado em ' + it.added.split('-').reverse().join('/')
    : `<span class="tag-pend">Falta preencher ${isRef(it) && it.metrics.views > 0 ? 'os seguidores' : isRef(it) && !it.metrics.followers ? 'visualizações e seguidores' : 'as visualizações'}</span>`;
  const needs = (it, k) => (k === 'views' && !(it.metrics.views > 0)) || (k === 'followers' && !(it.metrics.followers > 0));
  let filter = 'all';
  function renderList() {
    const items = lib.items.filter((it) => filter === 'all' || (filter === 'ref') === isRef(it));
    $('#lCount').textContent = lib.items.length ? `(${lib.items.length})` : '';
    $('#lList').innerHTML = items.length ? items.map((it) => `
      <article class="reel${isRef(it) ? ' ref' : ''}" data-id="${it.id}">
        <div class="rthumb">${it.thumb ? `<img src="${it.thumb}" alt="">` : ''}<span class="src">${isRef(it) ? 'Referência' : it.source === 'export' ? 'Corte' : 'Reel'}</span><span class="dur">${Math.round(it.feats.dur)}s</span></div>
        <div>
          <div class="rname" title="${esc(it.title || it.name)}">${esc(it.title ? it.title + ' — ' + it.name : it.name)}</div>
          ${isRef(it) ? `<input class="rprofile" data-p value="${esc(it.profile || '')}" placeholder="@perfil (opcional)" maxlength="40">` : ''}
          <div class="rgrid">${(isRef(it) ? METRICS_REF : METRICS).map(([k, label]) => `<label class="${needs(it, k) ? 'need' : ''}"><span>${label}</span><input inputmode="decimal" data-m="${k}" value="${fmtNum(it.metrics[k])}" placeholder="—"></label>`).join('')}</div>
          <div class="rfoot"><span class="rstate">${footOf(it)}</span><button data-del title="Remover do aprendizado">Remover</button></div>
        </div>
      </article>`).join('')
      : `<p class="empty">${filter === 'ref' ? 'Nenhuma referência ainda. Salve no celular cortes virais de outros perfis e adicione aqui.' : 'Nenhum vídeo ainda. Adicione os seus Reels ou referências para o site começar a aprender.'}</p>`;
  }

  $('#lList').addEventListener('change', (e) => {
    const prof = e.target.closest('input[data-p]');
    if (prof) {
      const it = lib.items.find((x) => x.id === prof.closest('.reel').dataset.id);
      const v = prof.value.trim().replace(/^@?/, '@');
      it.profile = v === '@' ? '' : v.slice(0, 40);
      prof.value = it.profile;
      save(); retrain(false);
      return;
    }
    const inp = e.target.closest('input[data-m]');
    if (!inp) return;
    const it = lib.items.find((x) => x.id === inp.closest('.reel').dataset.id);
    const n = parseNum(inp.value);
    if (n == null) delete it.metrics[inp.dataset.m]; else it.metrics[inp.dataset.m] = n;
    inp.value = fmtNum(n);
    // só este cartão muda: redesenhar a lista tiraria o foco do campo seguinte
    const card = inp.closest('.reel');
    card.querySelectorAll('input[data-m]').forEach((x) => x.parentElement.classList.toggle('need', needs(it, x.dataset.m)));
    card.querySelector('.rstate').innerHTML = footOf(it);
    save(); retrain(false);
  });
  $('#lList').addEventListener('click', (e) => {
    if (!e.target.closest('[data-del]')) return;
    const id = e.target.closest('.reel').dataset.id;
    lib.items = lib.items.filter((x) => x.id !== id);
    save(); retrain();
  });
  $('#lTarget').addEventListener('change', (e) => { lib.target = e.target.value; save(); retrain(); });
  $('#lFiles').addEventListener('change', (e) => { addFiles(Array.from(e.target.files), 'reel'); e.target.value = ''; });
  $('#lRefs').addEventListener('change', (e) => { addFiles(Array.from(e.target.files), 'ref'); e.target.value = ''; });
  $('#lFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    filter = b.dataset.v;
    $('#lFilter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderList();
  });
  $('#lExport').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(lib)], { type: 'application/json' }));
    a.download = `cortes-aprendizado-${today()}.json`;
    a.click();
  });
  $('#lImport').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d || !Array.isArray(d.items)) throw new Error('formato');
      const ids = new Set(lib.items.map((it) => it.id));
      const valid = d.items.filter((it) => it && it.id && it.feats && typeof it.feats.dur === 'number' && !ids.has(it.id))
        .map((it) => ({ id: String(it.id), key: String(it.key || ''), name: String(it.name || 'Vídeo'), title: it.title ? String(it.title) : '', source: ['export', 'ref'].includes(it.source) ? it.source : 'reel', profile: it.profile ? String(it.profile).slice(0, 40) : '',
          thumb: typeof it.thumb === 'string' && it.thumb.startsWith('data:image/') ? it.thumb : null, feats: it.feats, metrics: it.metrics || {}, added: String(it.added || today()) }));
      lib.items = valid.concat(lib.items);
      save(); retrain();
      C.toast(`${valid.length} vídeos restaurados.`);
    } catch (err) {
      C.toast('Esse arquivo não é um backup do aprendizado.');
    }
  });

  // abrir e fechar a tela
  let back = null;
  $('#learnBtn').addEventListener('click', () => {
    if (!$('#learn').hidden) return;
    back = $('#work').hidden ? '#intro' : '#work';
    const v = $('#src');
    if (v && !v.paused) v.pause();
    $('#intro').hidden = $('#work').hidden = true;
    $('#learn').hidden = false;
    window.scrollTo(0, 0);
  });
  $('#learnBack').addEventListener('click', () => {
    $('#learn').hidden = true;
    $(back || '#intro').hidden = false;
    window.dispatchEvent(new Event('resize'));
  });
  document.addEventListener('drop', (e) => {
    // vídeos soltos na tela de aprendizado entram como Reels, não no editor
    if ($('#learn').hidden) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    addFiles(Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm)$/i.test(f.name)), filter === 'ref' ? 'ref' : 'reel');
  }, true);

  retrain();
})();
