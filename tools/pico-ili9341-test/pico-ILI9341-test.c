#include <stdio.h>
#include "pico/stdlib.h"
#include "hardware/spi.h"

#define SPI_PORT spi0
#define PIN_MISO 16
#define PIN_CS   17
#define PIN_SCK  18
#define PIN_MOSI 19
#define PIN_DC   20
#define PIN_RST  21
#define PIN_BL   22

#define ILI9341_WIDTH  240
#define ILI9341_HEIGHT 320

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

// RGB565 colors
#define COLOR_BLACK   0x0000
#define COLOR_WHITE   0xFFFF
#define COLOR_RED     0xF800
#define COLOR_GREEN   0x07E0
#define COLOR_BLUE    0x001F
#define COLOR_YELLOW  0xFFE0
#define COLOR_CYAN    0x07FF
#define COLOR_MAGENTA 0xF81F

static inline void cs_select(void)   { gpio_put(PIN_CS, 0); }
static inline void cs_deselect(void) { gpio_put(PIN_CS, 1); }
static inline void dc_cmd(void)      { gpio_put(PIN_DC, 0); }
static inline void dc_data(void)     { gpio_put(PIN_DC, 1); }

static void write_cmd(uint8_t cmd) {
    cs_select();
    dc_cmd();
    spi_write_blocking(SPI_PORT, &cmd, 1);
    cs_deselect();
}

static void write_data(const uint8_t *buf, size_t len) {
    cs_select();
    dc_data();
    spi_write_blocking(SPI_PORT, buf, len);
    cs_deselect();
}

static void write_byte(uint8_t b) { write_data(&b, 1); }

static void ili9341_init(void) {
    gpio_put(PIN_RST, 1); sleep_ms(10);
    gpio_put(PIN_RST, 0); sleep_ms(10);
    gpio_put(PIN_RST, 1); sleep_ms(120);

    write_cmd(ILI9341_SWRESET); sleep_ms(120);

    write_cmd(ILI9341_PWCTR1); write_byte(0x23);
    write_cmd(ILI9341_PWCTR2); write_byte(0x10);

    write_cmd(ILI9341_VMCTR1); write_byte(0x3E); write_byte(0x28);
    write_cmd(ILI9341_VMCTR2); write_byte(0x86);

    // Portrait, BGR color order
    write_cmd(ILI9341_MADCTL); write_byte(0x48);

    // 16 bits/pixel
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
}

static void set_window(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1) {
    write_cmd(ILI9341_CASET);
    write_data((uint8_t[]){x0 >> 8, x0 & 0xFF, x1 >> 8, x1 & 0xFF}, 4);
    write_cmd(ILI9341_PASET);
    write_data((uint8_t[]){y0 >> 8, y0 & 0xFF, y1 >> 8, y1 & 0xFF}, 4);
    write_cmd(ILI9341_RAMWR);
}

// Row buffer for fast fills
static uint8_t row_buf[ILI9341_WIDTH * 2];

static void fill_rect(uint16_t x, uint16_t y, uint16_t w, uint16_t h, uint16_t color) {
    set_window(x, y, x + w - 1, y + h - 1);
    for (int i = 0; i < w; i++) {
        row_buf[i * 2]     = color >> 8;
        row_buf[i * 2 + 1] = color & 0xFF;
    }
    cs_select();
    dc_data();
    for (uint16_t row = 0; row < h; row++)
        spi_write_blocking(SPI_PORT, row_buf, w * 2);
    cs_deselect();
}

static void fill_screen(uint16_t color) {
    fill_rect(0, 0, ILI9341_WIDTH, ILI9341_HEIGHT, color);
}

int main(void) {
    stdio_init_all();

    spi_init(SPI_PORT, 10 * 1000 * 1000);
    spi_set_format(SPI_PORT, 8, SPI_CPOL_1, SPI_CPHA_1, SPI_MSB_FIRST);
    gpio_set_function(PIN_SCK,  GPIO_FUNC_SPI);
    gpio_set_function(PIN_MOSI, GPIO_FUNC_SPI);

    gpio_init(PIN_CS);  gpio_set_dir(PIN_CS,  GPIO_OUT); gpio_put(PIN_CS,  1);
    gpio_init(PIN_DC);  gpio_set_dir(PIN_DC,  GPIO_OUT); gpio_put(PIN_DC,  1);
    gpio_init(PIN_RST); gpio_set_dir(PIN_RST, GPIO_OUT); gpio_put(PIN_RST, 1);
    gpio_init(PIN_BL);  gpio_set_dir(PIN_BL,  GPIO_OUT); gpio_put(PIN_BL,  1);

    ili9341_init();

    while (true) {
        // Solid blue
        fill_screen(COLOR_BLUE);
        sleep_ms(500);

        // Four-color quadrants
        fill_rect(0,                  0,                   ILI9341_WIDTH / 2, ILI9341_HEIGHT / 2, COLOR_RED);
        fill_rect(ILI9341_WIDTH / 2,  0,                   ILI9341_WIDTH / 2, ILI9341_HEIGHT / 2, COLOR_GREEN);
        fill_rect(0,                  ILI9341_HEIGHT / 2,  ILI9341_WIDTH / 2, ILI9341_HEIGHT / 2, COLOR_YELLOW);
        fill_rect(ILI9341_WIDTH / 2,  ILI9341_HEIGHT / 2,  ILI9341_WIDTH / 2, ILI9341_HEIGHT / 2, COLOR_MAGENTA);
        sleep_ms(1000);

        // White cross on black
        fill_screen(COLOR_BLACK);
        fill_rect(ILI9341_WIDTH  / 2 - 5, 0,                  10,             ILI9341_HEIGHT, COLOR_WHITE);
        fill_rect(0,                       ILI9341_HEIGHT / 2 - 5, ILI9341_WIDTH, 10,         COLOR_WHITE);
        sleep_ms(1000);

        // Cyan horizontal stripes on black
        fill_screen(COLOR_BLACK);
        for (int i = 0; i < ILI9341_HEIGHT; i += 20)
            fill_rect(0, i, ILI9341_WIDTH, 10, COLOR_CYAN);
        sleep_ms(1000);
    }
}
