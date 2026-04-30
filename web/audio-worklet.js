// Bidule 01 — AudioWorklet processor
// Loaded as an ES-module worklet via AudioWorklet.addModule().
// Receives messages from the main thread:
//   { type: 'load',    binary: Uint8Array }   — new cart binary
//   { type: 'globals', data: Int32Array   }   — end-of-frame globals snapshot

import { VM, MAX_VARS } from './vm.js';

// The cart's audio callback runs at 22 050 Hz regardless of the AudioContext
// sample rate. We use a phase accumulator to advance `t` at exactly that rate.
const CART_HZ = 22050;

class BiduleAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._vm    = new VM({});   // audio-only VM — no display/input callbacks
    this._t     = 0;            // sample counter at CART_HZ
    this._phase = 0;            // fractional phase accumulator

    this.port.onmessage = ({ data }) => {
      if (data.type === 'load') {
        this._vm.load(data.binary);
        this._t = 0;
        this._phase = 0;
      } else if (data.type === 'globals') {
        // Apply the end-of-frame globals snapshot (shadow copy equivalent).
        // Only copy the integer globals; audio t-param will be overwritten by
        // callAudio() before execution, so no slot-collision concern.
        if (this._vm.loaded) {
          this._vm._globals.set(data.globals.subarray(0, MAX_VARS));
        }
      }
    };
  }

  process(_inputs, outputs) {
    const ch = outputs[0]?.[0];
    if (!ch) return true;

    if (!this._vm.loaded) {
      ch.fill(0);
      return true;
    }

    const rate = sampleRate; // AudioWorkletGlobalScope.sampleRate
    for (let i = 0; i < ch.length; i++) {
      // Call audio(t) and convert [0,255] → [-1.0, 1.0]
      const s = this._vm.callAudio(this._t);
      ch[i] = ((s & 0xFF) - 128) / 128;

      // Advance t at CART_HZ regardless of the context sample rate.
      this._phase += CART_HZ;
      if (this._phase >= rate) {
        this._phase -= rate;
        this._t = (this._t + 1) >>> 0; // wraps at 2^32
      }
    }
    return true;
  }
}

registerProcessor('bidule-audio', BiduleAudioProcessor);
