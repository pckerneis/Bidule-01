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
