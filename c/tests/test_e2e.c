/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
/* End-to-end tests over the built-in signaling server: two SDK instances in one process. */
#include "vdon_internal.h"
#include "vdoninja.h"

#include <cJSON.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define MAX_EVENTS 4096

typedef struct rec_event {
    vdon_event_type type;
    char *uuid, *json, *label, *message, *connection_type, *stream_id, *file_id;
    int64_t number;
    int flag, track, channel;
    uint8_t *bytes;
    size_t size;
} rec_event;

typedef struct recorder {
    const char *name;
    pthread_mutex_t lock;
    pthread_cond_t cond;
    rec_event ev[MAX_EVENTS];
    int count;
    int slow_file_header;
    int delayed_headers;
} recorder;

static int failures = 0;
static int verbose = 0;

static void sleep_ms(int ms) {
    struct timespec ts;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (long)(ms % 1000) * 1000000L;
    nanosleep(&ts, NULL);
}

#define CHECK(cond, ...)                                                                                               \
    do {                                                                                                               \
        if (!(cond)) {                                                                                                 \
            failures++;                                                                                                \
            fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__);                                                       \
            fprintf(stderr, __VA_ARGS__);                                                                              \
            fputc('\n', stderr);                                                                                       \
        }                                                                                                              \
    } while (0)

static void rec_init(recorder *r, const char *name) {
    memset(r, 0, sizeof(*r));
    r->name = name;
    pthread_mutex_init(&r->lock, NULL);
    pthread_cond_init(&r->cond, NULL);
}

static void rec_free(recorder *r) {
    int i;
    for (i = 0; i < r->count; i++) {
        free(r->ev[i].uuid);
        free(r->ev[i].json);
        free(r->ev[i].label);
        free(r->ev[i].message);
        free(r->ev[i].connection_type);
        free(r->ev[i].stream_id);
        free(r->ev[i].file_id);
        free(r->ev[i].bytes);
    }
    pthread_mutex_destroy(&r->lock);
    pthread_cond_destroy(&r->cond);
}

static void on_event(vdon_sdk *sdk, const vdon_event *ev, void *user) {
    recorder *r = (recorder *)user;
    rec_event *e;
    int slow_file_header;
    (void)sdk;
    pthread_mutex_lock(&r->lock);
    slow_file_header = r->slow_file_header;
    if (slow_file_header && ev->type == VDON_EVENT_FILE_TRANSFER_START &&
        ev->direction && strcmp(ev->direction, "inbound") == 0)
        r->delayed_headers++;
    pthread_mutex_unlock(&r->lock);
    if (slow_file_header && ev->type == VDON_EVENT_FILE_TRANSFER_START &&
        ev->direction && strcmp(ev->direction, "inbound") == 0)
        sleep_ms(1000); /* let request_file time out with its channel still active */
    if (verbose && ev->type != VDON_EVENT_RTP && ev->type != VDON_EVENT_FILE_TRANSFER_PROGRESS)
        fprintf(stderr, "[%s] %s uuid=%s label=%s json=%.120s msg=%s\n", r->name, vdon_event_name(ev->type),
                ev->uuid ? ev->uuid : "-", ev->label ? ev->label : "-", ev->json ? ev->json : "-",
                ev->message ? ev->message : "-");
    pthread_mutex_lock(&r->lock);
    if (r->count < MAX_EVENTS) {
        e = &r->ev[r->count++];
        memset(e, 0, sizeof(*e));
        e->type = ev->type;
        e->uuid = vdon_strdup(ev->uuid);
        e->json = vdon_strdup(ev->json);
        e->label = vdon_strdup(ev->label);
        e->message = vdon_strdup(ev->message);
        e->connection_type = vdon_strdup(ev->connection_type);
        e->stream_id = vdon_strdup(ev->stream_id);
        e->file_id = vdon_strdup(ev->file_id);
        e->number = ev->number;
        e->flag = ev->flag;
        e->track = ev->track;
        e->channel = ev->channel;
        if (ev->bytes && ev->size) {
            e->bytes = (uint8_t *)malloc(ev->size);
            memcpy(e->bytes, ev->bytes, ev->size);
            e->size = ev->size;
        }
    }
    pthread_cond_broadcast(&r->cond);
    pthread_mutex_unlock(&r->lock);
}

