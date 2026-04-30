// Bidule 01 — web emulator application
// Serve with:  deno run --allow-net --allow-read web/serve.js

import { VM }                                          from './vm.js';
import { compile }                                     from '../compiler/compiler.js';
import { drawCls, drawPset, drawRectfill, drawLine,
         drawPrint, blitToImageData }                  from './font.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const W = 128, H = 64, SCALE = 4;
const ON  = [74,  246, 38];
const OFF = [0,   18,  0];

// ─── State ───────────────────────────────────────────────────────────────────

const fb   = new Uint8Array(W * H);
const btns = new Uint8Array(6);
const prev = new Uint8Array(6);

let carts         = [];   // all known carts (UI list, updated anytime)
let bootCarts     = [];   // snapshot visible to the running VM (frozen at last reboot)
let cartIdx       = -1;   // index into carts[] of the currently highlighted cart
let running       = false;
let frame         = 0;
let loopId        = null;
let currentBinary = null; // last binary loaded, so audio can catch up after startAudio()

// ─── VM ───────────────────────────────────────────────────────────────────────

const vm = new VM({
  btn:  i => btns[i & 7],
  btnp: i => (btns[i & 7] && !prev[i & 7]) ? 1 : 0,

  cls:      c           => drawCls(fb, c),
  pset:     (x,y,c)     => drawPset(fb, x, y, c),
  rectfill: (x,y,w,h,c) => drawRectfill(fb, x, y, w, h, c),
  line:     (x0,y0,x1,y1,c) => drawLine(fb, x0, y0, x1, y1, c),
  print:    (text,x,y,c) => drawPrint(fb, text, x, y, c),

  save:  (slot, val) => persist.save(slot, val),
  load:  slot        => persist.load(slot),

  // Cart utilities use the bootCarts snapshot — not the live carts list.
  // New carts added via file picker are visible to the VM only after reboot.
  cartcount: () => bootCarts.length,
  cartmeta:  (i, field) => {
    const c = bootCarts[i];
    return c ? (parseMeta(c.binary)[field] ?? '') : '';
  },
  loadcart: i => bootCarts[i]?.binary ?? null,
});

// ─── Audio ───────────────────────────────────────────────────────────────────

let audioCtx  = null;
let audioNode = null;

async function startAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new AudioContext({ sampleRate: 44100 });
    await audioCtx.audioWorklet.addModule('./audio-worklet.js');
    audioNode = new AudioWorkletNode(audioCtx, 'bidule-audio');
    audioNode.connect(audioCtx.destination);
    if (currentBinary) audioLoad(currentBinary);
  } catch (e) {
    console.warn('AudioWorklet unavailable:', e);
    audioCtx = audioNode = null;
  }
}

function audioLoad(binary) {
  audioNode?.port.postMessage({ type: 'load', binary });
}

function audioSync() {
  if (audioNode && vm.loaded)
    audioNode.port.postMessage({ type: 'globals', globals: vm.globalsSnapshot() });
}

// ─── Persistence ─────────────────────────────────────────────────────────────

const persist = {
  _key: () => `bidule01:${vm.meta?.id ?? '__anon__'}`,
  _get() {
    try { return JSON.parse(localStorage.getItem(this._key())) ?? [0,0,0,0]; }
    catch { return [0,0,0,0]; }
  },
  save(slot, val) {
    if (slot < 0 || slot > 3) return;
    const d = this._get(); d[slot] = val | 0;
    try { localStorage.setItem(this._key(), JSON.stringify(d)); } catch {}
  },
  load(slot) {
    return (slot >= 0 && slot <= 3) ? (this._get()[slot] | 0) : 0;
  },
};

// ─── Binary metadata parser ───────────────────────────────────────────────────

function parseMeta(binary) {
  const bin = binary instanceof Uint8Array ? binary : new Uint8Array(binary);
  if (bin.length < 8) return {};
  let p = 6;
  const metaLen = bin[p] | (bin[p+1] << 8); p += 2;
  const meta = {};
  new TextDecoder().decode(bin.slice(p, p + metaLen))
    .split('\n').forEach(l => {
      const m = l.match(/^@(\S+)\s+(.*)/);
      if (m) meta[m[1]] = m[2].trim();
    });
  return meta;
}

// ─── Low-level cart loader ────────────────────────────────────────────────────
//
// Loads a binary into the VM and starts the 30 fps loop.
// Does NOT modify cartIdx — callers are responsible for that.

function loadAndRun(binary) {
  if (running) stopLoop();
  if (!vm.load(binary)) { showError('Invalid cart binary'); return false; }
  currentBinary = binary;
  audioLoad(binary);
  frame = 0;
  try { vm.callInit(); } catch (e) { halt(e); return false; }
  running = true;
  renderCartList();
  loopId = setInterval(tick, 1000 / 30);
  return true;
}

function stopLoop() {
  if (loopId) { clearInterval(loopId); loopId = null; }
  running = false;
}

function stopCart() {
  stopLoop();
  cartIdx = -1;
  renderCartList();
}

