#include "pico/stdlib.h"
#include "display.h"
#include "input.h"
#include "audio.h"
#include "cart.h"
#include "runtime/vm.h"
#include "tusb.h"

#if defined(CYW43_WL_GPIO_LED_PIN)
#include "pico/cyw43_arch.h"
#define LED_INIT()  cyw43_arch_init()
#define LED_ON()    cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, 1)
#define LED_OFF()   cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, 0)
#else
#define LED_INIT()  do { gpio_init(PICO_DEFAULT_LED_PIN); gpio_set_dir(PICO_DEFAULT_LED_PIN, GPIO_OUT); } while(0)
#define LED_ON()    gpio_put(PICO_DEFAULT_LED_PIN, 1)
#define LED_OFF()   gpio_put(PICO_DEFAULT_LED_PIN, 0)
#endif

#define TARGET_FPS      30
#define FRAME_PERIOD_MS (1000 / TARGET_FPS)

// --- Cart loading ------------------------------------------------------------

static bool try_load_cart(const char *name) {
    uint32_t size;
    const uint8_t *bin = cart_find_by_name(name, &size);
    return bin && vm_load(bin, size);
}

static void wait_any_button(void) {
    for (;;) {
        input_update();
        for (int i = 0; i < BTN_COUNT; i++)
            if (input_btnp(i)) return;
        sleep_ms(16);
    }
}

static bool is_any_button_pressed() {
    input_update();

    for (int i = 0; i < BTN_COUNT; i++)
        if (input_btnp(i)) return true;

    return false;
}

// --- Boot sequence (§5.1) ----------------------------------------------------

int main(void) {
    stdio_init_all();
    LED_INIT();
    LED_ON();

    // §5.1 step 1: initialise subsystems
    display_init();
    input_init();
    audio_init();

    // USB mode: if a button is held on boot, enter USB mass storage mode
    void usb_msc_flush(void);
    if (is_any_button_pressed()) {
        // Check that the pre-baked filesystem reached flash.
        // Expected: 0xEB at byte 0, 0x55 0xAA at bytes 510-511.
        const volatile uint8_t *fs = (const volatile uint8_t *)0x10080000u;
        bool fs_ok = (fs[0] == 0xEB && fs[510] == 0x55 && fs[511] == 0xAA);

        display_cls(0);
        display_print(2,  4, "USB Storage Mode", 1);
        display_print(2, 14, fs_ok ? "FS: OK" : "FS: MISSING", 1);
        display_print(2, 24, fs_ok ? "Connect USB cable" : "", 1);
        display_print(2, 34, fs_ok ? "to your computer." : "", 1);
        display_flush();

        tusb_init();
        for (;;) {
            usb_msc_flush(); // flush before tud_task so cache is clean on next write
            tud_task();
        }
        // never returns
    }

    // §5.1 step 2: attempt to load boot.bdb
    if (!try_load_cart("boot.bdb")) {
        // §5.1 step 3: show error, wait for button, fall back to built-in loader
        display_cls(0);
        display_print(2,  4, "No boot cart found.", 1);
        display_print(2, 20, "Press any button", 1);
        display_print(2, 30, "to continue.", 1);
        display_flush();
        wait_any_button();

        // TODO: load built-in cart selector
    }

    // §5.1 steps 4-5: init global table, call init()
    audio_set_callback(vm_call_audio);
    vm_call_init();
    audio_reset_t();

    // §5.2 main loop
    int frame = 0;
    for (;;) {
        absolute_time_t frame_end = make_timeout_time_ms(FRAME_PERIOD_MS);

        // poll input
        input_update();
        uint8_t mask = input_mask();

        // run cart
        vm_call_update(frame, mask);
        vm_call_draw(frame, mask);
        display_flush();

        // update audio shadow buffer after draw (§5.3)
        vm_sync_audio_shadow();

        if (vm_cart_switched()) {
            vm_call_init();
            audio_reset_t();
            frame = 0;
        } else {
            frame++;
        }

        sleep_until(frame_end);
    }
}
