#!/usr/bin/env -S deno run --allow-read --allow-write
// Bidule 01 compiler CLI
// Usage: bdcc <input.bdcart> [output.bdb]
//        bdcc --check <input.bdcart>   (validate only, no output)
//        bdcc --watch <input.bdcart>   (recompile on file change)
//
// Sprite assets: if <stem>.sprites.png exists alongside the source file, the
// compiler packages its palette and tile data into the binary automatically.

import { compile }                    from './compiler.js';
import { parsePNG, packSpriteSheet } from '../web/png.js';

function extname(path) {
  const dot = path.lastIndexOf('.');
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return dot > sep ? path.slice(dot) : '';
}

function basename(path, ext) {
  const base = path.split(/[\\/]/).pop() ?? path;
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
}

function dirname(path) {
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return sep >= 0 ? path.slice(0, sep + 1) : '';
}

// Load and pack a .sprites.png file; returns null if not found or on error.
async function loadSprites(cartPath) {
  const stem    = basename(cartPath, extname(cartPath));
  const dir     = dirname(cartPath);
  const pngPath = `${dir}${stem}.sprites.png`;

  let pngData;
  try {
    pngData = await Deno.readFile(pngPath);
  } catch {
    return null;  // no sprite sheet — not an error
  }

  try {
    const { width, height, plte, pixels } = await parsePNG(pngData);
    const packed = packSpriteSheet(width, height, plte, pixels);
    console.log(`sprites: '${pngPath}' — ${packed.length} bytes packed`);
    return packed;
  } catch (e) {
    console.error(`warning: could not load sprite sheet '${pngPath}': ${e.message}`);
    return null;
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args  = [...Deno.args];
const check = args[0] === '--check';
if (check) args.shift();
const watch = args[0] === '--watch';
if (watch) args.shift();

const input = args[0];
if (!input) {
  console.error('Usage: bdcc [--check] [--watch] <input.bdcart> [output.bdb]');
  Deno.exit(1);
}

const stem   = basename(input, extname(input));
const output = args[1] ?? `${stem}.bdb`;

async function runCompile() {
  let source;
  try {
    source = Deno.readTextFileSync(input);
  } catch (e) {
    console.error(`error: cannot read '${input}': ${e.message}`);
    return false;
  }

  const sprites = await loadSprites(input);
  const { binary, errors, warnings } = compile(source, { sprites });

  for (const w of warnings) console.warn(`warning: ${w}`);
  for (const e of errors)   console.error(`error: ${e}`);

  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s). Compilation failed.`);
    return false;
  }

  if (check) {
    console.log(`ok: '${input}' — ${binary.length} bytes`);
    return true;
  }

  try {
    Deno.writeFileSync(output, binary);
  } catch (e) {
    console.error(`error: cannot write '${output}': ${e.message}`);
    return false;
  }

  console.log(`ok: '${input}' → '${output}' (${binary.length} bytes)`);
  return true;
}

const ok = await runCompile();

if (!watch) {
  Deno.exit(ok ? 0 : 1);
}

console.log(`watching '${input}' for changes…`);

const watcher = Deno.watchFs(input);
for await (const event of watcher) {
  if (event.kind === 'modify' || event.kind === 'create') {
    console.log(`\n[${new Date().toLocaleTimeString()}] change detected, recompiling…`);
    await runCompile();
  }
}