// ─── Boot sequence (§5.1) ────────────────────────────────────────────────────
//
// 1. Snapshot the current cart list into bootCarts (what the VM will see).
// 2. Locate boot.bdb by @id or by name.
// 3. Launch it; if missing, fall back to cart_loader, then first cart.

function findBootCart(list) {
  // Match by known @id, or by name 'boot' (case-insensitive).
  return list.findIndex(c => {
    const meta = parseMeta(c.binary);
    return meta.id === 'bidule_splash_pckerneis_1'
        || c.name.toLowerCase() === 'boot'
        || (meta.title ?? '').toLowerCase() === 'boot';
  });
}

async function reboot() {
  stopLoop();
  cartIdx = -1;
  showError('');

  const noiseId = setInterval(showNoise, 1000 / 30);
  await autoLoadCarts();
  clearInterval(noiseId);

  bootCarts = [...carts];
  renderCartList();

  if (bootCarts.length === 0) {
    // Nothing to run — show a placeholder screen.
    drawCls(fb, 0);
    drawPrint(fb, 'BIDULE  01', 24, 24, 1);
    drawPrint(fb, 'no carts found', 14, 38, 1);
    blit();
    return;
  }

  // Boot cart priority: boot → cart_loader → first cart.
  let bootIdx = findBootCart(bootCarts);
  if (bootIdx < 0) {
    bootIdx = bootCarts.findIndex(c => parseMeta(c.binary).id === 'cart_loader');
  }
  if (bootIdx < 0) bootIdx = 0;

  // Find matching index in the UI carts[] list to highlight it.
  cartIdx = carts.findIndex(c => c.binary === bootCarts[bootIdx].binary);
  loadAndRun(bootCarts[bootIdx].binary);
}

// ─── UI-triggered cart launch (bypasses boot sequence) ───────────────────────

function startCart(idx) {
  stopLoop();
  const c = carts[idx];
  if (!c) return;
  cartIdx = idx;
  showError('');
  loadAndRun(c.binary);
}

// ─── Halt on runtime error ────────────────────────────────────────────────────

function halt(err) {
  stopLoop();
  cartIdx = -1;
  const msg = err?.message ?? String(err);
  showError(msg);
  drawCls(fb, 0);
  drawPrint(fb, 'ERROR:', 2, 2, 1);
  const words = msg.replace(/\s+/g, ' ').trim().split(' ');
  let line = '', y = 13;
  for (const w of words) {
    if ((line + w).length > 19 && line) {
      drawPrint(fb, line.trim(), 2, y, 1); y += 10; line = '';
      if (y > 54) break;
    }
    line += w + ' ';
  }
  if (line.trim()) drawPrint(fb, line.trim(), 2, y, 1);
  blit();
  renderCartList();
}

// ─── 30 fps game loop ─────────────────────────────────────────────────────────

function tick() {
  const input = btns.reduce((acc, b, i) => acc | (b ? (1 << i) : 0), 0);
  try {
    vm.callUpdate(frame, input);
    vm.callDraw(frame, input);
  } catch (e) { halt(e); return; }

  blit();
  audioSync();

  // Handle loadcart() switch between frames.
  if (vm.cartSwitched() && vm._pending) {
    const binary = vm._pending;
    vm._pending  = null;
    const newIdx = carts.findIndex(c => c.binary === binary);
    cartIdx = newIdx >= 0 ? newIdx : cartIdx;
    stopLoop();
    loadAndRun(binary);
    return;
  }

  frame = (frame + 1) | 0;
  prev.set(btns);
}

// ─── Canvas ───────────────────────────────────────────────────────────────────

const canvas = document.getElementById('screen');
const ctx2d  = canvas.getContext('2d');

function showNoise() {
  for (let i = 0; i < fb.length; i++) fb[i] = Math.random() < 0.5 ? 1 : 0;
  blit();
}

function blit() {
  const img = ctx2d.createImageData(W * SCALE, H * SCALE);
  blitToImageData(fb, img, SCALE, ON, OFF);
  ctx2d.putImageData(img, 0, 0);
}

// ─── File handling ────────────────────────────────────────────────────────────

async function handleFiles(files) {
  let added = 0;
  for (const file of files) {
    const buf = await file.arrayBuffer();
    const bin = new Uint8Array(buf);
    let binary = bin;

    if (file.name.endsWith('.bdcart') || bin[0] !== 0x42) {
      const src = new TextDecoder().decode(bin);
      const { binary: compiled, errors } = compile(src);
      if (errors.length) { showError(errors.join('\n')); continue; }
      binary = compiled;
    }

    const meta = parseMeta(binary);
    const name = meta.title ?? meta.name ?? file.name.replace(/\.[^.]+$/, '');
    // Replace existing cart with same name, or append.
    const existing = carts.findIndex(c => c.name === name);
    if (existing >= 0) carts[existing] = { name, binary };
    else               carts.push({ name, binary });
    added++;
  }
  if (added) renderCartList();
}

// ─── Auto-load from /carts ────────────────────────────────────────────────────

