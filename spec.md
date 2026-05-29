# Bidule 01 — Technical Specification

> **Status: Draft / Work in Progress**
> This document is the authoritative specification for the Bidule 01 platform.
> Sections marked 🔲 are placeholders pending design decisions.

**Spec version:** 0.7  
**Last updated:** 2026-05-29

---

### 1. Language Model

The cart language is a minimal imperative language with explicit types, global scope only, and no dynamic allocation. It is integer-only. The syntax is loosely JavaScript-inspired.

Key properties:

- Two types: `int` (signed 32-bit) and `arr` (fixed-size array of `int`).
- All variables are global. No locals, no closures.
- All arrays are fixed-size and declared at the top level.
- Functions return `int` only.
- No type inference. Types are determined by declaration syntax.
- Recursion is permitted within the call-stack limit.
- Single-file programs.
- Designed to compile to a compact stack-based bytecode.

---

### 2. Types and Variables

#### 2.1 Types

**`int`** — signed 32-bit integer, wraparound on overflow.  
**`arr`** — a named, fixed-size, globally allocated array of `int`.

There is no boolean type. `0` is false; any other value is true.

#### 2.2 Variable Declarations

All declarations appear at the top level (outside any function).

```
score = 0          // int variable, initialised to 0
lives = 3          // int variable, initialised to 3
buf[64]            // arr variable, 64 elements, all 0
name = "player1"   // arr variable, initialised with char codes (null-terminated)
```

The type is determined by syntax:

| Form | Type | Notes |
|---|---|---|
| `IDENT = NUMBER` | `int` | Initialised to the given value |
| `IDENT = STRING` | `arr` | Null-terminated char codes |
| `IDENT[N]` | `arr` | N elements, zero-initialised |

A name may be declared only once. Re-declaring is a compile-time error.

Assigning an `arr` variable to another `arr` variable is a **compile-time error**. Arrays do not alias.

Maximum **64 global variables** per cart (int and arr combined). Maximum **16 arr declarations** per cart.

Uninitialised int variables default to `0`.

#### 2.3 Integer Semantics

- Arithmetic is 32-bit signed with wraparound.
- Division truncates toward zero. Division by zero returns `0`.
- `%` satisfies: `a == (a / b) * b + (a % b)`.
- No floating-point at any level.

#### 2.4 Char Literals

`'A'` evaluates to the ASCII code of the character (`65`). This is compile-time syntactic sugar for an int literal.

```
if (buf[i] == 'a') { ... }
```

Char literals may only appear in integer expression contexts.

#### 2.5 Operator Precedence

| Precedence | Operators | Associativity |
|---|---|---|
| 9 | Unary `-` | Right |
| 8 | `*` `/` `%` | Left |
| 7 | `+` `-` | Left |
| 6 | `>>` `<<` | Left |
| 5 | `>` `<` `>=` `<=` `==` `!=` | Left |
| 4 | `&` | Left |
| 3 | `^` | Left |
| 2 | `\|` | Left |
| 1 | `&&` `\|\|` | Left |

`&&` and `||` are short-circuit. `==` / `!=` on `arr` variables is a compile-time error; use `streq`.

---

### 3. Functions

#### 3.1 User-Defined Functions

```
fn add(a, b) {
  return a + b
}

fn fill(dst[], val, len) {
  i = 0
  while (i < len) {
    dst[i] = val
    i++
  }
}
```

- Parameters without `[]` are `int`. Parameters with `[]` are `arr`.
- `[]` annotation is **required** for array parameters. The compiler rejects a call where argument type does not match parameter type.
- Functions return `int` via `return expr`. Falling off the end implicitly returns `0`.
- Returning an `arr` from a user-defined function is not supported.
- Calling a function with the wrong number or type of arguments is a compile-time error.
- A string literal may **not** be passed to a user-defined function's `arr` parameter. Pass a named array variable.
- Recursion is allowed. Stack overflow is a runtime error (see §10.5).
- Maximum call-stack depth: **16 frames**.

#### 3.2 Lifecycle Functions

A cart defines any combination of the following. They are recognised by name at the top level and do **not** use the `fn` keyword.

```
init() { ... }
update(frame, input) { ... }
draw(frame, input) { ... }
audio(t) { ... }
```

