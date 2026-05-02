// Bidule 01 compiler — unit tests
// Run with: deno test compiler.test.js

import { compile } from './compiler.js';

// ─── Opcode constants (mirrors compiler.js OP table) ─────────────────────────

const OP = {
  PUSH_INT: 0x00, PUSH_LIT: 0x01, LOAD: 0x02, STORE: 0x03,
  ADD: 0x10, SUB: 0x11, MUL: 0x12, DIV: 0x13, MOD: 0x14, NEG: 0x15,
  BAND: 0x20, BOR: 0x21, BXOR: 0x22, SHL: 0x23, SHR: 0x24,
  EQ: 0x30, NE: 0x31, LT: 0x32, LE: 0x33, GT: 0x34, GE: 0x35, NOT: 0x36,
  POP: 0x40, DUP: 0x41,
  JUMP: 0x50, JUMP_T: 0x51, JUMP_F: 0x52, PEEK_JUMP_T: 0x53, PEEK_JUMP_F: 0x54,
  CALL: 0x60, CALL_FN: 0x61,
  ARR_GET: 0x70, ARR_SET: 0x71, ARR_LEN: 0x72, PUSH_ARR_MUT: 0x73,
  RET: 0xFF,
};

// ─── Binary parser ────────────────────────────────────────────────────────────

function parseBinary(bin) {
  let p = 0;
  const r8  = () => bin[p++];
  const r16 = () => { const v = bin[p] | (bin[p + 1] << 8); p += 2; return v; };
  const rN  = (n) => { const s = bin.slice(p, p + n); p += n; return s; };

  const magic   = String.fromCharCode(...rN(4));
  const version = r8();
  r8(); // flags (reserved)
  const meta = new TextDecoder().decode(rN(r16()));

  // Array declaration table: [size: u16][initLen: u8][initLen bytes]
  const arrDeclCount = r8();
  const arrDecls = [];
  for (let i = 0; i < arrDeclCount; i++) {
    const size    = r16();
    const initLen = r8();
    const initData = initLen > 0 ? [...rN(initLen)] : [];
    arrDecls.push({ size, initData });
  }

  const initOff         = r16();
  const updateOff       = r16();
  const updateFrameSlot = r8();
  const updateInputSlot = r8();
  const drawOff         = r16();
  const drawFrameSlot   = r8();
  const drawInputSlot   = r8();
  const audioOff        = r16();
  const audioTSlot      = r8();
  const fnCount         = r16();
  const fnTableOff      = r16();

  const bytecode = bin.slice(p);

  // Parse function table from bytecode
  const userFns = [];
  if (fnCount > 0 && fnTableOff < bytecode.length) {
    let tp = fnTableOff;
    for (let i = 0; i < fnCount; i++) {
      if (tp >= bytecode.length) break;
      const nameLen = bytecode[tp++];
      let name = '';
      for (let j = 0; j < nameLen; j++) name += String.fromCharCode(bytecode[tp++]);
      const params  = bytecode[tp++];
      const entry   = bytecode[tp] | (bytecode[tp + 1] << 8); tp += 2;
      const paramSlots = [];
      for (let j = 0; j < params; j++) paramSlots.push(bytecode[tp++]);
      userFns.push({ name, params, entry, paramSlots });
    }
  }

  return {
    magic, version, meta, arrDecls,
    entryPoints: { init: initOff, update: updateOff, draw: drawOff, audio: audioOff },
    paramSlots: {
      updateFrame: updateFrameSlot, updateInput: updateInputSlot,
      drawFrame: drawFrameSlot, drawInput: drawInputSlot,
      audioT: audioTSlot,
    },
    fnCount, fnTableOff, userFns,
    bytecode,
  };
}

// ─── Bytecode disassembler ────────────────────────────────────────────────────

