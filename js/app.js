import { analyze, segments, transposeChord, useFlats, parseChord, liveChord, NOTE_SHARP, NOTE_FLAT } from './engine.js';
import { diagramSVG, capoRanking } from './chords.js';

const $ = (id) => document.getElementById(id);
const TARGET_SR = 22050;
let song = null;          // current song object
let audioURL = null;
let audioBlob = null;
let segEls = [];          // [{b0,b1,el,bar}]
let rafId = 0;

// ---------- utils ----------
function toast(msg, ms = 2200) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms); }
function fmtTime(s) { s = Math.max(0, s); const m = Math.floor(s / 60), r = Math.floor(s % 60); return `${m}:${String(r).padStart(2, '0')}`; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(t) { return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const AC = window.AudioContext || window.webkitAudioContext;
const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;

// ---------- IndexedDB (audio blobs) ----------
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('chordapp', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('audio');
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error);
    });
  },
  async put(k, v) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
  async get(k) { const db = await this.open(); return new Promise((res, rej) => { const r = db.transaction('audio').objectStore('audio').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async del(k) { const db = await this.open(); return new Promise((res) => { const tx = db.transaction('audio', 'readwrite'); tx.objectStore('audio').delete(k); tx.oncomplete = res; tx.onerror = res; }); },
};

// ---------- storage ----------
const LS_INDEX = 'chordapp.index';
function loadIndex() { try { return JSON.parse(localStorage.getItem(LS_INDEX)) || []; } catch { return []; } }
function saveIndex(ix) { localStorage.setItem(LS_INDEX, JSON.stringify(ix)); }
async function saveSong(quiet = false) {
  if (!song) return;
  song.name = $('songName').value.trim() || song.name || '無題';
  song.lyrics = $('lyrics').value;
  song.updatedAt = Date.now();
  try {
    localStorage.setItem('chordapp.song.' + song.id, JSON.stringify(song));
  } catch (e) { toast('保存容量が足りません'); return; }
  const ix = loadIndex().filter(s => s.id !== song.id);
  ix.unshift({ id: song.id, name: song.name, updatedAt: song.updatedAt, key: song.key.name, duration: song.duration });
  saveIndex(ix);
  if (audioBlob && !song.hasAudio) {
    try { await idb.put(song.id, audioBlob); song.hasAudio = true; localStorage.setItem('chordapp.song.' + song.id, JSON.stringify(song)); } catch (e) { console.warn(e); }
  }
  song.saved = true;
  if (!quiet) toast('保存しました');
}
async function openSong(id) {
  const raw = localStorage.getItem('chordapp.song.' + id);
  if (!raw) { toast('読み込めませんでした'); return; }
  const s = JSON.parse(raw);
  let blob = null;
  if (s.hasAudio) { try { blob = await idb.get(id); } catch {} }
  setSong(s, blob || null);
}
async function deleteSong(id) {
  localStorage.removeItem('chordapp.song.' + id);
  saveIndex(loadIndex().filter(s => s.id !== id));
  try { await idb.del(id); } catch {}
}

// ---------- decoding / resampling ----------
function decode(arrayBuf) {
  const ctx = new AC();
  return new Promise((res, rej) => {
    const done = (b) => { try { ctx.close && ctx.close(); } catch {} res(b); };
    const fail = (e) => { try { ctx.close && ctx.close(); } catch {} rej(e || new Error('decode failed')); };
    const p = ctx.decodeAudioData(arrayBuf, done, fail);
    if (p && p.catch) p.catch(fail);
  });
}
async function toMono(buffer) {
  const len = Math.ceil(buffer.duration * TARGET_SR);
  const oc = new OAC(1, len, TARGET_SR);
  const src = oc.createBufferSource();
  src.buffer = buffer; src.connect(oc.destination); src.start(0);
  const rendered = await new Promise((res, rej) => {
    oc.oncomplete = (e) => res(e.renderedBuffer);
    const p = oc.startRendering();
    if (p && p.then) p.then(res, rej);
  });
  return new Float32Array(rendered.getChannelData(0));
}
function runAnalysis(x) {
  return new Promise((resolve, reject) => {
    let w;
    try { w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); }
    catch (e) { w = null; }
    const mainThread = () => setTimeout(() => {
      try { resolve(analyze(x, TARGET_SR, { onProgress: progress })); } catch (e) { reject(e); }
    }, 30);
    if (!w) return mainThread();
    let started = false;
    w.onmessage = (e) => {
      started = true;
      const m = e.data;
      if (m.type === 'progress') progress(m.text, m.p);
      else if (m.type === 'done') { w.terminate(); resolve(m.result); }
      else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); if (!started) mainThread(); else reject(e); };
    w.postMessage({ x, sr: TARGET_SR });
  });
}
function progress(text, p) {
  $('progress').hidden = false;
  $('progText').textContent = text;
  $('progBar').style.width = Math.round(p * 100) + '%';
}

