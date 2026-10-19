/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
/* vdoninja-signal [port]: local VDO.Ninja-compatible signaling server (default 8080). */
#include "vdoninja.h"

#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#ifdef _WIN32
#include <windows.h>
#define sleep_ms(ms) Sleep(ms)
#else
#include <unistd.h>
#define sleep_ms(ms) usleep((ms) * 1000)
#endif

static volatile sig_atomic_t running = 1;
static void on_signal(int sig) { (void)sig; running = 0; }

int main(int argc, char **argv) {
    int port = argc > 1 ? atoi(argv[1]) : 8080;
    vdon_signal_server *server = vdon_signal_server_create((uint16_t)port);
    if (!server) {
        fprintf(stderr, "failed to start signaling server on port %d\n", port);
        return 1;
    }
    printf("vdoninja-signal listening on ws://0.0.0.0:%d\n", vdon_signal_server_port(server));
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);
    while (running)
        sleep_ms(200);
    vdon_signal_server_destroy(server);
    return 0;
}
