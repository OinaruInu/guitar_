// Chord detection engine — runs fully in the browser (and in Node for tests).
// No network, no external libraries.

export const NOTE_SHARP = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
export const NOTE_FLAT  = ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'];

export const QUALITIES = [
  { id: '',     iv: [0,4,7],    w: [1,1,1],        prior: 0 },
  { id: 'm',    iv: [0,3,7],    w: [1,1,1],        prior: 0 },
  { id: '7',    iv: [0,4,7,10], w: [1,1,0.8,0.8],  prior: -0.03 },
  { id: 'M7',   iv: [0,4,7,11], w: [1,1,0.8,0.8],  prior: -0.035 },
  { id: 'm7',   iv: [0,3,7,10], w: [1,1,0.8,0.8],  prior: -0.03 },
  { id: 'sus4', iv: [0,5,7],    w: [1,1,1],        prior: -0.04 },
  { id: 'sus2', iv: [0,2,7],    w: [1,1,1],        prior: -0.05 },
];

// ---------- FFT ----------
class FFT {
  constructor(n) {
    this.n = n;
    const bits = Math.round(Math.log2(n));
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos(2 * Math.PI * i / n);
      this.sin[i] = -Math.sin(2 * Math.PI * i / n);
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }
  // magnitude spectrum of real input (already windowed)
  mag(input, out) {
    const n = this.n, re = this.re, im = this.im, rev = this.rev;
    for (let i = 0; i < n; i++) { re[rev[i]] = input[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const l = i + j + half, c = this.cos[k], s = this.sin[k];
          const tr = re[l] * c - im[l] * s, ti = re[l] * s + im[l] * c;
          re[l] = re[i + j] - tr; im[l] = im[i + j] - ti;
          re[i + j] += tr; im[i + j] += ti;
        }
      }
    }
    for (let i = 0; i <= n / 2; i++) out[i] = Math.hypot(re[i], im[i]);
    return out;
  }
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  return w;
}

// ---------- Onset envelope / tempo / beats ----------
function onsetEnvelope(x, sr) {
  const N = 1024, hop = 256;
  const fft = new FFT(N), win = hann(N);
  const nb = Math.min(N / 2, Math.floor(6000 * N / sr));
  const frames = Math.max(0, Math.floor((x.length - N) / hop) + 1);
  const env = new Float64Array(frames);
  const buf = new Float64Array(N), mag = new Float64Array(N / 2 + 1);
  let prev = new Float64Array(nb), cur = new Float64Array(nb);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) buf[i] = x[o + i] * win[i];
    fft.mag(buf, mag);
    let s = 0;
    for (let k = 1; k < nb; k++) {
      cur[k] = Math.log(1 + 1000 * mag[k]);
      const d = cur[k] - prev[k];
      if (d > 0 && f > 0) s += d;
    }
    env[f] = s;
    const t = prev; prev = cur; cur = t;
  }
  // subtract local mean, half-wave rectify
  const W = Math.round(0.25 * sr / hop);
  const out = new Float64Array(frames);
  let acc = 0;
  const pre = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) { acc += env[i]; pre[i + 1] = acc; }
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - W), b = Math.min(frames, i + W + 1);
    const m = (pre[b] - pre[a]) / (b - a);
    out[i] = Math.max(0, env[i] - m);
  }
  return { env: out, fps: sr / hop, hop, N };
}

