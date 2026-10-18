/*
 * interop: the C peer of the cross-language interoperability test
 * (spec/interop/run_interop.py). Publisher: announces a data-only stream and
 * echoes probes. Viewer: views, sends a probe, waits for the echo and performs
 * one request/response round trip.
 *
 *   vdon_interop --role publish --stream s1 --host ws://127.0.0.1:8080
 *   vdon_interop --role view --stream s1 --host ws://127.0.0.1:8080
 *
 * Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MIT
 */
#include <vdoninja.h>

#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static char peer[128];
static char echo_text[512];
static int dc_open;

static void on_event(vdon_sdk *sdk, const vdon_event *ev, void *user) {
    int publisher = *(int *)user;
    if (ev->type == VDON_EVENT_DATA_CHANNEL_OPEN) {
        pthread_mutex_lock(&lock);
        snprintf(peer, sizeof(peer), "%s", ev->uuid);
        dc_open = 1;
        pthread_mutex_unlock(&lock);
    } else if (ev->type == VDON_EVENT_DATA_RECEIVED && ev->json) {
        if (publisher && strstr(ev->json, "\"probe\"")) {
            char reply[600];
            const char *p = strstr(ev->json, "\"probe\":"), *q;
            p += 8;
            while (*p == ' ')
                p++;
            q = p;
            if (*q == '"') {
                q++;
                while (*q && *q != '"')
                    q++;
                snprintf(reply, sizeof(reply), "{\"echo\":%.*s,\"lang\":\"c\"}", (int)(q - p + 1), p);
            } else {
                while (*q && *q != ',' && *q != '}')
                    q++;
                snprintf(reply, sizeof(reply), "{\"echo\":%.*s,\"lang\":\"c\"}", (int)(q - p), p);
            }
            vdon_send_data(sdk, reply, ev->uuid);
        } else if (!publisher && strstr(ev->json, "\"echo\"")) {
            pthread_mutex_lock(&lock);
            snprintf(echo_text, sizeof(echo_text), "%s", ev->json);
            pthread_mutex_unlock(&lock);
        }
    }
}

static char *whoami(vdon_sdk *sdk, const char *request_json, const char *from, void *user) {
    char *out = (char *)malloc(strlen(request_json) + 40);
    (void)sdk;
    (void)from;
    (void)user;
    sprintf(out, "{\"lang\":\"c\",\"got\":%s}", request_json);
    return out;
}

static void sleep_ms(int ms) {
    struct timespec ts = {ms / 1000, (long)(ms % 1000) * 1000000L};
    nanosleep(&ts, NULL);
}

int main(int argc, char **argv) {
    vdon_options o;
    vdon_sdk *sdk;
    const char *role = "view", *stream = "interop";
    int publisher, i, rc, waited;
    char probe[64], msg[128], *resp = NULL;
    vdon_options_init(&o);
    o.host = "wss://wss.vdo.ninja";
    for (i = 1; i + 1 < argc; i += 2) {
        if (!strcmp(argv[i], "--role"))
            role = argv[i + 1];
        else if (!strcmp(argv[i], "--stream"))
            stream = argv[i + 1];
        else if (!strcmp(argv[i], "--host"))
            o.host = argv[i + 1];
        else if (!strcmp(argv[i], "--password"))
            o.password = argv[i + 1];
        else if (!strcmp(argv[i], "--debug"))
            o.debug = atoi(argv[i + 1]);
    }
    o.label = "c";
    publisher = strcmp(role, "publish") == 0;
    sdk = vdon_create(&o, on_event, &publisher);
    if ((rc = vdon_connect(sdk, 20000)) != VDON_OK) {
        printf("FAIL connect: %s\n", vdon_strerror(rc));
        return 1;
    }
    if (publisher) {
        vdon_on_request(sdk, "whoami", whoami, NULL);
        if ((rc = vdon_announce(sdk, stream, NULL, NULL, 0)) != VDON_OK) {
            printf("FAIL announce: %s\n", vdon_strerror(rc));
            return 1;
        }
        printf("READY\n");
        fflush(stdout);
        for (;;)
            pause();
    }
    rc = vdon_view(sdk, stream, NULL, 30000);
    if (rc != VDON_OK) {
        printf("FAIL view: %s\n", vdon_strerror(rc));
        return 1;
    }
    for (waited = 0; waited < 20000; waited += 50) {
        int open;
        pthread_mutex_lock(&lock);
        open = dc_open;
        pthread_mutex_unlock(&lock);
        if (open)
            break;
        sleep_ms(50);
    }
    if (waited >= 20000) {
        printf("FAIL control channel never opened\n");
        return 1;
    }
    snprintf(probe, sizeof(probe), "c-%ld", (long)(time(NULL) % 100000));
    snprintf(msg, sizeof(msg), "{\"probe\":\"%s\"}", probe);
    vdon_send_data(sdk, msg, peer);
    for (waited = 0; waited < 15000; waited += 50) {
        int got;
        pthread_mutex_lock(&lock);
        got = echo_text[0] != 0;
        pthread_mutex_unlock(&lock);
        if (got)
            break;
        sleep_ms(50);
    }
    if (!echo_text[0] || !strstr(echo_text, probe)) {
        printf("FAIL no echo (%s)\n", echo_text);
        return 1;
    }
    printf("OK echo %s\n", echo_text);
    rc = vdon_request(sdk, "whoami", "{\"q\":1}", peer, 10000, &resp);
    if (rc != VDON_OK) {
        printf("FAIL request: %s %s\n", vdon_strerror(rc), resp ? resp : "");
        return 1;
    }
    printf("OK rpc %s\n", resp);
    vdon_free(resp);
    vdon_disconnect(sdk);
    vdon_destroy(sdk);
    return 0;
}
