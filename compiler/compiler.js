// Bidule 01 compiler — .bdcart source → .bdb binary
// Usage (browser / bundler): import { compile } from './compiler.js'
// Usage (Node.js):           const { compile } = await import('./compiler.js')

// ─── Opcode table (mirrors firmware/runtime/vm.h) ────────────────────────────

const OP = {
  PUSH_INT:     0x00,
  PUSH_ARR:     0x01,   // [u8]  push literal array ref by table index
  LOAD:         0x02,   // [u8]  push global variable by slot
  STORE:        0x03,   // [u8]  pop → global variable slot
  ADD:          0x10,  SUB:          0x11,  MUL:  0x12,
  DIV:          0x13,  MOD:          0x14,  NEG:  0x15,
  BAND:         0x20,  BOR:          0x21,  BXOR: 0x22,
  SHL:          0x23,  SHR:          0x24,
  EQ:           0x30,  NE:           0x31,  LT:   0x32,
  LE:           0x33,  GT:           0x34,  GE:   0x35,
  NOT:          0x36,
  POP:          0x40,
  DUP:          0x41,   // duplicate top of stack
  JUMP:         0x50,  JUMP_T:       0x51,  JUMP_F:       0x52,
  PEEK_JUMP_T:  0x53,  PEEK_JUMP_F:  0x54,
  CALL:         0x60,
  ARR_GET:      0x70,   // [u8 slot]  pop index; push arr[slot][index]   (0 if OOB)
  ARR_SET:      0x71,   // [u8 slot]  pop value (top), pop index; write  (no-op if OOB)
  ARR_LEN:      0x72,   // [u8 slot]  push declared length of arr[slot]
  PUSH_ARR_MUT: 0x73,   // [u8 slot]  push mutable array reference
  RET:          0xFF,
};

// ─── Built-in table ───────────────────────────────────────────────────────────
// argc: expected argument count
// returns: whether the built-in pushes a return value onto the stack
// audioOk: whether it may be called inside audio(t)  (§5.3)

const BUILTINS = {
  btn:       { id:  0, argc: 1, returns: true,  audioOk: false },
  btnp:      { id:  1, argc: 1, returns: true,  audioOk: false },
  cls:       { id:  2, argc: 1, returns: false, audioOk: false },
  pset:      { id:  3, argc: 3, returns: false, audioOk: false },
  rectfill:  { id:  4, argc: 5, returns: false, audioOk: false },
  line:      { id:  5, argc: 5, returns: false, audioOk: false },
  print:     { id:  6, argc: 4, returns: false, audioOk: false },
  abs:       { id:  7, argc: 1, returns: true,  audioOk: true  },
  min:       { id:  8, argc: 2, returns: true,  audioOk: true  },
  max:       { id:  9, argc: 2, returns: true,  audioOk: true  },
  clamp:     { id: 10, argc: 3, returns: true,  audioOk: true  },
  seed:      { id: 11, argc: 1, returns: false, audioOk: false },
  rnd:       { id: 12, argc: 1, returns: true,  audioOk: true  },
  streq:     { id: 13, argc: 2, returns: true,  audioOk: false },
  arreq:     { id: 14, argc: 3, returns: true,  audioOk: false },
  save:      { id: 15, argc: 2, returns: false, audioOk: false },
  load:      { id: 16, argc: 1, returns: true,  audioOk: false },
  cartcount: { id: 17, argc: 0, returns: true,  audioOk: false },
  cartmeta:  { id: 18, argc: 3, returns: true,  audioOk: false },
  loadcart:  { id: 19, argc: 1, returns: true,  audioOk: false },
};

// Lifecycle function names and their canonical parameter names
const LIFECYCLE = { init: [], update: ['frame', 'input'], draw: ['frame', 'input'], audio: ['t'] };

// ─── Lexer ────────────────────────────────────────────────────────────────────

