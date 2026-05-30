#include "display.h"
#include <string.h>
#include <stdlib.h>
#include "pico/stdlib.h"
#include "hardware/spi.h"

// --- SPI / ILI9341 transport -------------------------------------------------

#define SPI_PORT  spi0
#define PIN_MISO  16
#define PIN_CS    17
#define PIN_SCK   18
#define PIN_MOSI  19
#define PIN_DC    20
#define PIN_RST   21
#define PIN_BL    22

#define PHYS_W  320
#define PHYS_H  240
// Each logical pixel is rendered as a 2×2 physical pixel block (160×2=320, 120×2=240)

#define ILI9341_SWRESET  0x01
#define ILI9341_SLPOUT   0x11
#define ILI9341_GAMMASET 0x26
#define ILI9341_DISPON   0x29
#define ILI9341_CASET    0x2A
#define ILI9341_PASET    0x2B
#define ILI9341_RAMWR    0x2C
#define ILI9341_MADCTL   0x36
#define ILI9341_COLMOD   0x3A
#define ILI9341_FRMCTR1  0xB1
#define ILI9341_DFUNCTR  0xB6
#define ILI9341_PWCTR1   0xC0
#define ILI9341_PWCTR2   0xC1
#define ILI9341_VMCTR1   0xC5
#define ILI9341_VMCTR2   0xC7
#define ILI9341_GMCTRP1  0xE0
#define ILI9341_GMCTRN1  0xE1

static inline void cs_select(void)   { gpio_put(PIN_CS, 0); }
static inline void cs_deselect(void) { gpio_put(PIN_CS, 1); }
static inline void dc_cmd(void)      { gpio_put(PIN_DC, 0); }
static inline void dc_data(void)     { gpio_put(PIN_DC, 1); }

static void write_cmd(uint8_t cmd) {
    cs_select(); dc_cmd();
    spi_write_blocking(SPI_PORT, &cmd, 1);
    cs_deselect();
}

static void write_data(const uint8_t *buf, size_t len) {
    cs_select(); dc_data();
    spi_write_blocking(SPI_PORT, buf, len);
    cs_deselect();
}

static void write_byte(uint8_t b) { write_data(&b, 1); }

static void set_window(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1) {
    write_cmd(ILI9341_CASET);
    write_data((uint8_t[]){x0>>8, x0&0xFF, x1>>8, x1&0xFF}, 4);
    write_cmd(ILI9341_PASET);
    write_data((uint8_t[]){y0>>8, y0&0xFF, y1>>8, y1&0xFF}, 4);
    write_cmd(ILI9341_RAMWR);
}

// --- Framebuffer and CLUT ----------------------------------------------------

static uint8_t  fb[DISPLAY_H][DISPLAY_W];   // 19 200 bytes, 8-bit palette indices
static uint16_t palette[256];               // 512 bytes, RGB565 entries
static uint8_t  row_buf[PHYS_W * 2];        // 640 bytes, reused for flush and init clear

static uint16_t rgb565(int r, int g, int b) {
    return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3) | ((b & 0xF8) >> 3));
}

static void init_palette(void) {
    // 0-15: fixed game palette
    static const uint8_t pal16[16][3] = {
        {  0,   0,   0},   //  0 black
        {255, 255, 255},   //  1 white
        {255,  40,  40},   //  2 red
        { 40, 200,  40},   //  3 green
        { 40,  80, 255},   //  4 blue
        {255, 230,   0},   //  5 yellow
        {  0, 220, 220},   //  6 cyan
        {220,  40, 220},   //  7 magenta
        { 70,  70,  70},   //  8 dark grey
        {185, 185, 185},   //  9 light grey
        {255, 140,   0},   // 10 orange
        {  0, 110,   0},   // 11 dark green
        {  0,   0, 130},   // 12 navy
        {255, 120, 180},   // 13 pink
        {120,   0, 200},   // 14 purple
        {140,  80,  20},   // 15 brown
    };
    for (int i = 0; i < 16; i++)
        palette[i] = rgb565(pal16[i][0], pal16[i][1], pal16[i][2]);

    // 16-231: 6×6×6 colour cube (xterm-compatible)
    for (int i = 0; i < 216; i++) {
        int r = i / 36,       rv = r ? r * 40 + 55 : 0;
        int g = (i / 6) % 6, gv = g ? g * 40 + 55 : 0;
        int b = i % 6,        bv = b ? b * 40 + 55 : 0;
        palette[16 + i] = rgb565(rv, gv, bv);
    }

    // 232-255: greyscale ramp
    for (int i = 0; i < 24; i++) {
        int v = i * 10 + 8;
        palette[232 + i] = rgb565(v, v, v);
    }
}

