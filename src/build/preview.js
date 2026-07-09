// Live "visually active work" window.
// When you build an app/site/image with 700 AI, this spins up a local server
// and opens a browser window that live-reloads as files change — so you watch
// the work happen in real time.
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import open from 'open';
import { c } from '../theme.js';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const RELOAD = `<script>
let last=0;setInterval(async()=>{try{const r=await fetch('/__stamp');const t=await r.text();
if(last&&t!==last)location.reload();last=t;}catch(e){}},700);</script>`;

export function startPreview(title = '700 AI — Live Build') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), '700ai-build-'));
  let stamp = String(Date.now());

  fs.writeFileSync(path.join(dir, 'index.html'),
    `<!doctype html><meta charset=utf8><title>${title}</title>
     <body style="font-family:system-ui;background:#0a0a0a;color:#e8e6e3;padding:2rem">
     <h2 style="color:#e67e22">● 700 AI — live build workspace</h2>
     <p style="color:#888">Waiting for the first file… this window refreshes as work happens.</p>${RELOAD}`);

  const server = http.createServer((req, res) => {
    if (req.url === '/__stamp') { res.end(stamp); return; }
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file)) { res.statusCode = 404; res.end('not found'); return; }
    let body = fs.readFileSync(file);
    const ext = path.extname(file);
    if (ext === '.html') body = Buffer.from(body.toString() + RELOAD);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.end(body);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/`;
      console.log(c.dim('  live build window → ') + c.white(url));
      try { await open(url); } catch { /* headless */ }
      resolve({
        dir,
        url,
        // Write a file into the workspace; the window reloads to show it.
        write(name, content) {
          const dest = path.join(dir, name);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, content);
          stamp = String(Date.now());
        },
        stop() { server.close(); },
      });
    });
  });
}