async function processAudio(buffer, blob, name, source) {
  try {
    progress('音声を変換中…', 0.02);
    const x = await toMono(buffer);
    const r = await runAnalysis(x);
    const s = {
      id: uid(), name, source, createdAt: Date.now(), updatedAt: Date.now(),
      duration: r.duration, bpm: r.bpm, key: r.key, tuningCents: r.tuningCents,
      bounds: r.bounds, labels: r.labels, downbeatIndex: r.downbeatIndex, meter: 4,
      lyrics: '', transpose: 0, capo: 0, hasAudio: false,
    };
    const rank = capoRanking(segments(s.bounds, s.labels), 0);
    s.capo = rank[0].capo;
    setSong(s, blob);
    toast('解析が完了しました');
  } catch (e) {
    console.error(e);
    toast('解析に失敗しました: ' + (e.message || e), 4000);
  } finally {
    $('progress').hidden = true;
  }
}

// ---------- file input ----------
$('fileInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  progress('ファイルを読み込み中…', 0.01);
  try {
    const ab = await f.arrayBuffer();
    const buf = await decode(ab.slice(0));
    await processAudio(buf, f, f.name.replace(/\.[^.]+$/, ''), 'file');
  } catch (err) {
    console.error(err);
    $('progress').hidden = true;
    toast('このファイルは読み込めませんでした（DRM付きの曲は不可）', 4000);
  }
});

// ---------- microphone ----------
const rec = { ctx: null, stream: null, proc: null, chunks: [], len: 0, timer: 0, t0: 0, last: null };
$('btnRec').addEventListener('click', startRec);
$('btnRecStop').addEventListener('click', () => stopRec(true));
$('btnRecCancel').addEventListener('click', () => stopRec(false));