function lex(src) {
  const tokens = [];
  let i = 0, line = 1;
  const n = src.length;

  while (i < n) {
    const ch = src[i];

    if (ch === '\n') { line++; i++; continue; }
    if (ch === '\r' || ch === ' ' || ch === '\t') { i++; continue; }

    // Comments — and metadata lines (// @key value)
    if (ch === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < n && src[i] === ' ') i++;      // skip leading spaces
      if (src[i] === '@') {
        i++;                                       // skip '@'
        let key = '';
        while (i < n && src[i] >= 'a' && src[i] <= 'z') key += src[i++];
        while (i < n && src[i] === ' ') i++;      // skip spaces before value
        let val = '';
        while (i < n && src[i] !== '\n') val += src[i++];
        tokens.push({ type: 'META', key, value: val.trim(), line });
      } else {
        while (i < n && src[i] !== '\n') i++;
      }
      continue;
    }

    // Integer literals
    if (ch >= '0' && ch <= '9') {
      let s = '';
      while (i < n && src[i] >= '0' && src[i] <= '9') s += src[i++];
      tokens.push({ type: 'NUM', value: parseInt(s, 10), line });
      continue;
    }

    // String literals — compile-time arrays of char codes
    if (ch === '"') {
      i++;
      let s = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') {
          i++;
          if      (src[i] === '"')  s += '"';
          else if (src[i] === '\\') s += '\\';
          else                      s += src[i];
          i++;
        } else {
          if (src[i] === '\n') line++;
          s += src[i++];
        }
      }
      if (i < n) i++;  // closing "
      tokens.push({ type: 'STR', value: s, line });
      continue;
    }

    // Char literals 'x' — compile-time integer (ASCII code)
    if (ch === "'") {
      i++;
      let code = 0;
      if (src[i] === '\\') {
        i++;
        if      (src[i] === '\\') code = 92;
        else if (src[i] === "'")  code = 39;
        else                      code = src.charCodeAt(i);
        i++;
      } else {
        code = src.charCodeAt(i);
        i++;
      }
      if (src[i] === "'") i++;  // closing '
      tokens.push({ type: 'NUM', value: code, line });
      continue;
    }

    // Identifiers and keywords
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let s = '';
      while (i < n && (src[i] === '_' || (src[i] >= 'a' && src[i] <= 'z') ||
                        (src[i] >= 'A' && src[i] <= 'Z') || (src[i] >= '0' && src[i] <= '9'))) {
        s += src[i++];
      }
      const KWS = new Set(['if', 'else', 'while', 'for', 'break', 'continue', 'return']);
      tokens.push({ type: KWS.has(s) ? 'KW' : 'IDENT', value: s, line });
      continue;
    }

    // Two-character operators (must be checked before single-char)
    const two = src.slice(i, i + 2);
    if (['+=', '-=', '*=', '/=', '%=', '==', '!=', '>=', '<=', '&&', '||', '>>', '<<', '++', '--'].includes(two)) {
      tokens.push({ type: 'OP', value: two, line });
      i += 2;
      continue;
    }

    // Single-character operators and punctuation
    tokens.push({ type: 'OP', value: ch, line });
    i++;
  }

  tokens.push({ type: 'EOF', value: 'EOF', line });
  return tokens;
}

// ─── Bytecode emitter ─────────────────────────────────────────────────────────

class Emitter {
  constructor() { this.bytes = []; }

  emit(...bs)  { for (const b of bs) this.bytes.push(b & 0xFF); }

  emitI32(n) {
    const v = n | 0;
    this.bytes.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF);
  }

  emitJump(op) {
    this.bytes.push(op, 0x00, 0x00);
    return this.bytes.length - 2;
  }

  patch(patchPos) { this.patchTo(patchPos, this.bytes.length); }

  patchTo(patchPos, target) {
    const offset = target - (patchPos + 2);
    this.bytes[patchPos]     =  offset        & 0xFF;
    this.bytes[patchPos + 1] = (offset >> 8)  & 0xFF;
  }

  get length() { return this.bytes.length; }
}

// ─── Compile context (shared across all functions) ────────────────────────────

class Ctx {
  constructor() {
    this.vars        = new Map();  // name → slot (0–63), integer variables only
    this.arrLiterals = [];         // unique string literals (deduped), max 32
    this.arrayDecls  = [];         // [{name, size}] in declaration order, max 16
    this.errors      = [];
    this.warnings    = [];
  }

  varSlot(name, line) {
    if (this.arrayDecls.some(d => d.name === name)) {
      this.errors.push(`line ${line}: '${name}' is an array; use '${name}[i]' for element access`);
      return 0;
    }
    if (!this.vars.has(name)) {
      if (this.vars.size >= 64) {
        this.errors.push(`line ${line}: variable limit reached (max 64)`);
        return 0;
      }
      this.vars.set(name, this.vars.size);
    }
    return this.vars.get(name);
  }