function estimatePeriod(env, fps) {
  const minLag = Math.max(2, Math.floor(fps * 60 / 200));
  const maxLag = Math.ceil(fps * 60 / 50);
  const n = env.length;
  if (n < maxLag * 3) return null;
  let mean = 0; for (let i = 0; i < n; i++) mean += env[i]; mean /= n;
  const e = new Float64Array(n); for (let i = 0; i < n; i++) e[i] = env[i] - mean;
  const ac = new Float64Array(2 * maxLag + 2);
  for (let l = minLag; l <= Math.min(2 * maxLag + 1, n - 1); l++) {
    let s = 0; for (let i = l; i < n; i++) s += e[i] * e[i - l];
    ac[l] = s / (n - l);
  }
  let best = -Infinity, bestL = minLag;
  for (let l = minLag; l <= maxLag; l++) {
    const bpm = 60 * fps / l;
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.9, 2));
    const v = (ac[l] + 0.5 * (ac[2 * l] || 0)) * w;
    if (v > best) { best = v; bestL = l; }
  }
  // parabolic refine
  let p = bestL;
  if (bestL > minLag && bestL < maxLag) {
    const a = ac[bestL - 1], b = ac[bestL], c = ac[bestL + 1];
    const d = a - 2 * b + c;
    if (d < 0) p = bestL + 0.5 * (a - c) / d;
  }
  return p;
}

function trackBeats(env, period) {
  const n = env.length;
  let sd = 0, m = 0;
  for (let i = 0; i < n; i++) m += env[i]; m /= n;
  for (let i = 0; i < n; i++) sd += (env[i] - m) ** 2; sd = Math.sqrt(sd / n) || 1;
  // light smoothing
  const loc = new Float64Array(n);
  const r = Math.max(1, Math.round(period / 16));
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = -r; j <= r; j++) { const k = i + j; if (k >= 0 && k < n) { const g = Math.exp(-0.5 * (j / (r / 1.5 + 1e-9)) ** 2); s += g * env[k]; c += g; } }
    loc[i] = s / c / sd;
  }
  const score = new Float64Array(n), back = new Int32Array(n).fill(-1);
  const tight = 100;
  const lo = Math.round(2 * period), hi = Math.round(period / 2);
  for (let t = 0; t < n; t++) {
    let best = -Infinity, bi = -1;
    for (let p = Math.max(0, t - lo); p <= t - hi; p++) {
      const v = score[p] - tight * Math.log((t - p) / period) ** 2;
      if (v > best) { best = v; bi = p; }
    }
    if (bi >= 0 && best > 0) { score[t] = loc[t] + best; back[t] = bi; }
    else score[t] = loc[t];
  }
  let end = n - 1, bs = -Infinity;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > bs) { bs = score[t]; end = t; }
  const beats = [];
  for (let t = end; t >= 0; t = back[t]) { beats.push(t); if (back[t] < 0) break; }
  beats.reverse();
  return beats;
}

// ---------- Chroma ----------
function peaksToChroma(mag, sr, N, tuning, chroma, bass) {
  const kmin = Math.max(2, Math.floor(50 * N / sr)), kmax = Math.min(N / 2 - 2, Math.ceil(2100 * N / sr));
  let mx = 0;
  for (let k = kmin; k <= kmax; k++) if (mag[k] > mx) mx = mag[k];
  if (mx <= 0) return 0;
  const thr = mx * 0.015;
  let energy = 0;
  for (let k = kmin; k <= kmax; k++) {
    const b = mag[k];
    if (b < thr || b < mag[k - 1] || b < mag[k + 1]) continue;
    const la = Math.log(mag[k - 1] + 1e-12), lb = Math.log(b + 1e-12), lc = Math.log(mag[k + 1] + 1e-12);
    const den = la - 2 * lb + lc;
    const delta = den < 0 ? 0.5 * (la - lc) / den : 0;
    const f = (k + delta) * sr / N;
    const midi = 69 + 12 * Math.log2(f / 440) - tuning;
    const r = Math.round(midi), dev = Math.abs(midi - r);
    if (dev > 0.4) continue;
    const a = Math.log(1 + 30 * b / mx) * (1 - dev / 0.5);
    const pc = ((r % 12) + 12) % 12;
    // frequency weighting: fade below E2 and above C7
    let w = 1;
    if (r < 40) w = Math.max(0, (r - 30) / 10);
    if (r > 84) w = Math.max(0, 1 - (r - 84) / 12);
    chroma[pc] += a * w;
    if (bass && r >= 36 && r <= 55) bass[pc] += a * (r <= 50 ? 1 : (56 - r) / 6);
    energy += a;
  }
  return energy;
}

