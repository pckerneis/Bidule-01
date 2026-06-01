#include "vm.h"
#include "../display.h"
#include "../input.h"
#include "../cart.h"
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>

// ─── Limits ───────────────────────────────────────────────────────────────────

#define MAX_VARS        256
#define MAX_BYTECODE    16384
#define STACK_SIZE      32
#define MAX_ARR_DECLS   255     // u8 arridx in opcodes; binary format also uses u8 count
#define POOL_ELEMS      4096    // 16 KB pool / 4 bytes per element; also the per-array ceiling
#define MAX_USER_FNS    64
#define MAX_FN_PARAMS   8
#define MAX_CALL_DEPTH  8
#define MAX_PRINT_BUF   288   // practical truncation limit for print(); display fits ~26 chars/line

// ─── Value ───────────────────────────────────────────────────────────────────

// VALUE_ARR_LIT: .i is the bytecode offset of the first char code of an inline
//   PUSH_LIT string (vm.code[.i - 1] = len, vm.code[.i .. .i+len-1] = char data).
// VALUE_ARR_MUT: .i is the index into the mutable array pool.

#define VALUE_INT     0
#define VALUE_ARR_LIT 1
#define VALUE_ARR_MUT 2
#define VALUE_VOID    0xFF

typedef struct {
    uint8_t type;   // VALUE_INT, VALUE_ARR_LIT, VALUE_ARR_MUT, or VALUE_VOID
    int32_t i;
} Value;

// ─── VM state ─────────────────────────────────────────────────────────────────

static struct {
    // Loaded bytecode
    uint8_t  code[MAX_BYTECODE];
    uint16_t code_len;

    // Mutable array pool (declared with name[N] or name = "str" syntax)
    int32_t  arrpool[POOL_ELEMS];           // flat pool shared by all array declarations
    uint16_t arrbase[MAX_ARR_DECLS];        // starting index in arrpool for each array
    uint16_t arrdeclsize[MAX_ARR_DECLS];    // element count for each array (up to POOL_ELEMS)
    uint8_t  arrdecl_count;

    // Entry points (0xFFFF = lifecycle function not defined in cart)
    uint16_t off_init;
    uint16_t off_update;
    uint16_t off_draw;
    uint16_t off_audio;

    // Global variable slots for lifecycle function parameters (0xFF = not bound)
    uint8_t  param_update_frame;
    uint8_t  param_update_input;
    uint8_t  param_draw_frame;
    uint8_t  param_draw_input;
    uint8_t  param_audio_t;

    // Live global variable table (core 0) — integers only
    Value    globals[MAX_VARS];

    // Audio shadow buffers — core 0 writes inactive then flips; core 1 reads active.
    // Single-byte flip is naturally atomic on RP2040 (Cortex-M0+); DMB before write
    // ensures the memcpy is visible to core 1.
    Value    shadow[2][MAX_VARS];
    volatile uint8_t shadow_active;

    // User-defined function table (populated during vm_load)
    struct {
        uint16_t entry;
        uint8_t  params;
        uint8_t  param_slots[MAX_FN_PARAMS];
    } user_fns[MAX_USER_FNS];
    uint16_t user_fn_count;

    // Per-core evaluation stacks
    Value    stack0[STACK_SIZE];
    Value    stack1[STACK_SIZE];

    // LCG random state
    uint32_t rng;

    bool     loaded;
    bool     exit_exec;
    bool     cart_switched;
} vm;

// ─── Binary reading helpers ───────────────────────────────────────────────────

static inline int32_t  ri32(const uint8_t *p) {
    return (int32_t)((uint32_t)p[0] | ((uint32_t)p[1] << 8)
                   | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24));
}
static inline int16_t  ri16(const uint8_t *p) {
    return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}
static inline uint16_t ru16(const uint8_t *p) {
    return (uint16_t)p[0] | ((uint16_t)p[1] << 8);
}

// ─── Array helpers ────────────────────────────────────────────────────────────

