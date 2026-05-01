// Bidule 01 — bytecode VM
// Pure ES module; imported by app.js and audio-worklet.js.

export const MAX_VARS     = 64;
export const MAX_STACK    = 32;
export const MAX_ARR_LITS = 32;
export const MAX_ARR_DECLS = 16;
export const MAX_ARR_ELEMS = 256;

// ─── Opcodes ──────────────────────────────────────────────────────────────────

const OP = {
  PUSH_INT:0x00, PUSH_ARR:0x01, LOAD:0x02, STORE:0x03, LOAD_ARR:0x04,
  ADD:0x10, SUB:0x11, MUL:0x12, DIV:0x13, MOD:0x14, NEG:0x15,
  BAND:0x20, BOR:0x21, BXOR:0x22, SHL:0x23, SHR:0x24,
  EQ:0x30, NE:0x31, LT:0x32, LE:0x33, GT:0x34, GE:0x35, NOT:0x36,
  POP:0x40, DUP:0x41,
  JUMP:0x50, JUMP_T:0x51, JUMP_F:0x52, PEEK_JUMP_T:0x53, PEEK_JUMP_F:0x54,
  CALL:0x60, CALL_FN:0x61,
  ARR_GET:0x70, ARR_SET:0x71, ARR_LEN:0x72, PUSH_ARR_MUT:0x73,
  DYN_ARR_GET:0x74, DYN_ARR_SET:0x75, DYN_ARR_LEN:0x76,
  RET:0xFF,
};

// ─── Built-in IDs ─────────────────────────────────────────────────────────────

const B = {
  BTN:0, BTNP:1, CLS:2, PSET:3, RECTFILL:4, LINE:5, PRINT:6,
  ABS:7, MIN:8, MAX:9, CLAMP:10, SEED:11, RND:12,
  STREQ:13, ARREQ:14,
  SAVE:15, LOAD_SLOT:16,
  CARTCOUNT:17, CARTMETA:18, LOADCART:19,
};

// ─── Value type tags (stack only; globals array is plain Int32Array) ──────────

const T_INT = 0, T_LIT = 1, T_MUT = 2;

// ─── VM class ─────────────────────────────────────────────────────────────────

/**
 * callbacks object expected by VM:
 *   btn(i), btnp(i) → 0|1
 *   cls(c), pset(x,y,c), rectfill(x,y,w,h,c), line(x0,y0,x1,y1,c)
 *   print(str, x, y, c)           — str is already a JS string
 *   save(slot, value), load(slot) → value
 *   cartcount() → n
 *   cartmeta(i, fieldStr) → string
 *   loadcart(i) → Uint8Array|null
 */
export class VM {
  constructor(callbacks = {}) {
    this.cb        = callbacks;
    this.loaded    = false;
    this._rng      = 12345;
    this._switched = false;   // set by loadcart; cleared by cartSwitched()
    this._pending  = null;    // next binary to load (set by loadcart builtin)
  }

  // ── Binary loader ────────────────────────────────────────────────────────────