static int ts_wait(recorder *r, int64_t deadline) {
    struct timespec ts;
    ts.tv_sec = (time_t)(deadline / 1000);
    ts.tv_nsec = (long)(deadline % 1000) * 1000000L;
    return pthread_cond_timedwait(&r->cond, &r->lock, &ts) == 0;
}

/* Waits for the n-th (0-based) event of a type whose connection_type matches (NULL = any). Returns index or -1. */
static int wait_event_n(recorder *r, vdon_event_type type, const char *ctype, int nth, int timeout_ms) {
    int64_t deadline = vdon_now_ms() + timeout_ms;
    pthread_mutex_lock(&r->lock);
    for (;;) {
        int i, seen = 0;
        for (i = 0; i < r->count; i++)
            if (r->ev[i].type == type && (!ctype || (r->ev[i].connection_type && strcmp(r->ev[i].connection_type, ctype) == 0))) {
                if (seen++ == nth) {
                    pthread_mutex_unlock(&r->lock);
                    return i;
                }
            }
        if (vdon_now_ms() >= deadline || !ts_wait(r, deadline)) {
            pthread_mutex_unlock(&r->lock);
            return -1;
        }
    }
}

static int wait_event(recorder *r, vdon_event_type type, int timeout_ms) { return wait_event_n(r, type, NULL, 0, timeout_ms); }

static int count_events(recorder *r, vdon_event_type type) {
    int i, n = 0;
    pthread_mutex_lock(&r->lock);
    for (i = 0; i < r->count; i++)
        if (r->ev[i].type == type)
            n++;
    pthread_mutex_unlock(&r->lock);
    return n;
}

/* Waits until an event of the type with json containing needle exists. */
static int wait_event_json(recorder *r, vdon_event_type type, const char *needle, int timeout_ms) {
    int64_t deadline = vdon_now_ms() + timeout_ms;
    pthread_mutex_lock(&r->lock);
    for (;;) {
        int i;
        for (i = 0; i < r->count; i++)
            if (r->ev[i].type == type && r->ev[i].json && strstr(r->ev[i].json, needle)) {
                pthread_mutex_unlock(&r->lock);
                return i;
            }
        if (vdon_now_ms() >= deadline || !ts_wait(r, deadline)) {
            pthread_mutex_unlock(&r->lock);
            return -1;
        }
    }
}

static char *echo_handler(vdon_sdk *sdk, const char *request_json, const char *from_uuid, void *user) {
    char *out = (char *)malloc(strlen(request_json) + 64);
    (void)sdk;
    (void)from_uuid;
    (void)user;
    sprintf(out, "{\"echo\":%s,\"ok\":true}", request_json);
    return out;
}

static vdon_sdk *make_sdk(const char *url, recorder *rec, int no_password, const char *label) {
    vdon_options o;
    static const char *stun[1];
    vdon_options_init(&o);
    o.host = url;
    o.turn_mode = VDON_TURN_DISABLED;
    o.stun_servers = stun; /* no STUN: host candidates only (loopback) */
    o.stun_server_count = 0;
    o.no_password = no_password;
    o.label = label;
    o.debug = verbose;
    o.connection_timeout_ms = 15000;
    return vdon_create(&o, on_event, rec);
}