// Return element idx from any array value; 0 for out-of-bounds or non-array.
// VALUE_ARR_LIT: data is inline in vm.code; len is at vm.code[v.i - 1].
static int32_t arr_elem(Value v, int idx) {
    if (v.type == VALUE_ARR_LIT) {
        uint16_t off = (uint16_t)v.i;
        if (off == 0 || off >= vm.code_len) return 0;
        uint8_t len = vm.code[off - 1];
        return (idx >= 0 && idx < len) ? (int32_t)vm.code[off + idx] : 0;
    }
    if (v.type == VALUE_ARR_MUT) {
        int i = v.i;
        if (i >= 0 && i < vm.arrdecl_count && idx >= 0 && idx < vm.arrdeclsize[i])
            return vm.arrpool[vm.arrbase[i] + idx];
        return 0;
    }
    return 0;
}

// Fill buf with the null-terminated string represented by an array value.
// Interprets elements as char codes, stopping at 0 or end of array.
static void arr_to_cstr(Value v, char *buf, int bufsize) {
    int n = 0;
    if (v.type == VALUE_ARR_LIT) {
        uint16_t off = (uint16_t)v.i;
        if (off > 0 && off < vm.code_len) {
            uint8_t len = vm.code[off - 1];
            for (int j = 0; j < len && n < bufsize - 1; j++) {
                uint8_t c = vm.code[off + j];
                if (c == 0) break;
                buf[n++] = (char)c;
            }
        }
    } else if (v.type == VALUE_ARR_MUT) {
        int idx = v.i;
        if (idx >= 0 && idx < vm.arrdecl_count) {
            int size = vm.arrdeclsize[idx];
            for (int j = 0; j < size && n < bufsize - 1; j++) {
                int32_t c = vm.arrpool[vm.arrbase[idx] + j];
                if (c == 0) break;
                buf[n++] = (char)(c & 0x7F);
            }
        }
    }
    buf[n] = '\0';
}

static Value exec(uint16_t entry, Value *globals, Value *stk);

// ─── Built-in dispatch ────────────────────────────────────────────────────────