  load(binary) {
    const bin = binary instanceof Uint8Array ? binary : new Uint8Array(binary);
    if (bin.length < 8) return false;
    if (bin[0]!==0x42||bin[1]!==0x44||bin[2]!==0x42||bin[3]!==0x4E) return false;
    if (bin[4] !== 1) return false;

    let p = 6;
    const r8  = () => bin[p++];
    const r16 = () => { const v = bin[p]|(bin[p+1]<<8); p+=2; return v; };

    // Metadata block — decoded as 7-bit ASCII (no TextDecoder; works in AudioWorklet too)
    const metaLen = r16();
    this.meta = {};
    let metaStr = '';
    for (let i = 0; i < metaLen; i++) metaStr += String.fromCharCode(bin[p + i] & 0x7F);
    metaStr.split('\n').forEach(l => {
      const m = l.match(/^@(\S+)\s+(.*)/);
      if (m) this.meta[m[1]] = m[2].trim();
    });
    p += metaLen;

    // Array literal table
    const nlit = r8();
    this._lits = [];
    for (let i = 0; i < nlit; i++) {
      const len = r8();
      this._lits.push(bin.slice(p, p+len));
      p += len;
    }

    // Array declaration table (mutable pool)
    const ndecl = r8();
    this._pool   = [];
    this._poolSz = [];
    for (let i = 0; i < ndecl; i++) {
      const sz = Math.min(r16(), MAX_ARR_ELEMS);
      this._pool.push(new Int32Array(sz));
      this._poolSz.push(sz);
    }

    // Entry points + parameter slots
    this._eInit    = r16();
    this._eUpdate  = r16();  this._pUF = r8();  this._pUI = r8();
    this._eDraw    = r16();  this._pDF = r8();  this._pDI = r8();
    this._eAudio   = r16();  this._pAT = r8();

    // User function table header
    const fnCount    = r16();
    const fnTableOff = r16();

    // Bytecode stream
    this._code    = bin.slice(p);

    // Parse user-defined function table from bytecode at fnTableOff
    this._userFns = [];
    if (fnCount > 0 && fnTableOff < this._code.length) {
      let tp = fnTableOff;
      const c = this._code;
      for (let i = 0; i < fnCount; i++) {
        if (tp >= c.length) break;
        const nameLen = c[tp++];
        if (tp + nameLen + 3 > c.length) break;  // name + params + entry(u16)
        tp += nameLen;  // skip name (runtime uses entry + param_slots)
        const nparams = c[tp++];
        if (tp + 2 + nparams > c.length) break;
        const entry = c[tp] | (c[tp + 1] << 8); tp += 2;
        const paramSlots = [];
        for (let j = 0; j < nparams; j++) paramSlots.push(c[tp++]);
        this._userFns.push({ entry, paramSlots });
      }
    }

    // Reset live state
    this._globals = new Int32Array(MAX_VARS);
    this._rng     = 12345;
    this._switched = false;
    this._pending  = null;
    this.loaded    = true;
    return true;
  }

  // ── Lifecycle hooks ───────────────────────────────────────────────────────────

  callInit() {
    if (!this.loaded || this._eInit === 0xFFFF) return;
    this._run(this._eInit);
  }

  callUpdate(frame, input) {
    if (!this.loaded || this._eUpdate === 0xFFFF) return;
    this._sp(this._pUF, frame);
    this._sp(this._pUI, input);
    this._run(this._eUpdate);
  }

  callDraw(frame, input) {
    if (!this.loaded || this._eDraw === 0xFFFF) return;
    this._sp(this._pDF, frame);
    this._sp(this._pDI, input);
    this._run(this._eDraw);
  }

  // Returns the audio sample as the low 8 bits of the cart return value, or 128 on error.
  callAudio(t) {
    if (!this.loaded || this._eAudio === 0xFFFF) return 128;
    this._sp(this._pAT, t);
    try {
      const r = this._run(this._eAudio);
      return r & 0xFF;
    } catch {
      return 128;
    }
  }

  // Returns true (once) when loadcart() switched the cart.
  cartSwitched() { const v = this._switched; this._switched = false; return v; }

  // Returns a copy of globals for the audio shadow.
  globalsSnapshot() { return this._globals.slice(); }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  _sp(slot, val) { if (slot < MAX_VARS) this._globals[slot] = val | 0; }

  _elem(type, idx, i) {
    if (type === T_LIT) { const l=this._lits[idx]; return (l&&i>=0&&i<l.length) ? l[i] : 0; }
    if (type === T_MUT) { const a=this._pool[idx]; return (a&&i>=0&&i<a.length) ? a[i] : 0; }
    return 0;
  }

  _toStr(type, idx) {
    let s = '';
    if (type === T_LIT) {
      const l = this._lits[idx]; if (!l) return s;
      for (let i = 0; i < l.length; i++) { if (!l[i]) break; s += String.fromCharCode(l[i]); }
    } else if (type === T_MUT) {
      const a = this._pool[idx]; if (!a) return s;
      const sz = this._poolSz[idx];
      for (let i = 0; i < sz; i++) { if (!a[i]) break; s += String.fromCharCode(a[i] & 0x7F); }
    }
    return s;
  }

  // ── Interpreter ───────────────────────────────────────────────────────────────

