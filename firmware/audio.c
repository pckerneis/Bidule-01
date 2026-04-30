#include "audio.h"
#include "pico/stdlib.h"
#include "pico/multicore.h"
#include "hardware/pwm.h"

// 8000 Hz → 125 µs per sample
#define SAMPLE_PERIOD_US 125

static volatile int (*audio_cb)(int t) = NULL;

static void core1_entry(void) {
    uint32_t t = 0;
    for (;;) {
        uint32_t next = time_us_32() + SAMPLE_PERIOD_US;

        int (*cb)(int) = audio_cb;
        int sample = cb ? (cb((int)t) & 255) : 128;
        pwm_set_gpio_level(AUDIO_PIN, (uint16_t)sample);
        t++;

        // busy-wait for the remainder of the sample period
        while ((int32_t)(time_us_32() - next) < 0) tight_loop_contents();
    }
}

void audio_init(void) {
    gpio_set_function(AUDIO_PIN, GPIO_FUNC_PWM);
    uint slice = pwm_gpio_to_slice_num(AUDIO_PIN);
    pwm_config cfg = pwm_get_default_config();
    // wrap=255 → 8-bit resolution; clkdiv=1 → PWM freq ≈ 488 kHz >> audio range
    pwm_config_set_wrap(&cfg, 255);
    pwm_config_set_clkdiv(&cfg, 1.0f);
    pwm_init(slice, &cfg, true);
    pwm_set_gpio_level(AUDIO_PIN, 128); // silence (midpoint)

    multicore_launch_core1(core1_entry);
}

void audio_set_callback(int (*fn)(int t)) {
    audio_cb = fn;
}