function estimateTuning(x, sr) {
  const N = 8192, hop = 8192;
  const fft = new FFT(N), win = hann(N), buf = new Float64Array(N), mag = new Float64Array(N / 2 + 1);
  let sx = 0, sy = 0;
  const frames = Math.floor((x.length - N) / hop) + 1;
  const kmin = Math.floor(80 * N / sr), kmax = Math.ceil(1500 * N / sr);
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) buf[i] = x[o + i] * win[i];
    fft.mag(buf, mag);
    let mx = 0; for (let k = kmin; k <= kmax; k++) if (mag[k] > mx) mx = mag[k];
    if (mx <= 1e-6) continue;
    for (let k = kmin; k <= kmax; k++) {
      const b = mag[k];
      if (b < mx * 0.1 || b < mag[k - 1] || b < mag[k + 1]) continue;
      const la = Math.log(mag[k - 1] + 1e-12), lb = Math.log(b), lc = Math.log(mag[k + 1] + 1e-12);
      const den = la - 2 * lb + lc;
      const delta = den < 0 ? 0.5 * (la - lc) / den : 0;
      const midi = 69 + 12 * Math.log2((k + delta) * sr / N / 440);
      const ang = 2 * Math.PI * (midi - Math.round(midi));
      sx += b * Math.cos(ang); sy += b * Math.sin(ang);
    }
  }
  if (sx === 0 && sy === 0) return 0;
  return Math.atan2(sy, sx) / (2 * Math.PI);
}

function chromagram(x, sr, tuning, onProgress) {
  const N = sr > 30000 ? 16384 : 8192, hop = N / 8;
  const fft = new FFT(N), win = hann(N), buf = new Float64Array(N), mag = new Float64Array(N / 2 + 1);
  const frames = Math.max(1, Math.floor((x.length - N) / hop) + 1);
  const C = [], B = [], E = [], T = [];
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    let rms = 0;
    for (let i = 0; i < N; i++) { const v = (x[o + i] || 0); buf[i] = v * win[i]; rms += v * v; }
    fft.mag(buf, mag);
    const c = new Float64Array(12), b = new Float64Array(12);
    peaksToChroma(mag, sr, N, tuning, c, b);
    C.push(c); B.push(b); E.push(Math.sqrt(rms / N)); T.push((o + N / 2) / sr);
    if (onProgress && f % 200 === 0) onProgress(f / frames);
  }
  return { C, B, E, T, hop, N };
}

// ---------- Templates ----------
function buildTemplates() {
  const list = [];
  const harm = [1, 2, 3, 4, 5, 6], hw = [1, 0.6, 0.45, 0.3, 0.2, 0.15];
  for (let root = 0; root < 12; root++) {
    for (let qi = 0; qi < QUALITIES.length; qi++) {
      const q = QUALITIES[qi];
      const t = new Float64Array(12);
      q.iv.forEach((iv, j) => {
        harm.forEach((h, hi) => {
          const pc = (root + iv + Math.round(12 * Math.log2(h))) % 12;
          t[pc] += q.w[j] * hw[hi];
        });
      });
      let n = 0; for (let i = 0; i < 12; i++) n += t[i] * t[i]; n = Math.sqrt(n);
      for (let i = 0; i < 12; i++) t[i] /= n;
      const pcs = q.iv.map(iv => (root + iv) % 12);
      list.push({ root, q: qi, t, pcs, prior: q.prior });
    }
  }
  return list;
}
const TEMPLATES = buildTemplates();

