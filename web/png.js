// Bidule 01 — indexed-color PNG decoder + sprite sheet packer
// Browser and Deno compatible (uses DecompressionStream, no file I/O).

function u32be(data, off) {
  return ((data[off] << 24) | (data[off+1] << 16) | (data[off+2] << 8) | data[off+3]) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return (pa <= pb && pa <= pc) ? a : (pb <= pc) ? b : c;
}

async function inflate(data) {
  const ds     = new DecompressionStream('deflate');
  const stream = new Blob([data]).stream().pipeThrough(ds);
  const reader = stream.getReader();
  const chunks = [];
  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    if (value) chunks.push(value);
    done = d;
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const result = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { result.set(c, off); off += c.length; }
  return result;
}

export async function parsePNG(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) throw new Error('Not a valid PNG file');
  }

  let p = 8;
  let ihdr = null, plte = null;
  const idatBufs = [];

  while (p < buf.length) {
    if (p + 12 > buf.length) break;
    const len  = u32be(buf, p);
    const type = String.fromCharCode(buf[p+4], buf[p+5], buf[p+6], buf[p+7]);
    const data = buf.subarray(p + 8, p + 8 + len);
    p += 12 + len;

    if      (type === 'IHDR') {
      ihdr = { width: u32be(data,0), height: u32be(data,4), bitDepth: data[8], colorType: data[9] };
    } else if (type === 'PLTE') {
      plte = data.slice();
    } else if (type === 'IDAT') {
      idatBufs.push(data.slice());
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!ihdr)                throw new Error('PNG missing IHDR chunk');
  if (ihdr.colorType !== 3) throw new Error(`Sprite sheet must be indexed-color PNG (color type 3), got ${ihdr.colorType}`);
  if (ihdr.bitDepth  !== 8) throw new Error(`Sprite sheet must be 8-bit indexed, got ${ihdr.bitDepth}-bit`);
  if (!plte)                throw new Error('PNG missing PLTE chunk');
  if (idatBufs.length === 0) throw new Error('PNG missing IDAT chunk');

  let idatTotal = 0;
  for (const b of idatBufs) idatTotal += b.length;
  const idatData = new Uint8Array(idatTotal);
  let off = 0;
  for (const b of idatBufs) { idatData.set(b, off); off += b.length; }

  const raw = await inflate(idatData);

  const { width, height } = ihdr;
  const stride = width + 1;
  const pixels = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const filterType = raw[y * stride];
    const src  = raw.subarray(y * stride + 1, y * stride + 1 + width);
    const out  = pixels.subarray(y * width, (y + 1) * width);
    const prev = y > 0 ? pixels.subarray((y - 1) * width, y * width) : new Uint8Array(width);

    switch (filterType) {
      case 0: out.set(src); break;
      case 1:
        for (let x = 0; x < width; x++) out[x] = (src[x] + (x > 0 ? out[x-1] : 0)) & 0xFF;
        break;
      case 2:
        for (let x = 0; x < width; x++) out[x] = (src[x] + prev[x]) & 0xFF;
        break;
      case 3:
        for (let x = 0; x < width; x++) {
          const a = x > 0 ? out[x-1] : 0;
          out[x] = (src[x] + Math.floor((a + prev[x]) / 2)) & 0xFF;
        }
        break;
      case 4:
        for (let x = 0; x < width; x++) {
          const a = x > 0 ? out[x-1] : 0;
          out[x] = (src[x] + paeth(a, prev[x], x > 0 ? prev[x-1] : 0)) & 0xFF;
        }
        break;
      default:
        throw new Error(`Unknown PNG filter type ${filterType} at row ${y}`);
    }
  }

  return { width, height, plte, pixels };
}

export function packSpriteSheet(width, height, plte, pixels) {
  if (width !== 256 || height !== 128)
    throw new Error(`Sprite sheet must be 256×128 pixels, got ${width}×${height}`);

  const TILE_W = 8, TILE_H = 8;
  const TILES_X = 32, TILE_COUNT = 512, TILE_BYTES = 64;

  const palette = new Uint8Array(256 * 3);
  const entries = Math.min(Math.floor(plte.length / 3), 256);
  for (let i = 0; i < entries; i++) {
    palette[i*3+0] = plte[i*3+0];
    palette[i*3+1] = plte[i*3+1];
    palette[i*3+2] = plte[i*3+2];
  }

  const tiles = new Uint8Array(TILE_COUNT * TILE_BYTES);
  for (let ti = 0; ti < TILE_COUNT; ti++) {
    const tileCol = ti % TILES_X;
    const tileRow = Math.floor(ti / TILES_X);
    const base    = ti * TILE_BYTES;
    for (let py = 0; py < TILE_H; py++) {
      for (let px = 0; px < TILE_W; px++) {
        tiles[base + py * TILE_W + px] = pixels[(tileRow * TILE_H + py) * width + tileCol * TILE_W + px];
      }
    }
  }

  const out = new Uint8Array(palette.length + tiles.length);
  out.set(palette, 0);
  out.set(tiles, palette.length);
  return out;
}