  arrLitIndex(s, line) {
    let idx = this.arrLiterals.indexOf(s);
    if (idx === -1) {
      if (this.arrLiterals.length >= 32) {
        this.errors.push(`line ${line}: array literal limit reached (max 32)`);
        return 0;
      }
      this.arrLiterals.push(s);
      idx = this.arrLiterals.length - 1;
    }
    return idx;
  }

  declareArray(name, size, line) {
    if (this.vars.has(name) || this.arrayDecls.some(d => d.name === name)) {
      this.errors.push(`line ${line}: '${name}' already declared`);
      return;
    }
    if (this.arrayDecls.length >= 16) {
      this.errors.push(`line ${line}: array declaration limit reached (max 16)`);
      return;
    }
    if (size < 1) {
      this.errors.push(`line ${line}: array size must be at least 1`);
      return;
    }
    this.arrayDecls.push({ name, size });
  }

  arrayIndex(name) {
    return this.arrayDecls.findIndex(d => d.name === name);
  }

  error(msg)   { this.errors.push(msg); }
  warning(msg) { this.warnings.push(msg); }
}

// ─── Parser / code generator ──────────────────────────────────────────────────

class Parser {
  constructor(tokens, ctx, emitter, inAudio) {
    this.tok      = tokens;
    this.pos      = 0;
    this.ctx      = ctx;
    this.e        = emitter;
    this.inAudio  = inAudio;
    this.breakPatchLists    = [];
    this.continuePatchLists = [];
  }

  peek()         { return this.tok[this.pos] || { type: 'EOF', value: 'EOF', line: 0 }; }
  advance()      { return this.tok[this.pos++]; }
  checkOp(v)     { const t = this.peek(); return t.type === 'OP'   && t.value === v; }
  checkKw(v)     { const t = this.peek(); return t.type === 'KW'   && t.value === v; }
  checkIdent()   { return this.peek().type === 'IDENT'; }
  eatOp(v)       { return this._eat('OP',    v); }
  eatKw(v)       { return this._eat('KW',    v); }
  eatIdent()     { return this._eat('IDENT', undefined); }

  _eat(type, val) {
    const t = this.peek();
    if (t.type !== type || (val !== undefined && t.value !== val)) {
      const exp = val !== undefined ? `'${val}'` : type;
      this.ctx.error(`line ${t.line}: expected ${exp}, got '${t.value}'`);
      return { type, value: val ?? '', line: t.line };
    }
    return this.advance();
  }

  parseBody() {
    if (this.checkOp('{')) {
      this.advance();
      while (!this.checkOp('}') && this.peek().type !== 'EOF') this.parseStatement();
      this.eatOp('}');
    } else {
      this.parseStatement();
    }
  }

  // ── Statements ───────────────────────────────────────────────────────────────

  parseStatement() {
    const t = this.peek();

    if (t.type === 'KW') {
      switch (t.value) {
        case 'if':       return this.parseIf();
        case 'while':    return this.parseWhile();
        case 'for':      return this.parseFor();
        case 'break':    return this.parseBreak();
        case 'continue': return this.parseContinue();
        case 'return':   return this.parseReturn();
        default:
          this.ctx.error(`line ${t.line}: unexpected keyword '${t.value}'`);
          this.advance();
      }
      return;
    }

    if (t.type === 'IDENT') {
      const next = this.tok[this.pos + 1] || {};
      const isArrayAssign = next.type === 'OP' && next.value === '[';
      const isAssign      = next.type === 'OP' && ['=', '+=', '-=', '*=', '/=', '%='].includes(next.value);
      const isIncr        = next.type === 'OP' && ['++', '--'].includes(next.value);
      const isCall        = next.type === 'OP' && next.value === '(';
      if (isArrayAssign) return this.parseArrayAssign();
      if (isAssign)      return this.parseAssignment();
      if (isIncr)        return this.parsePostfixIncr();
      if (isCall)        return this.parseCallStmt();
      this.ctx.error(`line ${t.line}: expected assignment or function call`);
      this.advance();
      return;
    }

    if (t.type === 'OP' && ['++', '--'].includes(t.value))
      return this.parsePrefixIncr();

    this.ctx.error(`line ${t.line}: unexpected token '${t.value}'`);
    this.advance();
  }

