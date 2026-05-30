#pragma once
#include <stdint.h>

// Logical framebuffer dimensions (centred on the 320×240 ILI9341 panel)
#define DISPLAY_W 160
#define DISPLAY_H 120

void display_init(void);
void display_flush(void);

// Cart API (§6.3 – §6.5)
void display_cls(int c);
void display_pset(int x, int y, int c);
int  display_pget(int x, int y);
void display_rectfill(int x, int y, int w, int h, int c);
void display_rect(int x, int y, int w, int h, int c);
void display_line(int x0, int y0, int x1, int y1, int c);
void display_print(int x, int y, const char *s, int c);
void display_setpal(int i, int r, int g, int b);
int  display_getpal(int i, int chan);

// Reset CLUT to the firmware default (called at cart load time).
void display_reset_palette(void);

// Sprite sheet — called from vm_load() when flags bit 0 is set.
// pal_rgb:    256×3 bytes (R, G, B per entry); replaces the current palette.
// tile_data:  tile_count × 64 bytes (8×8 palette-index pixels, row-major).
void display_load_sprites(const uint8_t *pal_rgb, const uint8_t *tile_data, uint16_t tile_count);

// spr(n, x, y, flags) — draw 8×8 sprite n at screen (x, y).
void display_spr(int n, int x, int y, int flags);

// sspr(sx, sy, sw, sh, dx, dy, flags) — blit a rect from the sprite sheet.
void display_sspr(int sx, int sy, int sw, int sh, int dx, int dy, int flags);