void display_reset_palette(void) {
    init_palette();
}

// --- Font (Monogram by Datagoblin, ASCII 32-126, 5×9 px) ---------------------

#define FONT_W 5
#define FONT_H 9

static const uint8_t font[][FONT_H] = {
    { 0, 0, 0, 0, 0, 0, 0, 0, 0},  // 32 ' '
    { 4, 4, 4, 4, 4, 0, 4, 0, 0},  // 33 '!'
    {10,10,10, 0, 0, 0, 0, 0, 0},  // 34 '"'
    { 0,10,31,10,10,31,10, 0, 0},  // 35 '#'
    { 4,30, 5,14,20,15, 4, 0, 0},  // 36 '$'
    {17,17, 8, 4, 2,17,17, 0, 0},  // 37 '%'
    { 6, 9, 9,30, 9, 9,22, 0, 0},  // 38 '&'
    { 4, 4, 4, 0, 0, 0, 0, 0, 0},  // 39 '\''
    { 8, 4, 4, 4, 4, 4, 8, 0, 0},  // 40 '('
    { 2, 4, 4, 4, 4, 4, 2, 0, 0},  // 41 ')'
    { 0, 4,21,14,21, 4, 0, 0, 0},  // 42 '*'
    { 0, 4, 4,31, 4, 4, 0, 0, 0},  // 43 '+'
    { 0, 0, 0, 0, 0, 4, 4, 2, 0},  // 44 ','
    { 0, 0, 0,31, 0, 0, 0, 0, 0},  // 45 '-'
    { 0, 0, 0, 0, 0, 4, 4, 0, 0},  // 46 '.'
    {16,16, 8, 4, 2, 1, 1, 0, 0},  // 47 '/'
    {14,17,25,21,19,17,14, 0, 0},  // 48 '0'
    { 4, 6, 4, 4, 4, 4,31, 0, 0},  // 49 '1'
    {14,17,16, 8, 4, 2,31, 0, 0},  // 50 '2'
    {14,17,16,12,16,17,14, 0, 0},  // 51 '3'
    {18,18,17,31,16,16,16, 0, 0},  // 52 '4'
    {31, 1,15,16,16,17,14, 0, 0},  // 53 '5'
    {14, 1, 1,15,17,17,14, 0, 0},  // 54 '6'
    {31,16,16, 8, 4, 4, 4, 0, 0},  // 55 '7'
    {14,17,17,14,17,17,14, 0, 0},  // 56 '8'
    {14,17,17,30,16,17,14, 0, 0},  // 57 '9'
    { 0, 4, 4, 0, 0, 4, 4, 0, 0},  // 58 ':'
    { 0, 4, 4, 0, 0, 4, 4, 2, 0},  // 59 ';'
    { 0,24, 6, 1, 6,24, 0, 0, 0},  // 60 '<'
    { 0, 0,31, 0,31, 0, 0, 0, 0},  // 61 '='
    { 0, 3,12,16,12, 3, 0, 0, 0},  // 62 '>'
    {14,17,16, 8, 4, 0, 4, 0, 0},  // 63 '?'
    {14,25,21,21,25, 1,14, 0, 0},  // 64 '@'
    {14,17,17,17,31,17,17, 0, 0},  // 65 'A'
    {15,17,17,15,17,17,15, 0, 0},  // 66 'B'
    {14,17, 1, 1, 1,17,14, 0, 0},  // 67 'C'
    {15,17,17,17,17,17,15, 0, 0},  // 68 'D'
    {31, 1, 1,15, 1, 1,31, 0, 0},  // 69 'E'
    {31, 1, 1,15, 1, 1, 1, 0, 0},  // 70 'F'
    {14,17, 1,29,17,17,14, 0, 0},  // 71 'G'
    {17,17,17,31,17,17,17, 0, 0},  // 72 'H'
    {31, 4, 4, 4, 4, 4,31, 0, 0},  // 73 'I'
    {16,16,16,16,17,17,14, 0, 0},  // 74 'J'
    {17, 9, 5, 3, 5, 9,17, 0, 0},  // 75 'K'
    { 1, 1, 1, 1, 1, 1,31, 0, 0},  // 76 'L'
    {17,27,21,17,17,17,17, 0, 0},  // 77 'M'
    {17,17,19,21,25,17,17, 0, 0},  // 78 'N'
    {14,17,17,17,17,17,14, 0, 0},  // 79 'O'
    {15,17,17,15, 1, 1, 1, 0, 0},  // 80 'P'
    {14,17,17,17,17,17,14,24, 0},  // 81 'Q'
    {15,17,17,15,17,17,17, 0, 0},  // 82 'R'
    {14,17, 1,14,16,17,14, 0, 0},  // 83 'S'
    {31, 4, 4, 4, 4, 4, 4, 0, 0},  // 84 'T'
    {17,17,17,17,17,17,14, 0, 0},  // 85 'U'
    {17,17,17,17,10,10, 4, 0, 0},  // 86 'V'
    {17,17,17,17,21,27,17, 0, 0},  // 87 'W'
    {17,17,10, 4,10,17,17, 0, 0},  // 88 'X'
    {17,17,10, 4, 4, 4, 4, 0, 0},  // 89 'Y'
    {31,16, 8, 4, 2, 1,31, 0, 0},  // 90 'Z'
    {12, 4, 4, 4, 4, 4,12, 0, 0},  // 91 '['
    { 1, 1, 2, 4, 8,16,16, 0, 0},  // 92 '\\'
    { 6, 4, 4, 4, 4, 4, 6, 0, 0},  // 93 ']'
    { 4,10,17, 0, 0, 0, 0, 0, 0},  // 94 '^'
    { 0, 0, 0, 0, 0, 0,31, 0, 0},  // 95 '_'
    { 2, 4, 0, 0, 0, 0, 0, 0, 0},  // 96 '`'
    { 0, 0,30,17,17,17,30, 0, 0},  // 97 'a'
    { 1, 1,15,17,17,17,15, 0, 0},  // 98 'b'
    { 0, 0,14,17, 1,17,14, 0, 0},  // 99 'c'
    {16,16,30,17,17,17,30, 0, 0},  // 100 'd'
    { 0, 0,14,17,31, 1,14, 0, 0},  // 101 'e'
    {12,18, 2,15, 2, 2, 2, 0, 0},  // 102 'f'
    { 0, 0,30,17,17,17,30,16,14},  // 103 'g'
    { 1, 1,15,17,17,17,17, 0, 0},  // 104 'h'
    { 4, 0, 6, 4, 4, 4,31, 0, 0},  // 105 'i'
    {16, 0,24,16,16,16,16,17,14},  // 106 'j'
    { 1, 1,17, 9, 7, 9,17, 0, 0},  // 107 'k'
    { 3, 2, 2, 2, 2, 2,28, 0, 0},  // 108 'l'
    { 0, 0,15,21,21,21,21, 0, 0},  // 109 'm'
    { 0, 0,15,17,17,17,17, 0, 0},  // 110 'n'
    { 0, 0,14,17,17,17,14, 0, 0},  // 111 'o'
    { 0, 0,15,17,17,17,15, 1, 1},  // 112 'p'
    { 0, 0,30,17,17,17,30,16,16},  // 113 'q'
    { 0, 0,13,19, 1, 1, 1, 0, 0},  // 114 'r'
    { 0, 0,30, 1,14,16,15, 0, 0},  // 115 's'
    { 2, 2,15, 2, 2, 2,28, 0, 0},  // 116 't'
    { 0, 0,17,17,17,17,30, 0, 0},  // 117 'u'
    { 0, 0,17,17,17,10, 4, 0, 0},  // 118 'v'
    { 0, 0,17,17,21,21,10, 0, 0},  // 119 'w'
    { 0, 0,17,10, 4,10,17, 0, 0},  // 120 'x'
    { 0, 0,17,17,17,17,30,16,14},  // 121 'y'
    { 0, 0,31, 8, 4, 2,31, 0, 0},  // 122 'z'
    { 8, 4, 4, 2, 4, 4, 8, 0, 0},  // 123 '{'
    { 4, 4, 4, 4, 4, 4, 4, 0, 0},  // 124 '|'
    { 2, 4, 4, 8, 4, 4, 2, 0, 0},  // 125 '}'
    { 0, 0,18,13, 0, 0, 0, 0, 0},  // 126 '~'
};