  parsePostfixIncr() {
    const ident = this.eatIdent();
    if (this.inAudio)
      this.ctx.error(`line ${ident.line}: assignments are not allowed inside audio()`);
    const op   = this.advance();  // ++ or --
    const slot = this.ctx.varSlot(ident.value, ident.line);
    this.e.emit(OP.LOAD, slot);
    this.e.emit(OP.PUSH_INT); this.e.emitI32(1);
    this.e.emit(op.value === '++' ? OP.ADD : OP.SUB);
    this.e.emit(OP.STORE, slot);
  }

  parsePrefixIncr() {
    const op    = this.advance();  // ++ or --
    const ident = this.eatIdent();
    if (this.inAudio)
      this.ctx.error(`line ${ident.line}: assignments are not allowed inside audio()`);
    const slot = this.ctx.varSlot(ident.value, ident.line);
    this.e.emit(OP.LOAD, slot);
    this.e.emit(OP.PUSH_INT); this.e.emitI32(1);
    this.e.emit(op.value === '++' ? OP.ADD : OP.SUB);
    this.e.emit(OP.STORE, slot);
  }

  parseAssignment() {
    const ident = this.eatIdent();
    if (this.inAudio)
      this.ctx.error(`line ${ident.line}: assignments are not allowed inside audio()`);

    const op   = this.advance();   // =  +=  -=  *=  /=
    const slot = this.ctx.varSlot(ident.value, ident.line);

    if (op.value === '=') {
      this.parseExpr();
    } else {
      this.e.emit(OP.LOAD, slot);
      this.parseExpr();
      switch (op.value) {
        case '+=': this.e.emit(OP.ADD); break;
        case '-=': this.e.emit(OP.SUB); break;
        case '*=': this.e.emit(OP.MUL); break;
        case '/=': this.e.emit(OP.DIV); break;
        case '%=': this.e.emit(OP.MOD); break;
      }
    }
    this.e.emit(OP.STORE, slot);
  }

  // arr[i] op= expr
  parseArrayAssign() {
    const ident = this.eatIdent();
    if (this.inAudio)
      this.ctx.error(`line ${ident.line}: assignments are not allowed inside audio()`);

    this.eatOp('[');
    this.parseExpr();   // push index onto stack
    this.eatOp(']');

    const op   = this.advance();   // =  +=  -=  *=  /=
    const slot = this.ctx.arrayIndex(ident.value);
    if (slot === -1)
      this.ctx.error(`line ${ident.line}: '${ident.value}' is not a declared array`);

    if (op.value !== '=') {
      // Compound: DUP the index so ARR_GET and ARR_SET each get a copy
      this.e.emit(OP.DUP);
      this.e.emit(OP.ARR_GET, slot & 0xFF);
      this.parseExpr();
      switch (op.value) {
        case '+=': this.e.emit(OP.ADD); break;
        case '-=': this.e.emit(OP.SUB); break;
        case '*=': this.e.emit(OP.MUL); break;
        case '/=': this.e.emit(OP.DIV); break;
        case '%=': this.e.emit(OP.MOD); break;
      }
    } else {
      this.parseExpr();
    }
    this.e.emit(OP.ARR_SET, slot & 0xFF);
  }

  parseCallStmt() {
    const ident = this.eatIdent();
    this.eatOp('(');
    const argc = this.parseArglist();
    this.eatOp(')');
    this._emitCall(ident, argc, /* inExpr */ false);
  }

  _emitCall(ident, argc, inExpr) {
    const b = BUILTINS[ident.value];
    if (!b) {
      this.ctx.error(`line ${ident.line}: unknown function '${ident.value}'`);
      if (inExpr) { this.e.emit(OP.PUSH_INT); this.e.emitI32(0); }
      return;
    }
    if (argc !== b.argc)
      this.ctx.error(`line ${ident.line}: '${ident.value}' expects ${b.argc} arg(s), got ${argc}`);
    if (this.inAudio && !b.audioOk)
      this.ctx.error(`line ${ident.line}: '${ident.value}' cannot be called inside audio()`);

    this.e.emit(OP.CALL, b.id, argc);

    if (inExpr) {
      if (!b.returns) {
        this.ctx.warning(`line ${ident.line}: '${ident.value}' returns void, used in expression`);
        this.e.emit(OP.PUSH_INT); this.e.emitI32(0);
      }
    } else {
      if (b.returns) this.e.emit(OP.POP);
    }
  }

