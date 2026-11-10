# コード起こし (personal prototype)

Static PWA, no build step and no backend. Everything runs in the browser.

- `index.html`, `style.css`, `manifest.webmanifest`, `sw.js`, `icons/`
- `js/engine.js`: chord engine. Onset envelope → tempo (autocorrelation) → beat tracking (Ellis DP) → tuning estimate →
  spectral-peak chromagram + bass chroma → beat-synchronous chroma → template matching (maj/m/7/M7/m7/sus4/sus2,
  harmonic-weighted templates, key prior) → Viterbi smoothing → key estimate (Krumhansl + chord-based refinement)
  → downbeat phase.
- `js/chords.js`: fingerings, SVG diagrams, capo ranking
- `js/app.js`: UI (file upload, mic recording, sheet, playback highlight, edit, transpose/capo, save/load, export)
- `js/worker.js`: runs the analysis off the main thread
- `serve.py`: local static server on 127.0.0.1:8765
- `test/gen.py`: synthesizes test WAVs with known chords. `test/eval.mjs`: runs the engine in Node and scores it.
  Run: `cd test && python3 gen.py && node eval.mjs`

Hosting: any static HTTPS host works (GitHub Pages, Netlify, Cloudflare Pages), or a tunnel to serve.py.
iPhone mic access needs HTTPS.