static Value call_builtin(uint8_t id, Value *a) {
    switch ((BuiltinId)id) {

    // Input
    case BUILTIN_BTN:
        return (Value){ VALUE_INT, input_btn(a[0].i) };
    case BUILTIN_BTNP:
        return (Value){ VALUE_INT, input_btnp(a[0].i) };

    // Graphics
    case BUILTIN_CLS:
        display_cls(a[0].i);
        return (Value){ VALUE_VOID };
    case BUILTIN_PSET:
        display_pset(a[0].i, a[1].i, a[2].i);
        return (Value){ VALUE_VOID };
    case BUILTIN_RECTFILL:
        display_rectfill(a[0].i, a[1].i, a[2].i, a[3].i, a[4].i);
        return (Value){ VALUE_VOID };
    case BUILTIN_LINE:
        display_line(a[0].i, a[1].i, a[2].i, a[3].i, a[4].i);
        return (Value){ VALUE_VOID };
    case BUILTIN_PRINT: {
        char buf[MAX_PRINT_BUF];
        const char *text;
        if (a[0].type == VALUE_INT) {
            snprintf(buf, sizeof(buf), "%d", (int)a[0].i);
            text = buf;
        } else {
            arr_to_cstr(a[0], buf, sizeof(buf));
            text = buf;
        }
        display_print(a[1].i, a[2].i, text, a[3].i);
        return (Value){ VALUE_VOID };
    }

    // Math
    case BUILTIN_ABS: {
        int32_t x = a[0].i;
        return (Value){ VALUE_INT, x < 0 ? -x : x };
    }
    case BUILTIN_MIN:
        return (Value){ VALUE_INT, a[0].i < a[1].i ? a[0].i : a[1].i };
    case BUILTIN_MAX:
        return (Value){ VALUE_INT, a[0].i > a[1].i ? a[0].i : a[1].i };
    case BUILTIN_CLAMP: {
        int32_t x = a[0].i, lo = a[1].i, hi = a[2].i;
        return (Value){ VALUE_INT, x < lo ? lo : x > hi ? hi : x };
    }
    case BUILTIN_SEED:
        vm.rng = (uint32_t)a[0].i;
        return (Value){ VALUE_VOID };
    case BUILTIN_RND: {
        int32_t n = a[0].i;
        if (n <= 0) return (Value){ VALUE_INT, 0 };
        vm.rng = vm.rng * 1664525u + 1013904223u;
        return (Value){ VALUE_INT, (int32_t)((vm.rng >> 16) % (uint32_t)n) };
    }

    // Array comparison
    case BUILTIN_STREQ: {
        for (int i = 0; i <= POOL_ELEMS; i++) {
            int32_t ea = arr_elem(a[0], i);
            int32_t eb = arr_elem(a[1], i);
            if (ea != eb) return (Value){ VALUE_INT, 0 };
            if (ea == 0)  return (Value){ VALUE_INT, 1 };
        }
        return (Value){ VALUE_INT, 0 };
    }
    case BUILTIN_ARREQ: {
        int len = (int)a[2].i;
        for (int i = 0; i < len; i++)
            if (arr_elem(a[0], i) != arr_elem(a[1], i))
                return (Value){ VALUE_INT, 0 };
        return (Value){ VALUE_INT, 1 };
    }

    // Persistence — flash not yet implemented; stubs return safe defaults
    case BUILTIN_SAVE:
        return (Value){ VALUE_VOID };
    case BUILTIN_LOAD_SLOT:
        return (Value){ VALUE_INT, 0 };

    // Cart utilities
    case BUILTIN_CARTCOUNT:
        return (Value){ VALUE_INT, cart_count() };
    case BUILTIN_CARTMETA: {
        char field[32];
        arr_to_cstr(a[1], field, sizeof(field));
        const char *val = cart_meta(a[0].i, field);
        int written = 0;
        if (a[2].type == VALUE_ARR_MUT) {
            int dest = a[2].i;
            if (dest >= 0 && dest < vm.arrdecl_count) {
                int size = vm.arrdeclsize[dest];
                while (written < size - 1 && val[written]) {
                    vm.arrpool[vm.arrbase[dest] + written] = (int32_t)(unsigned char)val[written];
                    written++;
                }
                if (written < size) vm.arrpool[vm.arrbase[dest] + written] = 0;
            }
        }
        return (Value){ VALUE_INT, written };
    }
    case BUILTIN_LOADCART: {
        uint32_t size;
        const uint8_t *bin = cart_get(a[0].i, &size);
        if (!bin || !vm_load(bin, size)) return (Value){ VALUE_INT, 0 };
        exec(vm.off_init, vm.globals, vm.stack0);
        vm.exit_exec     = true;
        vm.cart_switched = true;
        return (Value){ VALUE_VOID };
    }

    // Graphics extras
    case BUILTIN_PGET:
        return (Value){ VALUE_INT, display_pget(a[0].i, a[1].i) };
    case BUILTIN_RECT:
        display_rect(a[0].i, a[1].i, a[2].i, a[3].i, a[4].i);
        return (Value){ VALUE_VOID };
    case BUILTIN_SETPAL:
        display_setpal(a[0].i, a[1].i, a[2].i, a[3].i);
        return (Value){ VALUE_VOID };
    case BUILTIN_GETPAL:
        return (Value){ VALUE_INT, display_getpal(a[0].i, a[1].i) };

    // Sprites
    case BUILTIN_SPR:
        display_spr(a[0].i, a[1].i, a[2].i, a[3].i);
        return (Value){ VALUE_VOID };
    case BUILTIN_SSPR:
        display_sspr(a[0].i, a[1].i, a[2].i, a[3].i, a[4].i, a[5].i, a[6].i);
        return (Value){ VALUE_VOID };

    default:
        return (Value){ VALUE_VOID };
    }
}

// ─── Interpreter ─────────────────────────────────────────────────────────────
//
// exec() runs one lifecycle function body to completion.
// `globals` is either vm.globals (core 0) or vm.shadow[active] (core 1 audio).
// `stk`     is vm.stack0 (core 0) or vm.stack1 (core 1).
// Returns the top-of-stack on RET/end-of-code, or {VALUE_INT, 128} if empty.

