/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
/* Exercise private signaling handlers without asynchronous transport timing. */
#include "vdon_sdk_internal.h"

static int candidates_added;
static int messages_sent;
static int message_channel;
static char last_message[128];
static int record_message(int id, const char *message, int size) {
    (void)size;
    messages_sent++;
    message_channel = id;
    snprintf(last_message, sizeof(last_message), "%s", message);
    return 0;
}
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
#define rtcSendMessage record_message
#include "../src/vdon_sdk.c"
#undef rtcAddRemoteCandidate
#include "../src/vdon_signalserver.c"
#undef rtcSendMessage

#define CHECK(expr) do { if (!(expr)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #expr); exit(1); } } while (0)

static void test_password_modes(void) {
    FILE *file = fopen(VDON_VECTORS_PATH, "rb");
    long size;
    char *text;
    cJSON *vectors, *c;
    CHECK(file);
    fseek(file, 0, SEEK_END); size = ftell(file); rewind(file);
    text = calloc((size_t)size + 1, 1);
    CHECK(text && fread(text, 1, (size_t)size, file) == (size_t)size);
    fclose(file);
    vectors = cJSON_Parse(text); free(text); CHECK(vectors);
    cJSON_ArrayForEach(c, jget(vectors, "passwordModes")) {
        vdon_options opts;
        vdon_sdk *s;
        char stream[128], room[32];
        vdon_options_init(&opts);
        opts.password = jstr(c, "rawPassword");
        opts.no_password = cJSON_IsTrue(jget(c, "noPassword"));
        opts.salt = jstr(c, "salt");
        s = vdon_create(&opts, NULL, NULL); CHECK(s);
        CHECK(s->has_password == cJSON_IsTrue(jget(c, "encrypted")));
        CHECK(strcmp(s->salt, jstr(c, "effectiveSalt")) == 0);
        if (s->has_password) CHECK(strcmp(s->password, jstr(c, "effectivePassword")) == 0);
        hashed_stream_id(s, "camera", stream, sizeof(stream));
        CHECK(strcmp(stream, jstr(c, "hashedStreamID")) == 0);
        if (s->has_password) {
            char phrase[1200];
            snprintf(phrase, sizeof(phrase), "room%s", s->phrase);
            vdon_generate_hash(phrase, 16, room);
        } else strcpy(room, "room");
        CHECK(strcmp(room, jstr(c, "hashedRoom")) == 0);
        vdon_destroy(s);
    }
    cJSON_Delete(vectors);
}

static void test_bye_uses_control_channel(void) {
    vdon_sdk s = {0};
    conn_t c = {0};
    chan_t channel = {0};
    cJSON *msg;
    pthread_mutex_init(&s.lock, NULL);
    s.connected = 1;
    s.ws = 10;
    c.uuid = "peer";
    c.type = TYPE_PUBLISHER;
    messages_sent = 0;
    conn_bye(&s, &c);
    CHECK(messages_sent == 0); /* No control channel: no signaling fallback. */
    channel.dc = 20;
    channel.open = 1;
    c.control = &channel;
    conn_bye(&s, &c);
    CHECK(messages_sent == 1 && message_channel == 20);
    msg = cJSON_Parse(last_message);
    CHECK(msg && cJSON_GetArraySize(msg) == 1 && cJSON_IsTrue(jget(msg, "bye")));
    cJSON_Delete(msg);
    pthread_mutex_destroy(&s.lock);
}

static void test_leave_closes_signaling(void) {
    vdon_sdk s = {0};
    vdon_signal_server server = {0};
    ss_client client = {0};
    cJSON *msg = cJSON_Parse("{\"leave\":true}");
    client.room = "room";
    ss_handle(&server, &client, msg);
    CHECK(client.room && strcmp(client.room, "room") == 0);
    cJSON_Delete(msg);

    pthread_mutex_init(&s.lock, NULL);
    pthread_cond_init(&s.cond, NULL);
    s.ws = -1;
    s.connected = 1;
    s.room = vdon_strdup("room");
    s.room_intent = vdon_strdup("room");
    s.room_joined = 1;
    messages_sent = 0;
    vdon_leave_room(&s);
    CHECK(!s.connected && !s.room && !s.room_intent && s.intentional);
    CHECK(messages_sent == 0);
    pthread_cond_destroy(&s.cond);
    pthread_mutex_destroy(&s.lock);
}

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
    test_password_modes();
    test_leave_closes_signaling();
    test_bye_uses_control_channel();
    test_ice_sessions();
    test_join_collision();
    test_retired_transfer();
    test_sender_lifetime();
    test_room_waiters();
    test_label_utf8_boundary();
    puts("review regressions passed");
    return 0;
}