// ---------- Key ----------
const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
function corr(a, b) {
  const n = a.length; let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; s += da * db; sa += da * da; sb += db * db; }
  return s / Math.sqrt(sa * sb + 1e-12);
}
export function estimateKey(chromaSum) {
  let best = { r: -2 };
  for (let k = 0; k < 12; k++) {
    const rot = Array.from({ length: 12 }, (_, i) => chromaSum[(i + k) % 12]);
    const rM = corr(rot, KK_MAJ), rm = corr(rot, KK_MIN);
    if (rM > best.r) best = { r: rM, tonic: k, mode: 'major' };
    if (rm > best.r) best = { r: rm, tonic: k, mode: 'minor' };
  }
  return best;
}
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
function diatonic(tpl, key) {
  const majTonic = key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12;
  const scale = new Set(MAJOR_SCALE.map(s => (s + majTonic) % 12));
  if (tpl.pcs.every(p => scale.has(p))) return true;
  if (key.mode === 'minor' && tpl.root === (key.tonic + 7) % 12 && (tpl.q === 0 || tpl.q === 2)) return true;
  return false;
}
export function useFlats(key) {
  if (!key) return false;
  const majTonic = key.mode === 'major' ? key.tonic : (key.tonic + 3) % 12;
  return [5, 10, 3, 8, 1].includes(majTonic); // F Bb Eb Ab Db
}