static Value exec(uint16_t entry, Value *globals, Value *stk) {
    if (entry == 0xFFFF || !vm.loaded) return (Value){ VALUE_INT, 128 };

    uint16_t ip = entry;
    int      sp = 0;
    vm.exit_exec = false;

    // Call frame stack for user-defined function calls
    struct { uint16_t ret_ip; } cframes[MAX_CALL_DEPTH];
    int cfp = 0;

#define PUSH(v)    do { if (sp < STACK_SIZE) stk[sp++] = (v); } while (0)
#define PUSH_I(n)  PUSH(((Value){ VALUE_INT, (int32_t)(n) }))
#define POP()      (sp > 0 ? stk[--sp] : (Value){ VALUE_INT, 0 })
#define PEEK()     (sp > 0 ? stk[sp-1]  : (Value){ VALUE_INT, 0 })
#define R8()       (vm.code[ip++])
#define R16()      (ip += 2, ri16(vm.code + ip - 2))
#define R32()      (ip += 4, ri32(vm.code + ip - 4))

    while (ip < vm.code_len) {
        switch ((Opcode)vm.code[ip++]) {

        // ── Literals ─────────────────────────────────────────────────────────
        case OP_PUSH_INT:     PUSH_I(R32()); break;
        case OP_PUSH_LIT: {
            // Inline literal: [len][char0 .. charN-1][0]
            // Push a T_LIT value whose .i is the bytecode offset of the first char code.
            // vm.code[dataOff - 1] = len (the byte we just read via R8).
            uint8_t  len     = R8();
            uint16_t dataOff = ip;
            ip += len;
            PUSH(((Value){ VALUE_ARR_LIT, (int32_t)dataOff }));
            break;
        }
        case OP_PUSH_ARR_MUT: PUSH(((Value){ VALUE_ARR_MUT, R8() })); break;

        // ── Variables ────────────────────────────────────────────────────────
        case OP_LOAD: {
            uint8_t s = R8();
            PUSH(s < MAX_VARS ? globals[s] : ((Value){ VALUE_INT, 0 }));
            break;
        }
        case OP_STORE: {
            uint8_t s = R8();
            Value v = POP();
            if (s < MAX_VARS) globals[s] = v;
            break;
        }
        case OP_LOAD_ARR: {
            uint8_t s = R8();
            PUSH(s < MAX_VARS ? globals[s] : ((Value){ VALUE_INT, 0 }));
            break;
        }

        // ── Arithmetic ───────────────────────────────────────────────────────
        case OP_ADD: { Value b = POP(), a = POP(); PUSH_I(a.i + b.i);              break; }
        case OP_SUB: { Value b = POP(), a = POP(); PUSH_I(a.i - b.i);              break; }
        case OP_MUL: { Value b = POP(), a = POP(); PUSH_I(a.i * b.i);              break; }
        case OP_DIV: { Value b = POP(), a = POP(); PUSH_I(b.i ? a.i / b.i : 0);   break; }
        case OP_MOD: { Value b = POP(), a = POP(); PUSH_I(b.i ? a.i % b.i : 0);   break; }
        case OP_NEG: { Value a = POP();             PUSH_I(-a.i);                   break; }

        // ── Bitwise ──────────────────────────────────────────────────────────
        case OP_BAND: { Value b = POP(), a = POP(); PUSH_I(a.i & b.i);          break; }
        case OP_BOR:  { Value b = POP(), a = POP(); PUSH_I(a.i | b.i);          break; }
        case OP_BXOR: { Value b = POP(), a = POP(); PUSH_I(a.i ^ b.i);          break; }
        case OP_SHL:  { Value b = POP(), a = POP(); PUSH_I(a.i << (b.i & 31));  break; }
        case OP_SHR:  { Value b = POP(), a = POP(); PUSH_I(a.i >> (b.i & 31));  break; }

        // ── Comparison ───────────────────────────────────────────────────────
        case OP_EQ: { Value b = POP(), a = POP(); PUSH_I(a.i == b.i); break; }
        case OP_NE: { Value b = POP(), a = POP(); PUSH_I(a.i != b.i); break; }
        case OP_LT: { Value b = POP(), a = POP(); PUSH_I(a.i <  b.i); break; }
        case OP_LE: { Value b = POP(), a = POP(); PUSH_I(a.i <= b.i); break; }
        case OP_GT: { Value b = POP(), a = POP(); PUSH_I(a.i >  b.i); break; }
        case OP_GE: { Value b = POP(), a = POP(); PUSH_I(a.i >= b.i); break; }

        // ── Logical NOT ──────────────────────────────────────────────────────
        case OP_NOT: { Value a = POP(); PUSH_I(!a.i); break; }

        // ── Stack ────────────────────────────────────────────────────────────
        case OP_POP: POP(); break;
        case OP_DUP: { Value top = PEEK(); PUSH(top); break; }

        // ── Control flow ─────────────────────────────────────────────────────
        case OP_JUMP:       { int16_t off = R16(); ip = (uint16_t)(ip + off);                break; }
        case OP_JUMP_T:     { int16_t off = R16(); if (POP().i  != 0) ip = (uint16_t)(ip + off); break; }
        case OP_JUMP_F:     { int16_t off = R16(); if (POP().i  == 0) ip = (uint16_t)(ip + off); break; }
        case OP_PEEK_JUMP_T:{ int16_t off = R16(); if (PEEK().i != 0) ip = (uint16_t)(ip + off); break; }
        case OP_PEEK_JUMP_F:{ int16_t off = R16(); if (PEEK().i == 0) ip = (uint16_t)(ip + off); break; }

        // ── Built-in call ────────────────────────────────────────────────────
        case OP_CALL: {
            uint8_t id   = R8();
            uint8_t argc = R8();
            Value args[8] = {{ VALUE_INT, 0 }};
            for (int i = argc - 1; i >= 0; i--) args[i] = POP();
            Value result = call_builtin(id, args);
            if (result.type != VALUE_VOID) PUSH(result);
            if (vm.exit_exec) goto done;
            break;
        }

        // ── User-defined function call ────────────────────────────────────────
        case OP_CALL_FN: {
            uint8_t  lo     = R8();
            uint8_t  hi     = R8();
            uint16_t fn_idx = (uint16_t)lo | ((uint16_t)hi << 8);
            uint8_t  argc   = R8();
            if (fn_idx >= vm.user_fn_count || cfp >= MAX_CALL_DEPTH) {
                PUSH_I(0);
                break;
            }
            int nparams = vm.user_fns[fn_idx].params;
            Value args[MAX_FN_PARAMS] = {{ VALUE_INT, 0 }};
            for (int i = argc - 1; i >= 0; i--) args[i] = POP();
            for (int i = 0; i < nparams && i < MAX_FN_PARAMS; i++) {
                uint8_t slot = vm.user_fns[fn_idx].param_slots[i];
                if (slot < MAX_VARS) globals[slot] = args[i];
            }
            cframes[cfp++].ret_ip = ip;
            ip = vm.user_fns[fn_idx].entry;
            break;
        }

        // ── Array operations ─────────────────────────────────────────────────
        case OP_ARR_GET: {
            uint8_t slot = R8();
            int     idx  = (int)POP().i;
            if (slot < vm.arrdecl_count && idx >= 0 && idx < vm.arrdeclsize[slot])
                PUSH_I(vm.arrpool[vm.arrbase[slot] + idx]);
            else
                PUSH_I(0);
            break;
        }
        case OP_ARR_SET: {
            uint8_t slot = R8();
            Value   val  = POP();
            int     idx  = (int)POP().i;
            if (slot < vm.arrdecl_count && idx >= 0 && idx < vm.arrdeclsize[slot])
                vm.arrpool[vm.arrbase[slot] + idx] = val.i;
            break;
        }
        case OP_ARR_LEN: {
            uint8_t slot = R8();
            PUSH_I(slot < vm.arrdecl_count ? vm.arrdeclsize[slot] : 0);
            break;
        }
        case OP_DYN_ARR_GET: {
            uint8_t slot = R8();
            int     idx  = (int)POP().i;
            Value   v    = slot < MAX_VARS ? globals[slot] : (Value){ VALUE_INT, 0 };
            PUSH_I(arr_elem(v, idx));
            break;
        }
        case OP_DYN_ARR_SET: {
            uint8_t slot = R8();
            Value   val  = POP();
            int     idx  = (int)POP().i;
            Value   v    = slot < MAX_VARS ? globals[slot] : (Value){ VALUE_INT, 0 };
            if (v.type == VALUE_ARR_MUT) {
                int i = v.i;
                if (i >= 0 && i < vm.arrdecl_count && idx >= 0 && idx < vm.arrdeclsize[i])
                    vm.arrpool[vm.arrbase[i] + idx] = val.i;
            }
            // VALUE_ARR_LIT: bytecode is read-only — silent no-op
            break;
        }
        case OP_DYN_ARR_LEN: {
            uint8_t  slot = R8();
            Value    v    = slot < MAX_VARS ? globals[slot] : (Value){ VALUE_INT, 0 };
            if (v.type == VALUE_ARR_LIT) {
                uint16_t off = (uint16_t)v.i;
                PUSH_I(off > 0 && off < vm.code_len ? vm.code[off - 1] : 0);
            } else if (v.type == VALUE_ARR_MUT) {
                PUSH_I(v.i >= 0 && v.i < vm.arrdecl_count ? vm.arrdeclsize[v.i] : 0);
            } else {
                PUSH_I(0);
            }
            break;
        }

        case OP_RET:
            if (cfp > 0) {
                Value ret = sp > 0 ? stk[--sp] : (Value){ VALUE_INT, 0 };
                ip = cframes[--cfp].ret_ip;
                PUSH(ret);
            } else {
                goto done;
            }
            break;
        }
    }
done:
    return sp > 0 ? stk[sp - 1] : (Value){ VALUE_INT, 128 };

#undef PUSH
#undef PUSH_I
#undef POP
#undef PEEK
#undef R8
#undef R16
#undef R32
}

