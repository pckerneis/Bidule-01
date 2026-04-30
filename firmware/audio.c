#include "audio.h"
#include "pico/stdlib.h"
#include "hardware/pwm.h"

// Negative delay: fire at a fixed absolute rate, compensating for callback duration.
#define SAMPLE_PERIOD_US (-125)  // 8000 Hz

static volatile int (*audio_cb)(int t) = NULL;
static int32_t audio_t = 0;
static struct repeating_timer audio_timer;

static bool timer_cb(struct repeating_timer *rt) {
    (void)rt;
    int (*cb)(int) = audio_cb;
    int32_t t = audio_t++;
    int sample = cb ? cb(t) : 128;
    sample = sample < 0 ? 0 : sample > 255 ? 255 : sample;
    pwm_set_gpio_level(AUDIO_PIN, (uint16_t)sample);
    return true;
}

void audio_init(void) {
    gpio_set_function(AUDIO_PIN, GPIO_FUNC_PWM);
    gpio_set_drive_strength(AUDIO_PIN, GPIO_DRIVE_STRENGTH_12MA);
    uint slice = pwm_gpio_to_slice_num(AUDIO_PIN);
    pwm_config cfg = pwm_get_default_config();
    pwm_config_set_wrap(&cfg, 255);
    pwm_config_set_clkdiv(&cfg, 1.0f);
    pwm_init(slice, &cfg, true);
    pwm_set_gpio_level(AUDIO_PIN, 128);

    add_repeating_timer_us(SAMPLE_PERIOD_US, timer_cb, NULL, &audio_timer);
}

void audio_set_callback(int (*fn)(int t)) {
    audio_cb = fn;
}

void audio_reset_t(void) {
    audio_t = 0;
}