function disassemble(bytes) {
  const instrs = [];
  let ip = 0;
  while (ip < bytes.length) {
    const op = bytes[ip++];
    let operands = [];
    switch (op) {
      case OP.PUSH_INT:
        operands = [(bytes[ip] | (bytes[ip+1]<<8) | (bytes[ip+2]<<16) | (bytes[ip+3]<<24)) | 0];
        ip += 4;
        break;
      case OP.PUSH_LIT: {
        // [len][len bytes of char data]
        const len = bytes[ip++];
        const data = [...bytes.slice(ip, ip + len)];
        operands = [len, ...data];
        ip += len;
        break;
      }
      case OP.LOAD: case OP.STORE:
      case OP.ARR_GET:  case OP.ARR_SET: case OP.ARR_LEN: case OP.PUSH_ARR_MUT:
        operands = [bytes[ip++]];
        break;
      case OP.JUMP: case OP.JUMP_T:      case OP.JUMP_F:
      case OP.PEEK_JUMP_T: case OP.PEEK_JUMP_F:
        operands = [((bytes[ip] | (bytes[ip + 1] << 8)) << 16) >> 16];
        ip += 2;
        break;
      case OP.CALL:
        operands = [bytes[ip++], bytes[ip++]];
        break;
      case OP.CALL_FN: {
        const lo = bytes[ip++], hi = bytes[ip++];
        operands = [lo | (hi << 8), bytes[ip++]];
        break;
      }
      default: break;
    }
    instrs.push({ op, operands });
    if (op === OP.RET) break;
  }
  return instrs;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

const compilesOk = (src) => compile(src).errors.length === 0;
const errorsOf   = (src) => compile(src).errors;
const warningsOf = (src) => compile(src).warnings;

function getBinary(src) {
  const { binary, errors } = compile(src);
  if (errors.length) throw new Error(errors.join('; '));
  return parseBinary(binary);
}

function opsOf(src, fn = 'draw') {
  const b   = getBinary(src);
  const off = b.entryPoints[fn];
  if (off === 0xFFFF) throw new Error(`'${fn}' not defined in binary`);
  return disassemble(b.bytecode.slice(off));
}

const hasOp = (src, opcode, fn = 'draw') => opsOf(src, fn).some(i => i.op === opcode);
const wrap  = (body) => `draw(f) { ${body} }`;

function eq(a, b, msg) {
  if (a !== b) throw new Error(msg ?? `expected ${JSON.stringify(a)}, got ${JSON.stringify(b)}`);
}
function ok(v, msg) {
  if (!v) throw new Error(msg ?? `expected truthy, got ${JSON.stringify(v)}`);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

Deno.test('Compilation basics', async (t) => {
  await t.step('empty program compiles without errors', () => {
    ok(compilesOk(''));
  });

  await t.step('missing @id produces a warning containing "id"', () => {
    ok(warningsOf('draw(f){}').some(m => m.includes('id')));
  });

  await t.step('unknown top-level token is a compile error', () => {
    ok(errorsOf('42').length > 0);
  });

  await t.step('minimal valid program compiles clean', () => {
    ok(compilesOk('// @id test\ndraw(f) { x = 1 }'));
  });
});

Deno.test('Binary structure', async (t) => {
  await t.step('magic bytes are BDBN', () => {
    eq(getBinary('').magic, 'BDBN');
  });

  await t.step('format version is 2', () => {
    eq(getBinary('').version, 2);
  });

  await t.step('undefined lifecycle function has offset 0xFFFF', () => {
    eq(getBinary('').entryPoints.draw, 0xFFFF);
  });

  await t.step('defined lifecycle function has offset != 0xFFFF', () => {
    ok(getBinary('draw(f){}').entryPoints.draw !== 0xFFFF);
  });

  await t.step('array declaration size appears in arrDecls', () => {
    const b = getBinary('buf[8]\ndraw(f){}');
    eq(b.arrDecls.length, 1);
    eq(b.arrDecls[0].size, 8);
  });

  await t.step('zero-init array has initData []', () => {
    const b = getBinary('buf[8]\ndraw(f){}');
    eq(b.arrDecls[0].initData.length, 0);
  });

  await t.step('string-init declaration has initData with char codes', () => {
    const b = getBinary('greeting = "hi"\ndraw(f){}');
    eq(b.arrDecls.length, 1);
    const d = b.arrDecls[0];
    eq(d.size, 3);          // 'h','i',0
    eq(d.initData[0], 104); // 'h'
    eq(d.initData[1], 105); // 'i'
    eq(d.initData[2], 0);   // null
  });
});

Deno.test('Scalar variables', async (t) => {
  await t.step('assignment emits STORE', () => {
    ok(hasOp(wrap('x = 1'), OP.STORE));
  });

  await t.step('variable read emits LOAD', () => {
    ok(hasOp(wrap('y = x + 1'), OP.LOAD));
  });

  await t.step('compound += emits LOAD then ADD then STORE', () => {
    const instrs = opsOf(wrap('x += 3'));
    ok(instrs.some(i => i.op === OP.LOAD));
    ok(instrs.some(i => i.op === OP.ADD));
    ok(instrs.some(i => i.op === OP.STORE));
  });

  await t.step('compound %= emits MOD', () => {
    ok(hasOp(wrap('x %= 3'), OP.MOD));
  });

  await t.step('64 variables compile without error', () => {
    const body = Array.from({ length: 64 }, (_, i) => `v${i} = 0`).join('\n');
    ok(compilesOk(`draw() { ${body} }`));  // no param so all 64 slots are available
  });

  await t.step('65th variable is a compile error', () => {
    const body = Array.from({ length: 65 }, (_, i) => `v${i} = 0`).join('\n');
    ok(errorsOf(`draw() { ${body} }`).length > 0);
  });
});

Deno.test('Arrays', async (t) => {
  await t.step('declaration size is recorded in arrDecls', () => {
    const b = getBinary('nums[16]\ndraw(f){}');
    eq(b.arrDecls[0].size, 16);
  });

  await t.step('element read emits ARR_GET', () => {
    ok(hasOp('arr[4]\ndraw(f){ x = arr[0] }', OP.ARR_GET));
  });

  await t.step('element write emits ARR_SET', () => {
    ok(hasOp('arr[4]\ndraw(f){ arr[0] = 1 }', OP.ARR_SET));
  });

  await t.step('compound element assignment emits DUP + ARR_GET + op + ARR_SET', () => {
    const instrs = opsOf('arr[4]\ndraw(f){ arr[0] += 1 }');
    ok(instrs.some(i => i.op === OP.DUP));
    ok(instrs.some(i => i.op === OP.ARR_GET));
    ok(instrs.some(i => i.op === OP.ADD));
    ok(instrs.some(i => i.op === OP.ARR_SET));
  });

  await t.step('.length emits ARR_LEN', () => {
    ok(hasOp('arr[4]\ndraw(f){ x = arr.length }', OP.ARR_LEN));
  });

  await t.step('bare array name in expression emits PUSH_ARR_MUT', () => {
    ok(hasOp('arr[4]\ndraw(f){ print(arr, 0, 0, 1) }', OP.PUSH_ARR_MUT));
  });

  await t.step('element access on undeclared array is a compile error', () => {
    ok(errorsOf('draw(f){ x = ghost[0] }').length > 0);
  });

  await t.step('17th array declaration is a compile error', () => {
    const decls = Array.from({ length: 17 }, (_, i) => `a${i}[4]`).join('\n');
    ok(errorsOf(`${decls}\ndraw(f){}`).length > 0);
  });

  await t.step('string-init declaration counts toward the 16-array limit', () => {
    const decls = Array.from({ length: 16 }, (_, i) => `a${i}[4]`).join('\n');
    ok(errorsOf(`${decls}\ngreeting = "hi"\ndraw(f){}`).length > 0);
  });
});

Deno.test('String literals', async (t) => {
  await t.step('string literal in expression emits PUSH_LIT', () => {
    ok(hasOp('draw(f){ print("hi", 0, 0, 1) }', OP.PUSH_LIT));
  });

  await t.step('PUSH_LIT contains correct char codes for "hi"', () => {
    const instrs = opsOf('draw(f){ print("hi", 0, 0, 1) }');
    const lit = instrs.find(i => i.op === OP.PUSH_LIT);
    ok(lit, 'PUSH_LIT not found');
    // operands: [len, char0, char1, ..., 0]
    eq(lit.operands[0], 3);   // len = 3 ('h','i',NUL)
    eq(lit.operands[1], 104); // 'h'
    eq(lit.operands[2], 105); // 'i'
    eq(lit.operands[3], 0);   // null terminator
  });

  await t.step('empty string "" emits PUSH_LIT with len=1 and data=[0]', () => {
    const instrs = opsOf('draw(f){ print("", 0, 0, 1) }');
    const lit = instrs.find(i => i.op === OP.PUSH_LIT);
    ok(lit, 'PUSH_LIT not found');
    eq(lit.operands[0], 1);
    eq(lit.operands[1], 0);
  });

  await t.step('duplicate string literals each emit their own PUSH_LIT (no dedup)', () => {
    const instrs = opsOf('draw(f){ print("ab", 0, 0, 1)\nprint("ab", 0, 10, 1) }');
    eq(instrs.filter(i => i.op === OP.PUSH_LIT).length, 2);
  });

  await t.step('top-level string declaration allocates a pool array with init data', () => {
    const b = getBinary('msg = "hi"\ndraw(f){}');
    eq(b.arrDecls.length, 1);
    eq(b.arrDecls[0].size, 3);
    eq(b.arrDecls[0].initData[0], 104);
    eq(b.arrDecls[0].initData[1], 105);
    eq(b.arrDecls[0].initData[2], 0);
  });

  await t.step('top-level string declaration emits no PUSH_LIT or STORE in bytecode', () => {
    const b = getBinary('msg = "hi"\ndraw(f){}');
    // No PUSH_LIT should appear (init is done at load time, not in bytecode)
    for (const off of [b.entryPoints.init, b.entryPoints.draw]) {
      if (off === 0xFFFF) continue;
      const instrs = disassemble(b.bytecode.slice(off));
      ok(!instrs.some(i => i.op === OP.PUSH_LIT), 'unexpected PUSH_LIT in init/draw');
    }
  });

  await t.step('bare string-init variable in expression emits PUSH_ARR_MUT', () => {
    ok(hasOp('msg = "hi"\ndraw(f){ print(msg, 0, 0, 1) }', OP.PUSH_ARR_MUT));
  });
});

Deno.test('Char literals', async (t) => {
  await t.step("'A' compiles to PUSH_INT 65", () => {
    const pi = opsOf(wrap("x = 'A'")).find(i => i.op === OP.PUSH_INT);
    eq(pi?.operands[0], 65);
  });

  await t.step("'0' compiles to PUSH_INT 48", () => {
    ok(opsOf(wrap("x = '0'")).some(i => i.op === OP.PUSH_INT && i.operands[0] === 48));
  });

  await t.step("'\\\\' (backslash escape) compiles to PUSH_INT 92", () => {
    ok(opsOf(wrap("x = '\\\\'")).some(i => i.op === OP.PUSH_INT && i.operands[0] === 92));
  });

  await t.step("'\\'' (single-quote escape) compiles to PUSH_INT 39", () => {
    ok(opsOf(wrap("x = '\\''")).some(i => i.op === OP.PUSH_INT && i.operands[0] === 39));
  });
});

Deno.test('Control flow', async (t) => {
  await t.step('if emits JUMP_F', () => {
    ok(hasOp(wrap('if (x) { y = 1 }'), OP.JUMP_F));
  });

  await t.step('if/else emits both JUMP_F and JUMP', () => {
    const instrs = opsOf(wrap('if (x) { y = 1 } else { y = 2 }'));
    ok(instrs.some(i => i.op === OP.JUMP_F));
    ok(instrs.some(i => i.op === OP.JUMP));
  });

  await t.step('while emits JUMP_F (exit) and JUMP (back-edge)', () => {
    const instrs = opsOf(wrap('while (x) { x -= 1 }'));
    ok(instrs.some(i => i.op === OP.JUMP_F));
    ok(instrs.some(i => i.op === OP.JUMP));
  });

  await t.step('for loop compiles without error', () => {
    ok(compilesOk(wrap('for (i = 0; i < 10; i++) { x = i }')));
  });

  await t.step('break outside loop is a compile error', () => {
    ok(errorsOf(wrap('break')).length > 0);
  });

  await t.step('continue outside loop is a compile error', () => {
    ok(errorsOf(wrap('continue')).length > 0);
  });

  await t.step('break inside while emits an unconditional JUMP', () => {
    ok(hasOp(wrap('while (1) { break }'), OP.JUMP));
  });
});

Deno.test('Expressions', async (t) => {
  await t.step('arithmetic operators emit correct opcodes', () => {
    ok(hasOp(wrap('x = 1 + 2'), OP.ADD));
    ok(hasOp(wrap('x = 1 - 2'), OP.SUB));
    ok(hasOp(wrap('x = 1 * 2'), OP.MUL));
    ok(hasOp(wrap('x = 1 / 2'), OP.DIV));
    ok(hasOp(wrap('x = 1 % 2'), OP.MOD));
  });

  await t.step('unary minus emits NEG', () => {
    ok(hasOp(wrap('x = -y'), OP.NEG));
  });

  await t.step('bitwise operators emit correct opcodes', () => {
    ok(hasOp(wrap('x = a & b'),  OP.BAND));
    ok(hasOp(wrap('x = a | b'),  OP.BOR));
    ok(hasOp(wrap('x = a ^ b'),  OP.BXOR));
    ok(hasOp(wrap('x = a << 1'), OP.SHL));
    ok(hasOp(wrap('x = a >> 1'), OP.SHR));
  });

  await t.step('comparison operators emit correct opcodes', () => {
    ok(hasOp(wrap('x = a == b'), OP.EQ));
    ok(hasOp(wrap('x = a != b'), OP.NE));
    ok(hasOp(wrap('x = a < b'),  OP.LT));
    ok(hasOp(wrap('x = a <= b'), OP.LE));
    ok(hasOp(wrap('x = a > b'),  OP.GT));
    ok(hasOp(wrap('x = a >= b'), OP.GE));
  });

  await t.step('&& emits PEEK_JUMP_F for short-circuit evaluation', () => {
    ok(hasOp(wrap('if (a && b) { x = 1 }'), OP.PEEK_JUMP_F));
  });

  await t.step('|| emits PEEK_JUMP_T for short-circuit evaluation', () => {
    ok(hasOp(wrap('if (a || b) { x = 1 }'), OP.PEEK_JUMP_T));
  });

  await t.step('&& and || normalise result with NOT NOT', () => {
    ok(hasOp(wrap('x = a && b'), OP.NOT));
    ok(hasOp(wrap('x = a || b'), OP.NOT));
  });
});

Deno.test('Builtins', async (t) => {
  await t.step('known builtin emits CALL', () => {
    ok(hasOp(wrap('cls(0)'), OP.CALL));
  });

  await t.step('print emits CALL with builtin id 6', () => {
    const call = opsOf(wrap('print("x", 0, 0, 1)')).find(i => i.op === OP.CALL);
    eq(call?.operands[0], 6);
    eq(call?.operands[1], 4); // 4 args
  });

  await t.step('streq with two literal args compiles without error', () => {
    ok(compilesOk('buf[4]\ndraw(f){ x = streq(buf, "hi") }'));
  });

  await t.step('streq emits CALL with id 13 and argc 2', () => {
    const call = opsOf('buf[4]\ndraw(f){ x = streq(buf, "hi") }')
      .find(i => i.op === OP.CALL && i.operands[0] === 13);
    ok(call, 'CALL 13 not found');
    eq(call.operands[1], 2);
  });

  await t.step('arreq emits CALL with id 14 and argc 3', () => {
    const call = opsOf('a[4]\nb[4]\ndraw(f){ x = arreq(a, b, 4) }')
      .find(i => i.op === OP.CALL && i.operands[0] === 14);
    ok(call, 'CALL 14 not found');
    eq(call.operands[1], 3);
  });

  await t.step('cartmeta with mutable arr as 3rd arg compiles clean', () => {
    ok(compilesOk('buf[32]\ndraw(f){ cartmeta(0, "id", buf) }'));
  });

  await t.step('cartmeta with string literal as 3rd arg is a compile error', () => {
    ok(errorsOf('draw(f){ cartmeta(0, "id", "oops") }').length > 0);
  });

  await t.step('cartmeta with string literal as 2nd arg (field) compiles clean', () => {
    ok(compilesOk('buf[32]\ndraw(f){ cartmeta(0, "title", buf) }'));
  });

  await t.step('cartmeta with 2 args is a compile error', () => {
    ok(errorsOf('draw(f){ cartmeta(0, "id") }').length > 0);
  });

  await t.step('unknown function is a compile error', () => {
    ok(errorsOf(wrap('foo(1)')).length > 0);
  });

  await t.step('wrong argument count is a compile error', () => {
    ok(errorsOf(wrap('cls(0, 1)')).length > 0);
  });

  await t.step('audio-restricted builtin inside audio() is a compile error', () => {
    ok(errorsOf('audio(t){ cls(0) }').length > 0);
  });

  await t.step('audio-safe builtin inside audio() is allowed', () => {
    ok(compilesOk('audio(t){ abs(t) }'));
  });
});

Deno.test('Writable parameter checks', async (t) => {
  await t.step('user fn with no array writes accepts temp literal', () => {
    ok(compilesOk('fn show(s[]) { x = s[0] }\ndraw(f){ show("hi") }'));
  });

  await t.step('user fn that writes to arr param rejects temp literal', () => {
    ok(errorsOf('fn fill(s[]) { s[0] = 1 }\ndraw(f){ fill("hi") }').length > 0);
  });

  await t.step('user fn with write param accepts mutable pool array', () => {
    ok(compilesOk('buf[4]\nfn fill(s[]) { s[0] = 1 }\ndraw(f){ fill(buf) }'));
  });

  await t.step('user fn with compound-assign element rejects temp literal', () => {
    ok(errorsOf('fn inc(a[]) { a[0] += 1 }\ndraw(f){ inc("x") }').length > 0);
  });
});

Deno.test('Lifecycle functions', async (t) => {
  await t.step('all four lifecycle functions get valid bytecode offsets', () => {
    const b = getBinary('init(){} update(f,i){} draw(f,i){} audio(t){}');
    ok(b.entryPoints.init   !== 0xFFFF);
    ok(b.entryPoints.update !== 0xFFFF);
    ok(b.entryPoints.draw   !== 0xFFFF);
    ok(b.entryPoints.audio  !== 0xFFFF);
  });

  await t.step('update frame and input get distinct, bound parameter slots', () => {
    const s = getBinary('update(frame, input){}').paramSlots;
    ok(s.updateFrame !== 0xFF);
    ok(s.updateInput !== 0xFF);
    ok(s.updateFrame !== s.updateInput);
  });

  await t.step('draw frame and input get distinct, bound parameter slots', () => {
    const s = getBinary('draw(frame, input){}').paramSlots;
    ok(s.drawFrame !== 0xFF);
    ok(s.drawInput !== 0xFF);
    ok(s.drawFrame !== s.drawInput);
  });

  await t.step('audio t parameter slot is bound', () => {
    ok(getBinary('audio(t){}').paramSlots.audioT !== 0xFF);
  });

  await t.step('duplicate lifecycle function definition is a compile error', () => {
    ok(errorsOf('draw(f){} draw(f){}').length > 0);
  });

  await t.step('variable assignment inside audio() is a compile error', () => {
    ok(errorsOf('audio(t){ x = 1 }').length > 0);
  });
});

Deno.test('User-defined functions', async (t) => {
  await t.step('no user functions: fnCount is 0', () => {
    eq(getBinary('draw(f){}').fnCount, 0);
  });

  await t.step('one user function: fnCount is 1', () => {
    eq(getBinary('fn add(a, b) { return a + b }\ndraw(f){}').fnCount, 1);
  });

  await t.step('user function appears in userFns table with correct name', () => {
    const b = getBinary('fn add(a, b) { return a + b }\ndraw(f){}');
    eq(b.userFns.length, 1);
    eq(b.userFns[0].name, 'add');
  });

  await t.step('user function param count is recorded in function table', () => {
    const b = getBinary('fn add(a, b) { return a + b }\ndraw(f){}');
    eq(b.userFns[0].params, 2);
  });

  await t.step('user function with no params has param count 0', () => {
    const b = getBinary('fn noop() { x = 1 }\ndraw(f){}');
    eq(b.userFns[0].params, 0);
  });

  await t.step('calling a user function as statement emits CALL_FN + POP', () => {
    const instrs = opsOf('fn noop() { x = 1 }\ndraw(f){ noop() }');
    ok(instrs.some(i => i.op === OP.CALL_FN));
    ok(instrs.some(i => i.op === OP.POP));
  });

  await t.step('calling a user function in expression emits CALL_FN without POP before STORE', () => {
    const instrs = opsOf('fn inc(n) { return n + 1 }\ndraw(f){ x = inc(3) }');
    ok(instrs.some(i => i.op === OP.CALL_FN));
    const callIdx = instrs.findIndex(i => i.op === OP.CALL_FN);
    ok(instrs[callIdx + 1]?.op !== OP.POP);
  });

  await t.step('CALL_FN carries correct fn index (0 for first user function)', () => {
    const instrs = opsOf('fn first() { x = 1 }\ndraw(f){ first() }');
    const call = instrs.find(i => i.op === OP.CALL_FN);
    eq(call?.operands[0], 0);
  });

  await t.step('second user function gets fn index 1', () => {
    const instrs = opsOf('fn a() { x = 1 }\nfn b() { x = 2 }\ndraw(f){ b() }');
    const call = instrs.find(i => i.op === OP.CALL_FN);
    eq(call?.operands[0], 1);
  });

  await t.step('user function body contains RET', () => {
    const b   = getBinary('fn inc(n) { return n + 1 }\ndraw(f){}');
    const fn  = b.userFns[0];
    const body = disassemble(b.bytecode.slice(fn.entry));
    ok(body.some(i => i.op === OP.RET));
  });

  await t.step('return in user function emits value then RET', () => {
    const b    = getBinary('fn double(n) { return n * 2 }\ndraw(f){}');
    const fn   = b.userFns[0];
    const body = disassemble(b.bytecode.slice(fn.entry));
    ok(body.some(i => i.op === OP.MUL));
    ok(body.some(i => i.op === OP.RET));
  });

  await t.step('forward reference: lifecycle function calls user fn defined after it', () => {
    ok(compilesOk('draw(f){ noop() }\nfn noop() { x = 1 }'));
  });

  await t.step('wrong argument count for user function is a compile error', () => {
    ok(errorsOf('fn add(a, b) { return a + b }\ndraw(f){ add(1) }').length > 0);
  });

  await t.step('calling undefined function is still a compile error', () => {
    ok(errorsOf('draw(f){ ghost() }').length > 0);
  });

  await t.step('redefining a builtin name is a compile error', () => {
    ok(errorsOf('fn cls(c) { x = c }\ndraw(f){}').length > 0);
  });

  await t.step('duplicate user function definition is a compile error', () => {
    ok(errorsOf('fn foo() { x = 1 }\nfn foo() { x = 2 }\ndraw(f){}').length > 0);
  });

  await t.step('return outside function or audio is a compile error', () => {
    ok(errorsOf('draw(f){ return 1 }').length > 0);
  });

  await t.step('user function param slots are bound (non-0xFF) in function table', () => {
    const b = getBinary('fn add(a, b) { return a + b }\ndraw(f){}');
    const fn = b.userFns[0];
    eq(fn.paramSlots.length, 2);
    ok(fn.paramSlots[0] !== 0xFF);
    ok(fn.paramSlots[1] !== 0xFF);
    ok(fn.paramSlots[0] !== fn.paramSlots[1]);
  });

  await t.step('assignments inside user function body are allowed', () => {
    ok(compilesOk('fn set(v) { x = v }\ndraw(f){}'));
  });

  await t.step('fn keyword without a name is a compile error', () => {
    ok(errorsOf('fn() {}\ndraw(f){}').length > 0);
  });

  await t.step('using fn keyword with a lifecycle name is a compile error', () => {
    ok(errorsOf('fn draw(f) {}\ndraw(f){}').length > 0);
  });
});