async function autoLoadCarts() {
  let names;
  try {
    const res = await fetch('/api/carts');
    if (!res.ok) return;
    names = await res.json();
  } catch {
    return; // not running under serve.js
  }

  for (const name of names) {
    try {
      const r = await fetch(`/carts/${name}`);
      if (!r.ok) continue;
      const bin = new Uint8Array(await r.arrayBuffer());
      let binary = bin;

      if (name.endsWith('.bdcart')) {
        const { binary: compiled, errors } = compile(new TextDecoder().decode(bin));
        if (errors.length) { console.warn(name, errors); continue; }
        binary = compiled;
      }

      const meta = parseMeta(binary);
      const cartName = meta.title ?? meta.name ?? name.replace(/\.(bdb|bdcart)$/, '');
      const existing = carts.findIndex(c => c.name === cartName);
      if (existing >= 0) carts[existing] = { name: cartName, binary };
      else               carts.push({ name: cartName, binary });
    } catch (e) {
      console.warn(`Failed to load ${name}:`, e);
    }
  }
}

// ─── Error / status display ───────────────────────────────────────────────────

function showError(msg) {
  const el = document.getElementById('error');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

// ─── Cart list UI ─────────────────────────────────────────────────────────────

function renderCartList() {
  const list = document.getElementById('cart-list');
  list.innerHTML = '';

  // Pending indicator: carts added after last reboot.
  const pending = carts.length - bootCarts.length;
  document.getElementById('pending-notice').style.display =
    pending > 0 ? 'block' : 'none';
  document.getElementById('pending-count').textContent =
    pending === 1 ? '1 new cart' : `${pending} new carts`;

  if (carts.length === 0) {
    list.innerHTML = '<p class="empty">No carts. Drop .bdb / .bdcart files here, then reboot.</p>';
    return;
  }

  carts.forEach((c, i) => {
    const isActive = (i === cartIdx && running);
    const inBoot   = bootCarts.some(b => b.binary === c.binary);

    const row = document.createElement('div');
    row.className = 'cart-row' + (isActive ? ' active' : '') + (inBoot ? '' : ' pending');

    const nameEl = document.createElement('span');
    nameEl.className = 'cart-name';
    nameEl.textContent = c.name;
    if (!inBoot) {
      const badge = document.createElement('span');
      badge.className = 'new-badge';
      badge.textContent = 'new';
      nameEl.appendChild(badge);
    }

    const runBtn = document.createElement('button');
    runBtn.className = 'cart-btn run';
    runBtn.textContent = isActive ? '■' : '▶';
    runBtn.title = isActive ? 'Stop' : 'Run';
    runBtn.onclick = () => {
      showError('');
      startAudio();
      if (isActive) { stopCart(); }
      else          { startCart(i); }
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'cart-btn del';
    delBtn.textContent = '✕';
    delBtn.title = 'Remove';
    delBtn.onclick = () => {
      if (isActive) stopCart();
      carts.splice(i, 1);
      renderCartList();
    };

    row.append(nameEl, runBtn, delBtn);
    list.appendChild(row);
  });
}

// ─── Keyboard ─────────────────────────────────────────────────────────────────

const KEY_MAP = { ArrowLeft:0, ArrowRight:1, ArrowUp:2, ArrowDown:3, z:4, x:5, Z:4, X:5 };
document.addEventListener('keydown', e => { const i=KEY_MAP[e.key]; if(i!=null){btns[i]=1;e.preventDefault();} });
document.addEventListener('keyup',   e => { const i=KEY_MAP[e.key]; if(i!=null) btns[i]=0; });

// ─── On-screen buttons ────────────────────────────────────────────────────────

function bindButton(id, index) {
  const el = document.getElementById(id); if (!el) return;
  const on  = () => btns[index] = 1;
  const off = () => btns[index] = 0;
  el.addEventListener('mousedown',   on);
  el.addEventListener('mouseup',     off);
  el.addEventListener('mouseleave',  off);
  el.addEventListener('touchstart',  e => { on(); e.preventDefault(); }, { passive: false });
  el.addEventListener('touchend',    off);
  el.addEventListener('touchcancel', off);
}
['btn-left','btn-right','btn-up','btn-down','btn-a','btn-b'].forEach((id, i) => bindButton(id, i));

// ─── Reboot button ────────────────────────────────────────────────────────────

document.getElementById('reboot-btn').addEventListener('click', () => {
  startAudio();
  reboot();
});

// ─── Drag-and-drop ────────────────────────────────────────────────────────────

const dropZone = document.getElementById('cart-panel');
dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  startAudio();
  handleFiles([...e.dataTransfer.files]);
});

// ─── File picker ──────────────────────────────────────────────────────────────

document.getElementById('add-cart').addEventListener('click', () => {
  startAudio();
  document.getElementById('file-input').click();
});
document.getElementById('file-input').addEventListener('change', e => {
  handleFiles([...e.target.files]);
  e.target.value = '';
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

drawCls(fb, 0);
blit();
reboot();