// ─── vm_load ─────────────────────────────────────────────────────────────────
//
// Binary format (.bdb) — all multi-byte integers little-endian:
//
//   [0]     4 B   magic 'B','D','B','N'
//   [4]     1 B   format version (1)
//   [5]     1 B   flags (reserved, must be 0)
//   [6]     2 B   metadata block length N
//   [8]     N B   metadata block (ignored by runtime)
//   [8+N]   1 B   array declaration count
//           ?     array declaration table: per entry:
//                   [size: u16 LE]  — element count
//                   [initLen: u8]   — 0 = zero-init; >0 = char code initialiser bytes
//                   [initLen bytes] — char codes (included null terminator)
//           2 B   init_off   (0xFFFF = not defined)
//           2 B   update_off
//           1 B   update 'frame' param slot (0xFF = not bound)
//           1 B   update 'input' param slot
//           2 B   draw_off
//           1 B   draw 'frame' param slot
//           1 B   draw 'input' param slot
//           2 B   audio_off
//           1 B   audio 't' param slot
//           ?     bytecode stream (PUSH_LIT instructions embed literal data inline)

bool vm_load(const uint8_t *bin, uint32_t len) {
    if (len < 8) return false;
    if (bin[0] != 'B' || bin[1] != 'D' || bin[2] != 'B' || bin[3] != 'N') return false;
    if (bin[4] != 1) return false;

    const uint8_t flags = bin[5];
    const uint8_t *p   = bin + 6;
    const uint8_t *end = bin + len;

    // Skip metadata block
    if (p + 2 > end) return false;
    uint16_t meta_len = ru16(p);
    p += 2 + meta_len;
    if (p > end) return false;

    // Zero mutable state before filling in from binary
    memset(vm.globals,  0, sizeof(vm.globals));
    memset(vm.shadow,   0, sizeof(vm.shadow));
    memset(vm.arrpool,  0, sizeof(vm.arrpool));

    // Array declaration table
    if (p >= end) return false;
    uint8_t ndecl = *p++;
    if (ndecl > MAX_ARR_DECLS) return false;
    vm.arrdecl_count = ndecl;
    uint16_t pool_used = 0;
    for (int i = 0; i < ndecl; i++) {
        if (p + 3 > end) return false;  // size (2) + initLen (1)
        uint16_t sz      = ru16(p); p += 2;
        uint8_t  initLen = *p++;
        uint16_t clamped = sz > POOL_ELEMS ? (uint16_t)POOL_ELEMS : sz;
        if ((uint32_t)pool_used + clamped > POOL_ELEMS) return false;
        vm.arrbase[i]     = pool_used;
        vm.arrdeclsize[i] = clamped;
        pool_used        += clamped;
        if (initLen > 0) {
            if (p + initLen > end) return false;
            for (int j = 0; j < initLen && j < clamped; j++)
                vm.arrpool[vm.arrbase[i] + j] = (int32_t)(*p++);
        }
    }

    // Entry points + parameter slots (13 bytes) + fn table header (4 bytes) = 17 bytes
    if (p + 17 > end) return false;
    vm.off_init           = ru16(p); p += 2;
    vm.off_update         = ru16(p); p += 2;
    vm.param_update_frame = *p++;
    vm.param_update_input = *p++;
    vm.off_draw           = ru16(p); p += 2;
    vm.param_draw_frame   = *p++;
    vm.param_draw_input   = *p++;
    vm.off_audio          = ru16(p); p += 2;
    vm.param_audio_t      = *p++;
    uint16_t fn_count     = ru16(p); p += 2;
    uint16_t fn_table_off = ru16(p); p += 2;

    // Reset palette to firmware default before applying any sprite palette.
    display_reset_palette();

    // Sprite section (flags bit 0): 256×3 palette bytes + 512×64 tile bytes
    if (flags & 0x01) {
        const uint32_t SPR_PAL_BYTES  = 256 * 3;
        const uint32_t SPR_TILE_BYTES = 512 * 64;
        if (p + SPR_PAL_BYTES + SPR_TILE_BYTES > end) return false;
        display_load_sprites(p, p + SPR_PAL_BYTES, 512);
        p += SPR_PAL_BYTES + SPR_TILE_BYTES;
    }

    // Bytecode
    uint32_t code_len = (uint32_t)(end - p);
    if (code_len > MAX_BYTECODE) return false;
    memcpy(vm.code, p, code_len);
    vm.code_len = (uint16_t)code_len;

    // Parse user-defined function table from bytecode at fn_table_off
    vm.user_fn_count = 0;
    if (fn_count > 0 && fn_table_off < vm.code_len) {
        uint16_t tp = fn_table_off;
        uint16_t count = fn_count < MAX_USER_FNS ? fn_count : MAX_USER_FNS;
        for (uint16_t i = 0; i < count; i++) {
            if (tp >= vm.code_len) break;
            uint8_t name_len = vm.code[tp++];
            if (tp + name_len + 3 > vm.code_len) break;  // name + params + entry (u16)
            tp += name_len;  // skip name (runtime only needs entry + param_slots)
            uint8_t nparams = vm.code[tp++];
            if (tp + 2 + nparams > vm.code_len) break;
            vm.user_fns[i].entry  = ru16(vm.code + tp); tp += 2;
            vm.user_fns[i].params = nparams;
            for (uint8_t j = 0; j < nparams && j < MAX_FN_PARAMS; j++) {
                vm.user_fns[i].param_slots[j] = vm.code[tp++];
            }
            vm.user_fn_count++;
        }
    }

    vm.shadow_active = 0;
    vm.rng           = 12345;
    vm.loaded        = true;
    return true;
}

