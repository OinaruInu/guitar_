// Guitar fingerings, chord diagrams (SVG), capo suggestion
import { parseChord, transposeChord, NOTE_SHARP } from './engine.js';

// strings 6→1, -1 = mute
const OPEN = {
  'C': [-1,3,2,0,1,0], 'C7': [-1,3,2,3,1,0], 'CM7': [-1,3,2,0,0,0], 'Csus4': [-1,3,3,0,1,1], 'Csus2': [-1,3,0,0,1,3],
  'D': [-1,-1,0,2,3,2], 'Dm': [-1,-1,0,2,3,1], 'D7': [-1,-1,0,2,1,2], 'DM7': [-1,-1,0,2,2,2], 'Dm7': [-1,-1,0,2,1,1], 'Dsus4': [-1,-1,0,2,3,3], 'Dsus2': [-1,-1,0,2,3,0],
  'E': [0,2,2,1,0,0], 'Em': [0,2,2,0,0,0], 'E7': [0,2,0,1,0,0], 'EM7': [0,2,1,1,0,0], 'Em7': [0,2,0,0,0,0], 'Esus4': [0,2,2,2,0,0],
  'G': [3,2,0,0,0,3], 'G7': [3,2,0,0,0,1], 'GM7': [3,2,0,0,0,2], 'Gsus4': [3,3,0,0,1,3], 'Gsus2': [3,0,0,0,3,3],
  'A': [-1,0,2,2,2,0], 'Am': [-1,0,2,2,1,0], 'A7': [-1,0,2,0,2,0], 'AM7': [-1,0,2,1,2,0], 'Am7': [-1,0,2,0,1,0], 'Asus4': [-1,0,2,2,3,0], 'Asus2': [-1,0,2,2,0,0],
  'FM7': [-1,-1,3,2,1,0], 'B7': [-1,2,1,2,0,2], 'Bm7': [-1,2,0,2,0,2], 'Em9': [0,2,0,0,0,2],
};
// difficulty: 1 = easy open chord
const EASY = new Set(['C','C7','CM7','Csus4','D','Dm','D7','DM7','Dm7','Dsus4','Dsus2','E','Em','E7','EM7','Em7','Esus4','G','G7','GM7','Gsus4','A','Am','A7','AM7','Am7','Asus4','Asus2','FM7','B7','Gsus2','Csus2']);
const MEDIUM = { 'F': 2.5, 'Bm': 2.5, 'Bm7': 1.6, 'Fm': 3, 'B': 3.5, 'F7': 2.5, 'Bb': 3 };

const ESHAPE = { '': [0,2,2,1,0,0], 'm': [0,2,2,0,0,0], '7': [0,2,0,1,0,0], 'M7': [0,-1,1,1,0,-1], 'm7': [0,2,0,0,0,0], 'sus4': [0,2,2,2,0,0] };
const ASHAPE = { '': [-1,0,2,2,2,0], 'm': [-1,0,2,2,1,0], '7': [-1,0,2,0,2,0], 'M7': [-1,0,2,1,2,0], 'm7': [-1,0,2,0,1,0], 'sus4': [-1,0,2,2,3,0], 'sus2': [-1,0,2,2,0,0] };

function normQual(q) {
  return q.replace(/^maj7$/i, 'M7').replace(/^△7?$/, 'M7').replace(/^min$/, 'm').replace(/^-$/, 'm').replace(/^min7$/, 'm7').replace(/^-7$/, 'm7');
}

export function canonical(label) {
  const p = parseChord(label);
  if (!p) return null;
  return { root: p.root, qual: normQual(p.qual), bass: p.bass };
}

export function fingering(label) {
  const c = canonical(label);
  if (!c) return null;
  const name = NOTE_SHARP[c.root] + c.qual;
  if (OPEN[name]) return { frets: OPEN[name], base: 1, barre: null };
  const cands = [];
  if (ESHAPE[c.qual]) { const b = (c.root - 4 + 12) % 12; cands.push({ shape: ESHAPE[c.qual], b }); }
  if (ASHAPE[c.qual]) { const b = (c.root - 9 + 12) % 12; cands.push({ shape: ASHAPE[c.qual], b }); }
  if (!cands.length) {
    // unknown quality → fall back to triad (major/minor guess)
    const q = /^m(?!aj)/.test(c.qual) ? 'm' : '';
    return fingering(NOTE_SHARP[c.root] + q);
  }
  cands.sort((x, y) => x.b - y.b);
  const { shape, b } = cands[0].b === 0 ? cands[0] : cands[0];
  const frets = shape.map(f => f < 0 ? -1 : f + b);
  return { frets, base: b > 0 ? b : 1, barre: b > 0 ? b : null };
}

