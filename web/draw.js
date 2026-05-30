// Bidule 01 — Monogram bitmap font
// Source: firmware/display.c  (Monogram by Datagoblin, ASCII 32–126)
// Format: FONT[charCode - 32] → Uint8Array(9)
//   Each byte = one row top-to-bottom; bit 0 = leftmost column (5 columns used).

export const FONT_W = 5;
export const FONT_H = 9;

// prettier-ignore
export const FONT = [
  [ 0, 0, 0, 0, 0, 0, 0, 0, 0],  // 32  ' '
  [ 4, 4, 4, 4, 4, 0, 4, 0, 0],  // 33  '!'
  [10,10,10, 0, 0, 0, 0, 0, 0],  // 34  '"'
  [ 0,10,31,10,10,31,10, 0, 0],  // 35  '#'
  [ 4,30, 5,14,20,15, 4, 0, 0],  // 36  '$'
  [17,17, 8, 4, 2,17,17, 0, 0],  // 37  '%'
  [ 6, 9, 9,30, 9, 9,22, 0, 0],  // 38  '&'
  [ 4, 4, 4, 0, 0, 0, 0, 0, 0],  // 39  '\''
  [ 8, 4, 4, 4, 4, 4, 8, 0, 0],  // 40  '('
  [ 2, 4, 4, 4, 4, 4, 2, 0, 0],  // 41  ')'
  [ 0, 4,21,14,21, 4, 0, 0, 0],  // 42  '*'
  [ 0, 4, 4,31, 4, 4, 0, 0, 0],  // 43  '+'
  [ 0, 0, 0, 0, 0, 4, 4, 2, 0],  // 44  ','
  [ 0, 0, 0,31, 0, 0, 0, 0, 0],  // 45  '-'
  [ 0, 0, 0, 0, 0, 4, 4, 0, 0],  // 46  '.'
  [16,16, 8, 4, 2, 1, 1, 0, 0],  // 47  '/'
  [14,17,25,21,19,17,14, 0, 0],  // 48  '0'
  [ 4, 6, 4, 4, 4, 4,31, 0, 0],  // 49  '1'
  [14,17,16, 8, 4, 2,31, 0, 0],  // 50  '2'
  [14,17,16,12,16,17,14, 0, 0],  // 51  '3'
  [18,18,17,31,16,16,16, 0, 0],  // 52  '4'
  [31, 1,15,16,16,17,14, 0, 0],  // 53  '5'
  [14, 1, 1,15,17,17,14, 0, 0],  // 54  '6'
  [31,16,16, 8, 4, 4, 4, 0, 0],  // 55  '7'
  [14,17,17,14,17,17,14, 0, 0],  // 56  '8'
  [14,17,17,30,16,17,14, 0, 0],  // 57  '9'
  [ 0, 4, 4, 0, 0, 4, 4, 0, 0],  // 58  ':'
  [ 0, 4, 4, 0, 0, 4, 4, 2, 0],  // 59  ';'
  [ 0,24, 6, 1, 6,24, 0, 0, 0],  // 60  '<'
  [ 0, 0,31, 0,31, 0, 0, 0, 0],  // 61  '='
  [ 0, 3,12,16,12, 3, 0, 0, 0],  // 62  '>'
  [14,17,16, 8, 4, 0, 4, 0, 0],  // 63  '?'
  [14,25,21,21,25, 1,14, 0, 0],  // 64  '@'
  [14,17,17,17,31,17,17, 0, 0],  // 65  'A'
  [15,17,17,15,17,17,15, 0, 0],  // 66  'B'
  [14,17, 1, 1, 1,17,14, 0, 0],  // 67  'C'
  [15,17,17,17,17,17,15, 0, 0],  // 68  'D'
  [31, 1, 1,15, 1, 1,31, 0, 0],  // 69  'E'
  [31, 1, 1,15, 1, 1, 1, 0, 0],  // 70  'F'
  [14,17, 1,29,17,17,14, 0, 0],  // 71  'G'
  [17,17,17,31,17,17,17, 0, 0],  // 72  'H'
  [31, 4, 4, 4, 4, 4,31, 0, 0],  // 73  'I'
  [16,16,16,16,17,17,14, 0, 0],  // 74  'J'
  [17, 9, 5, 3, 5, 9,17, 0, 0],  // 75  'K'
  [ 1, 1, 1, 1, 1, 1,31, 0, 0],  // 76  'L'
  [17,27,21,17,17,17,17, 0, 0],  // 77  'M'
  [17,17,19,21,25,17,17, 0, 0],  // 78  'N'
  [14,17,17,17,17,17,14, 0, 0],  // 79  'O'
  [15,17,17,15, 1, 1, 1, 0, 0],  // 80  'P'
  [14,17,17,17,17,17,14,24, 0],  // 81  'Q'
  [15,17,17,15,17,17,17, 0, 0],  // 82  'R'
  [14,17, 1,14,16,17,14, 0, 0],  // 83  'S'
  [31, 4, 4, 4, 4, 4, 4, 0, 0],  // 84  'T'
  [17,17,17,17,17,17,14, 0, 0],  // 85  'U'
  [17,17,17,17,10,10, 4, 0, 0],  // 86  'V'
  [17,17,17,17,21,27,17, 0, 0],  // 87  'W'
  [17,17,10, 4,10,17,17, 0, 0],  // 88  'X'
  [17,17,10, 4, 4, 4, 4, 0, 0],  // 89  'Y'
  [31,16, 8, 4, 2, 1,31, 0, 0],  // 90  'Z'
  [12, 4, 4, 4, 4, 4,12, 0, 0],  // 91  '['
  [ 1, 1, 2, 4, 8,16,16, 0, 0],  // 92  '\\'
  [ 6, 4, 4, 4, 4, 4, 6, 0, 0],  // 93  ']'
  [ 4,10,17, 0, 0, 0, 0, 0, 0],  // 94  '^'
  [ 0, 0, 0, 0, 0, 0,31, 0, 0],  // 95  '_'
  [ 2, 4, 0, 0, 0, 0, 0, 0, 0],  // 96  '`'
  [ 0, 0,30,17,17,17,30, 0, 0],  // 97  'a'
  [ 1, 1,15,17,17,17,15, 0, 0],  // 98  'b'
  [ 0, 0,14,17, 1,17,14, 0, 0],  // 99  'c'
  [16,16,30,17,17,17,30, 0, 0],  // 100 'd'
  [ 0, 0,14,17,31, 1,14, 0, 0],  // 101 'e'
  [12,18, 2,15, 2, 2, 2, 0, 0],  // 102 'f'
  [ 0, 0,30,17,17,17,30,16,14],  // 103 'g'
  [ 1, 1,15,17,17,17,17, 0, 0],  // 104 'h'
  [ 4, 0, 6, 4, 4, 4,31, 0, 0],  // 105 'i'
  [16, 0,24,16,16,16,16,17,14],  // 106 'j'
  [ 1, 1,17, 9, 7, 9,17, 0, 0],  // 107 'k'
  [ 3, 2, 2, 2, 2, 2,28, 0, 0],  // 108 'l'
  [ 0, 0,15,21,21,21,21, 0, 0],  // 109 'm'
  [ 0, 0,15,17,17,17,17, 0, 0],  // 110 'n'
  [ 0, 0,14,17,17,17,14, 0, 0],  // 111 'o'
  [ 0, 0,15,17,17,17,15, 1, 1],  // 112 'p'
  [ 0, 0,30,17,17,17,30,16,16],  // 113 'q'
  [ 0, 0,13,19, 1, 1, 1, 0, 0],  // 114 'r'
  [ 0, 0,30, 1,14,16,15, 0, 0],  // 115 's'
  [ 2, 2,15, 2, 2, 2,28, 0, 0],  // 116 't'
  [ 0, 0,17,17,17,17,30, 0, 0],  // 117 'u'
  [ 0, 0,17,17,17,10, 4, 0, 0],  // 118 'v'
  [ 0, 0,17,17,21,21,10, 0, 0],  // 119 'w'
  [ 0, 0,17,10, 4,10,17, 0, 0],  // 120 'x'
  [ 0, 0,17,17,17,17,30,16,14],  // 121 'y'
  [ 0, 0,31, 8, 4, 2,31, 0, 0],  // 122 'z'
  [ 8, 4, 4, 2, 4, 4, 8, 0, 0],  // 123 '{'
  [ 4, 4, 4, 4, 4, 4, 4, 0, 0],  // 124 '|'
  [ 2, 4, 4, 8, 4, 4, 2, 0, 0],  // 125 '}'
  [ 0, 0,18,13, 0, 0, 0, 0, 0],  // 126 '~'
];

