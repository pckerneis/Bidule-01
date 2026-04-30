#pragma once
#include <stdint.h>

// PWM audio output pin (§7.4 — GPIO TBD, using GP28 as placeholder)
#define AUDIO_PIN 28

void audio_init(void);

// Set the per-sample callback invoked from core 1 at 8000 Hz.
// Returns an unsigned 8-bit sample value [0, 255].
void audio_set_callback(int (*fn)(int t));