// ─── Lifecycle hooks ─────────────────────────────────────────────────────────

static void set_param(Value *globals, uint8_t slot, int32_t val) {
    if (slot < MAX_VARS) globals[slot] = (Value){ VALUE_INT, val };
}

void vm_call_init(void) {
    if (!vm.loaded) return;
    exec(vm.off_init, vm.globals, vm.stack0);
}

void vm_call_update(int frame, uint8_t input) {
    if (!vm.loaded) return;
    set_param(vm.globals, vm.param_update_frame, frame);
    set_param(vm.globals, vm.param_update_input,  input);
    exec(vm.off_update, vm.globals, vm.stack0);
}

void vm_call_draw(int frame, uint8_t input) {
    if (!vm.loaded) return;
    set_param(vm.globals, vm.param_draw_frame, frame);
    set_param(vm.globals, vm.param_draw_input,  input);
    exec(vm.off_draw, vm.globals, vm.stack0);
}

// Called from core 1 at 8000 Hz (§5.3).
int vm_call_audio(int t) {
    if (!vm.loaded || vm.off_audio == 0xFFFF) return 128;
    uint8_t  active = vm.shadow_active;
    Value   *shadow = vm.shadow[active];
    set_param(shadow, vm.param_audio_t, t);
    Value result = exec(vm.off_audio, shadow, vm.stack1);
    int32_t s = result.i;
    return s & 0xFF;
}

// Returns true (and clears the flag) if loadcart() was called this frame.
bool vm_cart_switched(void) {
    bool v = vm.cart_switched;
    vm.cart_switched = false;
    return v;
}

// Called from core 0 after vm_call_draw() (§5.3).
void vm_sync_audio_shadow(void) {
    uint8_t inactive = vm.shadow_active ^ 1;
    memcpy(vm.shadow[inactive], vm.globals, sizeof(vm.globals));
    // DMB: ensure memcpy is visible to core 1 before the index flip
    __asm volatile ("dmb" ::: "memory");
    vm.shadow_active = inactive;
}
