#pragma once
#include <stdint.h>

#define AUDIO_PIN 0  // GP0, PWM slice 0 channel A

void audio_init(void);

// Set the per-sample callback invoked from core 1 at 8000 Hz.
// Returns an unsigned 8-bit sample value [0, 255].
void audio_set_callback(int (*fn)(int t));
void audio_reset_t(void);