All are optional. `return` is invalid inside `init`, `update`, and `draw` (compile-time error). `return expr` inside `audio(t)` sets the output sample.

See §9 for calling semantics.

---

### 4. Control Flow

```
if (condition) { ... }
if (condition) { ... } else { ... }

while (condition) { ... }

for (i = 0; i < 10; i++) { ... }
```

Braces are mandatory. `break` and `continue` are valid inside `while` and `for` only. Comments are `//` single-line only.

---

### 5. Arrays

#### 5.1 Indexing

```
buf[0] = 65        // write element
x = buf[i]         // read element
buf[i] += 1        // compound assignment
```

Out-of-bounds reads return `0`. Out-of-bounds writes are silently ignored.

#### 5.2 Length

```
n = buf.length     // declared size of buf
```

`.length` is a compile-time constant property on `arr` variables only.

#### 5.3 String Initialisation

`name = "hello"` allocates an `arr` in the global pool, initialised with char codes `[104, 101, 108, 108, 111, 0]` (null-terminated). It is mutable after initialisation.

String literals appearing directly in expressions (not in declarations) are temporary inline byte sequences. They may be passed to built-in functions that accept read-only `arr` arguments (e.g. `print`, `streq`). They may not be assigned to a variable or passed to a user-defined function.

Escape sequences: `\\` — backslash; `\"` — double quote. Literals are restricted to printable ASCII (32–126).

---

### 6. Graphics API

#### 6.1 Display

- Resolution: **160 × 120 pixels**, landscape.
- Color model: **8-bit indexed (CLUT)**, palette of 256 entries. Each entry maps a palette index (0–255) to a 16-bit RGB565 color stored in the firmware.
- Color argument `c` in all drawing functions is a palette index (integer 0–255).
- Origin: top-left corner. X increases right, Y increases down.
- Drawing outside bounds is silently clipped.
- The framebuffer is written during `draw()` and flushed after `draw()` returns. The hardware upscales or letterboxes the 160×120 logical image to fill the physical display panel.
- Coordinates: `x` ∈ [0, 159], `y` ∈ [0, 119].

#### 6.2 Default Palette

The runtime provides a fixed 256-entry CLUT loaded at cart start. Required entries:

| Index | Color |
|---|---|
| 0 | Black (0, 0, 0) |
| 1 | White (255, 255, 255) |
| 2–15 | Standard 14-color set (red, green, blue, yellow, cyan, magenta, and mid-tones) |
| 16–255 | Implementation-defined defaults |

The full default palette is part of the firmware and must be documented separately. Carts may override any entry at runtime with `setpal`. The palette resets to the firmware default at cart start (not at each frame). Calling `setpal` inside `init()` establishes a cart-specific palette before the first frame.

#### 6.3 Drawing Functions

```
cls(c)                    // fill screen with colour c
pset(x, y, c)             // set pixel at (x, y)
pget(x, y)     → int      // get palette index at (x, y); returns 0 if out of bounds
line(x0, y0, x1, y1, c)   // Bresenham line; both endpoints included
rect(x, y, w, h, c)       // outline rectangle
rectfill(x, y, w, h, c)   // filled rectangle
```

#### 6.4 Text

```
print(text, x, y, c)
```

`text` may be an `int` (rendered as decimal digits) or an `arr` (rendered as char codes until first `0` or end of array).

Font: **Monogram** by Datagoblin. Character cell: 6 × 9 px (5 px glyph + 1 px gap, 9 px tall). Full printable ASCII (32–126). Single line; no wrapping.

#### 6.5 Palette (CLUT)

```
setpal(i, r, g, b)        // set palette entry i (0-255) to RGB (0-255 each)
getpal(i, chan) → int      // read back a palette entry; chan: 0=R, 1=G, 2=B
```

- Changes take effect at the next frame flush.
- `setpal` is a no-op for out-of-range `i`. `getpal` returns 0 for out-of-range `i` or `chan`.
- The firmware stores entries as RGB565 internally; `getpal` returns the value after round-tripping through RGB565 (5-bit R, 6-bit G, 5-bit B precision).
- `setpal` and `getpal` operate on the runtime CLUT, not the framebuffer. Calling `setpal` does not repaint already-drawn pixels; it changes how indices are translated to colors during the next flush.

---

### 7. Input API

