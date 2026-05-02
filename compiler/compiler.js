// Bidule 01 compiler — .bdcart source → .bdb binary
// Usage (browser / bundler): import { compile } from './compiler.js'
// Usage (Node.js):           const { compile } = await import('./compiler.js')

// ─── Opcode table (mirrors firmware/runtime/vm.h) ────────────────────────────

const OP = {
  PUSH_INT:     0x00,
  PUSH_ARR:     0x01,   // [u8]  push literal array ref by table index
  LOAD:         0x02,   // [u8]  push global int variable by slot
  STORE:        0x03,   // [u8]  pop → global variable slot (encodes arr_ref as negative)
  LOAD_ARR:     0x04,   // [u8]  push global arr_ref variable; decodes slot value to typed ref
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
  CALL_FN:      0x61,   // [u16 fn_idx LE][u8 argc]  call user-defined function
  ARR_GET:      0x70,   // [u8 slot]  pop index; push pool[slot][index]  (0 if OOB)
  ARR_SET:      0x71,   // [u8 slot]  pop value (top), pop index; write  (no-op if OOB)
  ARR_LEN:      0x72,   // [u8 slot]  push declared length of pool[slot]
  PUSH_ARR_MUT: 0x73,   // [u8 slot]  push mutable array reference
  DYN_ARR_GET:  0x74,   // [u8 slot]  pop index; push element from arr_ref stored in var slot
  DYN_ARR_SET:  0x75,   // [u8 slot]  pop value (top), pop index; write to arr_ref in var slot
  DYN_ARR_LEN:  0x76,   // [u8 slot]  push length of arr_ref stored in var slot
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
      const KWS = new Set(['if', 'else', 'while', 'for', 'break', 'continue', 'return', 'fn']);
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
    this.vars        = new Map();  // name → {slot, kind}  kind: null|'int'|'arr_ref'
    this.arrLiterals = [];         // unique string literals (deduped), max 32
    this.arrayDecls  = [];         // [{name, size}] in declaration order, max 16
    this.userFns     = new Map();  // name → { index, paramCount } in declaration order
    this.errors      = [];
    this.warnings    = [];
  }

  declareUserFn(name, paramCount, line) {
    if (this.userFns.has(name)) {
      this.errors.push(`line ${line}: '${name}' defined more than once`);
      return;
    }
    this.userFns.set(name, { index: this.userFns.size, paramCount });
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
      this.vars.set(name, { slot: this.vars.size, kind: null });
    }
    return this.vars.get(name).slot;
  }

  varKind(name) {
    return this.vars.get(name)?.kind ?? null;
  }

  setVarKind(name, kind, line) {
    const v = this.vars.get(name);
    if (!v || kind === null) return;
    if (v.kind === null) {
      v.kind = kind;
    } else if (v.kind !== kind) {
      this.errors.push(`line ${line}: cannot change value-kind of variable '${name}' (was '${v.kind}', reassigned as '${kind}')`);
    }
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
  constructor(tokens, ctx, emitter, inAudio, inUserFn = false) {
    this.tok       = tokens;
    this.pos       = 0;
    this.ctx       = ctx;
    this.e         = emitter;
    this.inAudio   = inAudio;
    this.inUserFn  = inUserFn;
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
    const op  = this.advance();  // ++ or --
    const vk  = this.ctx.varKind(ident.value);
    if (vk === 'arr_ref')
      this.ctx.error(`line ${ident.line}: '${op.value}' cannot be used on arr_ref variable '${ident.value}'`);
    const slot = this.ctx.varSlot(ident.value, ident.line);
    this.ctx.setVarKind(ident.value, 'int', ident.line);
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
    const vk  = this.ctx.varKind(ident.value);
    if (vk === 'arr_ref')
      this.ctx.error(`line ${ident.line}: '${op.value}' cannot be used on arr_ref variable '${ident.value}'`);
    const slot = this.ctx.varSlot(ident.value, ident.line);
    this.ctx.setVarKind(ident.value, 'int', ident.line);
    this.e.emit(OP.LOAD, slot);
    this.e.emit(OP.PUSH_INT); this.e.emitI32(1);
    this.e.emit(op.value === '++' ? OP.ADD : OP.SUB);
    this.e.emit(OP.STORE, slot);
  }

  parseAssignment() {
    const ident = this.eatIdent();
    if (this.inAudio)
      this.ctx.error(`line ${ident.line}: assignments are not allowed inside audio()`);

    const opTok = this.advance();   // =  +=  -=  *=  /=
    const vk    = this.ctx.varKind(ident.value);
    const slot  = this.ctx.varSlot(ident.value, ident.line);

    if (opTok.value === '=') {
      const rk = this.parseExpr();
      if (rk === 'int' || rk === 'arr_ref')
        this.ctx.setVarKind(ident.value, rk, ident.line);
    } else {
      // Compound assignment — only valid on int variables
      if (vk === 'arr_ref')
        this.ctx.error(`line ${opTok.line}: '${opTok.value}' cannot be used on arr_ref variable '${ident.value}'`);
      this.ctx.setVarKind(ident.value, 'int', ident.line);
      this.e.emit(OP.LOAD, slot);
      const rk = this.parseExpr();
      if (rk === 'arr_ref')
        this.ctx.error(`line ${opTok.line}: right-hand side of '${opTok.value}' must be an int`);
      switch (opTok.value) {
        case '+=': this.e.emit(OP.ADD); break;
        case '-=': this.e.emit(OP.SUB); break;
        case '*=': this.e.emit(OP.MUL); break;
        case '/=': this.e.emit(OP.DIV); break;
        case '%=': this.e.emit(OP.MOD); break;
      }
    }
    this.e.emit(OP.STORE, slot);
  }

  // arr[i] op= expr  (pool declaration or arr_ref scalar variable)
  parseArrayAssign() {
    const ident = this.eatIdent();
    if (this.inAudio)
      this.ctx.error(`line ${ident.line}: assignments are not allowed inside audio()`);

    this.eatOp('[');
    this.parseExpr();   // push index onto stack
    this.eatOp(']');

    const opTok = this.advance();   // =  +=  -=  *=  /=  ++  --

    const isIncr = opTok.value === '++' || opTok.value === '--';

    const _compoundOp = () => {
      switch (opTok.value) {
        case '+=': this.e.emit(OP.ADD); break;
        case '-=': this.e.emit(OP.SUB); break;
        case '*=': this.e.emit(OP.MUL); break;
        case '/=': this.e.emit(OP.DIV); break;
        case '%=': this.e.emit(OP.MOD); break;
        case '++': this.e.emit(OP.ADD); break;
        case '--': this.e.emit(OP.SUB); break;
      }
    };

    const _pushRhsOrOne = () => {
      if (isIncr) {
        this.e.emit(OP.PUSH_INT); this.e.emitI32(1);
      } else {
        this.parseExpr();
      }
    };

    // Pool declaration?
    const poolSlot = this.ctx.arrayIndex(ident.value);
    if (poolSlot !== -1) {
      if (opTok.value !== '=') {
        this.e.emit(OP.DUP);
        this.e.emit(OP.ARR_GET, poolSlot & 0xFF);
        _pushRhsOrOne();
        _compoundOp();
      } else {
        this.parseExpr();
      }
      this.e.emit(OP.ARR_SET, poolSlot & 0xFF);
      return;
    }

    // arr_ref scalar variable?
    const vk = this.ctx.varKind(ident.value);
    if (vk === 'int') {
      this.ctx.error(`line ${ident.line}: '${ident.value}' is an int variable; cannot use array indexing`);
      if (!isIncr) this.parseExpr();
      this.e.emit(OP.POP); this.e.emit(OP.POP);  // discard rhs and index
      return;
    }
    if (vk === null && !this.ctx.vars.has(ident.value)) {
      this.ctx.error(`line ${ident.line}: '${ident.value}' is not a declared array or arr_ref variable`);
      if (!isIncr) this.parseExpr();
      this.e.emit(OP.POP); this.e.emit(OP.POP);
      return;
    }
    // arr_ref or previously-seen variable — infer arr_ref
    const slot = this.ctx.varSlot(ident.value, ident.line);
    this.ctx.setVarKind(ident.value, 'arr_ref', ident.line);
    if (opTok.value !== '=') {
      this.e.emit(OP.DUP);
      this.e.emit(OP.DYN_ARR_GET, slot & 0xFF);
      _pushRhsOrOne();
      _compoundOp();
    } else {
      this.parseExpr();
    }
    this.e.emit(OP.DYN_ARR_SET, slot & 0xFF);
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
    if (b) {
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
      return;
    }

    const fn = this.ctx.userFns.get(ident.value);
    if (fn) {
      if (argc !== fn.paramCount)
        this.ctx.error(`line ${ident.line}: '${ident.value}' expects ${fn.paramCount} arg(s), got ${argc}`);
      this.e.emit(OP.CALL_FN, fn.index & 0xFF, (fn.index >> 8) & 0xFF, argc);
      if (!inExpr) this.e.emit(OP.POP);
      return;
    }

    this.ctx.error(`line ${ident.line}: unknown function '${ident.value}'`);
    if (inExpr) { this.e.emit(OP.PUSH_INT); this.e.emitI32(0); }
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
    if (!this.inAudio && !this.inUserFn) {
      this.ctx.error(`line ${t.line}: 'return' is only valid inside a user-defined function or audio()`);
      return;
    }
    const rk = this.parseExpr();
    if (this.inUserFn && rk === 'arr_ref')
      this.ctx.error(`line ${t.line}: user-defined functions cannot return arr_ref in v1`);
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

  parseExpr()   { return this.parseLogical(); }

  parseLogical() {
    let k = this.parseBitor();
    while (this.checkOp('&&') || this.checkOp('||')) {
      const isAnd = this.advance().value === '&&';
      const skipJump = this.e.emitJump(isAnd ? OP.PEEK_JUMP_F : OP.PEEK_JUMP_T);
      this.e.emit(OP.POP);
      this.parseBitor();
      this.e.patch(skipJump);
      this.e.emit(OP.NOT, OP.NOT);
      k = 'int';
    }
    return k;
  }

  parseBitor() {
    let k = this.parseBitxor();
    while (this.checkOp('|'))  { const t = this.advance(); const rk = this.parseBitxor(); this.e.emit(OP.BOR);  if (k==='arr_ref'||rk==='arr_ref') this.ctx.error(`line ${t.line}: '|' cannot be applied to arr_ref`); k='int'; }
    return k;
  }
  parseBitxor() {
    let k = this.parseBitand();
    while (this.checkOp('^'))  { const t = this.advance(); const rk = this.parseBitand(); this.e.emit(OP.BXOR); if (k==='arr_ref'||rk==='arr_ref') this.ctx.error(`line ${t.line}: '^' cannot be applied to arr_ref`); k='int'; }
    return k;
  }
  parseBitand() {
    let k = this.parseCompar();
    while (this.checkOp('&'))  { const t = this.advance(); const rk = this.parseCompar(); this.e.emit(OP.BAND); if (k==='arr_ref'||rk==='arr_ref') this.ctx.error(`line ${t.line}: '&' cannot be applied to arr_ref`); k='int'; }
    return k;
  }

  parseCompar() {
    let k = this.parseShift();
    const OPS = { '==': OP.EQ, '!=': OP.NE, '<': OP.LT, '<=': OP.LE, '>': OP.GT, '>=': OP.GE };
    while (this.peek().type === 'OP' && OPS[this.peek().value] !== undefined) {
      const opTok = this.advance();
      const rk = this.parseShift();
      // Ordered comparisons on arr_ref are invalid; == and != are reference identity (allowed)
      if ((opTok.value === '<' || opTok.value === '<=' || opTok.value === '>' || opTok.value === '>=') &&
          (k === 'arr_ref' || rk === 'arr_ref'))
        this.ctx.error(`line ${opTok.line}: ordered comparison '${opTok.value}' cannot be applied to arr_ref`);
      this.e.emit(OPS[opTok.value]);
      k = 'int';
    }
    return k;
  }

  parseShift() {
    let k = this.parseAdd();
    while (this.checkOp('>>') || this.checkOp('<<')) {
      const opTok = this.advance();
      const rk = this.parseAdd();
      if (k === 'arr_ref' || rk === 'arr_ref')
        this.ctx.error(`line ${opTok.line}: '${opTok.value}' cannot be applied to arr_ref`);
      this.e.emit(opTok.value === '>>' ? OP.SHR : OP.SHL);
      k = 'int';
    }
    return k;
  }

  parseAdd() {
    let k = this.parseMul();
    while (this.checkOp('+') || this.checkOp('-')) {
      const opTok = this.advance();
      const rk = this.parseMul();
      if (k === 'arr_ref' || rk === 'arr_ref')
        this.ctx.error(`line ${opTok.line}: '${opTok.value}' cannot be applied to arr_ref`);
      this.e.emit(opTok.value === '+' ? OP.ADD : OP.SUB);
      k = 'int';
    }
    return k;
  }

  parseMul() {
    let k = this.parseUnary();
    while (this.checkOp('*') || this.checkOp('/') || this.checkOp('%')) {
      const opTok = this.advance();
      const rk = this.parseUnary();
      if (k === 'arr_ref' || rk === 'arr_ref')
        this.ctx.error(`line ${opTok.line}: '${opTok.value}' cannot be applied to arr_ref`);
      this.e.emit(opTok.value === '*' ? OP.MUL : opTok.value === '/' ? OP.DIV : OP.MOD);
      k = 'int';
    }
    return k;
  }

  parseUnary() {
    if (this.checkOp('-')) {
      const opTok = this.advance();
      const k = this.parseUnary();
      if (k === 'arr_ref') this.ctx.error(`line ${opTok.line}: unary '-' cannot be applied to arr_ref`);
      this.e.emit(OP.NEG);
      return 'int';
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const t = this.peek();

    if (t.type === 'NUM') {
      this.advance();
      this.e.emit(OP.PUSH_INT);
      this.e.emitI32(t.value);
      return 'int';
    }

    // String literal → read-only literal arr_ref
    if (t.type === 'STR') {
      this.advance();
      this.e.emit(OP.PUSH_ARR, this.ctx.arrLitIndex(t.value, t.line));
      return 'arr_ref';
    }

    if (t.type === 'IDENT') {
      this.advance();

      if (this.checkOp('(')) {
        // Function call in expression context — always returns int in v1
        this.advance();
        const argc = this.parseArglist();
        this.eatOp(')');
        this._emitCall(t, argc, /* inExpr */ true);
        return 'int';
      }

      if (this.checkOp('[')) {
        // Array element read: arr[i]
        this.advance();
        const poolSlot = this.ctx.arrayIndex(t.value);
        if (poolSlot !== -1) {
          this.parseExpr();
          this.eatOp(']');
          this.e.emit(OP.ARR_GET, poolSlot & 0xFF);
          return 'int';
        }
        const vk = this.ctx.varKind(t.value);
        if (vk === 'int') {
          this.ctx.error(`line ${t.line}: '${t.value}' is an int variable; cannot use array indexing`);
          this.parseExpr(); this.eatOp(']');
          this.e.emit(OP.POP); this.e.emit(OP.PUSH_INT); this.e.emitI32(0);
          return 'int';
        }
        if (vk === null && !this.ctx.vars.has(t.value)) {
          // Completely undeclared — same error as before
          this.ctx.error(`line ${t.line}: '${t.value}' is not a declared array or arr_ref variable`);
          this.parseExpr(); this.eatOp(']');
          this.e.emit(OP.POP); this.e.emit(OP.PUSH_INT); this.e.emitI32(0);
          return 'int';
        }
        // arr_ref or previously-seen variable — treat as arr_ref, infer kind
        const slot = this.ctx.varSlot(t.value, t.line);
        this.ctx.setVarKind(t.value, 'arr_ref', t.line);
        this.parseExpr();
        this.eatOp(']');
        this.e.emit(OP.DYN_ARR_GET, slot & 0xFF);
        return 'int';
      }

      if (this.checkOp('.')) {
        // Property access — only .length is defined
        this.advance();
        const prop = this.eatIdent();
        if (prop.value !== 'length')
          this.ctx.error(`line ${prop.line}: unknown property '${prop.value}'`);
        const poolSlot = this.ctx.arrayIndex(t.value);
        if (poolSlot !== -1) {
          this.e.emit(OP.ARR_LEN, poolSlot & 0xFF);
          return 'int';
        }
        const vk = this.ctx.varKind(t.value);
        if (vk === 'int') {
          this.ctx.error(`line ${t.line}: '${t.value}' is an int variable; '.length' requires arr_ref`);
          this.e.emit(OP.PUSH_INT); this.e.emitI32(0);
          return 'int';
        }
        if (vk === null && !this.ctx.vars.has(t.value)) {
          this.ctx.error(`line ${t.line}: '${t.value}' is not a declared array or arr_ref variable`);
          this.e.emit(OP.PUSH_INT); this.e.emitI32(0);
          return 'int';
        }
        // arr_ref or previously-seen variable — infer arr_ref
        const slot = this.ctx.varSlot(t.value, t.line);
        this.ctx.setVarKind(t.value, 'arr_ref', t.line);
        this.e.emit(OP.DYN_ARR_LEN, slot & 0xFF);
        return 'int';
      }

      // Bare name: pool declaration or scalar variable
      const poolSlot = this.ctx.arrayIndex(t.value);
      if (poolSlot !== -1) {
        this.e.emit(OP.PUSH_ARR_MUT, poolSlot & 0xFF);
        return 'arr_ref';
      }
      const vk  = this.ctx.varKind(t.value);
      const slot = this.ctx.varSlot(t.value, t.line);
      if (vk === 'arr_ref') {
        this.e.emit(OP.LOAD_ARR, slot);
        return 'arr_ref';
      }
      this.e.emit(OP.LOAD, slot);
      return vk ?? 'int';
    }

    if (t.type === 'OP' && t.value === '(') {
      this.advance();
      const k = this.parseExpr();
      this.eatOp(')');
      return k;
    }

    this.ctx.error(`line ${t.line}: unexpected '${t.value}' in expression`);
    this.advance();
    this.e.emit(OP.PUSH_INT); this.e.emitI32(0);
    return 'int';
  }
}

// ─── Function-level compilation ───────────────────────────────────────────────

// Pre-scan function body tokens to infer which parameters are arr_ref.
// Heuristic: a parameter is arr_ref if it appears before '[' or '.' in the body,
// or if it is directly assigned a string literal.
// annotations[i] is 'arr_ref' if the parameter was explicitly typed; null otherwise.
function inferParamKinds(params, bodyTokens, annotations) {
  if (params.length === 0) return [];
  const arrRef = new Set();
  for (let i = 0; i < bodyTokens.length; i++) {
    const t = bodyTokens[i];
    if (t.type !== 'IDENT' || !params.includes(t.value)) continue;
    const idx = params.indexOf(t.value);
    if (annotations[idx] !== null) continue;  // skip explicitly annotated params
    const next = bodyTokens[i + 1];
    if (!next) continue;
    if (next.type === 'OP' && (next.value === '[' || next.value === '.')) {
      arrRef.add(t.value);
    }
    // param = "literal"
    if (next.type === 'OP' && next.value === '=' &&
        i + 2 < bodyTokens.length && bodyTokens[i + 2].type === 'STR') {
      arrRef.add(t.value);
    }
  }
  return params.map((p, i) => {
    if (annotations[i] !== null) return annotations[i];
    return arrRef.has(p) ? 'arr_ref' : 'int';
  });
}

function compileFunction(name, params, bodyTokens, ctx, isUserFn = false, paramAnnotations = null) {
  const e   = new Emitter();
  const tks = [...bodyTokens, { type: 'EOF', value: 'EOF', line: 0 }];
  const p   = new Parser(tks, ctx, e, name === 'audio', isUserFn);

  // Lifecycle params are always int; user-fn params use explicit annotations then inference.
  const annotations = paramAnnotations || params.map(() => null);
  const paramKinds = isUserFn
    ? inferParamKinds(params, bodyTokens, annotations)
    : params.map(() => 'int');

  const paramSlots = params.map((pname, i) => {
    const slot = ctx.varSlot(pname, 0);
    ctx.setVarKind(pname, paramKinds[i], 0);
    return slot;
  });

  p.parseBody();
  if (name === 'audio') { e.emit(OP.PUSH_INT); e.emitI32(128); }
  if (isUserFn)         { e.emit(OP.PUSH_INT); e.emitI32(0); }
  e.emit(OP.RET);

  return { bytes: e.bytes, paramSlots };
}

// ─── Binary assembler ─────────────────────────────────────────────────────────

function u16le(n) { return [n & 0xFF, (n >> 8) & 0xFF]; }

function assembleBinary(meta, ctx, compiled, compiledUserFns) {
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

  // User function bodies
  const userFnMeta = [];
  for (const fn of compiledUserFns) {
    const entry = code.length;
    code.push(...fn.bytes);
    userFnMeta.push({ name: fn.name, params: fn.paramSlots.length, entry, paramSlots: fn.paramSlots });
  }

  // Function table at end of bytecode; fn_table_off is offset from bytecode start
  const fn_table_off = code.length;
  for (const fn of userFnMeta) {
    const nameBytes = Array.from(fn.name, c => c.charCodeAt(0) & 0x7F);
    code.push(nameBytes.length, ...nameBytes, fn.params, ...u16le(fn.entry), ...fn.paramSlots);
  }

  const fn_count = compiledUserFns.length;

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
    ...u16le(fn_count),
    ...u16le(fn_table_off),
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

  // ── Top-level: array declarations, lifecycle functions, user-defined functions
  // Array declaration:         IDENT '[' NUMBER ']'
  // Lifecycle definition:      IDENT '(' params ')' block  (IDENT in LIFECYCLE)
  // User function definition:  'fn' IDENT '(' params ')' block

  const fnDefs         = {};   // name → { params, bodyTokens, nameLine, isUserFn }
  const userFnNames    = [];   // user function names in declaration order
  const topLevelInits  = [];   // { name, kind, value, line } for IDENT = NUMBER|STRING

  while (pos < tokens.length && tokens[pos].type !== 'EOF') {
    const t = tokens[pos];

    // User function: 'fn' IDENT '(' params ')' block
    if (t.type === 'KW' && t.value === 'fn') {
      pos++;  // consume 'fn'
      const nameTok = tokens[pos];
      if (!nameTok || nameTok.type !== 'IDENT') {
        ctx.error(`line ${t.line}: expected function name after 'fn'`);
        while (pos < tokens.length && !(tokens[pos].type === 'OP' && tokens[pos].value === '{')) pos++;
        let depth = 0;
        while (pos < tokens.length) { const v = tokens[pos++].value; if (v==='{') depth++; else if (v==='}' && --depth===0) break; }
        continue;
      }
      pos++;  // consume name
      const name     = nameTok.value;
      const nameLine = nameTok.line;
      if (name in BUILTINS)
        ctx.error(`line ${nameLine}: cannot redefine built-in function '${name}'`);
      if (name in LIFECYCLE)
        ctx.error(`line ${nameLine}: '${name}' is a lifecycle function name; define it without 'fn'`);
      if (tokens[pos]?.type !== 'OP' || tokens[pos].value !== '(') {
        ctx.error(`line ${nameLine}: expected '(' after '${name}'`); continue;
      }
      pos++;  // '('
      const params = [];
      const paramAnnotations = [];
      while (tokens[pos]?.type === 'IDENT') {
        const paramTok = tokens[pos++];
        params.push(paramTok.value);
        if (tokens[pos]?.type === 'OP' && tokens[pos].value === '[') {
          const bracketTok = tokens[pos++];
          if (tokens[pos]?.type === 'OP' && tokens[pos].value === ']') {
            pos++;
            paramAnnotations.push('arr_ref');
          } else {
            ctx.error(`line ${bracketTok.line}: expected ']' in type annotation for parameter '${paramTok.value}'`);
            paramAnnotations.push(null);
          }
        } else {
          paramAnnotations.push(null);
        }
        if (tokens[pos]?.type === 'OP' && tokens[pos].value === ',') pos++;
      }
      if (tokens[pos]?.type !== 'OP' || tokens[pos].value !== ')') {
        ctx.error(`line ${nameLine}: expected ')' in '${name}' parameters`);
      } else { pos++; }
      if (name in fnDefs) ctx.error(`line ${nameLine}: '${name}' defined more than once`);
      if (tokens[pos]?.type !== 'OP' || tokens[pos].value !== '{') {
        ctx.error(`line ${nameLine}: expected '{' for '${name}' body`); continue;
      }
      const bodyStart = pos;
      let depth = 0;
      while (pos < tokens.length) {
        const v = tokens[pos].value;
        if (v === '{') depth++; else if (v === '}' && --depth === 0) { pos++; break; }
        pos++;
      }
      fnDefs[name] = { params, paramAnnotations, bodyTokens: tokens.slice(bodyStart, pos), nameLine, isUserFn: true };
      userFnNames.push(name);
      continue;
    }

    if (t.type !== 'IDENT') {
      ctx.error(`line ${t.line}: expected array declaration or function definition, got '${t.value}'`);
      while (pos < tokens.length && !(tokens[pos].type === 'OP' && tokens[pos].value === '{')) pos++;
      let depth = 0;
      while (pos < tokens.length) {
        const v = tokens[pos++].value;
        if (v === '{') depth++;
        else if (v === '}' && --depth === 0) break;
      }
      continue;
    }

    // Global declarations: IDENT '[' NUMBER ']' | IDENT '=' NUMBER | IDENT '=' STRING
    const next = tokens[pos + 1];
    if (next && next.type === 'OP' && next.value === '=') {
      const rhs = tokens[pos + 2];
      if (rhs && (rhs.type === 'NUM' || rhs.type === 'STR')) {
        const nameTok = tokens[pos++];  // IDENT
        pos++;                           // '='
        const rhsTok  = tokens[pos++];  // NUMBER or STRING
        topLevelInits.push({
          name: nameTok.value,
          kind: rhsTok.type === 'STR' ? 'arr_ref' : 'int',
          value: rhsTok.value,
          line: nameTok.line,
        });
        continue;
      }
    }

    // Array declaration: IDENT '[' NUMBER ']'
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

    // Lifecycle function definition: IDENT '(' params ')' block
    const name     = t.value;
    const nameLine = t.line;
    pos++;

    if (!(name in LIFECYCLE)) {
      ctx.error(`line ${nameLine}: expected lifecycle function (init/update/draw/audio), array declaration, or 'fn' definition, got '${name}'`);
      while (pos < tokens.length && !(tokens[pos].type === 'OP' && tokens[pos].value === '{')) pos++;
      let depth = 0;
      while (pos < tokens.length) {
        const v = tokens[pos++].value;
        if (v === '{') depth++;
        else if (v === '}' && --depth === 0) break;
      }
      continue;
    }

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

    fnDefs[name] = { params, bodyTokens: tokens.slice(bodyStart, pos), nameLine, isUserFn: false };
  }

  // Register user functions before compiling any body (enables forward references)
  for (const name of userFnNames) {
    ctx.declareUserFn(name, fnDefs[name].params.length, fnDefs[name].nameLine);
  }

  // Register top-level init variable kinds so function bodies see them correctly
  for (const { name, kind, line } of topLevelInits) {
    ctx.varSlot(name, line);
    ctx.setVarKind(name, kind, line);
  }

  // ── Compile each function body ──────────────────────────────────────────────
  const compiled = {};
  for (const [name, { params, bodyTokens }] of Object.entries(fnDefs)) {
    if (name in LIFECYCLE) {
      compiled[name] = compileFunction(name, params, bodyTokens, ctx, false);
    }
  }

  const compiledUserFns = [];
  for (const [name, fn] of ctx.userFns) {
    const def = fnDefs[name];
    compiledUserFns.push({ name, ...compileFunction(name, def.params, def.bodyTokens, ctx, true, def.paramAnnotations) });
  }

  // Emit preamble for top-level initialisers and prepend to init()
  const preambleE = new Emitter();
  for (const { name, kind, value, line } of topLevelInits) {
    const slot = ctx.varSlot(name, line);
    if (kind === 'arr_ref') {
      preambleE.emit(OP.PUSH_ARR, ctx.arrLitIndex(value, line));
    } else {
      preambleE.emit(OP.PUSH_INT); preambleE.emitI32(value);
    }
    preambleE.emit(OP.STORE, slot);
  }
  if (preambleE.bytes.length > 0) {
    if (compiled.init) {
      compiled.init.bytes = [...preambleE.bytes, ...compiled.init.bytes];
    } else {
      preambleE.emit(OP.RET);
      compiled.init = { bytes: preambleE.bytes, paramSlots: [] };
    }
  }

  if (ctx.errors.length > 0) {
    return { binary: null, errors: ctx.errors, warnings: ctx.warnings };
  }

  const binary = assembleBinary(meta, ctx, compiled, compiledUserFns);
  return { binary, errors: [], warnings: ctx.warnings };
}