// --- Sprite storage ----------------------------------------------------------

#define SPR_SHEET_W   256   // sprite sheet width in pixels
#define SPR_SHEET_H   128   // sprite sheet height in pixels
#define SPR_TILE_W    8     // tile width in pixels
#define SPR_TILE_H    8     // tile height in pixels
#define SPR_TILES_X   (SPR_SHEET_W / SPR_TILE_W)   // 32
#define SPR_TILES_Y   (SPR_SHEET_H / SPR_TILE_H)   // 16
#define SPR_TILE_COUNT (SPR_TILES_X * SPR_TILES_Y)  // 512
#define SPR_TILE_BYTES (SPR_TILE_W * SPR_TILE_H)    // 64

static uint8_t spr_tiles[SPR_TILE_COUNT][SPR_TILE_BYTES];
static bool    spr_loaded = false;

// --- Drawing helpers ---------------------------------------------------------

static void fb_pixel(int x, int y, int c) {
    if ((unsigned)x < DISPLAY_W && (unsigned)y < DISPLAY_H)
        fb[y][x] = (uint8_t)(c & 0xFF);
}

static int draw_char(int x, int y, char ch, int c) {
    if (ch < 32 || ch > 126) ch = '?';
    const uint8_t *g = font[(unsigned char)ch - 32];
    for (int row = 0; row < FONT_H; row++) {
        uint8_t bits = g[row];
        for (int col = 0; col < FONT_W; col++)
            if ((bits >> col) & 1) fb_pixel(x + col, y + row, c);
    }
    return x + FONT_W + 1;
}

