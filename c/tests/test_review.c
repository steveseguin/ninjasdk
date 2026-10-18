/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
/* Exercise private signaling handlers without asynchronous transport timing. */
#include "vdon_sdk_internal.h"

static int candidates_added;
static int record_candidate(int pc, const char *candidate, const char *mid) {
    (void)pc;
    (void)mid;
    if (strcmp(candidate, "valid") != 0) {
        fprintf(stderr, "stale candidate reached the transport\n");
        exit(1);
    }
    candidates_added++;
    return 0;
}

#define rtcAddRemoteCandidate record_candidate
#include "../src/vdon_sdk.c"
#undef rtcAddRemoteCandidate
#include "../src/vdon_signalserver.c"

#define CHECK(expr) do { if (!(expr)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); exit(1); } } while (0)

static void test_ice_sessions(void) {
    vdon_sdk s = {0};
    conn_t c = {0};
    cJSON *msg;
    pthread_mutex_init(&s.lock, NULL);
    c.sdk = &s;
    c.uuid = "peer";
    c.type = TYPE_VIEWER;
    strcpy(c.session, "current");
    msg = cJSON_Parse("{\"UUID\":\"peer\",\"type\":\"local\",\"session\":\"old\",\"candidates\":[\"stale\"]}");
    /* Before SDP, retain the session and discard mismatches when draining. */
    handle_remote_candidates(&s, msg, NULL, 0);
    CHECK(s.pending_ice && strcmp(s.pending_ice->session, "old") == 0);
    queue_pending_ice(&s, "peer", "local", "current", cJSON_Parse("[\"valid\"]"));
    queue_pending_ice(&s, "peer", "local", NULL, cJSON_Parse("[\"valid\"]"));
    drain_pending_ice(&s, &c, "local");
    CHECK(!s.pending_ice && candidates_added == 2);
    s.conns = &c;
    /* Stale candidates must be rejected both before and after remote SDP. */
    handle_remote_candidates(&s, msg, NULL, 0);
    CHECK(!s.pending_ice);
    c.remote_set = 1;
    handle_remote_candidates(&s, msg, NULL, 0);
    CHECK(candidates_added == 2);
    cJSON_ReplaceItemInObjectCaseSensitive(msg, "session", cJSON_CreateString("current"));
    cJSON_ReplaceItemInObjectCaseSensitive(msg, "candidates", cJSON_Parse("[\"valid\"]"));
    handle_remote_candidates(&s, msg, NULL, 0);
    CHECK(candidates_added == 3);
    cJSON_Delete(msg);
    pthread_mutex_destroy(&s.lock);
}

static void test_join_collision(void) {
    vdon_signal_server s = {0};
    ss_client owner = {0}, other = {0};
    cJSON *msg;
    strcpy(owner.uuid, "owner");
    strcpy(other.uuid, "other");
    owner.stream_id = "taken";
    owner.next = &other;
    other.ws = -1;
    s.clients = &owner;
    msg = cJSON_Parse("{\"request\":\"joinroom\",\"roomid\":\"room\",\"streamID\":\"taken\",\"claim\":true}");
    ss_handle(&s, &other, msg);
    CHECK(!other.stream_id && !other.room && !s.directors);
    CHECK(ss_find_stream(&s, "taken") == &owner);
    cJSON_Delete(msg);
}

static void test_retired_transfer(void) {
    vdon_sdk s = {0};
    conn_t c = {0};
    chan_t ch = {0};
    inbound_t in = {0};
    pthread_mutex_init(&s.lock, NULL);
    pthread_cond_init(&s.cond, NULL);
    s.conns = &c;
    c.chans = &ch;
    ch.inbound = &in;
    pthread_mutex_lock(&s.lock);
    conn_retire(&s, &c);
    CHECK(!ch.inbound && in.done && in.err == VDON_ERR_CANCELLED);
    CHECK(!s.conns);
    while (s.jobs) {
        job_t *j = s.jobs;
        s.jobs = j->next;
        job_free(j);
    }
    pthread_mutex_unlock(&s.lock);
    pthread_cond_destroy(&s.cond);
    pthread_mutex_destroy(&s.lock);
}

static void test_room_waiters(void) {
    vdon_signal_server s = {0};
    ss_client pub = {0}, viewer = {0}, outside = {0};
    cJSON *msg;
    strcpy(pub.uuid, "publisher");
    strcpy(viewer.uuid, "viewer");
    strcpy(outside.uuid, "outside");
    pub.ws = viewer.ws = outside.ws = -1;
    pub.room = viewer.room = "room";
    outside.room = "other";
    pub.next = &viewer;
    viewer.next = &outside;
    s.clients = &pub;
    ss_queue(&s, "future", viewer.uuid);
    ss_queue(&s, "future", outside.uuid);
    msg = cJSON_Parse("{\"request\":\"seed\",\"streamID\":\"future\"}");
    ss_handle(&s, &pub, msg);
    CHECK(s.waiting && !s.waiting->next && strcmp(s.waiting->viewer_uuid, "outside") == 0);
    free(s.waiting->stream_id);
    free(s.waiting->viewer_uuid);
    free(s.waiting);
    free(pub.stream_id);
    cJSON_Delete(msg);
}

static void test_label_utf8_boundary(void) {
    const char *ends[] = {"\xc3\xa9", "\xe6\xbc\xa2", "\xf0\x9f\x98\x80"};
    size_t i;
    for (i = 0; i < sizeof(ends) / sizeof(ends[0]); i++) {
        char input[128], output[128], expected[128];
        memset(input, 'a', 99);
        strcpy(input + 99, ends[i]);
        strcpy(expected, input);
        strcat(input, "extra");
        CHECK(vdon_sanitize_label(input, output, sizeof(output)) == VDON_OK);
        CHECK(strcmp(output, expected) == 0);
    }
}

static int sender_finished;
static void *slow_sender(void *arg) {
    chan_t *ch = (chan_t *)arg;
    vdon__sleep_ms(50);
    CHECK(strcmp(ch->label, "file") == 0);
    sender_finished = 1;
    return NULL;
}

static void test_sender_lifetime(void) {
    conn_t *c = (conn_t *)calloc(1, sizeof(*c));
    chan_t *ch = (chan_t *)calloc(1, sizeof(*ch));
    c->chans = ch;
    ch->label = vdon_strdup("file");
    CHECK(pthread_create(&ch->file_thread, NULL, slow_sender, ch) == 0);
    ch->file_thread_started = 1;
    conn_free(c);
    CHECK(sender_finished);
}

int main(void) {
    test_ice_sessions();
    test_join_collision();
    test_retired_transfer();
    test_sender_lifetime();
    test_room_waiters();
    test_label_utf8_boundary();
    puts("review regressions passed");
    return 0;
}
