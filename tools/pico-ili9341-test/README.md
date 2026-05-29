# pico-ILI9341-test

Test project for driving an ILI9341 320×240 SPI display with a Raspberry Pi Pico.

## Wiring

| ILI9341 pin | Pico GPIO | Notes |
|-------------|-----------|-------|
| VCC         | 3V3       |       |
| GND         | GND       |       |
| CS          | GP17      |       |
| RST         | GP21      |       |
| DC          | GP20      | Data/Command select |
| MOSI / SDA  | GP19      |       |
| SCK / CLK   | GP18      |       |
| BL / LED    | GP22      | Driven high in firmware |
| MISO        | —         | Not connected (display is write-only) |

## SPI configuration

- Port: SPI0
- Speed: 10 MHz
- Mode: 3 (CPOL=1, CPHA=1) — required by this module despite datasheet saying Mode 0
- Pixel format: RGB565 (16 bpp)

## Test pattern

The firmware cycles through:
1. Solid blue fill
2. Four-color quadrants (red / green / yellow / magenta)
3. White cross on black
4. Cyan horizontal stripes on black

## Build

Requires the [Raspberry Pi Pico SDK](https://github.com/raspberrypi/pico-sdk) (v2.2.0).

```sh
mkdir build && cd build
cmake ..
ninja
```

Flash `pico-ILI9341-test.uf2` to the Pico by holding BOOTSEL while plugging in USB, then copying the file to the mounted drive.