```
btn(i)   → int    // 1 if button i is held, else 0
btnp(i)  → int    // 1 if button i was pressed this frame (edge), else 0
```

Returns `0` for out-of-range `i`.

| Index | Button |
|---|---|
| 0 | Left |
| 1 | Right |
| 2 | Up |
| 3 | Down |
| 4 | A |
| 5 | B |

`update(frame, input)` and `draw(frame, input)` also receive `input` as a bitfield: bit `i` is set if button `i` is held.

---

### 8. Math Utilities

```
abs(x)            → int
min(a, b)          → int
max(a, b)          → int
clamp(x, lo, hi)   → int
seed(n)            → void
rnd(n)             → int    // [0, n-1]; undefined if n <= 0
```

Random seed is initialised to a fixed constant at cart start.

---

### 9. Audio Model

`audio(t)` runs on **core 1** at **8000 Hz**.

- `t` is the sample counter (32-bit signed, reset to 0 after `init()` completes).
- The return value is treated as unsigned 8-bit: `output = return_value & 0xFF`. Range: 0–255; 128 = silence.
- Falling off the end without `return` implicitly returns `128`.
- `audio(t)` may call math utilities only. Graphics, input, and persistence calls are compile-time errors.
- `audio(t)` must not write to any global variable or array element. Any write is a compile-time error.

**Read-only variable access:**  
`audio(t)` reads from a shadow copy of the global variable table (int values only; array data is shared directly). The runtime maintains two shadow buffers (A and B, 64 × 4 bytes each). After each `draw()`, the live variable table is copied into the inactive buffer and the active index is atomically flipped. Core 1 always reads from the active buffer. Maximum read latency: one frame (~33 ms).

---

### 10. Persistence

Each cart has 4 × 32-bit save slots, keyed by the cart's `@id` metadata field.

```
save(slot, value)    // write; slot in [0, 3]; out-of-range is a no-op
load(slot) → int     // read; returns 0 if unwritten or out-of-range
```

**Cart identity:**

```
// @id my-game-v1
```

`@id` must be 1–32 printable ASCII characters. If absent and `save`/`load` are called, persistence is disabled (compiler warning). Uniqueness is the author's responsibility.

**Storage:** Flat array of 32 entries in a dedicated 4 KB flash page. Each entry: 32-byte id + 16-byte values = 48 bytes. Writes go to a RAM mirror; flushed to flash on cart exit or device shutdown. Power loss may lose the last write. No wear levelling. Carts should not call `save` on every frame.

---

### 11. Cart Utilities

```
cartcount()              → int
cartmeta(i, field[], dst[]) → int   // fills dst with null-terminated value; returns length or 0
loadcart(i)              → int      // loads cart i; returns 0 if invalid index
```

`field` is a read-only `arr` parameter. `dst` is a writable `arr` parameter. Passing a string literal for `dst` is a compile-time error; use a named array.

`loadcart(i)` returns 0 if the cart does not exist. If valid, the switch takes effect at the end of the current frame.

---

### 12. Array Comparison

```
streq(a[], b[]) → int    // 1 if null-terminated contents are equal, else 0
```

Both parameters are read-only; string literals are accepted. Comparison is capped at `MAX_ARRAY_ELEMENTS + 1` iterations.

`arreq` is deferred to v2.

---

### 13. Cartridge Format

#### 13.1 Files

| Format | Extension |
|---|---|
| Source | `.bdcart` |
| Compiled | `.bdb` |

The firmware executes compiled carts only.

#### 13.2 Source Metadata

Metadata appears at the top of the source file as `// @key value` comments.

| Key | Description |
|---|---|
| `title` | Display name |
| `author` | Author name |
| `version` | Version string |
| `desc` | One-line description |
| `id` | Persistence key |

Unknown keys are ignored.

#### 13.3 Compiled Binary Layout

All multi-byte integers are little-endian.

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | Magic: `B D B N` |
| 4 | 1 | Format version: `1` |
| 5 | 1 | Flags: `0` (reserved) |
| 6 | 2 | Metadata block length N |
| 8 | N | Metadata block (raw text) |
| 8+N | 1 | Array declaration count (0–16) |
| … | 2×count | Array sizes: u16 LE per entry, in declaration order |
| … | 2 | `init_off` (0xFFFF = not defined) |
| … | 2 | `update_off` |
| … | 1 | `update` frame slot (0xFF = not bound) |
| … | 1 | `update` input slot |
| … | 2 | `draw_off` |
| … | 1 | `draw` frame slot |
| … | 1 | `draw` input slot |
| … | 2 | `audio_off` |
| … | 1 | `audio` t slot |
| … | 2 | `fn_count` |
| … | 2 | `fn_table_off` (byte offset from bytecode start) |
| … | remainder | Bytecode stream |