static void test_data(const char *url) {
    recorder ra, rb;
    vdon_sdk *a, *b;
    int rc, i;
    char sid[64];
    const char *peer_b = NULL, *peer_a = NULL;
    printf("== data round trip\n");
    rec_init(&ra, "A");
    rec_init(&rb, "B");
    a = make_sdk(url, &ra, 0, "Publisher A");
    b = make_sdk(url, &rb, 0, NULL);
    CHECK(vdon_connect(a, 5000) == VDON_OK, "A connect");
    CHECK(vdon_connect(b, 5000) == VDON_OK, "B connect");
    CHECK(vdon_announce(a, "alpha_stream", NULL, sid, sizeof(sid)) == VDON_OK, "announce");
    CHECK(strcmp(sid, "alpha_stream") == 0, "stream id %s", sid);
    vdon_on_request(a, "echo", echo_handler, NULL);
    rc = vdon_view(b, "alpha_stream", NULL, 10000);
    CHECK(rc == VDON_OK, "view rc=%d (%s)", rc, vdon_strerror(rc));
    i = wait_event(&ra, VDON_EVENT_DATA_CHANNEL_OPEN, 15000);
    CHECK(i >= 0, "A data channel open");
    if (i >= 0)
        peer_b = ra.ev[i].uuid;
    i = wait_event(&rb, VDON_EVENT_DATA_CHANNEL_OPEN, 15000);
    CHECK(i >= 0, "B data channel open");
    if (i >= 0)
        peer_a = rb.ev[i].uuid;
    CHECK(wait_event(&ra, VDON_EVENT_PEER_CONNECTED, 15000) >= 0, "A peer connected");
    /* viewer receives publisher info (label) */
    i = wait_event_json(&rb, VDON_EVENT_PEER_INFO, "Publisher A", 5000);
    CHECK(i >= 0, "B received publisher label");

    /* data both ways */
    CHECK(vdon_send_data(b, "{\"hello\":\"from-b\"}", NULL) == VDON_OK, "B send");
    CHECK(wait_event_json(&ra, VDON_EVENT_DATA_RECEIVED, "from-b", 5000) >= 0, "A received data");
    CHECK(vdon_send_data(a, "{\"hello\":\"from-a\"}", peer_b) == VDON_OK, "A send");
    CHECK(wait_event_json(&rb, VDON_EVENT_DATA_RECEIVED, "from-a", 5000) >= 0, "B received data");
    CHECK(vdon_send_data(a, "\"plain string\"", NULL) == VDON_OK, "A send string");
    CHECK(wait_event_json(&rb, VDON_EVENT_DATA_RECEIVED, "plain string", 5000) >= 0, "B received string");

    /* request / response */
    {
        char *resp = NULL;
        rc = vdon_request(b, "echo", "{\"n\":42}", peer_a, 5000, &resp);
        CHECK(rc == VDON_OK, "request rc=%d", rc);
        CHECK(resp && strstr(resp, "\"n\":42") && strstr(resp, "\"ok\":true"), "response %s", resp ? resp : "(null)");
        vdon_free(resp);
        rc = vdon_request(b, "missing", "{}", peer_a, 500, &resp);
        CHECK(rc == VDON_ERR_TIMEOUT, "unknown request type should time out, rc=%d", rc);
        vdon_free(resp);
    }

    /* pub/sub */
    CHECK(vdon_subscribe(a, "news") == VDON_OK, "subscribe");
    CHECK(wait_event_json(&rb, VDON_EVENT_PEER_SUBSCRIBED, "news", 5000) >= 0, "B saw subscription");
    CHECK(vdon_publish_to_channel(b, "news", "{\"headline\":\"hi\"}", NULL) == VDON_OK, "publish");
    i = wait_event_json(&ra, VDON_EVENT_CHANNEL_MESSAGE, "headline", 5000);
    CHECK(i >= 0 && strcmp(ra.ev[i].label, "news") == 0, "A channel message");
    CHECK(vdon_publish_to_channel(b, "other", "{\"x\":1}", NULL) == VDON_OK, "publish other");
    sleep_ms(200);
    CHECK(count_events(&ra, VDON_EVENT_CHANNEL_MESSAGE) == 1, "unsubscribed channel must be ignored");

    /* ping */
    CHECK(vdon_send_ping(b, NULL) == VDON_OK, "ping");
    i = wait_event(&rb, VDON_EVENT_PEER_LATENCY, 5000);
    CHECK(i >= 0 && rb.ev[i].number >= 0 && rb.ev[i].number < 5000, "latency");

    /* binary lane */
    {
        uint8_t blob[5000];
        size_t k;
        for (k = 0; k < sizeof(blob); k++)
            blob[k] = (uint8_t)(k * 7);
        rc = vdon_send_binary(b, peer_a, blob, sizeof(blob));
        CHECK(rc == VDON_OK, "send_binary rc=%d", rc);
        i = wait_event(&ra, VDON_EVENT_BINARY_RECEIVED, 5000);
        CHECK(i >= 0 && ra.ev[i].size == sizeof(blob) && memcmp(ra.ev[i].bytes, blob, sizeof(blob)) == 0 &&
                  strcmp(ra.ev[i].label, VDON_BINARY_CHANNEL) == 0,
              "binary payload");
    }

    /* file transfer */
    {
        size_t n = 16384 * 5 + 1234, k;
        uint8_t *file = (uint8_t *)malloc(n), *got = NULL;
        size_t got_n = 0;
        char fid[32];
        for (k = 0; k < n; k++)
            file[k] = (uint8_t)(k ^ (k >> 8));
        CHECK(vdon_host_file(a, "data.bin", file, n, NULL, fid, sizeof(fid)) == VDON_OK, "host file");
        i = wait_event_json(&rb, VDON_EVENT_FILE_LIST, fid, 5000);
        CHECK(i >= 0, "B received file list");
        rc = vdon_request_file(b, peer_a, fid, 20000, &got, &got_n);
        CHECK(rc == VDON_OK, "request_file rc=%d (%s)", rc, vdon_strerror(rc));
        CHECK(got_n == n && got && memcmp(got, file, n) == 0, "file content (%zu bytes)", got_n);
        CHECK(wait_event(&ra, VDON_EVENT_FILE_TRANSFER_COMPLETE, 5000) >= 0, "A transfer complete");
        CHECK(wait_event(&rb, VDON_EVENT_FILE_TRANSFER_COMPLETE, 5000) >= 0, "B transfer complete");
        vdon_free(got);
        free(file);
    }

    /* Timeout after a header, followed by late chunks and EOF (ASan regression). */
    {
        uint8_t payload[1024] = {0}, *got = NULL;
        size_t got_n = 0;
        char fid[32];
        CHECK(vdon_host_file(a, "slow.bin", payload, sizeof(payload), NULL, fid, sizeof(fid)) == VDON_OK, "host slow file");
        CHECK(wait_event_json(&rb, VDON_EVENT_FILE_LIST, fid, 5000) >= 0, "slow file list");
        pthread_mutex_lock(&rb.lock);
        rb.slow_file_header = 1;
        pthread_mutex_unlock(&rb.lock);
        rc = vdon_request_file(b, peer_a, fid, 500, &got, &got_n);
        CHECK(rc == VDON_ERR_TIMEOUT && !got && got_n == 0, "slow request should time out: %d", rc);
        pthread_mutex_lock(&rb.lock);
        CHECK(rb.delayed_headers == 1, "header must be received before the request times out");
        pthread_mutex_unlock(&rb.lock);
        sleep_ms(1200); /* deliver late chunks and close callback before teardown */
        CHECK(count_events(&rb, VDON_EVENT_FILE_TRANSFER_COMPLETE) >= 2, "late EOF processed safely");
    }

    /* peers / streams introspection */
    {
        char *json = NULL;
        CHECK(vdon_peers_json(a, &json) == VDON_OK && json && strstr(json, peer_b), "peers json %s", json ? json : "");
        vdon_free(json);
        CHECK(vdon_streams_json(b, &json) == VDON_OK && json && strstr(json, "alpha_stream"), "streams json");
        vdon_free(json);
        CHECK(vdon_peer_connection(a, peer_b, "publisher") >= 0, "peer connection id");
    }

    /* stop viewing: publisher learns via bye */
    CHECK(vdon_stop_viewing(b, "alpha_stream") == VDON_OK, "stop viewing");
    CHECK(wait_event(&ra, VDON_EVENT_BYE, 5000) >= 0, "A got bye");
    CHECK(wait_event(&ra, VDON_EVENT_PEER_DISCONNECTED, 5000) >= 0, "A peer disconnected");
    CHECK(wait_event(&rb, VDON_EVENT_VIEWING_STOPPED, 1000) >= 0, "B viewing stopped");

    vdon_disconnect(b);
    vdon_disconnect(a);
    CHECK(wait_event(&ra, VDON_EVENT_DISCONNECTED, 1000) >= 0, "A disconnected event");
    vdon_destroy(a);
    vdon_destroy(b);
    rec_free(&ra);
    rec_free(&rb);
}