// --- Public API --------------------------------------------------------------

void display_init(void) {
    spi_init(SPI_PORT, 40 * 1000 * 1000);
    spi_set_format(SPI_PORT, 8, SPI_CPOL_1, SPI_CPHA_1, SPI_MSB_FIRST);
    gpio_set_function(PIN_SCK,  GPIO_FUNC_SPI);
    gpio_set_function(PIN_MOSI, GPIO_FUNC_SPI);
    gpio_set_function(PIN_MISO, GPIO_FUNC_SPI);

    gpio_init(PIN_CS);  gpio_set_dir(PIN_CS,  GPIO_OUT); gpio_put(PIN_CS,  1);
    gpio_init(PIN_DC);  gpio_set_dir(PIN_DC,  GPIO_OUT); gpio_put(PIN_DC,  1);
    gpio_init(PIN_RST); gpio_set_dir(PIN_RST, GPIO_OUT); gpio_put(PIN_RST, 1);
    gpio_init(PIN_BL);  gpio_set_dir(PIN_BL,  GPIO_OUT); gpio_put(PIN_BL,  1);

    // ILI9341 reset and init
    gpio_put(PIN_RST, 1); sleep_ms(10);
    gpio_put(PIN_RST, 0); sleep_ms(10);
    gpio_put(PIN_RST, 1); sleep_ms(120);

    write_cmd(ILI9341_SWRESET); sleep_ms(120);

    write_cmd(ILI9341_PWCTR1); write_byte(0x23);
    write_cmd(ILI9341_PWCTR2); write_byte(0x10);
    write_cmd(ILI9341_VMCTR1); write_byte(0x3E); write_byte(0x28);
    write_cmd(ILI9341_VMCTR2); write_byte(0x86);

    // Landscape (MV=1), BGR order — adjust if colours are swapped on your panel
    write_cmd(ILI9341_MADCTL); write_byte(0x28);

    // 16 bits/pixel RGB565
    write_cmd(ILI9341_COLMOD); write_byte(0x55);

    write_cmd(ILI9341_FRMCTR1); write_byte(0x00); write_byte(0x18);
    write_cmd(ILI9341_DFUNCTR); write_byte(0x08); write_byte(0x82); write_byte(0x27);
    write_cmd(ILI9341_GAMMASET); write_byte(0x01);

    write_cmd(ILI9341_GMCTRP1);
    write_data((uint8_t[]){0x0F,0x31,0x2B,0x0C,0x0E,0x08,0x4E,0xF1,
                            0x37,0x07,0x10,0x03,0x0E,0x09,0x00}, 15);
    write_cmd(ILI9341_GMCTRN1);
    write_data((uint8_t[]){0x00,0x0E,0x14,0x03,0x11,0x07,0x31,0xC1,
                            0x48,0x08,0x0F,0x0C,0x31,0x36,0x0F}, 15);

    write_cmd(ILI9341_SLPOUT); sleep_ms(120);
    write_cmd(ILI9341_DISPON);

    // Clear entire physical panel to black (row_buf is zero-initialised)
    memset(row_buf, 0, sizeof(row_buf));
    set_window(0, 0, PHYS_W - 1, PHYS_H - 1);
    cs_select(); dc_data();
    for (int y = 0; y < PHYS_H; y++)
        spi_write_blocking(SPI_PORT, row_buf, PHYS_W * 2);
    cs_deselect();

    init_palette();
    memset(fb, 0, sizeof(fb));
}