**Function table entry** (per user-defined function):

| Field | Size |
|---|---|
| name_len | 1 |
| name bytes | name_len |
| param_count | 1 |
| entry | 2 (LE bytecode offset) |
| param_slots | param_count × 1 (scalar slot per param) |

#### 13.4 Opcode Set

Stack-based interpreter. 1-byte opcode, variable-width operands.

| Opcode | Hex | Operands | Description |
|---|---|---|---|
| `PUSH_INT` | `0x00` | i32 | Push 32-bit integer constant |
| `PUSH_LIT` | `0x01` | u8 len, len+1 bytes | Push temporary read-only array ref (inline null-terminated data) |
| `LOAD` | `0x02` | u8 slot | Push int from global scalar slot |
| `STORE` | `0x03` | u8 slot | Pop → global scalar slot |
| `ADD` | `0x10` | — | a + b |
| `SUB` | `0x11` | — | a - b |
| `MUL` | `0x12` | — | a * b |
| `DIV` | `0x13` | — | a / b; 0 if b==0 |
| `MOD` | `0x14` | — | a % b |
| `NEG` | `0x15` | — | -a |
| `BAND` | `0x20` | — | a & b |
| `BOR` | `0x21` | — | a \| b |
| `BXOR` | `0x22` | — | a ^ b |
| `SHL` | `0x23` | — | a << (b & 31) |
| `SHR` | `0x24` | — | a >> (b & 31) |
| `EQ` | `0x30` | — | 1 if a==b, else 0 |
| `NE` | `0x31` | — | 1 if a!=b, else 0 |
| `LT` | `0x32` | — | 1 if a<b, else 0 |
| `LE` | `0x33` | — | 1 if a<=b, else 0 |
| `GT` | `0x34` | — | 1 if a>b, else 0 |
| `GE` | `0x35` | — | 1 if a>=b, else 0 |
| `NOT` | `0x36` | — | 1 if a==0, else 0 |
| `POP` | `0x40` | — | Discard top |
| `DUP` | `0x41` | — | Duplicate top |
| `ARR_GET` | `0x70` | u8 arridx | Pop index; push element from array pool entry arridx (0 if OOB) |
| `ARR_SET` | `0x71` | u8 arridx | Pop value, pop index; write into array pool entry arridx (no-op if OOB) |
| `ARR_LEN` | `0x72` | u8 arridx | Push declared size of array pool entry arridx |
| `PUSH_ARR` | `0x73` | u8 arridx | Push array pool reference (for passing to function) |
| `JUMP` | `0x50` | i16 | Unconditional relative jump |
| `JUMP_T` | `0x51` | i16 | Pop; jump if nonzero |
| `JUMP_F` | `0x52` | i16 | Pop; jump if zero |
| `PEEK_JUMP_T` | `0x53` | i16 | Peek; jump if nonzero (for `\|\|`) |
| `PEEK_JUMP_F` | `0x54` | i16 | Peek; jump if zero (for `&&`) |
| `CALL` | `0x60` | u8 id, u8 argc | Call built-in id; pops argc args; pushes return value if non-void |
| `CALL_FN` | `0x61` | u8 fnidx, u8 argc | Call user-defined function by function table index |
| `RET` | `0xFF` | — | Return. For `audio(t)`: pops top as sample. For `fn`: pops top as return value. For others: stack empty. |

**Index spaces:**

| Space | Range | Used by |
|---|---|---|
| Scalar variable slots | 0–63 | `LOAD`, `STORE`, parameter slots |
| Array pool indices | 0–15 | `ARR_GET`, `ARR_SET`, `ARR_LEN`, `PUSH_ARR` |
| Function table indices | 0–fn_count−1 | `CALL_FN` |

**Compound assignment** (`arr[i] += v`) compiles to: `<i>`, `DUP`, `ARR_GET`, `<v>`, `<op>`, `ARR_SET`.