async function startRec() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('この環境ではマイクが使えません（HTTPSで開いてください）', 4000); return;
  }
  try {
    // create & resume AudioContext synchronously inside the tap (iOS requirement)
    rec.ctx = new AC();
    const resumeP = rec.ctx.resume ? rec.ctx.resume() : Promise.resolve();
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    await resumeP;
    if (rec.ctx.state !== 'running') { try { await rec.ctx.resume(); } catch {} }
    const src = rec.ctx.createMediaStreamSource(rec.stream);
    rec.proc = rec.ctx.createScriptProcessor(4096, 1, 1);
    const mute = rec.ctx.createGain(); mute.gain.value = 0;
    rec.chunks = []; rec.len = 0;
    rec.proc.onaudioprocess = (ev) => {
      const d = new Float32Array(ev.inputBuffer.getChannelData(0));
      rec.chunks.push(d); rec.len += d.length;
    };
    src.connect(rec.proc); rec.proc.connect(mute); mute.connect(rec.ctx.destination);
    rec.src = src; rec.mute = mute;
    rec.t0 = performance.now(); rec.last = null; rec.lastCount = 0;
    $('recPanel').hidden = false; $('btnRec').hidden = true;
    rec.timer = setInterval(recTick, 250);
  } catch (e) {
    console.error(e);
    cleanupRec();
    toast('マイクを使えませんでした: ' + (e.name === 'NotAllowedError' ? 'マイクの許可が必要です（設定 > Safari > マイク）' : e.message), 5000);
  }
}
function recentSamples(n) {
  const out = new Float32Array(n);
  let need = n, ci = rec.chunks.length - 1;
  while (need > 0 && ci >= 0) {
    const c = rec.chunks[ci];
    const take = Math.min(need, c.length);
    out.set(c.subarray(c.length - take), need - take);
    need -= take; ci--;
  }
  return out;
}
function recTick() {
  const el = (performance.now() - rec.t0) / 1000;
  $('recTime').textContent = fmtTime(el);
  const sr = rec.ctx.sampleRate;
  const N = sr > 30000 ? 16384 : 8192;
  if (rec.len < N) return;
  const fr = recentSamples(N);
  const r = liveChord(fr, sr);
  $('recLevel').style.width = Math.min(100, r.rms * 400) + '%';
  if (r.label) {
    if (r.label === rec.last) rec.lastCount++; else { rec.last = r.label; rec.lastCount = 1; }
    if (rec.lastCount >= 2) $('liveChord').textContent = r.label;
  }
  if (el > 600) stopRec(true); // 10 min limit
}
function cleanupRec() {
  clearInterval(rec.timer);
  try { rec.proc && (rec.proc.onaudioprocess = null); rec.src && rec.src.disconnect(); rec.proc && rec.proc.disconnect(); } catch {}
  if (rec.stream) rec.stream.getTracks().forEach(t => t.stop());
  const ctx = rec.ctx;
  rec.stream = null; rec.proc = null;
  $('recPanel').hidden = true; $('btnRec').hidden = false;
  $('liveChord').textContent = '–'; $('recLevel').style.width = '0';
  return ctx;
}
async function stopRec(analyzeIt) {
  const ctx = cleanupRec();
  if (!ctx) return;
  const sr = ctx.sampleRate;
  const total = rec.len, chunks = rec.chunks;
  rec.chunks = []; rec.len = 0; rec.ctx = null;
  if (!analyzeIt || total < sr * 2) {
    try { await ctx.close(); } catch {}
    if (analyzeIt) toast('録音が短すぎます（2秒以上録音してください）');
    return;
  }
  const data = new Float32Array(total);
  let o = 0; for (const c of chunks) { data.set(c, o); o += c.length; }
  const buffer = ctx.createBuffer(1, total, sr);
  (buffer.copyToChannel ? buffer.copyToChannel(data, 0) : buffer.getChannelData(0).set(data));
  try { await ctx.close(); } catch {}
  const blob = wavBlob(data, sr);
  const d = new Date();
  await processAudio(buffer, blob, `録音 ${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, 'mic');
}
function wavBlob(data, sr) {
  const n = data.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, data[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

// ---------- song view ----------
function setSong(s, blob) {
  song = s;
  song.saved = !!loadIndex().find(x => x.id === s.id);
  audioBlob = blob;
  if (audioURL) URL.revokeObjectURL(audioURL);
  audioURL = blob ? URL.createObjectURL(blob) : null;
  const a = $('audio');
  if (audioURL) { a.src = audioURL; $('playerCard').hidden = false; $('noAudio').hidden = true; }
  else { a.removeAttribute('src'); a.load(); $('playerCard').hidden = true; $('noAudio').hidden = false; }
  $('songName').value = s.name || '';
  $('lyrics').value = s.lyrics || '';
  $('meter').value = String(s.meter || 4);
  $('result').hidden = false;
  render();
  $('result').scrollIntoView({ behavior: 'smooth' });
}

const shift = () => (song.transpose || 0) - (song.capo || 0);
function viewFlats() {
  const t = ((song.key.tonic + shift()) % 12 + 12) % 12;
  return useFlats({ tonic: t, mode: song.key.mode });
}
function show(label) { return label === 'N' ? 'N' : transposeChord(label, shift(), viewFlats()); }
function keyName(tonic, mode) { const f = useFlats({ tonic, mode }); return (f ? NOTE_FLAT : NOTE_SHARP)[(tonic % 12 + 12) % 12] + (mode === 'minor' ? 'm' : ''); }

function render() {
  const segs = segments(song.bounds, song.labels);
  // meta
  const soundKey = keyName(song.key.tonic + song.transpose, song.key.mode);
  $('meta').textContent = `長さ ${fmtTime(song.duration)} ・ BPM ${song.bpm ? Math.round(song.bpm) : '?'} ・ 原曲キー ${song.key.name}` + (song.tuningCents && Math.abs(song.tuningCents) >= 15 ? ` ・ チューニングずれ ${song.tuningCents > 0 ? '+' : ''}${song.tuningCents}セント` : '');
  $('trVal').textContent = (song.transpose > 0 ? '+' : '') + song.transpose;
  $('keyShow').textContent = `キー: ${soundKey}`;
  $('capoVal').textContent = song.capo;
  const rank = capoRanking(segs, song.transpose);
  const best = rank[0].capo;
  $('capoAuto').textContent = `おすすめ: カポ${best}`;
  $('capoAuto').classList.toggle('on', best === song.capo);
  $('capoHint').textContent = song.capo > 0
    ? `カポ${song.capo}で ${keyName(song.key.tonic + song.transpose - song.capo, song.key.mode)} の押さえ方で弾くと、実際は ${soundKey} で鳴ります。表示は押さえ方です。`
    : 'カポなし（表示は実音）';
  renderSheet();
  renderDiagrams(segs);
}

function renderSheet() {
  const m = song.meter || 4;
  const n = song.labels.length;
  const db = Math.min(Math.max(0, song.downbeatIndex || 0), n - 1);
  // bars: pickup [0, db % m ... ) — use bars aligned so that db is a bar start
  const first = db % m === 0 ? 0 : db % m - m; // may be negative → pickup bar padded
  const bars = [];
  for (let b0 = first; b0 < n; b0 += m) bars.push([b0, b0 + m]);
  // trim leading/trailing all-N bars
  const isN = ([a, b]) => { for (let i = Math.max(0, a); i < Math.min(n, b); i++) if (song.labels[i] !== 'N') return false; return true; };
  while (bars.length && isN(bars[0])) bars.shift();
  while (bars.length && isN(bars[bars.length - 1])) bars.pop();
  const sheet = $('sheet');
  sheet.innerHTML = '';
  segEls = [];
  const perLine = 4;
  let prevLabel = null;
  for (let li = 0; li < bars.length; li += perLine) {
    const line = document.createElement('div'); line.className = 'line';
    const startBeat = Math.max(0, bars[li][0]);
    const ts = document.createElement('div'); ts.className = 'ts'; ts.textContent = fmtTime(song.bounds[startBeat]);
    ts.onclick = () => seek(song.bounds[startBeat]);
    line.appendChild(ts);
    const grid = document.createElement('div'); grid.className = 'bars';
    for (let bi = li; bi < Math.min(bars.length, li + perLine); bi++) {
      const [a, b] = bars[bi];
      const cell = document.createElement('div'); cell.className = 'barc';
      const num = document.createElement('span'); num.className = 'bnum'; num.textContent = bi + 1; cell.appendChild(num);
      let i = a;
      if (i < 0) { const pad = document.createElement('div'); pad.style.flex = String(-i); cell.appendChild(pad); i = 0; }
      while (i < Math.min(b, n)) {
        let j = i; while (j < Math.min(b, n) && song.labels[j] === song.labels[i]) j++;
        const el = document.createElement('div');
        const lab = song.labels[i];
        el.className = 'seg' + (lab === 'N' ? ' nc' : '') + (lab === prevLabel && i === Math.max(0, a) ? ' cont' : '');
        el.style.flex = String(j - i);
        el.textContent = lab === 'N' ? 'N.C.' : show(lab);
        const b0 = i, b1 = j;
        el.onclick = () => openEditor(b0, b1);
        cell.appendChild(el);
        segEls.push({ b0, b1, el, cell });
        prevLabel = lab;
        i = j;
      }
      if (b > n) { const pad = document.createElement('div'); pad.style.flex = String(b - n); cell.appendChild(pad); }
      grid.appendChild(cell);
    }
    line.appendChild(grid);
    sheet.appendChild(line);
  }
  if (!bars.length) sheet.innerHTML = '<p class="hint">コードが検出されませんでした。</p>';
  lastNow = -1;
}

function renderDiagrams(segs) {
  const seen = [];
  for (const s of segs) { if (s.label === 'N') continue; const l = show(s.label); if (!seen.includes(l)) seen.push(l); }
  $('diagrams').innerHTML = seen.map(l => diagramSVG(l)).join('') || '<p class="hint">なし</p>';
}

// ---------- playback highlight ----------
let lastNow = -1;
function beatAt(t) {
  const b = song.bounds; let lo = 0, hi = b.length - 2;
  if (t < b[0]) return 0;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (b[mid] <= t) lo = mid; else hi = mid - 1; }
  return lo;
}
function tick() {
  if (!song) return;
  const t = $('audio').currentTime;
  const bi = beatAt(t);
  const idx = segEls.findIndex(s => bi >= s.b0 && bi < s.b1);
  if (idx !== lastNow) {
    if (lastNow >= 0 && segEls[lastNow]) segEls[lastNow].el.classList.remove('now');
    if (idx >= 0) {
      segEls[idx].el.classList.add('now');
      if ($('follow').checked && !$('audio').paused) {
        const r = segEls[idx].el.getBoundingClientRect();
        const top = $('playerCard').getBoundingClientRect().bottom + 10;
        if (r.top < top || r.bottom > window.innerHeight - 40) window.scrollBy({ top: r.top - top - 60, behavior: 'smooth' });
      }
    }
    lastNow = idx;
  }
  // now / next
  const cur = song.labels[bi];
  let nx = null;
  for (let i = bi + 1; i < song.labels.length; i++) if (song.labels[i] !== cur) { nx = song.labels[i]; break; }
  $('nowChord').textContent = cur && cur !== 'N' ? show(cur) : '–';
  $('nextChord').textContent = nx && nx !== 'N' ? show(nx) : '–';
}
function loop() { tick(); rafId = requestAnimationFrame(loop); }
$('audio').addEventListener('play', () => { cancelAnimationFrame(rafId); loop(); });
$('audio').addEventListener('pause', () => { cancelAnimationFrame(rafId); tick(); });
$('audio').addEventListener('seeked', tick);
$('rate').addEventListener('change', () => { const a = $('audio'); a.playbackRate = +$('rate').value; a.preservesPitch = true; a.webkitPreservesPitch = true; });
function seek(t) { const a = $('audio'); if (!audioURL) return; a.currentTime = t; a.play().catch(() => {}); }

// ---------- controls ----------
$('trUp').onclick = () => { song.transpose = Math.min(11, song.transpose + 1); render(); };
$('trDown').onclick = () => { song.transpose = Math.max(-11, song.transpose - 1); render(); };
$('capoUp').onclick = () => { song.capo = Math.min(9, song.capo + 1); render(); };
$('capoDown').onclick = () => { song.capo = Math.max(0, song.capo - 1); render(); };
$('capoAuto').onclick = () => { song.capo = capoRanking(segments(song.bounds, song.labels), song.transpose)[0].capo; render(); };
$('meter').onchange = () => { song.meter = +$('meter').value; render(); };
$('dbLeft').onclick = () => { song.downbeatIndex = Math.max(0, (song.downbeatIndex || 0) - 1); render(); };
$('dbRight').onclick = () => { song.downbeatIndex = Math.min(song.labels.length - 1, (song.downbeatIndex || 0) + 1); render(); };
$('btnSave').onclick = () => saveSong(false);
$('btnNew').onclick = () => { $('result').hidden = true; $('audio').pause(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
let autoT = 0;
$('lyrics').addEventListener('input', () => { if (song) { song.lyrics = $('lyrics').value; if (song.saved) { clearTimeout(autoT); autoT = setTimeout(saveQuiet, 1200); } } });
$('songName').addEventListener('change', () => { if (song && song.saved) saveQuiet(); });
function saveQuiet() { saveSong(true); }

// ---------- editor ----------
let editRange = null;
function openEditor(b0, b1) {
  editRange = [b0, b1];
  const lab = song.labels[b0];
  $('editInput').value = lab === 'N' ? 'N' : show(lab);
  $('editInfo').textContent = `${fmtTime(song.bounds[b0])}〜${fmtTime(song.bounds[b1])}（${b1 - b0}拍）`;
  // chips: chords in song + diatonic of displayed key
  const used = [];
  for (const l of song.labels) { if (l === 'N') continue; const s = show(l); if (!used.includes(s)) used.push(s); }
  const k = ((song.key.tonic + shift()) % 12 + 12) % 12;
  const fl = viewFlats(), names = fl ? NOTE_FLAT : NOTE_SHARP;
  const dia = song.key.mode === 'major'
    ? [[0, ''], [2, 'm'], [4, 'm'], [5, ''], [7, ''], [9, 'm'], [7, '7']]
    : [[0, 'm'], [3, ''], [5, 'm'], [7, ''], [7, '7'], [8, ''], [10, '']];
  dia.forEach(([iv, q]) => { const s = names[(k + iv) % 12] + q; if (!used.includes(s)) used.push(s); });
  $('editChips').innerHTML = '';
  used.forEach(s => { const b = document.createElement('button'); b.textContent = s; b.onclick = () => { $('editInput').value = s; }; $('editChips').appendChild(b); });
  $('editModal').hidden = false;
}
$('editCancel').onclick = () => $('editModal').hidden = true;
$('editPlay').onclick = () => { $('editModal').hidden = true; seek(song.bounds[editRange[0]]); };
$('editOk').onclick = () => {
  const toks = $('editInput').value.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return;
  const orig = [];
  for (const t of toks) {
    if (/^(N|N\.C\.?|-)$/i.test(t)) { orig.push('N'); continue; }
    if (!parseChord(t)) { toast(`「${t}」はコード名として読めません`); return; }
    orig.push(transposeChord(t, -shift(), useFlats(song.key)));
  }
  const [b0, b1] = editRange, len = b1 - b0;
  for (let i = 0; i < len; i++) song.labels[b0 + i] = orig[Math.min(orig.length - 1, Math.floor(i * orig.length / len))];
  $('editModal').hidden = true;
  render();
  if (song.saved) saveQuiet();
};

// ---------- library ----------
$('btnLibrary').onclick = () => {
  const ix = loadIndex();
  const ul = $('libList'); ul.innerHTML = '';
  if (!ix.length) ul.innerHTML = '<li class="hint">まだ保存した曲はありません</li>';
  ix.forEach(s => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="nm">${esc(s.name)}<small>キー ${esc(s.key || '')} ・ ${fmtTime(s.duration || 0)} ・ ${new Date(s.updatedAt).toLocaleString('ja-JP')}</small></div><button class="ghost">削除</button>`;
    li.querySelector('.nm').onclick = () => { $('libModal').hidden = true; openSong(s.id); };
    li.querySelector('button').onclick = async () => { if (confirm(`「${s.name}」を削除しますか？`)) { await deleteSong(s.id); li.remove(); } };
    ul.appendChild(li);
  });
  $('libModal').hidden = false;
};
$('libClose').onclick = () => $('libModal').hidden = true;

