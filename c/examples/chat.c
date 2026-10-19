/*
 * Data-only chat over VDO.Ninja. Two or more instances in the same room find
 * each other automatically (half mesh) and exchange messages typed on stdin.
 *
 *   vdon_chat --room myroom [--password pw] [--name alice] [--host ws://127.0.0.1:8080]
 *
 * Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MIT
 */
#include <vdoninja.h>

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char *g_name = "anon";

static void on_event(vdon_sdk *sdk, const vdon_event *ev, void *user) {
    (void)sdk;
    (void)user;
    switch (ev->type) {
    case VDON_EVENT_CONNECTED: printf("* connected to signaling\n"); break;
    case VDON_EVENT_ROOM_JOINED: printf("* joined room, listing: %s\n", ev->json ? ev->json : "[]"); break;
    case VDON_EVENT_DATA_CHANNEL_OPEN: printf("* channel open with %s (%s)\n", ev->uuid, ev->connection_type); break;
    case VDON_EVENT_PEER_DISCONNECTED: printf("* %s left\n", ev->uuid); break;
    case VDON_EVENT_DATA_RECEIVED: printf("<%s> %s\n", ev->uuid ? ev->uuid : "?", ev->json); break;
    case VDON_EVENT_PEER_LATENCY: printf("* %s latency %lld ms\n", ev->uuid, (long long)ev->number); break;
    case VDON_EVENT_RECONNECTING: printf("* reconnecting (attempt %lld)\n", (long long)ev->number); break;
    case VDON_EVENT_ERROR:
    case VDON_EVENT_ALERT: printf("* %s: %s\n", vdon_event_name(ev->type), ev->message ? ev->message : ""); break;
    default: break;
    }
}

int main(int argc, char **argv) {
    vdon_options o;
    vdon_sdk *sdk;
    const char *room = "vdon-c-chat";
    char line[1024], sid[64];
    int i, rc;
    vdon_options_init(&o);
    for (i = 1; i + 1 < argc; i += 2) {
        if (!strcmp(argv[i], "--room"))
            room = argv[i + 1];
        else if (!strcmp(argv[i], "--password"))
            o.password = argv[i + 1];
        else if (!strcmp(argv[i], "--name"))
            g_name = argv[i + 1];
        else if (!strcmp(argv[i], "--host"))
            o.host = argv[i + 1];
    }
    o.label = g_name;
    sdk = vdon_create(&o, on_event, NULL);
    rc = vdon_auto_connect(sdk, room, NULL, 0, 10000, sid, sizeof(sid));
    if (rc != VDON_OK) {
        fprintf(stderr, "autoConnect failed: %s\n", vdon_strerror(rc));
        vdon_destroy(sdk);
        return 1;
    }
    printf("* publishing as %s in room %s; type messages, /ping, or /quit\n", sid, room);
    while (fgets(line, sizeof(line), stdin)) {
        char msg[1200];
        size_t n = strlen(line);
        while (n && (line[n - 1] == '\n' || line[n - 1] == '\r'))
            line[--n] = 0;
        if (!n)
            continue;
        if (!strcmp(line, "/quit"))
            break;
        if (!strcmp(line, "/ping")) {
            vdon_send_ping(sdk, NULL);
            continue;
        }
        /* naive JSON string escaping for the demo */
        {
            char esc[1100];
            size_t j = 0, k;
            for (k = 0; k < n && j < sizeof(esc) - 3; k++) {
                if (line[k] == '"' || line[k] == '\\')
                    esc[j++] = '\\';
                esc[j++] = line[k];
            }
            esc[j] = 0;
            snprintf(msg, sizeof(msg), "{\"from\":\"%s\",\"text\":\"%s\"}", g_name, esc);
        }
        if (vdon_send_data(sdk, msg, NULL) != VDON_OK)
            printf("* no peers connected yet\n");
    }
    vdon_destroy(sdk);
    return 0;
}