static void test_media(const char *url) {
    recorder ra, rb;
    vdon_sdk *a, *b;
    vdon_track_init tracks[2];
    int i, rc, track_b;
    uint8_t pkt[200];
    int sent, tries;
    printf("== media (raw RTP + PLI)\n");
    rec_init(&ra, "A");
    rec_init(&rb, "B");
    a = make_sdk(url, &ra, 0, NULL);
    b = make_sdk(url, &rb, 0, NULL);
    CHECK(vdon_connect(a, 5000) == VDON_OK, "A connect");
    CHECK(vdon_connect(b, 5000) == VDON_OK, "B connect");
    vdon_track_init_defaults(&tracks[0], VDON_MEDIA_VIDEO, VDON_CODEC_VP8);
    tracks[0].ssrc = 0x11223344;
    vdon_track_init_defaults(&tracks[1], VDON_MEDIA_AUDIO, VDON_CODEC_OPUS);
    tracks[1].ssrc = 0x55667788;
    CHECK(vdon_publish(a, "media_stream", NULL, tracks, 2, NULL, 0) == VDON_OK, "publish");
    rc = vdon_view(b, "media_stream", NULL, 10000);
    CHECK(rc == VDON_OK, "view rc=%d", rc);
    i = wait_event(&rb, VDON_EVENT_TRACK, 10000);
    CHECK(i >= 0, "B got track event");
    CHECK(wait_event_n(&rb, VDON_EVENT_TRACK, NULL, 1, 10000) >= 0, "B got second track");
    CHECK(wait_event(&rb, VDON_EVENT_PEER_CONNECTED, 15000) >= 0, "B peer connected");
    CHECK(wait_event(&ra, VDON_EVENT_DATA_CHANNEL_OPEN, 15000) >= 0, "A control channel");
    track_b = -1;
    pthread_mutex_lock(&rb.lock);
    for (i = 0; i < rb.count; i++)
        if (rb.ev[i].type == VDON_EVENT_TRACK && rb.ev[i].label && strcmp(rb.ev[i].label, "video") == 0)
            track_b = rb.ev[i].track;
    pthread_mutex_unlock(&rb.lock);
    CHECK(track_b >= 0, "video track id");

    /* fake RTP: V=2, PT=96, seq, ts, ssrc */
    memset(pkt, 0, sizeof(pkt));
    pkt[0] = 0x80;
    pkt[1] = 96;
    pkt[8] = 0x11;
    pkt[9] = 0x22;
    pkt[10] = 0x33;
    pkt[11] = 0x44;
    sent = 0;
    for (tries = 0; tries < 100 && wait_event(&rb, VDON_EVENT_RTP, 50) < 0; tries++) {
        pkt[2] = (uint8_t)(tries >> 8);
        pkt[3] = (uint8_t)tries;
        pkt[7] = (uint8_t)tries;
        sent += vdon_send_rtp(a, VDON_MEDIA_VIDEO, pkt, sizeof(pkt)) > 0;
    }
    CHECK(sent > 0, "send_rtp reached a track");
    i = wait_event(&rb, VDON_EVENT_RTP, 5000);
    CHECK(i >= 0 && rb.ev[i].size == sizeof(pkt) && rb.ev[i].bytes[1] == 96 && strcmp(rb.ev[i].label, "video") == 0,
          "B received RTP");

    /* PLI from the viewer surfaces as a keyframe request on the publisher */
    CHECK(vdon_request_keyframe(b, track_b) == VDON_OK, "request keyframe");
    i = wait_event(&ra, VDON_EVENT_KEYFRAME_REQUEST, 5000);
    CHECK(i >= 0 && strcmp(ra.ev[i].label, "video") == 0, "A keyframe request");

    vdon_stop_publishing(a);
    CHECK(wait_event(&rb, VDON_EVENT_BYE, 5000) >= 0, "B got bye when publishing stopped");
    vdon_destroy(a);
    vdon_destroy(b);
    rec_free(&ra);
    rec_free(&rb);
}

