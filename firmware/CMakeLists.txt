# Generated Cmake Pico project file

cmake_minimum_required(VERSION 3.13)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# Initialise pico_sdk from installed location
# (note this can come from environment, CMake cache etc)

# == DO NOT EDIT THE FOLLOWING LINES for the Raspberry Pi Pico VS Code Extension to work ==
if(WIN32)
    set(USERHOME $ENV{USERPROFILE})
else()
    set(USERHOME $ENV{HOME})
endif()
set(sdkVersion 2.2.0)
set(toolchainVersion 14_2_Rel1)
set(picotoolVersion 2.2.0-a4)
set(picoVscode ${USERHOME}/.pico-sdk/cmake/pico-vscode.cmake)
if (EXISTS ${picoVscode})
    include(${picoVscode})
endif()
# ====================================================================================
set(PICO_BOARD pico_w CACHE STRING "Board type")

# Pull in Raspberry Pi Pico SDK (must be before project)
include(pico_sdk_import.cmake)

project(bidule-01 C CXX ASM)

# Initialise the Raspberry Pi Pico SDK
pico_sdk_init()

# Generate the FAT12 filesystem image as a C source file before compiling.
# The C file places the image in .flash_fs which is pinned to 0x10040000
# by the linker options below, so picotool includes it in the normal UF2.
find_package(Python3 REQUIRED)
find_program(DENO_EXECUTABLE deno
    HINTS "$ENV{USERPROFILE}/.deno/bin" "$ENV{HOME}/.deno/bin"
    REQUIRED
)
set(FS_IMAGE_C ${CMAKE_CURRENT_BINARY_DIR}/fs_image.c)
set(CARTS_DIR  ${CMAKE_CURRENT_SOURCE_DIR}/../carts)
set(COMPILER_CLI ${CMAKE_CURRENT_SOURCE_DIR}/../compiler/cli.js)
set(COMPILER_JS  ${CMAKE_CURRENT_SOURCE_DIR}/../compiler/compiler.js)

# Compile every .bdcart → .bdb; CONFIGURE_DEPENDS re-runs CMake when the
# glob result changes (i.e. a .bdcart is added or removed).
file(GLOB BDCART_FILES CONFIGURE_DEPENDS "${CARTS_DIR}/*.bdcart")

set(BDB_FILES "")
foreach(CART_SRC ${BDCART_FILES})
    get_filename_component(CART_STEM "${CART_SRC}" NAME_WE)
    set(CART_OUT "${CARTS_DIR}/${CART_STEM}.bdb")
    add_custom_command(
        OUTPUT  "${CART_OUT}"
        COMMAND ${DENO_EXECUTABLE} run --allow-read --allow-write "${COMPILER_CLI}" "${CART_SRC}" "${CART_OUT}"
        DEPENDS "${CART_SRC}" "${COMPILER_CLI}" "${COMPILER_JS}"
        COMMENT "Compiling ${CART_STEM}.bdcart"
        VERBATIM
    )
    list(APPEND BDB_FILES "${CART_OUT}")
endforeach()

add_custom_command(
    OUTPUT ${FS_IMAGE_C}
    COMMAND ${Python3_EXECUTABLE}
        ${CMAKE_CURRENT_SOURCE_DIR}/../tools/gen_fs.py
        ${FS_IMAGE_C}
        ${BDB_FILES}
    DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/../tools/gen_fs.py
            ${BDB_FILES}
    COMMENT "Generating FAT12 filesystem image"
    VERBATIM
)

add_executable(bidule-01
        main.c
        usb_msc.c
        display.c
        input.c
        audio.c
        cart.c
        runtime/vm.c
        ${FS_IMAGE_C}
)

pico_set_program_name(bidule-01 "bidule-01")
pico_set_program_version(bidule-01 "0.1")

pico_enable_stdio_usb(bidule-01 0)
pico_enable_stdio_uart(bidule-01 1)

target_link_libraries(bidule-01
        pico_stdlib
        tinyusb_device
        tinyusb_board)

target_include_directories(bidule-01 PRIVATE
        ${CMAKE_CURRENT_LIST_DIR}
)

target_link_libraries(bidule-01
        hardware_i2c
        hardware_pwm
        hardware_flash
)

if (PICO_CYW43_SUPPORTED)
    target_link_libraries(bidule-01 pico_cyw43_arch_none)
endif()

pico_add_extra_outputs(bidule-01)

# Pin .flash_fs to 0x10040000 (XIP_BASE + FLASH_DISK_OFFSET).
# picotool sees this as a separate ELF load segment and writes it to flash
# as part of the normal bidule-01.uf2 — no UF2 merging needed.
# -u flash_fs_image prevents --gc-sections from discarding the section.
target_link_options(bidule-01 PRIVATE
    "-Wl,--section-start=.flash_fs=0x10080000"
    "-Wl,-u,flash_fs_image"
)