export function difficulty(label) {
  if (!label || label === 'N') return 0;
  const c = canonical(label);
  if (!c) return 3;
  const name = NOTE_SHARP[c.root] + c.qual;
  if (EASY.has(name)) return 1;
  const flatName = name.replace('A#', 'Bb');
  if (MEDIUM[flatName]) return MEDIUM[flatName];
  return 4;
}

// segs: [{label, start, end}] (sounding chords). Returns [{capo, cost}] sorted best first
export function capoRanking(segs, transpose = 0) {
  const res = [];
  for (let capo = 0; capo <= 7; capo++) {
    let cost = 0, tot = 0;
    const seen = new Set();
    for (const s of segs) {
      if (s.label === 'N') continue;
      const shape = transposeChord(transposeChord(s.label, transpose), -capo);
      const d = s.end - s.start;
      cost += difficulty(shape) * d; tot += d;
      seen.add(shape);
    }
    // distinct-chord penalty for hard shapes + small penalty for high capo
    let distinct = 0; seen.forEach(x => distinct += difficulty(x) - 1);
    res.push({ capo, cost: (tot ? cost / tot : 0) + 0.15 * distinct + 0.04 * capo });
  }
  return res.sort((a, b) => a.cost - b.cost);
}

export function diagramSVG(label) {
  const f = fingering(label);
  const W = 92, H = 122, x0 = 18, y0 = 36, dx = 12, dy = 15, nf = 5;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" class="diag">`;
  s += `<text x="${W / 2}" y="14" text-anchor="middle" class="dname">${escapeXml(label)}</text>`;
  if (!f) return s + `<text x="${W/2}" y="60" text-anchor="middle" font-size="10">?</text></svg>`;
  const played = f.frets.filter(v => v > 0);
  const maxF = played.length ? Math.max(...played) : 0;
  let base = 1;
  if (maxF > 4) base = f.barre || Math.min(...played);
  if (base > 1) s += `<text x="${x0 - 4}" y="${y0 + dy * 0.7}" text-anchor="end" font-size="9" class="fnum">${base}</text>`;
  else s += `<rect x="${x0}" y="${y0 - 3}" width="${dx * 5}" height="3" class="nut"/>`;
  for (let i = 0; i < 6; i++) s += `<line x1="${x0 + i * dx}" y1="${y0}" x2="${x0 + i * dx}" y2="${y0 + nf * dy}" class="str"/>`;
  for (let j = 0; j <= nf; j++) s += `<line x1="${x0}" y1="${y0 + j * dy}" x2="${x0 + 5 * dx}" y2="${y0 + j * dy}" class="fret"/>`;
  if (f.barre) {
    const j = f.barre - base;
    const strs = f.frets.map((v, i) => v === f.barre ? i : -1).filter(i => i >= 0);
    if (strs.length >= 2) {
      const a = Math.min(...strs), b = Math.max(...strs);
      s += `<rect x="${x0 + a * dx - 4}" y="${y0 + j * dy + dy / 2 - 4}" width="${(b - a) * dx + 8}" height="8" rx="4" class="dot"/>`;
    }
  }
  f.frets.forEach((v, i) => {
    const x = x0 + i * dx;
    if (v < 0) s += `<text x="${x}" y="${y0 - 7}" text-anchor="middle" font-size="9" class="mark">×</text>`;
    else if (v === 0) s += `<circle cx="${x}" cy="${y0 - 10}" r="3" class="open"/>`;
    else if (!(f.barre && v === f.barre)) {
      const j = v - base;
      s += `<circle cx="${x}" cy="${y0 + j * dy + dy / 2}" r="4.5" class="dot"/>`;
    }
  });
  return s + '</svg>';
}
function escapeXml(t) { return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