static void test_no_password(const char *url) {
    recorder ra, rb;
    vdon_sdk *a, *b;
    printf("== no password\n");
    rec_init(&ra, "A");
    rec_init(&rb, "B");
    a = make_sdk(url, &ra, 1, NULL);
    b = make_sdk(url, &rb, 1, NULL);
    CHECK(vdon_connect(a, 5000) == VDON_OK, "A connect");
    CHECK(vdon_connect(b, 5000) == VDON_OK, "B connect");
    CHECK(vdon_announce(a, "plain_stream", NULL, NULL, 0) == VDON_OK, "announce");
    CHECK(vdon_view(b, "plain_stream", NULL, 10000) == VDON_OK, "view");
    CHECK(wait_event(&ra, VDON_EVENT_DATA_CHANNEL_OPEN, 15000) >= 0, "A dc open");
    CHECK(vdon_send_data(b, "{\"clear\":true}", NULL) == VDON_OK, "send");
    CHECK(wait_event_json(&ra, VDON_EVENT_DATA_RECEIVED, "clear", 5000) >= 0, "received");
    vdon_destroy(a);
    vdon_destroy(b);
    rec_free(&ra);
    rec_free(&rb);
}

static void test_pending_view(const char *url) {
    recorder ra, rb;
    vdon_sdk *a, *b;
    int rc;
    printf("== pending view\n");
    rec_init(&ra, "A");
    rec_init(&rb, "B");
    a = make_sdk(url, &ra, 0, NULL);
    b = make_sdk(url, &rb, 0, NULL);
    CHECK(vdon_connect(a, 5000) == VDON_OK, "A connect");
    CHECK(vdon_connect(b, 5000) == VDON_OK, "B connect");
    rc = vdon_view(b, "late_stream", NULL, 300);
    CHECK(rc == VDON_ERR_PENDING, "view before publish should be pending, rc=%d", rc);
    CHECK(vdon_announce(a, "late_stream", NULL, NULL, 0) == VDON_OK, "announce");
    CHECK(wait_event(&rb, VDON_EVENT_DATA_CHANNEL_OPEN, 15000) >= 0, "B connected after late announce");
    vdon_destroy(a);
    vdon_destroy(b);
    rec_free(&ra);
    rec_free(&rb);
}