  _run(entry) {
    const code = this._code;
    const G    = this._globals;

    // Per-call stack (avoids allocation on repeated calls)
    const stk  = new Array(MAX_STACK);
    const stkT = new Uint8Array(MAX_STACK);
    let ip = entry, sp = 0, done = false;
    this._exit = false;

    // Call frame stack for user-defined function returns
    const cframes = [];

    const PI  = n       => { stkT[sp] = T_INT; stk[sp++] = n | 0; };
    const PA  = (t, v)  => { stkT[sp] = t;     stk[sp++] = v; };
    const PO  = ()      => sp > 0 ? { t: stkT[--sp], v: stk[sp] } : { t: T_INT, v: 0 };
    const PK  = ()      => sp > 0 ? { t: stkT[sp-1], v: stk[sp-1] } : { t: T_INT, v: 0 };
    const R8  = ()      => code[ip++];
    const R16 = ()      => { const v = ((code[ip]|(code[ip+1]<<8))<<16)>>16; ip+=2; return v; };
    const R32 = ()      => { const v = (code[ip]|(code[ip+1]<<8)|(code[ip+2]<<16)|(code[ip+3]<<24))|0; ip+=4; return v; };

    while (!done && ip < code.length) {
      switch (code[ip++]) {

      // ── Literals ──────────────────────────────────────────────────────────────
      case OP.PUSH_INT:     PI(R32()); break;
      case OP.PUSH_ARR:     PA(T_LIT, R8()); break;
      case OP.PUSH_ARR_MUT: PA(T_MUT, R8()); break;

      // ── Variables ─────────────────────────────────────────────────────────────
      case OP.LOAD:  { const s=R8(); PI(s<MAX_VARS ? G[s] : 0); break; }
      case OP.STORE: {
        const s=R8(); const {t,v}=PO();
        // arr_ref encoding: T_LIT stored as -(litidx+1) (negative), T_MUT as mutidx (non-negative)
        if(s<MAX_VARS) G[s] = (t===T_LIT) ? -(v+1) : v|0;
        break;
      }
      case OP.LOAD_ARR: {
        // Decode arr_ref from global slot: negative → T_LIT, non-negative → T_MUT
        const s=R8(); const enc=s<MAX_VARS ? G[s] : 0;
        if(enc<0) PA(T_LIT, -(enc+1)); else PA(T_MUT, enc);
        break;
      }

      // ── Arithmetic ────────────────────────────────────────────────────────────
      case OP.ADD: { const {v:b}=PO(), {v:a}=PO(); PI(a+b);                       break; }
      case OP.SUB: { const {v:b}=PO(), {v:a}=PO(); PI(a-b);                       break; }
      case OP.MUL: { const {v:b}=PO(), {v:a}=PO(); PI(Math.imul(a,b));            break; }
      case OP.DIV: { const {v:b}=PO(), {v:a}=PO(); PI(b ? Math.trunc(a/b)|0 : 0); break; }
      case OP.MOD: { const {v:b}=PO(), {v:a}=PO(); PI(b ? a%b : 0);               break; }
      case OP.NEG: { const {v:a}=PO(); PI(-a); break; }

      // ── Bitwise ───────────────────────────────────────────────────────────────
      case OP.BAND: { const {v:b}=PO(), {v:a}=PO(); PI(a&b);          break; }
      case OP.BOR:  { const {v:b}=PO(), {v:a}=PO(); PI(a|b);          break; }
      case OP.BXOR: { const {v:b}=PO(), {v:a}=PO(); PI(a^b);          break; }
      case OP.SHL:  { const {v:b}=PO(), {v:a}=PO(); PI(a<<(b&31));    break; }
      case OP.SHR:  { const {v:b}=PO(), {v:a}=PO(); PI(a>>(b&31));    break; }

      // ── Comparison ────────────────────────────────────────────────────────────
      case OP.EQ:  { const {v:b}=PO(), {v:a}=PO(); PI(a===b?1:0); break; }
      case OP.NE:  { const {v:b}=PO(), {v:a}=PO(); PI(a!==b?1:0); break; }
      case OP.LT:  { const {v:b}=PO(), {v:a}=PO(); PI(a<b  ?1:0); break; }
      case OP.LE:  { const {v:b}=PO(), {v:a}=PO(); PI(a<=b ?1:0); break; }
      case OP.GT:  { const {v:b}=PO(), {v:a}=PO(); PI(a>b  ?1:0); break; }
      case OP.GE:  { const {v:b}=PO(), {v:a}=PO(); PI(a>=b ?1:0); break; }
      case OP.NOT: { const {v:a}=PO(); PI(a===0?1:0); break; }

      // ── Stack ─────────────────────────────────────────────────────────────────
      case OP.POP: PO(); break;
      case OP.DUP: { const {t,v}=PK(); PA(t,v); break; }

      // ── Control flow ──────────────────────────────────────────────────────────
      case OP.JUMP:        { const o=R16(); ip+=o; break; }
      case OP.JUMP_T:      { const o=R16(); const {v}=PO(); if(v!==0) ip+=o; break; }
      case OP.JUMP_F:      { const o=R16(); const {v}=PO(); if(v===0) ip+=o; break; }
      case OP.PEEK_JUMP_T: { const o=R16(); if(PK().v!==0) ip+=o; break; }
      case OP.PEEK_JUMP_F: { const o=R16(); if(PK().v===0) ip+=o; break; }

      // ── Array ops ─────────────────────────────────────────────────────────────
      case OP.ARR_GET: {
        const slot=R8(), idx=PO().v;
        const a=this._pool[slot];
        PI(a&&idx>=0&&idx<a.length ? a[idx] : 0);
        break;
      }
      case OP.ARR_SET: {
        const slot=R8(), val=PO().v|0, idx=PO().v;
        const a=this._pool[slot];
        if (a&&idx>=0&&idx<a.length) a[idx]=val;
        break;
      }
      case OP.ARR_LEN: {
        const slot=R8();
        PI(this._poolSz[slot] ?? 0);
        break;
      }

      // Dynamic arr_ref variable ops — operand is a scalar var slot, not a pool index.
      // Encoding: G[slot] < 0 → T_LIT index -(G[slot]+1), ≥ 0 → T_MUT index G[slot].
      case OP.DYN_ARR_GET: {
        const s=R8(), idx=PO().v;
        const enc=s<MAX_VARS ? G[s] : 0;
        if(enc<0) { const l=this._lits[-(enc+1)]; PI(l&&idx>=0&&idx<l.length ? l[idx] : 0); }
        else      { const a=this._pool[enc];       PI(a&&idx>=0&&idx<a.length ? a[idx] : 0); }
        break;
      }
      case OP.DYN_ARR_SET: {
        const s=R8(), val=PO().v|0, idx=PO().v;
        const enc=s<MAX_VARS ? G[s] : 0;
        if(enc>=0) { const a=this._pool[enc]; if(a&&idx>=0&&idx<a.length) a[idx]=val; }
        // read-only literal: silent no-op
        break;
      }
      case OP.DYN_ARR_LEN: {
        const s=R8();
        const enc=s<MAX_VARS ? G[s] : 0;
        if(enc<0) { const l=this._lits[-(enc+1)]; PI(l ? l.length : 0); }
        else      { PI(this._poolSz[enc] ?? 0); }
        break;
      }

      // ── Built-in call ─────────────────────────────────────────────────────────
      case OP.CALL: {
        const id=R8(), argc=R8();
        const args = [];
        for (let i=argc-1; i>=0; i--) args[i]=PO();
        const r = this._builtin(id, args);
        if (r !== undefined) PA(r.t, r.v);
        if (this._exit) done = true;
        break;
      }

      // ── User-defined function call ─────────────────────────────────────────────
      case OP.CALL_FN: {
        const fnIdx = R8() | (R8() << 8);
        const argc  = R8();
        const fn    = this._userFns[fnIdx];
        if (!fn || cframes.length >= 8) { stkT[sp]=T_INT; stk[sp++]=0; break; }
        const args = [];
        for (let i=argc-1; i>=0; i--) args[i]=PO();
        for (let i=0; i<fn.paramSlots.length; i++) {
          const slot = fn.paramSlots[i];
          if (slot < MAX_VARS && args[i]) {
            const {t, v} = args[i];
            G[slot] = (t===T_LIT) ? -(v+1) : v|0;
          }
        }
        cframes.push(ip);
        ip = fn.entry;
        break;
      }

      case OP.RET:
        if (cframes.length > 0) {
          const retT = sp > 0 ? stkT[sp-1] : T_INT;
          const retV = sp > 0 ? stk[sp-1]  : 0;
          if (sp > 0) sp--;
          ip = cframes.pop();
          stkT[sp] = retT; stk[sp++] = retV;
        } else {
          done = true;
        }
        break;
      }
    }

    return sp > 0 ? stk[sp-1] : 128;
  }

