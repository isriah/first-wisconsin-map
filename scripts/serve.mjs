// Local preview server for site/. Usage: node scripts/serve.mjs [port]
// With --mock (or MOCK_CONTACT=1) it also answers POST /contact like the Worker would, without sending anything,
// and serves a config.js that points the form at it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = fileURLToPath(new URL('../site/', import.meta.url));
const args = process.argv.slice(2);
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? process.env.PORT ?? 5173);
const mock = process.env.MOCK_CONTACT === '1' || args.includes('--mock');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (mock && url.pathname === '/contact' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const bad = !body.name || !/^\S+@\S+\.\S+$/.test(body.email ?? '') || !body.message;
    console.log(`mock contact: region=${body.region} ok=${!bad}`);
    res.writeHead(bad ? 400 : 200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(bad ? { ok: false, error: 'validation', fields: { message: 'Enter a message.' } } : { ok: true }));
  }
  if (mock && url.pathname === '/config.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'] });
    return res.end("window.MAP_CONFIG = { contactEndpoint: '/contact', turnstileSiteKey: '' };");
  }
  const file = normalize(join(siteDir, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(siteDir.endsWith(sep) ? siteDir : siteDir + sep)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(port, () => console.log(`Serving site/ at http://localhost:${port}${mock ? ' (mock contact endpoint on)' : ''}`));