**Short-circuit** (`a && b`): `<a>`, `PEEK_JUMP_F skip`, `POP`, `<b>`, `skip:`. Result is the final value on the stack, not normalised to 0/1.

#### 13.5 Size Limits

| Limit | Value |
|---|---|
| Max source size | 64 KB |
| Max bytecode size | 16 KB |
| Max array declarations | 16 |
| Max elements per array | 256 |
| Max global variables | 64 |
| Max string literal length | 255 chars |
| Max user-defined functions | 64 |
| Max call stack depth | 16 frames |
| Evaluation stack depth | 32 slots |

---

### 14. Firmware / Runtime

#### 14.1 Boot Sequence

1. Initialise display, input, audio.
2. If any button held at boot: enter USB storage mode; loop until unplugged or reset.
3. Load `boot.bdb`. If missing or invalid: display error, wait for button press, load built-in cart selector.
4. Initialise global variable table to 0.
5. Call `init()` if defined.
6. Reset `t` counter to 0.
7. Enter main loop.

#### 14.2 Main Loop

Target: **30 frames per second**. Each frame:

1. Poll input.
2. Call `update(frame, input)` if defined.
3. Call `draw(frame, input)` if defined.
4. Flush framebuffer to display.
5. Copy live variable table to inactive audio shadow; atomically swap active shadow.
6. Increment `frame` counter (32-bit signed, wraps).

`frame` wraps from 2³¹−1 to −2³¹ after ~828 days at 30 fps.

Overrun: if update + draw + flush exceed 33 ms, next frame starts immediately. No frame skipping; `draw()` is never omitted.

#### 14.3 Audio Callback

Core 1. Called 8000 times per second. One sample per call.

Core 1 spins at ~45 µs per sample. If `audio(t)` takes longer, the effective rate degrades proportionally. No error is raised; no silence is inserted.

#### 14.4 Cart Switching

`loadcart(i)` requested during `update()` takes effect at frame end (after `draw()` and flush). On switch: global table is reset, `t` reset, `frame` reset, new cart's `init()` called. Audio continues during transition using the last shadow written.

#### 14.5 Error Handling

- **Load-time error:** display message, halt, wait for reset.
- **Runtime error in `update()`/`draw()`:** halt immediately, display message. Device waits for reset.
- **Runtime error in `audio(t)`:** return 128 (silence) for that sample; continue normally.
- **Stack overflow:** treated as runtime error per context above.

#### 14.6 Display Hardware

- Controller: **ILI9341** or compatible SPI TFT (240×320 physical)
- Logical resolution: **160 × 120** (2× pixel-doubling on the physical panel, centred with black letterbox if needed)
- Firmware framebuffer: 160 × 120 × 1 byte (palette indices) = **19 200 bytes (~19 KB)**
- CLUT: 256 × 2 bytes = **512 bytes** (RGB565 entries, firmware-managed)
- Flush sequence: CPU or DMA expands 8-bit index row → 16-bit RGB565 row → SPI to display; or pre-expand the full frame to a 320×240 line-doubled buffer (38.4 KB) before DMA transfer.
- Interface: SPI. GPIO assignments: TBD.

#### 14.7 Memory Budget

| Region | Size | Notes |
|---|---|---|
| Firmware code | in flash | Runs via XIP; does not consume SRAM |
| Firmware data/stacks | ~20 KB | Firmware globals, C stacks, SDK buffers |
| Framebuffer (8-bit indexed) | ~19 KB | 160×120×1 B |
| Line-double expand buffer (optional) | ~38 KB | 320×240×2 B RGB565, for DMA flush |
| CLUT | 0.5 KB | 256 × RGB565 |
| Cart bytecode | 16 KB | |
| Global variable table (live + 2 shadows) | 0.75 KB | 3 × 64 × 4 B |
| Global array pool | 16 KB | 16 arrays × 256 × 4 B |
| Evaluation stacks | 0.25 KB | 2 cores × 32 × 4 B |
| **Total (with DMA expand)** | **~110 KB** | ~154 KB remaining |
| **Total (without DMA expand)** | **~72 KB** | ~192 KB remaining |

#### 14.8 Distribution

- **Firmware:** flash via BOOTSEL + `.uf2` drop.
- **Carts:** USB mass-storage mode exposes cart region. Drag `.bdb` files. Max 32 carts.
- **On-device selection:** built-in cart selector at boot. No button combination to return mid-cart; cart must call `loadcart()` or device must be reset.