  parseIf() {
    this.eatKw('if');
    this.eatOp('(');
    this.parseExpr();
    this.eatOp(')');

    const exitJump = this.e.emitJump(OP.JUMP_F);
    this.parseBody();

    if (this.checkKw('else')) {
      this.advance();
      const skipElse = this.e.emitJump(OP.JUMP);
      this.e.patch(exitJump);
      this.parseBody();
      this.e.patch(skipElse);
    } else {
      this.e.patch(exitJump);
    }
  }

  parseWhile() {
    this.eatKw('while');
    this.eatOp('(');
    const condStart = this.e.length;
    this.parseExpr();
    this.eatOp(')');

    const exitJump = this.e.emitJump(OP.JUMP_F);

    this.breakPatchLists.push([]);
    this.continuePatchLists.push([]);
    this.parseBody();
    const continuePatches = this.continuePatchLists.pop();
    const breakPatches    = this.breakPatchLists.pop();

    for (const p of continuePatches) this.e.patchTo(p, condStart);

    const backJump = this.e.emitJump(OP.JUMP);
    this.e.patchTo(backJump, condStart);

    this.e.patch(exitJump);
    for (const p of breakPatches) this.e.patch(p);
  }

  parseForUpdate() {
    const t    = this.peek();
    const next = this.tok[this.pos + 1] || {};
    if (t.type === 'IDENT' && next.type === 'OP' && ['++', '--'].includes(next.value))
      return this.parsePostfixIncr();
    if (t.type === 'OP' && ['++', '--'].includes(t.value))
      return this.parsePrefixIncr();
    if (t.type === 'IDENT' && next.type === 'OP' && next.value === '[')
      return this.parseArrayAssign();
    this.parseAssignment();
  }

  parseForInit() {
    const t    = this.peek();
    const next = this.tok[this.pos + 1] || {};
    if (t.type === 'IDENT' && next.type === 'OP' && next.value === '[')
      return this.parseArrayAssign();
    this.parseAssignment();
  }

  parseFor() {
    this.eatKw('for');
    this.eatOp('(');
    this.parseForInit();               // init
    this.eatOp(';');

    const condStart = this.e.length;
    this.parseExpr();                  // condition
    this.eatOp(';');
    const exitJump = this.e.emitJump(OP.JUMP_F);

    const savedE  = this.e;
    const updateE = new Emitter();
    this.e = updateE;
    this.parseForUpdate();             // update
    this.e = savedE;
    this.eatOp(')');

    this.breakPatchLists.push([]);
    this.continuePatchLists.push([]);
    this.parseBody();
    const continuePatches = this.continuePatchLists.pop();
    const breakPatches    = this.breakPatchLists.pop();

    const continueTarget = this.e.length;
    for (const b of updateE.bytes) this.e.bytes.push(b);
    for (const p of continuePatches) this.e.patchTo(p, continueTarget);

    const backJump = this.e.emitJump(OP.JUMP);
    this.e.patchTo(backJump, condStart);

    this.e.patch(exitJump);
    for (const p of breakPatches) this.e.patch(p);
  }

  parseBreak() {
    const t = this.eatKw('break');
    if (this.breakPatchLists.length === 0) {
      this.ctx.error(`line ${t.line}: 'break' outside loop`);
      return;
    }
    this.breakPatchLists[this.breakPatchLists.length - 1].push(this.e.emitJump(OP.JUMP));
  }

  parseContinue() {
    const t = this.eatKw('continue');
    if (this.continuePatchLists.length === 0) {
      this.ctx.error(`line ${t.line}: 'continue' outside loop`);
      return;
    }
    this.continuePatchLists[this.continuePatchLists.length - 1].push(this.e.emitJump(OP.JUMP));
  }

  parseReturn() {
    const t = this.eatKw('return');
    if (!this.inAudio) {
      this.ctx.error(`line ${t.line}: 'return' is only valid inside audio()`);
      return;
    }
    this.parseExpr();
    this.e.emit(OP.RET);
  }

  // ── Expressions ──────────────────────────────────────────────────────────────