void display_flush(void) {
    set_window(0, 0, PHYS_W - 1, PHYS_H - 1);
    cs_select(); dc_data();
    for (int y = 0; y < DISPLAY_H; y++) {
        // Expand each logical pixel to 2 consecutive physical pixels
        for (int x = 0; x < DISPLAY_W; x++) {
            uint16_t c  = palette[fb[y][x]];
            uint8_t  hi = (uint8_t)(c >> 8);
            uint8_t  lo = (uint8_t)(c & 0xFF);
            row_buf[x * 4    ] = hi;
            row_buf[x * 4 + 1] = lo;
            row_buf[x * 4 + 2] = hi;
            row_buf[x * 4 + 3] = lo;
        }
        // Send the expanded row twice (2 physical rows per logical row)
        spi_write_blocking(SPI_PORT, row_buf, PHYS_W * 2);
        spi_write_blocking(SPI_PORT, row_buf, PHYS_W * 2);
    }
    cs_deselect();
}

void display_cls(int c) {
    memset(fb, (uint8_t)(c & 0xFF), sizeof(fb));
}

void display_pset(int x, int y, int c) {
    fb_pixel(x, y, c);
}

int display_pget(int x, int y) {
    if ((unsigned)x < DISPLAY_W && (unsigned)y < DISPLAY_H)
        return fb[y][x];
    return 0;
}