---

### 15. V1 Scope / Later Scope

**In v1:**
- `int` and `arr` types, global scope only
- Fixed-size arrays, global pool
- `init` / `update` / `draw` / `audio` lifecycle
- `btn` / `btnp` input
- `cls` / `pset` / `pget` / `line` / `rect` / `rectfill` / `print` graphics
- `setpal` palette control
- `abs` / `min` / `max` / `clamp` / `seed` / `rnd` math
- `save` / `load` persistence (4 slots)
- `cartcount` / `cartmeta` / `loadcart` cart utilities
- `streq` string comparison
- `fn` user-defined functions (int args + arr args, int return)
- Recursion (capped at 16 frames)
- Compiled binary format (`.bdb`)
- Source metadata block (`// @key value`)

**Deferred to later:**

| Feature | Reason |
|---|---|
| `arreq(a, b, len)` | `streq` covers most cases |
| `clearsave()` | Not needed for core game loop |
| Sprite/tile blit API (`blit`, `spr`) | Useful but adds ROM/RAM complexity |
| Music / tracker API | Audio synthesis in cart code is sufficient for v1 |
| Larger save slots or more than 4 slots | Extend the flash layout when needed |
| Additional buttons or analog input | Hardware TBD |
| Multi-file carts | Adds toolchain complexity |
| First-class functions, closures | Explicitly deferred |
| Floating point | Explicitly excluded |
| String formatting built-ins | Cart code can do it with arrays |
| `print` with background color | Minor API addition, easy to add later |
| `circ` / `circfill` | Nice-to-have graphics primitives |

---

### 16. Example Cart

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

### Grammar (Summary)

```
program      := top_level*
top_level    := global_decl | fn_def | lifecycle_fn
global_decl  := IDENT '=' NUMBER
              | IDENT '=' STRING
              | IDENT '[' NUMBER ']'
fn_def       := 'fn' IDENT '(' param_list ')' block
lifecycle_fn := ('init' | 'update' | 'draw' | 'audio') '(' param_list ')' block
param_list   := (param (',' param)*)?
param        := IDENT ('[' ']')?
statement    := assignment | arr_assign | incr_stmt | if_stmt | while_stmt
             | for_stmt | break_stmt | continue_stmt | return_stmt | call_stmt
assignment   := IDENT ('=' | '+=' | '-=' | '*=' | '/=' | '%=') expr
arr_assign   := IDENT '[' expr ']' ('=' | '+=' | '-=' | '*=' | '/=' | '%=') expr
incr_stmt    := IDENT ('++' | '--')
if_stmt      := 'if' '(' expr ')' block ('else' block)?
while_stmt   := 'while' '(' expr ')' block
for_stmt     := 'for' '(' (assignment | incr_stmt) ';' expr ';' (assignment | incr_stmt) ')' block
break_stmt   := 'break'
continue_stmt := 'continue'
return_stmt  := 'return' expr
call_stmt    := IDENT '(' arglist ')'
block        := '{' statement* '}'
expr         := bitor (('&&' | '||') bitor)*
bitor        := bitxor ('|' bitxor)*
bitxor       := bitand ('^' bitand)*
bitand       := comparison ('&' comparison)*
comparison   := shift (('==' | '!=' | '>' | '<' | '>=' | '<=') shift)*
shift        := additive (('>>' | '<<') additive)*
additive     := multiplicative (('+' | '-') multiplicative)*
multiplicative := unary (('*' | '/' | '%') unary)*
unary        := '-' unary | '!' unary | primary
primary      := NUMBER | CHAR_LIT | STRING | IDENT | IDENT '[' expr ']'
              | IDENT '.length' | IDENT '(' arglist ')' | '(' expr ')'
arglist      := (expr (',' expr)*)?
```

Notes:
- `!` (logical not) is added as a unary operator; it is equivalent to `== 0` and compiles to `NOT`.
- Prefix `++`/`--` are removed from v1 (redundant given postfix forms and compound assignment).
- `IDENT '.length'` is only valid if `IDENT` is an `arr` variable (compile-time check).
- Lifecycle function parameter lists are fixed by name (`frame`, `input`, `t`); unrecognised names are a compile-time error.
