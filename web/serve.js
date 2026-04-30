// Bidule 01 — development HTTP server
// Run from the repo root:  deno run --allow-net --allow-read web/serve.js

const PORT = 8000;
const ROOT = Deno.cwd(); // must be run from the repo root

const MIME = {
  '.html':    'text/html; charset=utf-8',
  '.js':      'application/javascript; charset=utf-8',
  '.json':    'application/json',
  '.bdb':     'application/octet-stream',
  '.bdcart':  'text/plain; charset=utf-8',
  '.css':     'text/css; charset=utf-8',
};

function mime(path) {
  for (const [ext, type] of Object.entries(MIME))
    if (path.endsWith(ext)) return type;
  return 'application/octet-stream';
}

Deno.serve({ port: PORT }, async (req) => {
  const url  = new URL(req.url);
  let   path = decodeURIComponent(url.pathname);

  // ── Redirect bare root so ./app.js resolves to /web/app.js ──────────────
  if (path === '/') {
    return new Response(null, {
      status: 302,
      headers: { 'Location': '/web/' },
    });
  }

  // ── Trailing slash → index.html ──────────────────────────────────────────
  if (path.endsWith('/')) path += 'index.html';

  // ── API: list available carts ────────────────────────────────────────────
  if (path === '/api/carts') {
    const entries = [];
    try {
      for await (const e of Deno.readDir(ROOT + '/carts')) {
        if (e.isFile && (e.name.endsWith('.bdb') || e.name.endsWith('.bdcart')))
          entries.push(e.name);
      }
    } catch { /* carts/ not found */ }
    entries.sort();
    // Prefer .bdb when both .bdb and .bdcart exist for the same stem
    const seen = new Set(), result = [];
    for (const name of entries) {
      const stem = name.replace(/\.(bdb|bdcart)$/, '');
      if (!seen.has(stem)) { seen.add(stem); result.push(name); }
    }
    return Response.json(result, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }

  // ── Static files ──────────────────────────────────────────────────────────
  // ROOT + path   e.g.  /C:/dev/repo  +  /web/app.js
  // Deno accepts forward slashes on Windows, so this works cross-platform.
  const filePath = ROOT + path;

  try {
    const data = await Deno.readFile(filePath);
    return new Response(data, {
      headers: {
        'Content-Type': mime(path),
        // Required for SharedArrayBuffer (future-proofing)
        'Cross-Origin-Opener-Policy':   'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    });
  } catch {
    return new Response('404 Not found: ' + path, { status: 404 });
  }
});

console.log(`\n  Bidule 01 emulator →  http://localhost:${PORT}/\n`);