  // ── Built-in dispatcher ───────────────────────────────────────────────────────

  _builtin(id, a) {
    const I  = v => ({ t: T_INT, v: v|0 });
    const cb = this.cb;

    switch (id) {
    case B.BTN:  return I(cb.btn?.(a[0].v)  ?? 0);
    case B.BTNP: return I(cb.btnp?.(a[0].v) ?? 0);

    case B.CLS:      cb.cls?.(a[0].v);                                          break;
    case B.PSET:     cb.pset?.(a[0].v, a[1].v, a[2].v);                        break;
    case B.RECTFILL: cb.rectfill?.(a[0].v,a[1].v,a[2].v,a[3].v,a[4].v);       break;
    case B.LINE:     cb.line?.(a[0].v,a[1].v,a[2].v,a[3].v,a[4].v);           break;
    case B.PRINT: {
      const text = a[0].t === T_INT ? String(a[0].v) : this._toStr(a[0].t, a[0].v);
      cb.print?.(text, a[1].v, a[2].v, a[3].v);
      break;
    }

    case B.ABS:   return I(Math.abs(a[0].v));
    case B.MIN:   return I(a[0].v < a[1].v ? a[0].v : a[1].v);
    case B.MAX:   return I(a[0].v > a[1].v ? a[0].v : a[1].v);
    case B.CLAMP: { const [x,lo,hi]=[a[0].v,a[1].v,a[2].v]; return I(x<lo?lo:x>hi?hi:x); }
    case B.SEED:  this._rng = a[0].v >>> 0; break;
    case B.RND: {
      const n = a[0].v; if (n<=0) return I(0);
      this._rng = (Math.imul(this._rng, 1664525) + 1013904223) >>> 0;
      return I((this._rng >>> 16) % n);
    }

    case B.STREQ: {
      for (let i=0; i<=MAX_ARR_ELEMS; i++) {
        const ea=this._elem(a[0].t,a[0].v,i), eb=this._elem(a[1].t,a[1].v,i);
        if (ea!==eb) return I(0);
        if (ea===0)  return I(1);
      }
      return I(0);
    }
    case B.ARREQ: {
      const len=a[2].v;
      for (let i=0; i<len; i++)
        if (this._elem(a[0].t,a[0].v,i)!==this._elem(a[1].t,a[1].v,i)) return I(0);
      return I(1);
    }

    case B.SAVE:      cb.save?.(a[0].v, a[1].v);         break;
    case B.LOAD_SLOT: return I(cb.load?.(a[0].v) ?? 0);

    case B.CARTCOUNT: return I(cb.cartcount?.() ?? 0);
    case B.CARTMETA: {
      const field  = this._toStr(a[1].t, a[1].v);
      const val    = cb.cartmeta?.(a[0].v, field) ?? '';
      let written  = 0;
      if (a[2].t === T_MUT) {
        const arr = this._pool[a[2].v];
        if (arr) {
          const sz = this._poolSz[a[2].v];
          while (written < sz-1 && val[written]) {
            arr[written] = val.charCodeAt(written);
            written++;
          }
          if (written < sz) arr[written] = 0;
        }
      }
      return I(written);
    }
    case B.LOADCART: {
      const binary = cb.loadcart?.(a[0].v);
      if (binary) {
        this._pending  = binary;
        this._switched = true;
        this._exit     = true;
      } else {
        return I(0);
      }
      break;
    }
    }
    return undefined;
  }
}