  parseArglist() {
    let count = 0;
    if (!this.checkOp(')')) {
      this.parseExpr(); count++;
      while (this.checkOp(',')) { this.advance(); this.parseExpr(); count++; }
    }
    return count;
  }

  parseExpr()   { this.parseLogical(); }

  parseLogical() {
    this.parseBitor();
    while (this.checkOp('&&') || this.checkOp('||')) {
      const isAnd = this.advance().value === '&&';
      const skipJump = this.e.emitJump(isAnd ? OP.PEEK_JUMP_F : OP.PEEK_JUMP_T);
      this.e.emit(OP.POP);
      this.parseBitor();
      this.e.patch(skipJump);
      this.e.emit(OP.NOT, OP.NOT);
    }
  }

  parseBitor()  { this.parseBitxor(); while (this.checkOp('|'))  { this.advance(); this.parseBitxor(); this.e.emit(OP.BOR);  } }
  parseBitxor() { this.parseBitand(); while (this.checkOp('^'))  { this.advance(); this.parseBitand(); this.e.emit(OP.BXOR); } }
  parseBitand() { this.parseCompar(); while (this.checkOp('&'))  { this.advance(); this.parseCompar(); this.e.emit(OP.BAND); } }

  parseCompar() {
    this.parseShift();
    const OPS = { '==': OP.EQ, '!=': OP.NE, '<': OP.LT, '<=': OP.LE, '>': OP.GT, '>=': OP.GE };
    while (this.peek().type === 'OP' && OPS[this.peek().value] !== undefined) {
      const op = this.advance().value;
      this.parseShift();
      this.e.emit(OPS[op]);
    }
  }

  parseShift() {
    this.parseAdd();
    while (this.checkOp('>>') || this.checkOp('<<')) {
      const op = this.advance().value;
      this.parseAdd();
      this.e.emit(op === '>>' ? OP.SHR : OP.SHL);
    }
  }

  parseAdd() {
    this.parseMul();
    while (this.checkOp('+') || this.checkOp('-')) {
      const op = this.advance().value;
      this.parseMul();
      this.e.emit(op === '+' ? OP.ADD : OP.SUB);
    }
  }

  parseMul() {
    this.parseUnary();
    while (this.checkOp('*') || this.checkOp('/') || this.checkOp('%')) {
      const op = this.advance().value;
      this.parseUnary();
      this.e.emit(op === '*' ? OP.MUL : op === '/' ? OP.DIV : OP.MOD);
    }
  }

  parseUnary() {
    if (this.checkOp('-')) { this.advance(); this.parseUnary(); this.e.emit(OP.NEG); }
    else                    this.parsePrimary();
  }

  parsePrimary() {
    const t = this.peek();

    if (t.type === 'NUM') {
      this.advance();
      this.e.emit(OP.PUSH_INT);
      this.e.emitI32(t.value);
      return;
    }

    // String literal → read-only literal array reference
    if (t.type === 'STR') {
      this.advance();
      this.e.emit(OP.PUSH_ARR, this.ctx.arrLitIndex(t.value, t.line));
      return;
    }

    if (t.type === 'IDENT') {
      this.advance();
      if (this.checkOp('(')) {
        // Built-in call in expression context
        this.advance();   // '('
        const argc = this.parseArglist();
        this.eatOp(')');
        this._emitCall(t, argc, /* inExpr */ true);
      } else if (this.checkOp('[')) {
        // Array element read: arr[i]
        this.advance();   // '['
        const slot = this.ctx.arrayIndex(t.value);
        if (slot === -1)
          this.ctx.error(`line ${t.line}: '${t.value}' is not a declared array`);
        this.parseExpr();
        this.eatOp(']');
        this.e.emit(OP.ARR_GET, slot & 0xFF);
      } else if (this.checkOp('.')) {
        // Property access — only .length is defined
        this.advance();   // '.'
        const prop = this.eatIdent();
        if (prop.value !== 'length')
          this.ctx.error(`line ${prop.line}: unknown property '${prop.value}'`);
        const slot = this.ctx.arrayIndex(t.value);
        if (slot === -1)
          this.ctx.error(`line ${t.line}: '${t.value}' is not a declared array`);
        this.e.emit(OP.ARR_LEN, slot & 0xFF);
      } else {
        // Bare name: array reference or scalar variable
        const arrSlot = this.ctx.arrayIndex(t.value);
        if (arrSlot !== -1) {
          this.e.emit(OP.PUSH_ARR_MUT, arrSlot & 0xFF);
        } else {
          this.e.emit(OP.LOAD, this.ctx.varSlot(t.value, t.line));
        }
      }
      return;
    }

    if (t.type === 'OP' && t.value === '(') {
      this.advance();
      this.parseExpr();
      this.eatOp(')');
      return;
    }

    this.ctx.error(`line ${t.line}: unexpected '${t.value}' in expression`);
    this.advance();
    this.e.emit(OP.PUSH_INT); this.e.emitI32(0);
  }
}

