import { analyze } from './engine.js';
self.onmessage = (e) => {
  const { x, sr } = e.data;
  try {
    const r = analyze(x, sr, { onProgress: (text, p) => self.postMessage({ type: 'progress', text, p }) });
    self.postMessage({ type: 'done', result: r });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