// ─── Display helpers ──────────────────────────────────────────────────────────

const W = 160, H = 120;

function fbPixel(fb, x, y, c) {
  if (x >= 0 && x < W && y >= 0 && y < H)
    fb[y * W + x] = c & 0xFF;
}

export function drawCls(fb, c) {
  fb.fill(c & 0xFF);
}

export function drawPset(fb, x, y, c) {
  fbPixel(fb, x|0, y|0, c);
}

export function drawRectfill(fb, x, y, w, h, c) {
  x=x|0; y=y|0; w=w|0; h=h|0;
  for (let py = y; py < y+h; py++)
    for (let px = x; px < x+w; px++)
      fbPixel(fb, px, py, c);
}

export function drawLine(fb, x0, y0, x1, y1, c) {
  x0=x0|0; y0=y0|0; x1=x1|0; y1=y1|0;
  const dx =  Math.abs(x1-x0), sx = x0<x1 ? 1 : -1;
  const dy = -Math.abs(y1-y0), sy = y0<y1 ? 1 : -1;
  let err = dx+dy;
  for (;;) {
    fbPixel(fb, x0, y0, c);
    if (x0===x1 && y0===y1) break;
    const e2 = 2*err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

export function drawPrint(fb, str, x, y, c) {
  x=x|0; y=y|0;
  for (let ci = 0; ci < str.length; ci++) {
    if (x + FONT_W >= W) break;
    let code = str.charCodeAt(ci);
    if (code < 32 || code > 126) code = 63; // '?'
    const glyph = FONT[code - 32];
    for (let row = 0; row < FONT_H; row++) {
      const bits = glyph[row];
      for (let col = 0; col < FONT_W; col++)
        if ((bits >> col) & 1) fbPixel(fb, x+col, y+row, c);
    }
    x += FONT_W + 1;
  }
}

export function drawPget(fb, x, y) {
  x=x|0; y=y|0;
  if (x < 0 || x >= W || y < 0 || y >= H) return 0;
  return fb[y * W + x];
}

export function drawRect(fb, x, y, w, h, c) {
  x=x|0; y=y|0; w=w|0; h=h|0;
  for (let px = x; px < x+w; px++) { fbPixel(fb, px, y,     c); fbPixel(fb, px, y+h-1, c); }
  for (let py = y; py < y+h; py++) { fbPixel(fb, x,     py, c); fbPixel(fb, x+w-1, py, c); }
}

// ─── Sprite drawing ───────────────────────────────────────────────────────────
//
// tiles: Uint8Array of 512×64 bytes (palette-index pixels, 8×8 per tile).
// flags bit 0 = flip horizontally, bit 1 = flip vertically.
// Palette index 0 is transparent and never written.

const SPR_TILE_W = 8, SPR_TILE_H = 8;
const SPR_TILES_X = 32;   // 256 / 8

export function drawSpr(fb, tiles, n, x, y, flags) {
  if (!tiles || n < 0 || n >= 512) return;
  x = x|0; y = y|0;
  const flip_x = flags & 1, flip_y = (flags >> 1) & 1;
  const base = n * SPR_TILE_W * SPR_TILE_H;
  for (let ty = 0; ty < SPR_TILE_H; ty++) {
    const sy = flip_y ? SPR_TILE_H - 1 - ty : ty;
    for (let tx = 0; tx < SPR_TILE_W; tx++) {
      const idx = tiles[base + sy * SPR_TILE_W + (flip_x ? SPR_TILE_W - 1 - tx : tx)];
      if (idx !== 0) fbPixel(fb, x + tx, y + ty, idx);
    }
  }
}

export function drawSspr(fb, tiles, sx, sy, sw, sh, dx, dy, flags) {
  if (!tiles) return;
  sx=sx|0; sy=sy|0; sw=sw|0; sh=sh|0; dx=dx|0; dy=dy|0;
  const flip_x = flags & 1, flip_y = (flags >> 1) & 1;
  for (let ty = 0; ty < sh; ty++) {
    const src_y = sy + (flip_y ? sh - 1 - ty : ty);
    if (src_y < 0 || src_y >= 128) continue;
    for (let tx = 0; tx < sw; tx++) {
      const src_x = sx + (flip_x ? sw - 1 - tx : tx);
      if (src_x < 0 || src_x >= 256) continue;
      const tc  = (src_x / SPR_TILE_W) | 0;
      const tr  = (src_y / SPR_TILE_H) | 0;
      const ti  = tr * SPR_TILES_X + tc;
      const idx = tiles[ti * SPR_TILE_W * SPR_TILE_H +
                        (src_y % SPR_TILE_H) * SPR_TILE_W + (src_x % SPR_TILE_W)];
      if (idx !== 0) fbPixel(fb, dx + tx, dy + ty, idx);
    }
  }
}

// Blit the 8-bit indexed framebuffer to an ImageData at the given pixel scale.
// palette is a Uint8Array of 256*3 bytes: [R0,G0,B0, R1,G1,B1, ...].
export function blitToImageData(fb, imgData, scale, palette) {
  const d = imgData.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const pi = fb[y*W+x] * 3;
      const R = palette[pi], G = palette[pi+1], B = palette[pi+2];
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const i = ((y*scale+sy)*W*scale + (x*scale+sx)) * 4;
          d[i]=R; d[i+1]=G; d[i+2]=B; d[i+3]=255;
        }
      }
    }
  }
}