// ─── Function-level compilation ───────────────────────────────────────────────

function compileFunction(name, params, bodyTokens, ctx) {
  const e   = new Emitter();
  const tks = [...bodyTokens, { type: 'EOF', value: 'EOF', line: 0 }];
  const p   = new Parser(tks, ctx, e, name === 'audio');

  const paramSlots = params.map(pname => ctx.varSlot(pname, 0));

  p.parseBody();
  if (name === 'audio') { e.emit(OP.PUSH_INT); e.emitI32(128); }
  e.emit(OP.RET);

  return { bytes: e.bytes, paramSlots };
}

// ─── Binary assembler ─────────────────────────────────────────────────────────

function u16le(n) { return [n & 0xFF, (n >> 8) & 0xFF]; }

function assembleBinary(meta, ctx, compiled) {
  const metaText  = Object.entries(meta).map(([k, v]) => `@${k} ${v}`).join('\n');
  const metaBytes = Array.from(metaText, c => c.charCodeAt(0) & 0x7F);

  // Array literal table — null-terminated char-code arrays
  const arrLitBytes = [];
  for (const s of ctx.arrLiterals) {
    const codes = Array.from(s, c => c.charCodeAt(0) & 0x7F);
    codes.push(0);                                  // null terminator
    arrLitBytes.push(codes.length, ...codes);       // [len][chars + null]
  }

  // Array declaration table — declared sizes as u16 LE
  const arrDeclBytes = [];
  for (const decl of ctx.arrayDecls) {
    arrDeclBytes.push(...u16le(decl.size));
  }

  // Concatenate bytecode, record offsets
  const code    = [];
  const offsets = { init: 0xFFFF, update: 0xFFFF, draw: 0xFFFF, audio: 0xFFFF };
  const params  = {
    update: { frame: 0xFF, input: 0xFF },
    draw:   { frame: 0xFF, input: 0xFF },
    audio:  { t:     0xFF },
  };

  for (const [name, result] of Object.entries(compiled)) {
    if (!result) continue;
    offsets[name] = code.length;
    code.push(...result.bytes);
    const s = result.paramSlots;
    if      (name === 'update') { params.update.frame = s[0] ?? 0xFF; params.update.input = s[1] ?? 0xFF; }
    else if (name === 'draw')   { params.draw.frame   = s[0] ?? 0xFF; params.draw.input   = s[1] ?? 0xFF; }
    else if (name === 'audio')  { params.audio.t      = s[0] ?? 0xFF; }
  }

  const out = [
    0x42, 0x44, 0x42, 0x4E,          // magic 'BDBN'
    1,                                 // format version
    0,                                 // flags
    ...u16le(metaBytes.length),
    ...metaBytes,
    ctx.arrLiterals.length,            // array literal count
    ...arrLitBytes,
    ctx.arrayDecls.length,             // array declaration count
    ...arrDeclBytes,
    ...u16le(offsets.init),
    ...u16le(offsets.update), params.update.frame, params.update.input,
    ...u16le(offsets.draw),   params.draw.frame,   params.draw.input,
    ...u16le(offsets.audio),  params.audio.t,
    ...code,
  ];

  return new Uint8Array(out);
}

// ─── Main compile function ────────────────────────────────────────────────────

/**
 * Compile a Bidule 01 source cart (.bdcart) to a binary cart (.bdb).
 *
 * @param  {string} source  - Source text of the cart.
 * @returns {{ binary: Uint8Array|null, errors: string[], warnings: string[] }}
 *   `binary` is null when there are compile errors.
 */