void display_rectfill(int x, int y, int w, int h, int c) {
    for (int py = y; py < y + h; py++)
        for (int px = x; px < x + w; px++)
            fb_pixel(px, py, c);
}

void display_rect(int x, int y, int w, int h, int c) {
    display_line(x,         y,         x + w - 1, y,         c);
    display_line(x,         y + h - 1, x + w - 1, y + h - 1, c);
    display_line(x,         y + 1,     x,         y + h - 2, c);
    display_line(x + w - 1, y + 1,     x + w - 1, y + h - 2, c);
}

void display_line(int x0, int y0, int x1, int y1, int c) {
    int dx =  abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    int dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    for (;;) {
        fb_pixel(x0, y0, c);
        if (x0 == x1 && y0 == y1) break;
        int e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
    }
}

void display_print(int x, int y, const char *s, int c) {
    while (*s && x < DISPLAY_W)
        x = draw_char(x, y, *s++, c);
}

void display_setpal(int i, int r, int g, int b) {
    if ((unsigned)i < 256)
        palette[i] = rgb565(r & 0xFF, g & 0xFF, b & 0xFF);
}

int display_getpal(int i, int chan) {
    if ((unsigned)i >= 256) return 0;
    uint16_t c = palette[i];
    switch (chan) {
        case 0: return ((c >> 11) & 0x1F) << 3;   // R: 5 bits → 8 bits (approx)
        case 1: return ((c >>  5) & 0x3F) << 2;   // G: 6 bits → 8 bits
        case 2: return ((c      ) & 0x1F) << 3;   // B: 5 bits → 8 bits
    }
    return 0;
}

void display_load_sprites(const uint8_t *pal_rgb, const uint8_t *tile_data, uint16_t tile_count) {
    // Replace palette with sprite sheet palette
    for (int i = 0; i < 256; i++)
        palette[i] = rgb565(pal_rgb[i*3], pal_rgb[i*3+1], pal_rgb[i*3+2]);

    // Copy tile data
    uint16_t n = tile_count < SPR_TILE_COUNT ? tile_count : SPR_TILE_COUNT;
    memcpy(spr_tiles, tile_data, (size_t)n * SPR_TILE_BYTES);
    spr_loaded = true;
}

void display_spr(int n, int x, int y, int flags) {
    if (!spr_loaded || (unsigned)n >= SPR_TILE_COUNT) return;
    const uint8_t *tile = spr_tiles[n];
    int flip_x = flags & 1, flip_y = (flags >> 1) & 1;
    for (int ty = 0; ty < SPR_TILE_H; ty++) {
        int sy = flip_y ? SPR_TILE_H - 1 - ty : ty;
        for (int tx = 0; tx < SPR_TILE_W; tx++) {
            uint8_t idx = tile[sy * SPR_TILE_W + (flip_x ? SPR_TILE_W - 1 - tx : tx)];
            if (idx != 0) fb_pixel(x + tx, y + ty, idx);
        }
    }
}

void display_sspr(int sx, int sy, int sw, int sh, int dx, int dy, int flags) {
    if (!spr_loaded) return;
    int flip_x = flags & 1, flip_y = (flags >> 1) & 1;
    for (int ty = 0; ty < sh; ty++) {
        int src_y = sy + (flip_y ? sh - 1 - ty : ty);
        if (src_y < 0 || src_y >= SPR_SHEET_H) continue;
        for (int tx = 0; tx < sw; tx++) {
            int src_x = sx + (flip_x ? sw - 1 - tx : tx);
            if (src_x < 0 || src_x >= SPR_SHEET_W) continue;
            int tc  = src_x / SPR_TILE_W;
            int tr  = src_y / SPR_TILE_H;
            int ti  = tr * SPR_TILES_X + tc;
            uint8_t idx = spr_tiles[ti][(src_y % SPR_TILE_H) * SPR_TILE_W + (src_x % SPR_TILE_W)];
            if (idx != 0) fb_pixel(dx + tx, dy + ty, idx);
        }
    }
}