// ---------- export ----------
function exportText() {
  const m = song.meter || 4, n = song.labels.length;
  const db = song.downbeatIndex || 0;
  const first = db % m === 0 ? 0 : db % m - m;
  const lines = [];
  const name = $('songName').value.trim() || song.name || '無題';
  lines.push(`曲名: ${name}`);
  const soundKey = keyName(song.key.tonic + song.transpose, song.key.mode);
  lines.push(`キー: ${soundKey}${song.transpose ? `（原曲 ${song.key.name} から ${song.transpose > 0 ? '+' : ''}${song.transpose}）` : ''} / BPM: ${song.bpm ? Math.round(song.bpm) : '?'} / 拍子: ${m}/4`);
  lines.push(song.capo ? `カポ: ${song.capo}（以下は押さえ方）` : 'カポ: なし');
  lines.push('');
  const bars = [];
  for (let b0 = first; b0 < n; b0 += m) {
    const toks = [];
    for (let i = b0; i < b0 + m; i++) toks.push(i < 0 || i >= n ? null : song.labels[i]);
    bars.push({ b0, toks });
  }
  const isN = b => b.toks.every(t => t === null || t === 'N');
  while (bars.length && isN(bars[0])) bars.shift();
  while (bars.length && isN(bars[bars.length - 1])) bars.pop();
  const cellStr = (b) => {
    const t = b.toks.map(x => x === null ? '' : x === 'N' ? 'N.C.' : show(x));
    const uniq = t.filter((x, i) => x && (i === 0 || x !== t[i - 1]));
    if (uniq.length === 1 && t.every(x => !x || x === uniq[0])) return uniq[0];
    return t.map((x, i) => !x ? '' : (i > 0 && x === t[i - 1]) ? '.' : x).filter(x => x !== '').join(' ');
  };
  const cells = bars.map(cellStr);
  const w = Math.max(6, ...cells.map(c => c.length));
  for (let i = 0; i < bars.length; i += 4) {
    const t = song.bounds[Math.max(0, bars[i].b0)];
    lines.push(`[${fmtTime(t).padStart(5)}] | ` + cells.slice(i, i + 4).map(c => c.padEnd(w)).join(' | ') + ' |');
  }
  const lyr = $('lyrics').value.trim();
  if (lyr) { lines.push(''); lines.push('--- 歌詞メモ ---'); lines.push(lyr); }
  return lines.join('\n');
}
$('btnExport').onclick = () => { $('expText').value = exportText(); $('expModal').hidden = false; };
$('expClose').onclick = () => $('expModal').hidden = true;
$('expCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('expText').value); toast('コピーしました'); }
  catch { const t = $('expText'); t.removeAttribute('readonly'); t.select(); document.execCommand('copy'); t.setAttribute('readonly', ''); toast('コピーしました'); }
};
$('expShare').onclick = async () => {
  if (navigator.share) { try { await navigator.share({ title: $('songName').value || 'コード譜', text: $('expText').value }); } catch {} }
  else toast('共有に対応していません');
};
$('expDl').onclick = () => {
  const blob = new Blob([$('expText').value], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = ($('songName').value.trim() || 'chords') + '.txt';
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};

// ---------- service worker ----------
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
// expose for debugging/tests
window.__chordapp = { get song() { return song; }, exportText, processAudio, decode, setSong };