// ---------- Chord naming ----------
export function chordName(root, qi, flats) {
  return (flats ? NOTE_FLAT : NOTE_SHARP)[root] + QUALITIES[qi].id;
}
export function parseChord(label) {
  if (!label) return null;
  const m = /^([A-G])([#b♯♭]?)(.*?)(?:\/([A-G])([#b♯♭]?))?$/.exec(label.trim());
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const acc = s => (s === '#' || s === '♯') ? 1 : (s === 'b' || s === '♭') ? -1 : 0;
  const root = (base[m[1]] + acc(m[2]) + 12) % 12;
  let qual = m[3] || '';
  const bass = m[4] ? (base[m[4]] + acc(m[5]) + 12) % 12 : null;
  return { root, qual, bass };
}
export function transposeChord(label, semis, flats) {
  if (!label || label === 'N') return label;
  const p = parseChord(label);
  if (!p) return label;
  const names = flats ? NOTE_FLAT : NOTE_SHARP;
  let s = names[(p.root + semis + 120) % 12] + p.qual;
  if (p.bass !== null) s += '/' + names[(p.bass + semis + 120) % 12];
  return s;
}

// ---------- Main analysis ----------
export function analyze(x, sr, opts = {}) {
  const prog = opts.onProgress || (() => {});
  const duration = x.length / sr;
  prog('テンポを解析中…', 0.05);
  const on = onsetEnvelope(x, sr);
  const period = estimatePeriod(on.env, on.fps);
  let beatTimes = [];
  let bpm = null;
  if (period) {
    bpm = 60 * on.fps / period;
    const bf = trackBeats(on.env, period);
    beatTimes = bf.map(f => (f * on.hop + on.N / 2) / sr);
  }
  const beatPeriod = period ? period / on.fps : 0.5;
  if (beatTimes.length < 2) {
    beatTimes = [];
    for (let t = 0; t < duration; t += beatPeriod) beatTimes.push(t);
  } else {
    // extrapolate to cover whole file
    while (beatTimes[0] - beatPeriod > 0.05) beatTimes.unshift(beatTimes[0] - beatPeriod);
    while (beatTimes[beatTimes.length - 1] + beatPeriod < duration - 0.05) beatTimes.push(beatTimes[beatTimes.length - 1] + beatPeriod);
  }
  // segment boundaries: [0, beats..., duration]
  const bounds = [];
  if (beatTimes[0] > 0.05) bounds.push(0);
  for (const b of beatTimes) if (b < duration) bounds.push(b);
  bounds.push(duration);

  prog('チューニングを推定中…', 0.15);
  const tuning = estimateTuning(x, sr);
  prog('和音を解析中…', 0.2);
  const cg = chromagram(x, sr, tuning, p => prog('和音を解析中…', 0.2 + 0.6 * p));

  // beat-synchronous chroma
  const nSeg = bounds.length - 1;
  const segC = [], segB = [], segE = [];
  let fi = 0;
  for (let s = 0; s < nSeg; s++) {
    const a = bounds[s], b = bounds[s + 1];
    const c = new Float64Array(12), bb = new Float64Array(12);
    let e = 0, cnt = 0;
    while (fi < cg.T.length && cg.T[fi] < a) fi++;
    let j = fi;
    for (; j < cg.T.length && cg.T[j] < b; j++) {
      for (let i = 0; i < 12; i++) { c[i] += cg.C[j][i]; bb[i] += cg.B[j][i]; }
      e += cg.E[j]; cnt++;
    }
    if (cnt === 0) {
      // nearest frame
      const mid = (a + b) / 2;
      let k = Math.min(cg.T.length - 1, Math.max(0, Math.round((mid * sr - cg.N / 2) / cg.hop)));
      for (let i = 0; i < 12; i++) { c[i] = cg.C[k][i]; bb[i] = cg.B[k][i]; }
      e = cg.E[k]; cnt = 1;
    }
    segC.push(c); segB.push(bb); segE.push(e / cnt);
  }
  const total = new Float64Array(12);
  segC.forEach(c => { for (let i = 0; i < 12; i++) total[i] += c[i]; });
  const key = estimateKey(Array.from(total));
  const maxE = Math.max(...segE, 1e-9);

  prog('コード進行を推定中…', 0.85);
  const K = TEMPLATES.length; // + N
  const S = [];
  for (let s = 0; s < nSeg; s++) {
    const c = segC[s], bb = segB[s];
    let n = 0; for (let i = 0; i < 12; i++) n += c[i] * c[i]; n = Math.sqrt(n);
    let bmax = 0; for (let i = 0; i < 12; i++) bmax = Math.max(bmax, bb[i]);
    const row = new Float64Array(K + 1);
    const silent = segE[s] < maxE * 0.03 || n < 1e-6;
    for (let k = 0; k < K; k++) {
      const tp = TEMPLATES[k];
      let dot = 0; for (let i = 0; i < 12; i++) dot += c[i] * tp.t[i];
      let sc = n > 0 ? dot / n : 0;
      if (bmax > 0) sc += 0.12 * (bb[tp.root] / bmax) - 0.04;
      sc += tp.prior;
      if (diatonic(tp, key)) sc += 0.03;
      row[k] = silent ? 0 : sc;
    }
    row[K] = silent ? 1 : 0.45;
    S.push(row);
  }
  // Viterbi
  const beta = opts.beta || 30, sw = opts.switchCost || 2;
  let prev = new Float64Array(K + 1), cur = new Float64Array(K + 1);
  const bp = [];
  for (let k = 0; k <= K; k++) prev[k] = beta * S[0][k];
  for (let s = 1; s < nSeg; s++) {
    let bestK = 0; for (let k = 1; k <= K; k++) if (prev[k] > prev[bestK]) bestK = k;
    const back = new Int16Array(K + 1);
    for (let k = 0; k <= K; k++) {
      const stay = prev[k], move = prev[bestK] - sw;
      if (stay >= move) { cur[k] = stay; back[k] = k; } else { cur[k] = move; back[k] = bestK; }
      cur[k] += beta * S[s][k];
    }
    bp.push(back);
    const t = prev; prev = cur; cur = t;
  }
  let last = 0; for (let k = 1; k <= K; k++) if (prev[k] > prev[last]) last = k;
  const path = new Array(nSeg); path[nSeg - 1] = last;
  for (let s = nSeg - 1; s > 0; s--) path[s - 1] = bp[s - 1][path[s]];

  // refine key using the detected chords (diatonic coverage + tonic chord weight)
  {
    const dur = new Map();
    for (let s = 0; s < nSeg; s++) if (path[s] !== K) dur.set(path[s], (dur.get(path[s]) || 0) + bounds[s + 1] - bounds[s]);
    let best = null;
    for (let t = 0; t < 12; t++) for (const mode of ['major', 'minor']) {
      const kk = { tonic: t, mode };
      let sc = 0;
      for (const [k, d] of dur) {
        const tp = TEMPLATES[k];
        if (diatonic(tp, kk)) sc += d;
        if (tp.root === t && ((mode === 'major' && [0, 3, 2].includes(tp.q)) || (mode === 'minor' && [1, 4].includes(tp.q)))) sc += 0.6 * d;
        if (tp.root === (t + 7) % 12 && (tp.q === 0 || tp.q === 2)) sc += 0.15 * d;
      }
      if (!best || sc > best.sc) best = { sc, ...kk };
    }
    if (best && best.sc > 0) { key.tonic = best.tonic; key.mode = best.mode; }
  }
  const flats = useFlats(key);
  const labels = path.map(k => k === K ? 'N' : chordName(TEMPLATES[k].root, TEMPLATES[k].q, flats));

  // downbeat phase (assume 4/4): choose phase where chord changes land most often
  const startIdx = bounds[0] === 0 && beatTimes[0] > 0.05 ? 1 : 0; // seg index of first real beat
  const phaseScore = [0, 0, 0, 0];
  for (let s = startIdx + 1; s < nSeg; s++) {
    if (labels[s] !== labels[s - 1]) phaseScore[(s - startIdx) % 4] += 1;
    // bass weight as tie-breaker
    phaseScore[(s - startIdx) % 4] += 0.001 * segE[s] / maxE;
  }
  let phase = 0; for (let p = 1; p < 4; p++) if (phaseScore[p] > phaseScore[phase]) phase = p;

  prog('完了', 1);
  return {
    duration, sr, bpm: bpm ? Math.round(bpm * 10) / 10 : null,
    tuningCents: Math.round(tuning * 100),
    key: { tonic: key.tonic, mode: key.mode, name: (flats ? NOTE_FLAT : NOTE_SHARP)[key.tonic] + (key.mode === 'minor' ? 'm' : '') },
    bounds, labels, downbeatIndex: startIdx + phase,
  };
}

// merge consecutive identical labels
export function segments(bounds, labels) {
  const out = [];
  for (let i = 0; i < labels.length; i++) {
    const last = out[out.length - 1];
    if (last && last.label === labels[i]) { last.end = bounds[i + 1]; last.beatEnd = i + 1; }
    else out.push({ label: labels[i], start: bounds[i], end: bounds[i + 1], beatStart: i, beatEnd: i + 1 });
  }
  return out;
}

// Live (mic) single-window detection
let liveFFT = null;
export function liveChord(frame, sr) {
  const N = frame.length;
  if (!liveFFT || liveFFT.n !== N) liveFFT = { n: N, fft: new FFT(N), win: hann(N), buf: new Float64Array(N), mag: new Float64Array(N / 2 + 1) };
  const L = liveFFT;
  let rms = 0;
  for (let i = 0; i < N; i++) { L.buf[i] = frame[i] * L.win[i]; rms += frame[i] * frame[i]; }
  rms = Math.sqrt(rms / N);
  if (rms < 0.003) return { label: null, rms };
  L.fft.mag(L.buf, L.mag);
  const c = new Float64Array(12), b = new Float64Array(12);
  peaksToChroma(L.mag, sr, N, 0, c, b);
  let n = 0; for (let i = 0; i < 12; i++) n += c[i] * c[i]; n = Math.sqrt(n);
  if (n === 0) return { label: null, rms };
  let bmax = 0; for (let i = 0; i < 12; i++) bmax = Math.max(bmax, b[i]);
  let best = -1, bk = 0;
  for (let k = 0; k < TEMPLATES.length; k++) {
    const tp = TEMPLATES[k];
    let dot = 0; for (let i = 0; i < 12; i++) dot += c[i] * tp.t[i];
    let sc = dot / n + tp.prior + (bmax > 0 ? 0.12 * b[tp.root] / bmax : 0);
    if (sc > best) { best = sc; bk = k; }
  }
  return { label: chordName(TEMPLATES[bk].root, TEMPLATES[bk].q, false), score: best, rms };
}