export function compile(source) {
  const ctx    = new Ctx();
  const tokens = lex(source);
  let pos = 0;

  // ── Extract leading metadata (// @key value lines) ─────────────────────────
  const meta = {};
  while (pos < tokens.length && tokens[pos].type === 'META') {
    const { key, value } = tokens[pos++];
    meta[key] = value;
  }
  if (meta.id == null) ctx.warning('no @id metadata — persistence (save/load) will be disabled');

  // ── Top-level: array declarations and lifecycle function definitions ─────────
  // Array declaration:      IDENT '[' NUMBER ']'
  // Lifecycle definition:   IDENT '(' params ')' block

  const fnDefs = {};

  while (pos < tokens.length && tokens[pos].type !== 'EOF') {
    const t = tokens[pos];

    if (t.type !== 'IDENT') {
      ctx.error(`line ${t.line}: expected array declaration or lifecycle function, got '${t.value}'`);
      while (pos < tokens.length && !(tokens[pos].type === 'OP' && tokens[pos].value === '{')) pos++;
      let depth = 0;
      while (pos < tokens.length) {
        const v = tokens[pos++].value;
        if (v === '{') depth++;
        else if (v === '}' && --depth === 0) break;
      }
      continue;
    }

    // Array declaration: IDENT '[' NUMBER ']'
    const next = tokens[pos + 1];
    if (next && next.type === 'OP' && next.value === '[') {
      const nameTok = tokens[pos++];  // IDENT
      pos++;                           // '['
      if (tokens[pos]?.type !== 'NUM') {
        ctx.error(`line ${nameTok.line}: expected integer size in array declaration`);
        while (pos < tokens.length && tokens[pos].value !== ']') pos++;
        if (pos < tokens.length) pos++;
      } else {
        const size = tokens[pos++].value;
        if (tokens[pos]?.type !== 'OP' || tokens[pos].value !== ']') {
          ctx.error(`line ${nameTok.line}: expected ']' after array size`);
        } else {
          pos++;  // ']'
        }
        ctx.declareArray(nameTok.value, size, nameTok.line);
      }
      continue;
    }

    // Lifecycle function definition
    if (!(t.value in LIFECYCLE)) {
      ctx.error(`line ${t.line}: expected lifecycle function (init/update/draw/audio) or array declaration, got '${t.value}'`);
      while (pos < tokens.length && !(tokens[pos].type === 'OP' && tokens[pos].value === '{')) pos++;
      let depth = 0;
      while (pos < tokens.length) {
        const v = tokens[pos++].value;
        if (v === '{') depth++;
        else if (v === '}' && --depth === 0) break;
      }
      continue;
    }

    const name     = t.value;
    const nameLine = t.line;
    pos++;

    if (tokens[pos]?.type !== 'OP' || tokens[pos].value !== '(') {
      ctx.error(`line ${nameLine}: expected '(' after '${name}'`); continue;
    }
    pos++;  // '('
    const params = [];
    while (tokens[pos]?.type === 'IDENT') {
      params.push(tokens[pos++].value);
      if (tokens[pos]?.type === 'OP' && tokens[pos].value === ',') pos++;
    }
    if (tokens[pos]?.type !== 'OP' || tokens[pos].value !== ')') {
      ctx.error(`line ${nameLine}: expected ')' in '${name}' parameters`);
    } else {
      pos++;
    }

    if (name in fnDefs) {
      ctx.error(`line ${nameLine}: '${name}' defined more than once`);
    }

    if (tokens[pos]?.type !== 'OP' || tokens[pos].value !== '{') {
      ctx.error(`line ${nameLine}: expected '{' for '${name}' body`); continue;
    }
    const bodyStart = pos;
    let depth = 0;
    while (pos < tokens.length) {
      const v = tokens[pos].value;
      if (v === '{')                       depth++;
      else if (v === '}' && --depth === 0) { pos++; break; }
      pos++;
    }

    fnDefs[name] = { params, bodyTokens: tokens.slice(bodyStart, pos) };
  }

  // ── Compile each function body ──────────────────────────────────────────────
  const compiled = {};
  for (const [name, { params, bodyTokens }] of Object.entries(fnDefs)) {
    compiled[name] = compileFunction(name, params, bodyTokens, ctx);
  }

  if (ctx.errors.length > 0) {
    return { binary: null, errors: ctx.errors, warnings: ctx.warnings };
  }

  const binary = assembleBinary(meta, ctx, compiled);
  return { binary, errors: [], warnings: ctx.warnings };
}