static void test_room_autoconnect(const char *url) {
    recorder ra, rb;
    vdon_sdk *a, *b;
    int i;
    printf("== room + half-mesh autoConnect\n");
    rec_init(&ra, "A");
    rec_init(&rb, "B");
    a = make_sdk(url, &ra, 0, NULL);
    b = make_sdk(url, &rb, 0, NULL);
    CHECK(vdon_auto_connect(a, "testroom", "aaa_peer", 0, 5000, NULL, 0) == VDON_OK, "A autoconnect");
    CHECK(wait_event(&ra, VDON_EVENT_ROOM_JOINED, 5000) >= 0, "A joined");
    CHECK(vdon_auto_connect(b, "testroom", "bbb_peer", 0, 5000, NULL, 0) == VDON_OK, "B autoconnect");
    CHECK(wait_event_json(&rb, VDON_EVENT_LISTING, "aaa_peer", 5000) >= 0, "B listing has A");
    CHECK(wait_event_json(&ra, VDON_EVENT_VIDEO_ADDED_TO_ROOM, "bbb_peer", 5000) >= 0 ||
              wait_event_json(&ra, VDON_EVENT_SOMEONE_JOINED, "bbb_peer", 5000) >= 0,
          "A notified of B");
    /* half mesh: B (bbb > aaa) views A; A does not view B */
    i = wait_event_n(&rb, VDON_EVENT_DATA_CHANNEL_OPEN, "viewer", 0, 15000);
    CHECK(i >= 0, "B viewer channel to A");
    CHECK(wait_event_n(&ra, VDON_EVENT_DATA_CHANNEL_OPEN, "publisher", 0, 15000) >= 0, "A publisher channel to B");
    sleep_ms(500);
    CHECK(wait_event_n(&ra, VDON_EVENT_DATA_CHANNEL_OPEN, "viewer", 0, 10) < 0, "A must not also view B (half mesh)");
    {
        char room[64];
        vdon_room(a, room, sizeof(room));
        CHECK(strcmp(room, "testroom") == 0, "room %s", room);
    }
    CHECK(vdon_send_data(a, "{\"room\":\"msg\"}", NULL) == VDON_OK, "A send in room");
    CHECK(wait_event_json(&rb, VDON_EVENT_DATA_RECEIVED, "msg", 5000) >= 0, "B received room data");
    vdon_destroy(a);
    vdon_destroy(b);
    rec_free(&ra);
    rec_free(&rb);
}

int main(int argc, char **argv) {
    vdon_signal_server *server;
    char url[64];
    verbose = argc > 1 && strcmp(argv[1], "-v") == 0;
    server = vdon_signal_server_create(0);
    if (!server) {
        fprintf(stderr, "cannot start signaling server\n");
        return 2;
    }
    snprintf(url, sizeof(url), "ws://127.0.0.1:%d", vdon_signal_server_port(server));
    printf("signaling server at %s\n", url);
    test_data(url);
    test_media(url);
    test_no_password(url);
    test_pending_view(url);
    test_room_autoconnect(url);
    vdon_signal_server_destroy(server);
    if (failures) {
        fprintf(stderr, "%d failure(s)\n", failures);
        return 1;
    }
    printf("e2e: all checks passed\n");
    return 0;
}
