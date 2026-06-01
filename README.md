# Bidule 01

> A tiny, open, DIY platform for making games, art, and apps — from hardware to software.

Bidule 01 is a creative and educational fantasy console designed to run on minimal hardware (a Raspberry Pi Pico). It pairs a 160×120 color screen, 6-button input, and procedural audio with an intentionally small scripting language, so that a single person can understand and build the entire stack.

The constraints are the point: no floats, no dynamic allocation — just code, pixels, and sound.

> ⚠️ This project is in early development. A web emulator and Pico prototype are on the roadmap. Watch the repo to follow progress.

---

## Contents

- [Philosophy](#philosophy)
- [Example cart](#example-cart)
- [Program structure](#program-structure)
- [Scripting language](#scripting-language)
- [Hardware](#hardware)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Prior art](#prior-art)

---

## Philosophy

Most creative tools hide their complexity. This one doesn't.

Bidule 01 is designed so that a curious person — a student, a hobbyist, a tinkerer — can trace every part of the system: the hardware schematic, the interpreter, the draw loop, and the audio callback. Building something on it means understanding it.

Constraints are deliberate:
- **160×120 indexed-color display** — forces spatial thinking
- **6 buttons only** — forces interaction design
- **Integer-only math** — keeps the interpreter tiny and auditable
- **No dynamic allocation** — fixed arrays, global scope, predictable memory

---

## Example cart

```
// @title  Blink
// @author example
// @id     blink-v1

x = 80
y = 60
dx = 2
dy = 2
col = 7

init() {
  setpal(7, 255, 200, 0)
}

update(frame, input) {
  x += dx
  y += dy
  if (x < 8 || x > 152) { dx = 0 - dx }
  if (y < 8 || y > 112) { dy = 0 - dy }
  if (btnp(4)) { col = rnd(255) + 1 }
}

draw(frame, input) {
  cls(0)
  rectfill(x - 4, y - 4, 8, 8, col)
  print(frame, 2, 2, 1)
}

audio(t) {
  return (t * 4) & 255
}
```

---

## Program structure

A cart is a single source file (`.bdcart`) compiled to a binary (`.bdb`). It defines any combination of four lifecycle functions:

| Function | Called | Purpose |
|---|---|---|
| `init()` | Once at start | Initialise state |
| `update(frame, input)` | 30× per second | Game logic |
| `draw(frame, input)` | 30× per second | Rendering |
| `audio(t)` | 8000× per second | Sound synthesis |

All are optional.

### Cart metadata

Declared at the top of the source file:

```
// @title   My Game
// @author  yourname
// @version 1.0.0
// @desc    A short description
// @id      my-game-v1
```

`@id` is required for persistence (`save`/`load`).

---

## Scripting language

The cart language is a minimal, integer-only language with JavaScript-like syntax. Full details are in [spec.md](spec.md); this is an overview.

### Types

- **`int`** — signed 32-bit integer, wraparound on overflow. `0` is false; any other value is true.
- **`arr`** — fixed-size global array of `int`. Declared at the top level.

No strings as a first-class type: text is stored as null-terminated arrays of char codes.

### Variables and arrays

All declarations appear at the top level, outside any function:

```
score = 0       // int, initialised to 0
buf[64]         // arr, 64 elements, zero-initialised
name = "hello"  // arr, initialised with char codes (null-terminated)
```

Maximum 64 global variables and 16 array declarations per cart.

### Functions

User-defined functions use the `fn` keyword:

```
fn clamp(x, lo, hi) {
  if (x < lo) { return lo }
  if (x > hi) { return hi }
  return x
}
```

Array parameters use `[]`: `fn fill(dst[], val, len) { ... }`.

### Control flow

```
if (condition) { ... }
if (condition) { ... } else { ... }
while (condition) { ... }
for (i = 0; i < 10; i++) { ... }
```

`break` and `continue` are supported. Comments are `//` only.

### Built-in API

A quick reference — see [spec.md](spec.md) for full signatures and behaviour.

**Input:** `btn(i)`, `btnp(i)`

**Graphics:** `cls`, `pset`, `pget`, `line`, `rect`, `rectfill`, `print`, `spr`, `sspr`, `setpal`, `getpal`

**Math:** `abs`, `min`, `max`, `clamp`, `seed`, `rnd`

**Arrays:** `streq`, `arreq`

**Persistence:** `save`, `load`

**Cart utilities:** `cartcount`, `cartmeta`, `loadcart`

---

## Hardware

### Minimal bill of materials

| Component | Notes |
|---|---|
| Raspberry Pi Pico | RP2040-based board |
| ILI9341 SPI TFT | 240×320 physical panel; firmware displays at 160×120 |
| 6× tact switch | Momentary pushbutton |
| Speaker or jack | 1W 8Ω speaker or 3.5mm female connector |
| Power | USB or 3× AAA batteries |
| Breadboard + jumper wires | For prototyping; a PCB design is planned |

Wiring instructions and a PCB layout are on the roadmap.

---

## Roadmap

### v1

| Item | Status |
|---|---|
| Language specification | 🟦 In progress |
| Raspberry Pi Pico prototype | 🟦 In progress |
| Reference compiler / interpreter | 🟦 In progress |
| Web emulator | 🟦 In progress |
| Pico build instructions | 📋 Planned |
| PCB files | 📋 Planned |
| Enclosure design | 📋 Planned |

### Beyond v1

- Community forum
- Cart sharing platform
- Build and BOM sharing platform

---

## Contributing

The project is open and contributions are welcome, even at this early stage. The most useful things right now are:

- Feedback on the language design and API
- Breadboard prototype builds and reports
- Web emulator implementation

Please open an issue before starting significant work so we can coordinate.

---

## Prior art

Bidule 01 draws direct inspiration from:

- [PICO-8](https://www.lexaloffle.com/pico-8.php) — the original fantasy console
- [TIC-80](https://tic80.com/) — open-source fantasy computer
- [Lowres NX](https://lowresnx.inutilis.com/) — educational fantasy console
- [Arduboy](https://www.arduboy.com/) — open-source handheld gaming platform

The goal is not to replicate these but to push further toward hardware openness and interpretive minimalism.
