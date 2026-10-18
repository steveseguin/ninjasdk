/*
 * VDO.Ninja SDK for C — core: signaling socket, rooms, publishing, viewing,
 * peer connections and the worker thread.
 *
 * Copyright (c) 2025-2026 Steve Seguin
 * SPDX-License-Identifier: MPL-2.0
 */
#include "vdon_sdk_internal.h"

#include <errno.h>
#include <time.h>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif
#ifdef VDON_HAVE_CURL
#include <curl/curl.h>
#endif

static const char *TYPE_PUBLISHER = "publisher";
static const char *TYPE_VIEWER = "viewer";

/* ------------------------------------------------------------------ utils */

void vdon__sleep_ms(int ms) {
#ifdef _WIN32
    Sleep((DWORD)ms);
#else
    struct timespec ts;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (long)(ms % 1000) * 1000000L;
    nanosleep(&ts, NULL);
#endif
}

void vdon__logf(vdon_sdk *s, const char *fmt, ...) {
    va_list ap;
    if (!s || !s->o.debug)
        return;
    fprintf(stderr, "[vdoninja] ");
    va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    va_end(ap);
    fputc('\n', stderr);
}

void vdon__emit(vdon_sdk *s, vdon_event *ev) {
    if (s->cb)
        s->cb(s, ev, s->user);
}

#define EV(var, t)                                                                                                     \
    vdon_event var;                                                                                                    \
    memset(&var, 0, sizeof(var));                                                                                      \
    var.type = (t)

static const char *jstr(const cJSON *o, const char *k) {
    return o ? cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(o, k)) : NULL;
}
static cJSON *jget(const cJSON *o, const char *k) { return o ? cJSON_GetObjectItemCaseSensitive(o, k) : NULL; }

char *vdon__json_text(cJSON *v) { return v ? cJSON_PrintUnformatted(v) : NULL; }

cJSON *vdon__parse_or_string(const char *json) {
    cJSON *v;
    if (!json)
        return cJSON_CreateNull();
    v = cJSON_Parse(json);
    return v ? v : cJSON_CreateString(json);
}

static void strnode_add(strnode_t **list, const char *s) {
    strnode_t *n;
    for (n = *list; n; n = n->next)
        if (strcmp(n->s, s) == 0)
            return;
    n = (strnode_t *)calloc(1, sizeof(*n));
    n->s = vdon_strdup(s);
    n->next = *list;
    *list = n;
}
static int strnode_has(strnode_t *list, const char *s) {
    for (; list; list = list->next)
        if (strcmp(list->s, s) == 0)
            return 1;
    return 0;
}
static void strnode_remove(strnode_t **list, const char *s) {
    while (*list) {
        if (strcmp((*list)->s, s) == 0) {
            strnode_t *n = *list;
            *list = n->next;
            free(n->s);
            free(n);
            return;
        }
        list = &(*list)->next;
    }
}
static void strnode_free(strnode_t **list) {
    while (*list) {
        strnode_t *n = *list;
        *list = n->next;
        free(n->s);
        free(n);
    }
}

int vdon__wait_until(vdon_sdk *s, int64_t deadline_ms) {
    struct timespec ts;
    int64_t now = vdon_now_ms();
    if (now >= deadline_ms)
        return 0;
    ts.tv_sec = (time_t)(deadline_ms / 1000);
    ts.tv_nsec = (long)(deadline_ms % 1000) * 1000000L;
    return pthread_cond_timedwait(&s->cond, &s->lock, &ts) != ETIMEDOUT;
}

/* ------------------------------------------------------------ public misc */

const char *vdon_version(void) { return VDON_VERSION; }

const char *vdon_strerror(int code) {
    switch (code) {
    case VDON_OK: return "ok";
    case VDON_ERR_INVALID: return "invalid argument";
    case VDON_ERR_FAILURE: return "failure";
    case VDON_ERR_NOT_CONNECTED: return "not connected";
    case VDON_ERR_TIMEOUT: return "timeout";
    case VDON_ERR_PENDING: return "pending";
    case VDON_ERR_NO_CHANNEL: return "no data channel";
    case VDON_ERR_NOT_FOUND: return "not found";
    case VDON_ERR_REMOTE: return "remote error";
    case VDON_ERR_CANCELLED: return "cancelled";
    case VDON_ERR_TOO_SMALL: return "buffer too small";
    case VDON_ERR_UNSUPPORTED: return "unsupported";
    case VDON_ERR_ALREADY_PUBLISHING: return "already publishing on this connection; disconnect and reconnect to publish a different stream";
    default: return "unknown error";
    }
}

const char *vdon_event_name(vdon_event_type t) {
    switch (t) {
    case VDON_EVENT_CONNECTED: return "connected";
    case VDON_EVENT_DISCONNECTED: return "disconnected";
    case VDON_EVENT_RECONNECTING: return "reconnecting";
    case VDON_EVENT_RECONNECTED: return "reconnected";
    case VDON_EVENT_RECONNECT_FAILED: return "reconnectFailed";
    case VDON_EVENT_ROOM_JOINED: return "roomJoined";
    case VDON_EVENT_ROOM_LEFT: return "roomLeft";
    case VDON_EVENT_LISTING: return "listing";
    case VDON_EVENT_VIDEO_ADDED_TO_ROOM: return "videoaddedtoroom";
    case VDON_EVENT_SOMEONE_JOINED: return "someonejoined";
    case VDON_EVENT_PUBLISHING: return "publishing";
    case VDON_EVENT_PUBLISHING_STOPPED: return "publishingStopped";
    case VDON_EVENT_VIEWING_STOPPED: return "viewingStopped";
    case VDON_EVENT_PEER_CONNECTED: return "peerConnected";
    case VDON_EVENT_PEER_DISCONNECTED: return "peerDisconnected";
    case VDON_EVENT_CONNECTION_FAILED: return "connectionFailed";
    case VDON_EVENT_DATA_CHANNEL_OPEN: return "dataChannelOpen";
    case VDON_EVENT_DATA_CHANNEL_CLOSE: return "dataChannelClose";
    case VDON_EVENT_DATA_RECEIVED: return "dataReceived";
    case VDON_EVENT_PEER_INFO: return "peerInfo";
    case VDON_EVENT_PEER_LATENCY: return "peerLatency";
    case VDON_EVENT_REMOTE_VIDEO_MUTE: return "remoteVideoMute";
    case VDON_EVENT_OBS_STATE: return "obsState";
    case VDON_EVENT_TRACK: return "track";
    case VDON_EVENT_RTP: return "rtp";
    case VDON_EVENT_KEYFRAME_REQUEST: return "keyframeRequest";
    case VDON_EVENT_CHANNEL_MESSAGE: return "channelMessage";
    case VDON_EVENT_PEER_SUBSCRIBED: return "peerSubscribed";
    case VDON_EVENT_PEER_UNSUBSCRIBED: return "peerUnsubscribed";
    case VDON_EVENT_CHANNEL_OPEN: return "channelOpen";
    case VDON_EVENT_BINARY_RECEIVED: return "binaryReceived";
    case VDON_EVENT_FILE_LIST: return "fileList";
    case VDON_EVENT_FILE_TRANSFER_START: return "fileTransferStart";
    case VDON_EVENT_FILE_TRANSFER_PROGRESS: return "fileTransferProgress";
    case VDON_EVENT_FILE_CHUNK: return "fileChunk";
    case VDON_EVENT_FILE_TRANSFER_COMPLETE: return "fileTransferComplete";
    case VDON_EVENT_FILE_TRANSFER_CANCELLED: return "fileTransferCancelled";
    case VDON_EVENT_FILE_TRANSFER_ERROR: return "fileTransferError";
    case VDON_EVENT_RESOURCE_RECEIVED: return "resourceReceived";
    case VDON_EVENT_UNSUPPORTED_CHANNEL: return "unsupportedChannel";
    case VDON_EVENT_BYE: return "bye";
    case VDON_EVENT_HANGUP: return "hangup";
    case VDON_EVENT_ALERT: return "alert";
    case VDON_EVENT_ERROR: return "error";
    default: return "unknown";
    }
}

void vdon_options_init(vdon_options *o) {
    if (!o)
        return;
    memset(o, 0, sizeof(*o));
    o->host = VDON_DEFAULT_HOST;
    o->salt = VDON_DEFAULT_SALT;
    o->turn_mode = VDON_TURN_AUTO;
    o->max_reconnect_attempts = 5;
    o->reconnect_delay_ms = 1000;
    o->connection_timeout_ms = 20000;
    o->view_retry_interval_ms = 900000;
    o->auto_ping_interval_ms = 10000;
}

void vdon_view_options_init(vdon_view_options *o) {
    if (!o)
        return;
    memset(o, 0, sizeof(*o));
    o->audio = 1;
    o->video = 1;
    o->downloads = 1;
}

void vdon_track_init_defaults(vdon_track_init *t, vdon_media_kind kind, vdon_codec codec) {
    if (!t)
        return;
    memset(t, 0, sizeof(*t));
    t->kind = kind;
    t->codec = codec;
    t->payload_type = kind == VDON_MEDIA_AUDIO ? 111 : 96;
    if (codec == VDON_CODEC_PCMU)
        t->payload_type = 0;
    else if (codec == VDON_CODEC_PCMA)
        t->payload_type = 8;
    else if (codec == VDON_CODEC_G722)
        t->payload_type = 9;
    t->nal_separator = 3;
}

static int codec_clock_rate(vdon_codec codec) {
    switch (codec) {
    case VDON_CODEC_OPUS: return 48000;
    case VDON_CODEC_PCMU:
    case VDON_CODEC_PCMA:
    case VDON_CODEC_G722: return 8000;
    case VDON_CODEC_AAC: return 48000;
    default: return 90000;
    }
}

/* ----------------------------------------------------------- hashing etc */

static void refresh_password(vdon_sdk *s) {
    /* lock held */
    free(s->phrase);
    s->phrase = NULL;
    s->hash6[0] = 0;
    if (!s->has_password)
        return;
    s->phrase = (char *)malloc(strlen(s->password) + strlen(s->salt) + 1);
    strcpy(s->phrase, s->password);
    strcat(s->phrase, s->salt);
    vdon_generate_hash(s->phrase, 6, s->hash6);
}

/* hashed stream id: sanitized + 6-char hash (lock held). out >= 80 bytes */
static void hashed_stream_id(vdon_sdk *s, const char *sid, char *out, size_t n) {
    snprintf(out, n, "%s%s", sid, s->has_password ? s->hash6 : "");
}

static char *strip_hash(vdon_sdk *s, const char *sid) {
    size_t n;
    if (!sid)
        return vdon_strdup("");
    n = strlen(sid);
    if (s->has_password && n > 6 && strcmp(sid + n - 6, s->hash6) == 0) {
        char *out = (char *)malloc(n - 5);
        memcpy(out, sid, n - 6);
        out[n - 6] = 0;
        return out;
    }
    return vdon_strdup(sid);
}

/* Encrypts a JSON value; sets item "key" (hex) and "vector" on msg. Lock not required (phrase is immutable after join). */
static int encrypt_into(vdon_sdk *s, cJSON *msg, const char *key, cJSON *value) {
    char *text = cJSON_PrintUnformatted(value);
    char *enc = NULL, *iv = NULL;
    int rc;
    if (!text)
        return VDON_ERR_FAILURE;
    rc = vdon_encrypt_message(text, s->phrase, &enc, &iv);
    free(text);
    if (rc != VDON_OK)
        return rc;
    cJSON_AddStringToObject(msg, key, enc);
    cJSON_AddStringToObject(msg, "vector", iv);
    free(enc);
    free(iv);
    return VDON_OK;
}

/* Returns a new cJSON (caller deletes) decoded from msg[key] (encrypted string or inline value). */
static cJSON *decode_field(vdon_sdk *s, const cJSON *msg, const char *key) {
    cJSON *v = jget(msg, key);
    if (!v)
        return NULL;
    if (cJSON_IsString(v)) {
        const char *iv = jstr(msg, "vector");
        char *plain = NULL;
        cJSON *out;
        if (!s->has_password || !iv)
            return NULL;
        if (vdon_decrypt_message(cJSON_GetStringValue(v), iv, s->phrase, &plain) != VDON_OK)
            return NULL;
        out = cJSON_Parse(plain);
        free(plain);
        return out;
    }
    return cJSON_Duplicate(v, 1);
}

/* ------------------------------------------------------------- scheduling */

void vdon__schedule(vdon_sdk *s, int type, int64_t at, conn_t *c, const char *str, int id) {
    job_t *j = (job_t *)calloc(1, sizeof(*j)), **pp = &s->jobs;
    j->type = type;
    j->at = at;
    j->conn = c;
    j->str = str ? vdon_strdup(str) : NULL;
    j->id = id;
    while (*pp && (*pp)->at <= at)
        pp = &(*pp)->next;
    j->next = *pp;
    *pp = j;
    pthread_cond_broadcast(&s->cond);
}

static void job_free(job_t *j) {
    free(j->str);
    free(j);
}

static void cancel_jobs_for_conn(vdon_sdk *s, conn_t *c, int keep_type) {
    job_t **pp = &s->jobs;
    while (*pp) {
        job_t *j = *pp;
        if (j->conn == c && j->type != keep_type) {
            *pp = j->next;
            job_free(j);
        } else {
            pp = &j->next;
        }
    }
}

static int has_job(vdon_sdk *s, int type, const char *str) {
    job_t *j;
    for (j = s->jobs; j; j = j->next)
        if (j->type == type && (!str || (j->str && strcmp(j->str, str) == 0)))
            return 1;
    return 0;
}

/* ------------------------------------------------------------- WebSocket */

int vdon__ws_send(vdon_sdk *s, cJSON *msg) {
    int ws;
    char *text;
    int rc;
    pthread_mutex_lock(&s->lock);
    ws = s->connected ? s->ws : -1;
    if (ws >= 0 && s->o.client_id && !jget(msg, "from"))
        cJSON_AddStringToObject(msg, "from", s->o.client_id);
    pthread_mutex_unlock(&s->lock);
    if (ws < 0)
        return 0;
    text = cJSON_PrintUnformatted(msg);
    if (!text)
        return 0;
    vdon__logf(s, "-> WS %.300s", text);
    rc = rtcSendMessage(ws, text, -1);
    free(text);
    return rc >= 0;
}

static void ws_send_free(vdon_sdk *s, cJSON *msg) {
    vdon__ws_send(s, msg);
    cJSON_Delete(msg);
}

static void handle_signal(vdon_sdk *s, cJSON *msg);
static void restore_intent(vdon_sdk *s);

static void RTC_API on_ws_open(int id, void *ptr) {
    vdon_sdk *s = (vdon_sdk *)ptr;
    int was_reconnect;
    if (!s)
        return;
    pthread_mutex_lock(&s->lock);
    if (id != s->ws) {
        pthread_mutex_unlock(&s->lock);
        return;
    }
    s->connected = 1;
    s->ever_connected = 1;
    s->ws_failed = 0;
    was_reconnect = s->reconnects > 0;
    s->reconnects = 0;
    s->reconnect_delay = s->o.reconnect_delay_ms;
    pthread_cond_broadcast(&s->cond);
    pthread_mutex_unlock(&s->lock);
    vdon__logf(s, "signaling connected");
    {
        EV(ev, was_reconnect ? VDON_EVENT_RECONNECTED : VDON_EVENT_CONNECTED);
        vdon__emit(s, &ev);
    }
    if (was_reconnect)
        restore_intent(s);
}

static void RTC_API on_ws_closed(int id, void *ptr) {
    vdon_sdk *s = (vdon_sdk *)ptr;
    int was_connected = 0, intentional;
    if (!s)
        return;
    pthread_mutex_lock(&s->lock);
    if (id != s->ws) {
        pthread_mutex_unlock(&s->lock);
        return;
    }
    s->ws = -1;
    was_connected = s->connected;
    s->connected = 0;
    s->ws_failed = 1;
    intentional = s->intentional;
    vdon__schedule(s, JOB_DELETE_WS, vdon_now_ms(), NULL, NULL, id);
    if (!intentional && s->ever_connected && !s->stopping) {
        int delay = s->reconnect_delay > 0 ? s->reconnect_delay : s->o.reconnect_delay_ms;
        if (s->reconnects < s->o.max_reconnect_attempts) {
            vdon__schedule(s, JOB_RECONNECT, vdon_now_ms() + delay, NULL, NULL, 0);
            s->reconnect_delay = delay * 2 > 30000 ? 30000 : delay * 2;
        } else {
            EV(ev, VDON_EVENT_RECONNECT_FAILED);
            pthread_mutex_unlock(&s->lock);
            vdon__emit(s, &ev);
            pthread_mutex_lock(&s->lock);
        }
    }
    pthread_cond_broadcast(&s->cond);
    pthread_mutex_unlock(&s->lock);
    if (was_connected) {
        EV(ev, VDON_EVENT_DISCONNECTED);
        ev.flag = intentional;
        vdon__emit(s, &ev);
    }
}

static void RTC_API on_ws_error(int id, const char *error, void *ptr) {
    vdon_sdk *s = (vdon_sdk *)ptr;
    if (!s)
        return;
    vdon__logf(s, "signaling error: %s", error ? error : "?");
    pthread_mutex_lock(&s->lock);
    if (id == s->ws)
        s->ws_failed = 1;
    pthread_cond_broadcast(&s->cond);
    pthread_mutex_unlock(&s->lock);
}

static void RTC_API on_ws_message(int id, const char *message, int size, void *ptr) {
    vdon_sdk *s = (vdon_sdk *)ptr;
    cJSON *msg;
    if (!s || size >= 0)
        return;
    pthread_mutex_lock(&s->lock);
    if (id != s->ws) {
        pthread_mutex_unlock(&s->lock);
        return;
    }
    pthread_mutex_unlock(&s->lock);
    vdon__logf(s, "<- WS %.300s", message);
    msg = cJSON_Parse(message);
    if (!msg)
        return;
    if (cJSON_IsObject(msg))
        handle_signal(s, msg);
    cJSON_Delete(msg);
}

/* lock held */
static int ws_open(vdon_sdk *s) {
    rtcWsConfiguration cfg;
    int ws;
    memset(&cfg, 0, sizeof(cfg));
    cfg.connectionTimeoutMs = 15000;
    ws = rtcCreateWebSocketEx(s->o.host, &cfg);
    if (ws < 0)
        return VDON_ERR_FAILURE;
    s->ws = ws;
    s->ws_failed = 0;
    rtcSetUserPointer(ws, s);
    rtcSetOpenCallback(ws, on_ws_open);
    rtcSetClosedCallback(ws, on_ws_closed);
    rtcSetErrorCallback(ws, on_ws_error);
    rtcSetMessageCallback(ws, on_ws_message);
    if (rtcIsOpen(ws) && !s->connected) {
        pthread_mutex_unlock(&s->lock);
        on_ws_open(ws, s);
        pthread_mutex_lock(&s->lock);
    }
    return VDON_OK;
}

/* ------------------------------------------------------------------ TURN */

typedef struct turn_entry {
    const char *user, *cred, *url;
    int tz, udp;
} turn_entry;

static const turn_entry FALLBACK_TURNS[] = {
    {"steve", "setupYourOwnPlease", "turns:www.turn.obs.ninja:443", 300, 0},
    {"steve", "setupYourOwnPlease", "turn:turn-cae1.vdo.ninja:3478", 300, 1},
    {"vdoninja", "theyBeSharksHere", "turn:turn-usw2.vdo.ninja:3478", 480, 1},
    {"vdoninja", "PolandPirat", "turn:turn-eu4.vdo.ninja:3478", -70, 1},
    {"steve", "setupYourOwnPlease", "turns:turn.obs.ninja:443", -60, 0},
    {"steve", "setupYourOwnPlease", "turn:turn-eu1.vdo.ninja:3478", -60, 1},
    {"vdoninja", "EastSideRepresentZ", "turn:turn-use1.vdo.ninja:3478", 300, 1},
};

static int local_tz_offset_minutes(void) {
    time_t t = time(NULL);
    struct tm lt, gt;
#ifdef _WIN32
    localtime_s(&lt, &t);
    gmtime_s(&gt, &t);
#else
    localtime_r(&t, &lt);
    gmtime_r(&t, &gt);
#endif
    {
        int diff = (lt.tm_hour - gt.tm_hour) * 60 + (lt.tm_min - gt.tm_min);
        int dd = lt.tm_yday - gt.tm_yday;
        if (dd == 1 || dd < -1)
            diff += 24 * 60;
        else if (dd == -1 || dd > 1)
            diff -= 24 * 60;
        return diff;
    }
}

/* Builds "turn:user:pass@host:port" from a VDO.Ninja URL. */
static char *turn_url(const char *user, const char *cred, const char *url) {
    const char *colon = strchr(url, ':');
    size_t n;
    char *out;
    if (!colon)
        return NULL;
    n = strlen(url) + strlen(user) + strlen(cred) + 3;
    out = (char *)malloc(n + 1);
    snprintf(out, n + 1, "%.*s:%s:%s@%s", (int)(colon - url), url, user, cred, colon + 1);
    return out;
}

static void add_ice_server(vdon_sdk *s, char *url) {
    if (!url)
        return;
    s->ice_servers = (char **)realloc(s->ice_servers, sizeof(char *) * (size_t)(s->ice_count + 1));
    s->ice_servers[s->ice_count++] = url;
}

typedef struct cand_turn {
    char *user, *cred, *url;
    int tz, udp, delta;
} cand_turn;

static void select_turns(vdon_sdk *s, cand_turn *list, int n) {
    int tz = local_tz_offset_minutes(), i, j, udp = 0, tcp = 0;
    for (i = 0; i < n; i++) {
        int d = list[i].tz - tz, w;
        if (d < 0)
            d = -d;
        w = d - 60 * 24;
        if (w < 0)
            w = -w;
        list[i].delta = w < d ? w : d;
    }
    for (i = 1; i < n; i++) { /* stable insertion sort */
        cand_turn t = list[i];
        for (j = i - 1; j >= 0 && list[j].delta > t.delta; j--)
            list[j + 1] = list[j];
        list[j + 1] = t;
    }
    for (i = 0; i < n; i++) {
        if (s->o.force_tcp && list[i].udp)
            continue;
        if (list[i].udp && udp < 2)
            udp++;
        else if (!list[i].udp && tcp < 1)
            tcp++;
        else
            continue;
        add_ice_server(s, turn_url(list[i].user, list[i].cred, list[i].url));
    }
}

#ifdef VDON_HAVE_CURL
typedef struct curl_buf {
    char *data;
    size_t len;
} curl_buf;
static size_t curl_write(void *ptr, size_t sz, size_t nm, void *ud) {
    curl_buf *b = (curl_buf *)ud;
    size_t n = sz * nm;
    if (b->len + n > 1024 * 1024)
        return 0;
    b->data = (char *)realloc(b->data, b->len + n + 1);
    memcpy(b->data + b->len, ptr, n);
    b->len += n;
    b->data[b->len] = 0;
    return n;
}

/* Returns the number of servers added to list, 0 on failure. */
static int fetch_hosted_turns(vdon_sdk *s, cand_turn *list, int max) {
    CURL *curl = curl_easy_init();
    curl_buf buf = {NULL, 0};
    char url[128];
    cJSON *root = NULL, *servers, *it;
    int n = 0;
    long code = 0;
    if (!curl)
        return 0;
    snprintf(url, sizeof(url), "https://turnservers.vdo.ninja/?ts=%lld", (long long)vdon_now_ms());
    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, curl_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &buf);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 5000L);
    curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 1L);
    if (curl_easy_perform(curl) == CURLE_OK)
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &code);
    curl_easy_cleanup(curl);
    if (code == 200 && buf.data)
        root = cJSON_Parse(buf.data);
    free(buf.data);
    servers = jget(root, "servers");
    cJSON_ArrayForEach(it, servers) {
        cJSON *urls = jget(it, "urls");
        const char *user = jstr(it, "username"), *cred = jstr(it, "credential"), *u = NULL;
        if (n >= max || !user || !cred)
            continue;
        if (cJSON_IsArray(urls) && cJSON_GetArraySize(urls) > 0)
            u = cJSON_GetStringValue(cJSON_GetArrayItem(urls, 0));
        else if (cJSON_IsString(urls))
            u = cJSON_GetStringValue(urls);
        if (!u)
            continue;
        list[n].user = vdon_strdup(user);
        list[n].cred = vdon_strdup(cred);
        list[n].url = vdon_strdup(u);
        list[n].tz = (int)cJSON_GetNumberValue(jget(it, "tz"));
        list[n].udp = cJSON_IsTrue(jget(it, "udp"));
        n++;
    }
    cJSON_Delete(root);
    (void)s;
    return n;
}
#endif

/* Builds the ICE server list once. lock NOT held. */
static void ensure_ice_servers(vdon_sdk *s) {
    cand_turn list[64];
    int n = 0, i, fetched = 0;
    pthread_mutex_lock(&s->lock);
    if (s->turn_fetched) {
        pthread_mutex_unlock(&s->lock);
        return;
    }
    pthread_mutex_unlock(&s->lock);
    memset(list, 0, sizeof(list));
    if (s->o.turn_mode == VDON_TURN_AUTO) {
#ifdef VDON_HAVE_CURL
        n = fetch_hosted_turns(s, list, 64);
        fetched = n > 0;
#endif
        if (n == 0) {
            for (i = 0; i < (int)(sizeof(FALLBACK_TURNS) / sizeof(FALLBACK_TURNS[0])); i++) {
                list[n].user = vdon_strdup(FALLBACK_TURNS[i].user);
                list[n].cred = vdon_strdup(FALLBACK_TURNS[i].cred);
                list[n].url = vdon_strdup(FALLBACK_TURNS[i].url);
                list[n].tz = FALLBACK_TURNS[i].tz;
                list[n].udp = FALLBACK_TURNS[i].udp;
                n++;
            }
        }
    }
    pthread_mutex_lock(&s->lock);
    if (!s->turn_fetched) {
        if (s->stun_copy) {
            for (i = 0; i < s->o.stun_server_count; i++)
                add_ice_server(s, vdon_strdup(s->stun_copy[i]));
        } else {
            add_ice_server(s, vdon_strdup("stun:stun.l.google.com:19302"));
            add_ice_server(s, vdon_strdup("stun:stun.cloudflare.com:3478"));
        }
        if (s->o.turn_mode == VDON_TURN_CUSTOM) {
            for (i = 0; i < s->o.turn_server_count; i++)
                add_ice_server(s, vdon_strdup(s->turn_copy[i]));
        } else if (s->o.turn_mode == VDON_TURN_AUTO) {
            select_turns(s, list, n);
        }
        s->turn_fetched = 1;
        vdon__logf(s, "ICE servers: %d (%s TURN list)", s->ice_count, fetched ? "hosted" : "built-in");
    }
    pthread_mutex_unlock(&s->lock);
    for (i = 0; i < n; i++) {
        free(list[i].user);
        free(list[i].cred);
        free(list[i].url);
    }
}

/* ----------------------------------------------------------- connections */

conn_t *vdon__find_conn(vdon_sdk *s, const char *uuid, const char *type) {
    conn_t *c, *any = NULL;
    if (!uuid)
        return NULL;
    for (c = s->conns; c; c = c->next) {
        if (c->closed || strcmp(c->uuid, uuid) != 0)
            continue;
        if (type && strcmp(c->type, type) != 0)
            continue;
        if (!type && strcmp(c->type, TYPE_PUBLISHER) == 0)
            return c;
        if (!any)
            any = c;
    }
    return any;
}

static conn_t *find_viewer_for_stream(vdon_sdk *s, const char *sid) {
    conn_t *c;
    for (c = s->conns; c; c = c->next)
        if (!c->closed && c->type == TYPE_VIEWER && c->stream_id && strcmp(c->stream_id, sid) == 0)
            return c;
    return NULL;
}

int vdon__conn_send_control(vdon_sdk *s, conn_t *c, cJSON *msg) {
    int dc = -1;
    char *text;
    int rc;
    pthread_mutex_lock(&s->lock);
    if (!c->closed && c->control && c->control->open)
        dc = c->control->dc;
    pthread_mutex_unlock(&s->lock);
    if (dc < 0)
        return 0;
    text = cJSON_PrintUnformatted(msg);
    if (!text)
        return 0;
    vdon__logf(s, "-> DC(%s/%s) %.300s", c->uuid, c->type, text);
    rc = rtcSendMessage(dc, text, -1);
    free(text);
    return rc >= 0;
}

static void set_stream_state(vdon_sdk *s, const char *sid, const char *state) {
    /* lock held */
    stream_t *st;
    if (!sid || !*sid)
        return;
    for (st = s->streams; st; st = st->next)
        if (strcmp(st->sid, sid) == 0) {
            st->state = state;
            return;
        }
}

static stream_t *stream_touch(vdon_sdk *s, const char *sid, const char *uuid) {
    /* lock held */
    stream_t *st;
    if (!sid || !*sid)
        return NULL;
    for (st = s->streams; st; st = st->next)
        if (strcmp(st->sid, sid) == 0)
            break;
    if (!st) {
        st = (stream_t *)calloc(1, sizeof(*st));
        st->sid = vdon_strdup(sid);
        st->state = "available";
        st->next = s->streams;
        s->streams = st;
    }
    if (uuid && *uuid) {
        free(st->uuid);
        st->uuid = vdon_strdup(uuid);
    }
    if (strcmp(st->state, "disconnected") == 0 || strcmp(st->state, "failed") == 0)
        st->state = "available";
    return st;
}

static void conn_bye(vdon_sdk *s, conn_t *c) {
    cJSON *m = cJSON_CreateObject();
    cJSON_AddBoolToObject(m, "bye", 1);
    if (!vdon__conn_send_control(s, c, m)) {
        cJSON_AddStringToObject(m, "UUID", c->uuid);
        vdon__ws_send(s, m);
    }
    cJSON_Delete(m);
}

/* Unlinks a connection and schedules its close. lock held. */
static void conn_retire(vdon_sdk *s, conn_t *c) {
    conn_t **pp;
    if (c->closed)
        return;
    c->closed = 1;
    for (pp = &s->conns; *pp; pp = &(*pp)->next)
        if (*pp == c) {
            *pp = c->next;
            break;
        }
    c->next = NULL;
    cancel_jobs_for_conn(s, c, -1);
    vdon__schedule(s, JOB_CLOSE_CONN, vdon_now_ms(), c, NULL, 0);
    pthread_cond_broadcast(&s->cond);
}

static void conn_free(conn_t *c) {
    chan_t *ch;
    ptrack_t *t;
    while ((ch = c->chans)) {
        c->chans = ch->next;
        free(ch->label);
        free(ch->fid);
        free(ch->fname);
        cJSON_Delete(ch->res_meta);
        free(ch->res_buf);
        free(ch);
    }
    while ((t = c->tracks)) {
        c->tracks = t->next;
        free(t);
    }
    cJSON_Delete(c->info);
    cJSON_Delete(c->obs);
    cJSON_Delete(c->ice_bundle);
    cJSON_Delete(c->advertised);
    free(c->uuid);
    free(c->stream_id);
    free(c->vlabel);
    free(c);
}

/* Closes libdatachannel objects. lock NOT held. */
static void conn_close_rtc(vdon_sdk *s, conn_t *c) {
    chan_t *ch;
    ptrack_t *t;
    (void)s;
    for (ch = c->chans; ch; ch = ch->next)
        if (ch->dc >= 0) {
            rtcDelete(ch->dc);
            ch->dc = -1;
            ch->open = 0;
        }
    for (t = c->tracks; t; t = t->next)
        if (t->tr >= 0) {
            rtcDeleteTrack(t->tr);
            t->tr = -1;
        }
    if (c->pc >= 0) {
        rtcDeletePeerConnection(c->pc);
        c->pc = -1;
    }
}

static void schedule_view_retry(vdon_sdk *s, const char *sid, int delay_ms) {
    /* lock held */
    if (s->intentional || strnode_has(s->stopped_views, sid) || has_job(s, JOB_VIEW_RETRY, sid))
        return;
    vdon__schedule(s, JOB_VIEW_RETRY, vdon_now_ms() + delay_ms, NULL, sid, 0);
}

/* Drops a failed connection; viewers retry from the play request. */
static void recover_connection(vdon_sdk *s, conn_t *c, const char *reason) {
    char *sid = NULL;
    const char *type;
    pthread_mutex_lock(&s->lock);
    if (c->closed) {
        pthread_mutex_unlock(&s->lock);
        return;
    }
    type = c->type;
    sid = c->stream_id ? vdon_strdup(c->stream_id) : NULL;
    set_stream_state(s, c->stream_id, "failed");
    conn_retire(s, c);
    if (type == TYPE_VIEWER && sid)
        schedule_view_retry(s, sid, 2000);
    pthread_mutex_unlock(&s->lock);
    vdon__logf(s, "Recovering %s connection to %s (%s)", type, c->uuid, reason);
    {
        EV(ev, VDON_EVENT_CONNECTION_FAILED);
        ev.uuid = c->uuid;
        ev.stream_id = sid;
        ev.connection_type = type;
        ev.message = reason;
        vdon__emit(s, &ev);
    }
    free(sid);
}

/* --------------------------------------------------- peer connection cbs */

static void on_candidate_message(vdon_sdk *s, conn_t *c, cJSON *bundle, int via_dc);

static int mline_index(int pc, const char *mid) {
    char buf[16384];
    char *p, *line;
    int cur = -1;
    if (!mid || rtcGetLocalDescription(pc, buf, sizeof(buf)) < 0)
        return 0;
    p = buf;
    while ((line = p) && *line) {
        char *nl = strchr(line, '\n');
        if (nl)
            *nl = 0;
        if (strncmp(line, "m=", 2) == 0)
            cur++;
        else if (strncmp(line, "a=mid:", 6) == 0) {
            size_t n = strlen(line + 6);
            while (n && (line[6 + n - 1] == '\r'))
                n--;
            if (strlen(mid) == n && strncmp(line + 6, mid, n) == 0)
                return cur < 0 ? 0 : cur;
        }
        p = nl ? nl + 1 : NULL;
    }
    return 0;
}

static void RTC_API on_local_description(int pc, const char *sdp, const char *type, void *ptr) {
    conn_t *c = (conn_t *)ptr;
    vdon_sdk *s;
    cJSON *desc, *msg;
    char hashed[96];
    int is_offer;
    if (!c)
        return;
    s = c->sdk;
    pthread_mutex_lock(&s->lock);
    if (c->closed) {
        pthread_mutex_unlock(&s->lock);
        return;
    }
    is_offer = strcmp(type, "offer") == 0;
    msg = cJSON_CreateObject();
    cJSON_AddStringToObject(msg, "UUID", c->uuid);
    cJSON_AddStringToObject(msg, "session", c->session);
    if (c->stream_id && *c->stream_id) {
        hashed_stream_id(s, c->stream_id, hashed, sizeof(hashed));
        cJSON_AddStringToObject(msg, "streamID", hashed);
    }
    pthread_mutex_unlock(&s->lock);
    desc = cJSON_CreateObject();
    cJSON_AddStringToObject(desc, "type", type);
    cJSON_AddStringToObject(desc, "sdp", sdp);
    if (s->has_password) {
        if (encrypt_into(s, msg, "description", desc) != VDON_OK) {
            cJSON_Delete(desc);
            cJSON_Delete(msg);
            return;
        }
        cJSON_Delete(desc);
    } else {
        cJSON_AddItemToObject(msg, "description", desc);
    }
    (void)is_offer;
    /* Over the control channel when open (renegotiation), else via signaling. */
    {
        cJSON *dcm = cJSON_CreateObject();
        cJSON_AddItemReferenceToObject(dcm, "description", jget(msg, "description"));
        cJSON_AddItemReferenceToObject(dcm, "session", jget(msg, "session"));
        if (jget(msg, "vector"))
            cJSON_AddItemReferenceToObject(dcm, "vector", jget(msg, "vector"));
        if (!vdon__conn_send_control(s, c, dcm))
            vdon__ws_send(s, msg);
        cJSON_Delete(dcm);
    }
    cJSON_Delete(msg);
}

static void RTC_API on_local_candidate(int pc, const char *cand, const char *mid, void *ptr) {
    conn_t *c = (conn_t *)ptr;
    vdon_sdk *s;
    cJSON *obj;
    int via_dc = 0;
    if (!c || !cand)
        return;
    s = c->sdk;
    obj = cJSON_CreateObject();
    cJSON_AddStringToObject(obj, "candidate", cand);
    cJSON_AddStringToObject(obj, "sdpMid", mid ? mid : "0");
    cJSON_AddNumberToObject(obj, "sdpMLineIndex", mline_index(pc, mid));
    pthread_mutex_lock(&s->lock);
    if (c->closed) {
        pthread_mutex_unlock(&s->lock);
        cJSON_Delete(obj);
        return;
    }
    if (c->control && c->control->open) {
        via_dc = 1;
    } else {
        int delay;
        if (!c->ice_bundle)
            c->ice_bundle = cJSON_CreateArray();
        cJSON_AddItemToArray(c->ice_bundle, obj);
        obj = NULL;
        if (!c->ice_scheduled) {
            delay = c->ice_delay_ms;
            c->ice_delay_ms = c->ice_delay_ms * 2 > 1000 ? 1000 : c->ice_delay_ms * 2;
            c->ice_scheduled = 1;
            vdon__schedule(s, JOB_ICE_FLUSH, vdon_now_ms() + delay, c, NULL, 0);
        }
    }
    pthread_mutex_unlock(&s->lock);
    if (via_dc) {
        cJSON *arr = cJSON_CreateArray();
        cJSON_AddItemToArray(arr, obj);
        on_candidate_message(s, c, arr, 1);
    }
}

/* Sends a candidate bundle (takes ownership). */
static void on_candidate_message(vdon_sdk *s, conn_t *c, cJSON *bundle, int via_dc) {
    cJSON *msg = cJSON_CreateObject();
    cJSON_AddStringToObject(msg, "type", c->type == TYPE_VIEWER ? "remote" : "local");
    cJSON_AddStringToObject(msg, "UUID", c->uuid);
    cJSON_AddStringToObject(msg, "session", c->session);
    if (s->has_password) {
        if (encrypt_into(s, msg, "candidates", bundle) != VDON_OK) {
            cJSON_Delete(bundle);
            cJSON_Delete(msg);
            return;
        }
        cJSON_Delete(bundle);
    } else {
        cJSON_AddItemToObject(msg, "candidates", bundle);
    }
    if (!(via_dc && vdon__conn_send_control(s, c, msg)))
        vdon__ws_send(s, msg);
    cJSON_Delete(msg);
}

static void RTC_API on_state_change(int pc, rtcState state, void *ptr) {
    conn_t *c = (conn_t *)ptr;
    vdon_sdk *s;
    if (!c)
        return;
    s = c->sdk;
    vdon__logf(s, "Peer state for %s/%s: %d", c->uuid, c->type, (int)state);
    pthread_mutex_lock(&s->lock);
    if (c->closed) {
        pthread_mutex_unlock(&s->lock);
        return;
    }
    switch (state) {
    case RTC_CONNECTED: {
        int first = !c->connected_once;
        char *sid = c->stream_id ? vdon_strdup(c->stream_id) : NULL;
        c->connected_once = 1;
        c->grace_pending = 0;
        set_stream_state(s, c->stream_id, "connected");
        cancel_jobs_for_conn(s, c, JOB_PING);
        pthread_cond_broadcast(&s->cond);
        pthread_mutex_unlock(&s->lock);
        if (first) {
            EV(ev, VDON_EVENT_PEER_CONNECTED);
            ev.uuid = c->uuid;
            ev.stream_id = sid;
            ev.connection_type = c->type;
            vdon__emit(s, &ev);
        }
        free(sid);
        return;
    }
    case RTC_DISCONNECTED:
        set_stream_state(s, c->stream_id, "disconnected");
        if (!c->grace_pending) {
            c->grace_pending = 1;
            vdon__schedule(s, JOB_DISCONNECT_GRACE, vdon_now_ms() + 5000, c, NULL, 0);
        }
        pthread_mutex_unlock(&s->lock);
        return;
    case RTC_FAILED:
        pthread_mutex_unlock(&s->lock);
        recover_connection(s, c, "failed");
        return;
    case RTC_CLOSED:
        pthread_mutex_unlock(&s->lock);
        return;
    default:
        pthread_mutex_unlock(&s->lock);
        return;
    }
}

/* ------------------------------------------------------------ data chans */

static void RTC_API on_dc_open(int id, void *ptr);
static void RTC_API on_dc_closed(int id, void *ptr);
static void RTC_API on_dc_message(int id, const char *message, int size, void *ptr);

chan_t *vdon__chan_new(conn_t *c, int dc, int kind, const char *label) {
    chan_t *ch = (chan_t *)calloc(1, sizeof(*ch));
    ch->dc = dc;
    ch->kind = kind;
    ch->label = vdon_strdup(label ? label : "");
    ch->conn = c;
    ch->next = c->chans;
    c->chans = ch;
    return ch;
}

void vdon__chan_install_callbacks(chan_t *ch) {
    rtcSetUserPointer(ch->dc, ch);
    rtcSetOpenCallback(ch->dc, on_dc_open);
    rtcSetClosedCallback(ch->dc, on_dc_closed);
    rtcSetMessageCallback(ch->dc, on_dc_message);
}

static void control_opened(vdon_sdk *s, conn_t *c, chan_t *ch) {
    cJSON *m = NULL;
    int is_viewer;
    char *sid;
    pthread_mutex_lock(&s->lock);
    if (c->closed) {
        pthread_mutex_unlock(&s->lock);
        return;
    }
    c->control = ch;
    ch->open = 1;
    is_viewer = c->type == TYPE_VIEWER;
    sid = c->stream_id ? vdon_strdup(c->stream_id) : NULL;
    if (is_viewer) {
        m = cJSON_CreateObject();
        cJSON_AddBoolToObject(m, "audio", c->vopts.audio);
        cJSON_AddBoolToObject(m, "video", c->vopts.video);
        cJSON_AddBoolToObject(m, "downloads", c->vopts.downloads);
        if (c->vlabel && *c->vlabel) {
            cJSON *info = cJSON_AddObjectToObject(m, "info");
            cJSON_AddStringToObject(info, "label", c->vlabel);
        }
        if (c->vopts.allow_resources)
            cJSON_AddBoolToObject(m, "allowresources", 1);
        if (s->o.auto_ping_viewer) {
            int iv = s->o.auto_ping_interval_ms < 1000 ? 1000 : s->o.auto_ping_interval_ms;
            vdon__schedule(s, JOB_PING, vdon_now_ms() + iv, c, NULL, 0);
        }
    } else if (s->publisher_info && cJSON_GetArraySize(s->publisher_info) > 0) {
        m = cJSON_CreateObject();
        cJSON_AddItemToObject(m, "info", cJSON_Duplicate(s->publisher_info, 1));
    }
    pthread_cond_broadcast(&s->cond);
    pthread_mutex_unlock(&s->lock);
    if (m) {
        vdon__conn_send_control(s, c, m);
        cJSON_Delete(m);
    }
    vdon__send_subscriptions(s, c);
    {
        EV(ev, VDON_EVENT_DATA_CHANNEL_OPEN);
        ev.uuid = c->uuid;
        ev.stream_id = sid;
        ev.connection_type = c->type;
        ev.channel = ch->dc;
        ev.label = ch->label;
        vdon__emit(s, &ev);
    }
    free(sid);
}

static void RTC_API on_dc_open(int id, void *ptr) {
    chan_t *ch = (chan_t *)ptr;
    if (!ch)
        return;
    if (ch->kind == CH_CONTROL) {
        control_opened(ch->conn->sdk, ch->conn, ch);
        return;
    }
    pthread_mutex_lock(&ch->conn->sdk->lock);
    ch->open = 1;
    pthread_cond_broadcast(&ch->conn->sdk->cond);
    pthread_mutex_unlock(&ch->conn->sdk->lock);
    vdon__chan_opened_extra(ch);
}

static void RTC_API on_dc_closed(int id, void *ptr) {
    chan_t *ch = (chan_t *)ptr;
    conn_t *c;
    vdon_sdk *s;
    int was_control = 0;
    char *sid = NULL;
    if (!ch)
        return;
    c = ch->conn;
    s = c->sdk;
    pthread_mutex_lock(&s->lock);
    ch->open = 0;
    if (ch->kind == CH_CONTROL && c->control == ch) {
        c->control = NULL;
        was_control = !c->closed;
        sid = c->stream_id ? vdon_strdup(c->stream_id) : NULL;
        cancel_jobs_for_conn(s, c, JOB_CLOSE_CONN);
    }
    pthread_cond_broadcast(&s->cond);
    pthread_mutex_unlock(&s->lock);
    vdon__chan_closed_extra(ch);
    if (was_control) {
        EV(ev, VDON_EVENT_DATA_CHANNEL_CLOSE);
        ev.uuid = c->uuid;
        ev.stream_id = sid;
        ev.connection_type = c->type;
        ev.label = ch->label;
        vdon__emit(s, &ev);
    }
    free(sid);
}

static void handle_control(vdon_sdk *s, conn_t *c, cJSON *msg);

static void RTC_API on_dc_message(int id, const char *message, int size, void *ptr) {
    chan_t *ch = (chan_t *)ptr;
    if (!ch)
        return;
    if (ch->kind == CH_CONTROL) {
        cJSON *msg;
        conn_t *c = ch->conn;
        vdon_sdk *s = c->sdk;
        if (size >= 0)
            return; /* binary on the control channel: VDO.Ninja renders images; ignored here */
        pthread_mutex_lock(&s->lock);
        c->last_message = vdon_now_ms();
        pthread_mutex_unlock(&s->lock);
        msg = cJSON_Parse(message);
        if (!msg)
            return;
        vdon__logf(s, "<- DC(%s/%s) %.300s", c->uuid, c->type, message);
        if (cJSON_IsObject(msg))
            handle_control(s, c, msg);
        cJSON_Delete(msg);
        return;
    }
    vdon__chan_message(ch, message, size);
}

static void RTC_API on_data_channel(int pc, int dc, void *ptr) {
    conn_t *c = (conn_t *)ptr;
    vdon_sdk *s;
    char label[256];
    chan_t *ch;
    int kind;
    if (!c)
        return;
    s = c->sdk;
    if (rtcGetDataChannelLabel(dc, label, sizeof(label)) < 0)
        label[0] = 0;
    vdon__logf(s, "Data channel from %s: \"%s\"", c->uuid, label);
    if (!label[0] || strcmp(label, VDON_CONTROL_CHANNEL) == 0)
        kind = CH_CONTROL;
    else if (strcmp(label, "chunked") == 0)
        kind = CH_IGNORED;
    else if (strcmp(label, "resources") == 0)
        kind = CH_RESOURCE;
    else if (strcmp(label, VDON_BINARY_CHANNEL) == 0)
        kind = CH_BINARY;
    else if (strncmp(label, "x-", 2) == 0)
        kind = CH_RESERVED;
    else
        kind = CH_FILE_IN;
    pthread_mutex_lock(&s->lock);
    if (c->closed) {
        pthread_mutex_unlock(&s->lock);
        vdon__schedule(s, JOB_CLOSE_DC, vdon_now_ms(), NULL, NULL, dc);
        return;
    }
    ch = vdon__chan_new(c, dc, kind, label);
    if (kind == CH_RESOURCE && !c->vopts.allow_resources) {
        ch->kind = CH_IGNORED;
        vdon__schedule(s, JOB_CLOSE_DC, vdon_now_ms(), NULL, NULL, dc);
    }
    pthread_mutex_unlock(&s->lock);
    vdon__chan_install_callbacks(ch);
    if (kind == CH_IGNORED) {
        EV(ev, VDON_EVENT_UNSUPPORTED_CHANNEL);
        ev.uuid = c->uuid;
        ev.label = label;
        vdon__emit(s, &ev);
        return;
    }
    /* Incoming channels are already open when libdatachannel reports them. */
    if (rtcIsOpen(dc))
        on_dc_open(dc, ch);
}

/* --------------------------------------------------------------- tracks */

static void RTC_API on_track_message(int id, const char *message, int size, void *ptr) {
    ptrack_t *t = (ptrack_t *)ptr;
    if (!t || size < 0)
        return;
    {
        EV(ev, VDON_EVENT_RTP);
        ev.uuid = t->conn->uuid;
        ev.track = id;
        ev.label = t->kind == VDON_MEDIA_AUDIO ? "audio" : "video";
        ev.bytes = (const uint8_t *)message;
        ev.size = (size_t)size;
        vdon__emit(t->conn->sdk, &ev);
    }
}

static void RTC_API on_pli(int tr, void *ptr) {
    ptrack_t *t = (ptrack_t *)ptr;
    if (!t)
        return;
    {
        EV(ev, VDON_EVENT_KEYFRAME_REQUEST);
        ev.uuid = t->conn->uuid;
        ev.track = tr;
        ev.label = t->kind == VDON_MEDIA_AUDIO ? "audio" : "video";
        vdon__emit(t->conn->sdk, &ev);
    }
}

static void RTC_API on_track(int pc, int tr, void *ptr) {
    conn_t *c = (conn_t *)ptr;
    vdon_sdk *s;
    char desc[4096];
    ptrack_t *t;
    if (!c)
        return;
    s = c->sdk;
    if (rtcGetTrackDescription(tr, desc, sizeof(desc)) < 0)
        desc[0] = 0;
    t = (ptrack_t *)calloc(1, sizeof(*t));
    t->tr = tr;
    t->conn = c;
    t->kind = strstr(desc, "m=audio") ? VDON_MEDIA_AUDIO : VDON_MEDIA_VIDEO;
    pthread_mutex_lock(&s->lock);
    if (c->closed) {
        pthread_mutex_unlock(&s->lock);
        free(t);
        return;
    }
    t->next = c->tracks;
    c->tracks = t;
    pthread_mutex_unlock(&s->lock);
    rtcSetUserPointer(tr, t);
    rtcChainRtcpReceivingSession(tr);
    rtcSetMessageCallback(tr, on_track_message);
    {
        EV(ev, VDON_EVENT_TRACK);
        ev.uuid = c->uuid;
        ev.stream_id = c->stream_id;
        ev.track = tr;
        ev.label = t->kind == VDON_MEDIA_AUDIO ? "audio" : "video";
        ev.message = desc;
        vdon__emit(s, &ev);
    }
}

int vdon_request_keyframe(vdon_sdk *sdk, int track) {
    if (!sdk || track < 0)
        return VDON_ERR_INVALID;
    return rtcRequestKeyframe(track) >= 0 ? VDON_OK : VDON_ERR_FAILURE;
}

static int add_publisher_tracks(vdon_sdk *s, conn_t *c) {
    /* lock held */
    int i;
    for (i = 0; i < s->track_count; i++) {
        track_tmpl *tp = &s->tracks[i];
        rtcTrackInit init;
        ptrack_t *t;
        int tr;
        uint32_t ssrc = tp->init.ssrc;
        if (!ssrc)
            vdon_random_bytes((uint8_t *)&ssrc, sizeof(ssrc));
        memset(&init, 0, sizeof(init));
        init.direction = RTC_DIRECTION_SENDONLY;
        init.codec = (rtcCodec)tp->init.codec;
        init.payloadType = tp->init.payload_type;
        init.ssrc = ssrc;
        init.mid = tp->mid;
        init.name = tp->init.kind == VDON_MEDIA_AUDIO ? "audio" : "video";
        init.msid = "vdoninja";
        init.trackId = tp->init.kind == VDON_MEDIA_AUDIO ? "vdoninja-audio" : "vdoninja-video";
        tr = rtcAddTrackEx(c->pc, &init);
        if (tr < 0)
            return VDON_ERR_FAILURE;
        t = (ptrack_t *)calloc(1, sizeof(*t));
        t->tr = tr;
        t->kind = tp->init.kind;
        t->packetize = tp->init.packetize;
        t->clock_rate = (uint32_t)(tp->init.clock_rate > 0 ? tp->init.clock_rate : codec_clock_rate(tp->init.codec));
        t->conn = c;
        vdon_random_bytes((uint8_t *)&t->ts, sizeof(t->ts));
        t->next = c->tracks;
        c->tracks = t;
        rtcSetUserPointer(tr, t);
        if (tp->init.packetize) {
            rtcPacketizerInit pi;
            uint16_t seq;
            vdon_random_bytes((uint8_t *)&seq, sizeof(seq));
            memset(&pi, 0, sizeof(pi));
            pi.ssrc = ssrc;
            pi.cname = "vdoninja";
            pi.payloadType = (uint8_t)tp->init.payload_type;
            pi.clockRate = t->clock_rate;
            pi.sequenceNumber = seq;
            pi.timestamp = t->ts;
            pi.nalSeparator = (rtcNalUnitSeparator)tp->init.nal_separator;
            pi.obuPacketization = RTC_OBU_PACKETIZED_TEMPORAL_UNIT;
            switch (tp->init.codec) {
            case VDON_CODEC_H264: rtcSetH264Packetizer(tr, &pi); break;
            case VDON_CODEC_H265: rtcSetH265Packetizer(tr, &pi); break;
            case VDON_CODEC_AV1: rtcSetAV1Packetizer(tr, &pi); break;
            case VDON_CODEC_OPUS: rtcSetOpusPacketizer(tr, &pi); break;
            case VDON_CODEC_AAC: rtcSetAACPacketizer(tr, &pi); break;
            case VDON_CODEC_PCMU: rtcSetPCMUPacketizer(tr, &pi); break;
            case VDON_CODEC_PCMA: rtcSetPCMAPacketizer(tr, &pi); break;
            case VDON_CODEC_G722: rtcSetG722Packetizer(tr, &pi); break;
            default: break;
            }
            rtcChainRtcpSrReporter(tr);
            rtcChainRtcpNackResponder(tr, 512);
        }
        rtcChainPliHandler(tr, on_pli);
    }
    return VDON_OK;
}

/* Creates a peer connection record. lock NOT held. Returns NULL on failure. */
static conn_t *conn_create(vdon_sdk *s, const char *uuid, const char *type) {
    rtcConfiguration cfg;
    conn_t *c;
    int pc;
    ensure_ice_servers(s);
    memset(&cfg, 0, sizeof(cfg));
    pthread_mutex_lock(&s->lock);
    cfg.iceServers = (const char **)s->ice_servers;
    cfg.iceServersCount = s->ice_count;
    cfg.bindAddress = s->o.bind_address;
    cfg.iceTransportPolicy = s->o.force_turn ? RTC_TRANSPORT_POLICY_RELAY : RTC_TRANSPORT_POLICY_ALL;
    cfg.disableAutoNegotiation = true;
    pthread_mutex_unlock(&s->lock);
    pc = rtcCreatePeerConnection(&cfg);
    if (pc < 0) {
        vdon__logf(s, "rtcCreatePeerConnection failed: %d", pc);
        return NULL;
    }
    c = (conn_t *)calloc(1, sizeof(*c));
    c->sdk = s;
    c->uuid = vdon_strdup(uuid);
    c->type = type;
    c->pc = pc;
    c->info = cJSON_CreateObject();
    c->obs = cJSON_CreateObject();
    c->advertised = cJSON_CreateArray();
    c->allow_audio = c->allow_video = 1;
    c->ice_delay_ms = 70;
    c->created_at = vdon_now_ms();
    vdon_view_options_init(&c->vopts);
    vdon_generate_session(c->session);
    rtcSetUserPointer(pc, c);
    rtcSetLocalDescriptionCallback(pc, on_local_description);
    rtcSetLocalCandidateCallback(pc, on_local_candidate);
    rtcSetStateChangeCallback(pc, on_state_change);
    rtcSetDataChannelCallback(pc, on_data_channel);
    rtcSetTrackCallback(pc, on_track);
    pthread_mutex_lock(&s->lock);
    c->next = s->conns;
    s->conns = c;
    vdon__schedule(s, JOB_CONNECT_TIMEOUT, vdon_now_ms() + s->o.connection_timeout_ms, c, NULL, 0);
    pthread_mutex_unlock(&s->lock);
    return c;
}

/* ----------------------------------------------------------- pending ICE */

static void queue_pending_ice(vdon_sdk *s, const char *uuid, const char *type, const char *session, cJSON *cands) {
    /* lock held; takes ownership of cands */
    pice_t *p = (pice_t *)calloc(1, sizeof(*p));
    p->uuid = vdon_strdup(uuid);
    p->type = type;
    p->session = session && *session ? vdon_strdup(session) : NULL;
    p->cands = cands;
    p->next = s->pending_ice;
    s->pending_ice = p;
}

static void add_candidates(conn_t *c, cJSON *cands) {
    cJSON *it;
    cJSON_ArrayForEach(it, cands) {
        const char *cand = cJSON_IsString(it) ? cJSON_GetStringValue(it) : jstr(it, "candidate");
        const char *mid = cJSON_IsObject(it) ? jstr(it, "sdpMid") : NULL;
        if (cand && *cand)
            rtcAddRemoteCandidate(c->pc, cand, mid);
    }
}

/* lock NOT held */
static void drain_pending_ice(vdon_sdk *s, conn_t *c, const char *type) {
    cJSON *all = cJSON_CreateArray();
    pice_t **pp;
    pthread_mutex_lock(&s->lock);
    pp = &s->pending_ice;
    while (*pp) {
        pice_t *p = *pp;
        if (strcmp(p->uuid, c->uuid) == 0 && p->type == type) {
            cJSON *it;
            /* Candidates queued for an earlier session of this peer are dropped. */
            if (!(p->session && c->session[0] && strcmp(p->session, c->session) != 0))
                while ((it = cJSON_DetachItemFromArray(p->cands, 0)))
                    cJSON_AddItemToArray(all, it);
            *pp = p->next;
            cJSON_Delete(p->cands);
            free(p->uuid);
            free(p->session);
            free(p);
        } else {
            pp = &p->next;
        }
    }
    pthread_mutex_unlock(&s->lock);
    add_candidates(c, all);
    cJSON_Delete(all);
}

static void drop_pending_ice(vdon_sdk *s, const char *uuid) {
    /* lock held */
    pice_t **pp = &s->pending_ice;
    while (*pp) {
        pice_t *p = *pp;
        if (strcmp(p->uuid, uuid) == 0) {
            *pp = p->next;
            cJSON_Delete(p->cands);
            free(p->uuid);
            free(p->session);
            free(p);
        } else {
            pp = &p->next;
        }
    }
}

/* --------------------------------------------------------- SDP handling */

static void handle_offer(vdon_sdk *s, const char *uuid, const char *session, cJSON *msg, cJSON *desc, conn_t *via) {
    conn_t *c = NULL;
    char *clean = NULL;
    const char *raw_sid = jstr(msg, "streamID");
    const char *sdp = jstr(desc, "sdp");
    pview_t *pv = NULL;
    int rc;
    if (!sdp)
        return;
    pthread_mutex_lock(&s->lock);
    if (raw_sid)
        clean = strip_hash(s, raw_sid);
    c = via && via->type == TYPE_VIEWER ? via : vdon__find_conn(s, uuid, TYPE_VIEWER);
    if (c && session && *session && strcmp(c->session, session) != 0) {
        vdon__logf(s, "Session mismatch for %s (%s vs %s): replacing viewer connection", uuid, c->session, session);
        conn_retire(s, c);
        c = NULL;
    }
    if (!c && clean) {
        for (pv = s->pending_views; pv; pv = pv->next)
            if (strcmp(pv->sid, clean) == 0)
                break;
    }
    pthread_mutex_unlock(&s->lock);
    if (!c) {
        c = conn_create(s, uuid, TYPE_VIEWER);
        if (!c) {
            EV(ev, VDON_EVENT_ERROR);
            ev.uuid = uuid;
            ev.message = "failed to create viewer connection";
            vdon__emit(s, &ev);
            free(clean);
            return;
        }
        pthread_mutex_lock(&s->lock);
        if (session && *session)
            snprintf(c->session, sizeof(c->session), "%s", session);
        if (clean)
            c->stream_id = vdon_strdup(clean);
        /* re-lookup: the pending view may have changed while unlocked */
        pv = NULL;
        if (clean)
            for (pv = s->pending_views; pv; pv = pv->next)
                if (strcmp(pv->sid, clean) == 0)
                    break;
        if (pv) {
            c->vopts = pv->opts;
            free(c->vlabel);
            c->vlabel = pv->label ? vdon_strdup(pv->label) : NULL;
        }
        if (clean && *clean)
            stream_touch(s, clean, uuid);
        pthread_mutex_unlock(&s->lock);
    } else {
        pthread_mutex_lock(&s->lock);
        if (!c->session[0] && session)
            snprintf(c->session, sizeof(c->session), "%s", session);
        if (!c->stream_id && clean)
            c->stream_id = vdon_strdup(clean);
        pthread_mutex_unlock(&s->lock);
    }
    rc = rtcSetRemoteDescription(c->pc, sdp, "offer");
    if (rc < 0) {
        EV(ev, VDON_EVENT_ERROR);
        ev.uuid = uuid;
        ev.message = "failed to handle offer";
        vdon__emit(s, &ev);
        free(clean);
        return;
    }
    pthread_mutex_lock(&s->lock);
    c->remote_set = 1;
    pthread_mutex_unlock(&s->lock);
    drain_pending_ice(s, c, "local");
    /* the answer is delivered via on_local_description */
    if (rtcSetLocalDescription(c->pc, "answer") < 0) {
        EV(ev, VDON_EVENT_ERROR);
        ev.uuid = uuid;
        ev.message = "failed to create answer";
        vdon__emit(s, &ev);
    }
    if (clean && *clean) {
        pview_t **pp;
        pthread_mutex_lock(&s->lock);
        pp = &s->pending_views;
        while (*pp) {
            if (strcmp((*pp)->sid, clean) == 0) {
                pview_t *d = *pp;
                *pp = d->next;
                free(d->sid);
                free(d->label);
                free(d);
            } else {
                pp = &(*pp)->next;
            }
        }
        pthread_cond_broadcast(&s->cond);
        pthread_mutex_unlock(&s->lock);
    }
    free(clean);
}

static void handle_answer(vdon_sdk *s, const char *uuid, const char *session, cJSON *desc) {
    conn_t *c;
    const char *sdp = jstr(desc, "sdp");
    if (!sdp)
        return;
    pthread_mutex_lock(&s->lock);
    c = vdon__find_conn(s, uuid, TYPE_PUBLISHER);
    if (!c)
        c = vdon__find_conn(s, uuid, NULL);
    if (c && session && *session && strcmp(c->session, session) != 0) {
        vdon__logf(s, "Session mismatch, ignoring answer from %s", uuid);
        c = NULL;
    }
    pthread_mutex_unlock(&s->lock);
    if (!c) {
        vdon__logf(s, "No connection for answer from %s", uuid);
        return;
    }
    if (rtcSetRemoteDescription(c->pc, sdp, "answer") < 0) {
        EV(ev, VDON_EVENT_ERROR);
        ev.uuid = uuid;
        ev.message = "failed to handle answer";
        vdon__emit(s, &ev);
        return;
    }
    pthread_mutex_lock(&s->lock);
    c->remote_set = 1;
    pthread_mutex_unlock(&s->lock);
    drain_pending_ice(s, c, "remote");
}

static void handle_sdp(vdon_sdk *s, cJSON *msg, conn_t *via) {
    cJSON *desc = decode_field(s, msg, "description");
    const char *type, *uuid = via ? via->uuid : jstr(msg, "UUID"), *session = jstr(msg, "session");
    if (!desc)
        return;
    if (via && !session)
        session = via->session;
    type = jstr(desc, "type");
    if (uuid && type && strcmp(type, "offer") == 0)
        handle_offer(s, uuid, session, msg, desc, via);
    else if (uuid && type && strcmp(type, "answer") == 0)
        handle_answer(s, uuid, session, desc);
    cJSON_Delete(desc);
}

static void handle_remote_candidates(vdon_sdk *s, cJSON *msg, conn_t *via, int single) {
    cJSON *cands = decode_field(s, msg, single ? "candidate" : "candidates");
    const char *uuid = via ? via->uuid : jstr(msg, "UUID");
    const char *mtype = jstr(msg, "type");
    const char *session = via ? NULL : jstr(msg, "session");
    const char *want;
    conn_t *c;
    int ready = 0;
    if (!cands || !uuid) {
        cJSON_Delete(cands);
        return;
    }
    if (!cJSON_IsArray(cands)) {
        cJSON *arr = cJSON_CreateArray();
        cJSON_AddItemToArray(arr, cands);
        cands = arr;
    }
    /* "remote" is sent by viewers toward our publisher pc; "local" by publishers toward our viewer pc. */
    if (via)
        want = via->type;
    else if (mtype && strcmp(mtype, "remote") == 0)
        want = TYPE_PUBLISHER;
    else
        want = TYPE_VIEWER;
    pthread_mutex_lock(&s->lock);
    c = via ? via : vdon__find_conn(s, uuid, want);
    if (c && c->closed)
        c = NULL;
    if (c && session && *session && c->session[0] && strcmp(c->session, session) != 0) {
        /* Delayed candidates from a replaced session (same UUID) would corrupt the new ICE agent. */
        vdon__logf(s, "Session mismatch for %s (%s vs %s): ignoring candidates", uuid, c->session, session);
        pthread_mutex_unlock(&s->lock);
        cJSON_Delete(cands);
        return;
    }
    if (c && c->remote_set)
        ready = 1;
    if (!ready) {
        queue_pending_ice(s, uuid, want == TYPE_PUBLISHER ? "remote" : "local", session, cands);
        pthread_mutex_unlock(&s->lock);
        return;
    }
    pthread_mutex_unlock(&s->lock);
    add_candidates(c, cands);
    cJSON_Delete(cands);
}

/* ------------------------------------------------------- offer creation */

static void handle_offer_request(vdon_sdk *s, const char *uuid) {
    conn_t *c, *old;
    char *sid;
    int rc;
    if (!uuid || !*uuid)
        return;
    pthread_mutex_lock(&s->lock);
    if (!s->publishing) {
        pthread_mutex_unlock(&s->lock);
        return;
    }
    sid = vdon_strdup(s->stream_id ? s->stream_id : "");
    old = vdon__find_conn(s, uuid, TYPE_PUBLISHER);
    if (old)
        conn_retire(s, old);
    pthread_mutex_unlock(&s->lock);
    c = conn_create(s, uuid, TYPE_PUBLISHER);
    if (!c) {
        free(sid);
        return;
    }
    pthread_mutex_lock(&s->lock);
    c->stream_id = sid;
    {
        chan_t *ch;
        int dc = rtcCreateDataChannel(c->pc, VDON_CONTROL_CHANNEL);
        if (dc < 0) {
            conn_retire(s, c);
            pthread_mutex_unlock(&s->lock);
            return;
        }
        ch = vdon__chan_new(c, dc, CH_CONTROL, VDON_CONTROL_CHANNEL);
        vdon__chan_install_callbacks(ch);
    }
    rc = add_publisher_tracks(s, c);
    pthread_mutex_unlock(&s->lock);
    if (rc != VDON_OK || rtcSetLocalDescription(c->pc, "offer") < 0) {
        EV(ev, VDON_EVENT_ERROR);
        ev.uuid = uuid;
        ev.message = "failed to create offer";
        vdon__emit(s, &ev);
        pthread_mutex_lock(&s->lock);
        conn_retire(s, c);
        pthread_mutex_unlock(&s->lock);
    }
}

/* ------------------------------------------------------------ bye / misc */

static void handle_bye(vdon_sdk *s, const char *uuid, vdon_event_type type, cJSON *msg) {
    conn_t *c;
    char *retry = NULL;
    int found = 0;
    if (!uuid || !*uuid)
        return;
    pthread_mutex_lock(&s->lock);
    drop_pending_ice(s, uuid);
    for (c = s->conns; c;) {
        conn_t *next = c->next;
        if (!c->closed && strcmp(c->uuid, uuid) == 0) {
            found = 1;
            if (c->type == TYPE_VIEWER && c->stream_id && !s->intentional && !strnode_has(s->stopped_views, c->stream_id)) {
                free(retry);
                retry = vdon_strdup(c->stream_id);
                set_stream_state(s, c->stream_id, "disconnected");
            }
            conn_retire(s, c);
        }
        c = next;
    }
    if (retry)
        schedule_view_retry(s, retry, 2000);
    pthread_mutex_unlock(&s->lock);
    {
        char *raw = vdon__json_text(msg);
        EV(ev, type);
        ev.uuid = uuid;
        ev.json = raw;
        vdon__emit(s, &ev);
        free(raw);
    }
    if (!found) {
        EV(ev, VDON_EVENT_PEER_DISCONNECTED);
        ev.uuid = uuid;
        vdon__emit(s, &ev);
    }
    free(retry);
}

static void auto_consider(vdon_sdk *s, const char *sid);

static void handle_listing(vdon_sdk *s, cJSON *msg) {
    cJSON *list = jget(msg, "list"), *out = cJSON_CreateArray(), *it;
    char *text;
    int first_join;
    pthread_mutex_lock(&s->lock);
    first_join = s->room_join_pending;
    s->room_join_pending = 0;
    s->room_joined = 1;
    if (cJSON_IsArray(list)) {
        cJSON_ArrayForEach(it, list) {
            cJSON *e = cJSON_CreateObject();
            char *sid = NULL;
            const char *uuid = NULL;
            if (cJSON_IsString(it)) {
                sid = strip_hash(s, cJSON_GetStringValue(it));
            } else if (cJSON_IsObject(it)) {
                const char *raw = jstr(it, "streamID");
                sid = raw ? strip_hash(s, raw) : vdon_strdup("");
                uuid = jstr(it, "UUID");
                if (!uuid)
                    uuid = jstr(it, "uuid");
                if (jstr(it, "label"))
                    cJSON_AddStringToObject(e, "label", jstr(it, "label"));
                cJSON_AddBoolToObject(e, "director", cJSON_IsTrue(jget(it, "director")));
            } else {
                cJSON_Delete(e);
                continue;
            }
            cJSON_AddStringToObject(e, "streamID", sid);
            if (uuid)
                cJSON_AddStringToObject(e, "UUID", uuid);
            if (*sid)
                stream_touch(s, sid, uuid);
            cJSON_AddItemToArray(out, e);
            free(sid);
        }
    } else if (jstr(msg, "streamID")) {
        cJSON *e = cJSON_CreateObject();
        char *sid = strip_hash(s, jstr(msg, "streamID"));
        cJSON_AddStringToObject(e, "streamID", sid);
        if (jstr(msg, "UUID"))
            cJSON_AddStringToObject(e, "UUID", jstr(msg, "UUID"));
        stream_touch(s, sid, jstr(msg, "UUID"));
        cJSON_AddItemToArray(out, e);
        free(sid);
    }
    pthread_cond_broadcast(&s->cond);
    pthread_mutex_unlock(&s->lock);
    text = cJSON_PrintUnformatted(out);
    if (first_join) {
        EV(ev, VDON_EVENT_ROOM_JOINED);
        ev.json = text;
        vdon__emit(s, &ev);
    }
    {
        EV(ev, VDON_EVENT_LISTING);
        ev.json = text;
        vdon__emit(s, &ev);
    }
    cJSON_ArrayForEach(it, out) {
        const char *sid = jstr(it, "streamID");
        if (sid && *sid)
            auto_consider(s, sid);
    }
    free(text);
    cJSON_Delete(out);
}

static void replay_pending_play(vdon_sdk *s, const char *sid) {
    pview_t *pv;
    int found = 0;
    char hashed[96];
    pthread_mutex_lock(&s->lock);
    for (pv = s->pending_views; pv; pv = pv->next)
        if (strcmp(pv->sid, sid) == 0)
            found = 1;
    if (found)
        hashed_stream_id(s, sid, hashed, sizeof(hashed));
    pthread_mutex_unlock(&s->lock);
    if (found) {
        cJSON *m = cJSON_CreateObject();
        cJSON_AddStringToObject(m, "request", "play");
        cJSON_AddStringToObject(m, "streamID", hashed);
        ws_send_free(s, m);
    }
}

static void handle_video_added(vdon_sdk *s, cJSON *msg, vdon_event_type type) {
    const char *raw = jstr(msg, "streamID"), *uuid = jstr(msg, "UUID");
    char *sid = NULL, *text;
    pthread_mutex_lock(&s->lock);
    if (raw)
        sid = strip_hash(s, raw);
    if (sid && *sid)
        stream_touch(s, sid, uuid);
    pthread_mutex_unlock(&s->lock);
    text = vdon__json_text(msg);
    {
        EV(ev, type);
        ev.stream_id = sid;
        ev.uuid = uuid;
        ev.json = text;
        vdon__emit(s, &ev);
    }
    free(text);
    if (sid && *sid) {
        replay_pending_play(s, sid);
        auto_consider(s, sid);
    }
    free(sid);
}

static void handle_signal(vdon_sdk *s, cJSON *msg) {
    const char *request = jstr(msg, "request");
    if (jget(msg, "description")) {
        handle_sdp(s, msg, NULL);
    } else if (jget(msg, "candidate")) {
        handle_remote_candidates(s, msg, NULL, 1);
    } else if (jget(msg, "candidates")) {
        handle_remote_candidates(s, msg, NULL, 0);
    } else if (request) {
        if (strcmp(request, "listing") == 0 || strcmp(request, "transferred") == 0)
            handle_listing(s, msg);
        else if (strcmp(request, "videoaddedtoroom") == 0)
            handle_video_added(s, msg, VDON_EVENT_VIDEO_ADDED_TO_ROOM);
        else if (strcmp(request, "someonejoined") == 0 || strcmp(request, "joinroom") == 0)
            handle_video_added(s, msg, VDON_EVENT_SOMEONE_JOINED);
        else if (strcmp(request, "play") == 0) {
            char *req;
            int ok;
            pthread_mutex_lock(&s->lock);
            req = strip_hash(s, jstr(msg, "streamID"));
            ok = s->publishing && s->stream_id && strcmp(s->stream_id, req) == 0;
            pthread_mutex_unlock(&s->lock);
            if (ok)
                handle_offer_request(s, jstr(msg, "UUID"));
            else
                vdon__logf(s, "Ignoring play request for \"%s\" (not publishing it)", req);
            free(req);
        } else if (strcmp(request, "offerSDP") == 0) {
            handle_offer_request(s, jstr(msg, "UUID"));
        } else if (strcmp(request, "error") == 0) {
            EV(ev, VDON_EVENT_ERROR);
            ev.message = jstr(msg, "message");
            vdon__emit(s, &ev);
        } else if (strcmp(request, "alert") == 0) {
            const char *text = jstr(msg, "message");
            EV(ev, VDON_EVENT_ALERT);
            ev.message = text;
            vdon__emit(s, &ev);
            if (text && (strstr(text, "already in use") || strstr(text, "Stream ID is already"))) {
                pthread_mutex_lock(&s->lock);
                s->publishing = 0;
                pthread_cond_broadcast(&s->cond);
                pthread_mutex_unlock(&s->lock);
            }
        }
    } else if (jget(msg, "bye")) {
        handle_bye(s, jstr(msg, "UUID"), VDON_EVENT_BYE, msg);
    } else if (jget(msg, "hangup")) {
        handle_bye(s, jstr(msg, "UUID"), VDON_EVENT_HANGUP, msg);
    } else if (jget(msg, "pipe") && jget(msg, "__fallback")) {
        char *text = vdon__json_text(jget(msg, "pipe"));
        EV(ev, VDON_EVENT_DATA_RECEIVED);
        ev.uuid = jstr(msg, "UUID");
        ev.json = text;
        ev.flag = 1;
        vdon__emit(s, &ev);
        free(text);
    } else if (jget(msg, "rejected") || jget(msg, "approved")) {
        EV(ev, VDON_EVENT_ALERT);
        ev.message = jget(msg, "rejected") ? "connection rejected" : "connection approved";
        vdon__emit(s, &ev);
    } else if (jget(msg, "iceRestartRequest")) {
        vdon__logf(s, "ICE restart requested by %s (not supported by libdatachannel)", jstr(msg, "UUID"));
    }
}

/* ----------------------------------------------------- control messages */

static void handle_control(vdon_sdk *s, conn_t *c, cJSON *msg) {
    cJSON *v;
    char *sid;
    pthread_mutex_lock(&s->lock);
    sid = c->stream_id ? vdon_strdup(c->stream_id) : NULL;
    pthread_mutex_unlock(&s->lock);

    if (cJSON_IsArray(jget(msg, "fileList"))) {
        char *text = vdon__json_text(jget(msg, "fileList"));
        EV(ev, VDON_EVENT_FILE_LIST);
        ev.uuid = c->uuid;
        ev.stream_id = sid;
        ev.json = text;
        vdon__emit(s, &ev);
        free(text);
    }
    if ((v = jget(msg, "requestFile"))) {
        char num[32];
        const char *id = NULL;
        if (cJSON_IsString(v))
            id = cJSON_GetStringValue(v);
        else if (cJSON_IsNumber(v)) {
            snprintf(num, sizeof(num), "%.0f", cJSON_GetNumberValue(v));
            id = num;
        }
        if (id)
            vdon__handle_file_request(s, c, id);
    }
    if ((v = jget(msg, "downloads"))) {
        int on = cJSON_IsTrue(v);
        pthread_mutex_lock(&s->lock);
        c->allow_download = on;
        pthread_mutex_unlock(&s->lock);
        if (on && c->type == TYPE_PUBLISHER)
            vdon__send_file_list(s, c);
    }
    if ((v = jget(msg, "allowresources"))) {
        pthread_mutex_lock(&s->lock);
        c->allow_resource = cJSON_IsTrue(v);
        pthread_mutex_unlock(&s->lock);
    }
    if (cJSON_IsObject((v = jget(msg, "obsState")))) {
        cJSON *k, *snap;
        char *text;
        pthread_mutex_lock(&s->lock);
        cJSON_ArrayForEach(k, v) {
            cJSON_DeleteItemFromObjectCaseSensitive(c->obs, k->string);
            cJSON_AddItemToObject(c->obs, k->string, cJSON_Duplicate(k, 1));
        }
        snap = cJSON_Duplicate(c->obs, 1);
        pthread_mutex_unlock(&s->lock);
        text = vdon__json_text(snap);
        {
            EV(ev, VDON_EVENT_OBS_STATE);
            ev.uuid = c->uuid;
            ev.stream_id = sid;
            ev.json = text;
            vdon__emit(s, &ev);
        }
        free(text);
        cJSON_Delete(snap);
    }
    if (cJSON_IsObject((v = jget(msg, "info")))) {
        cJSON *k, *snap;
        char *text;
        pthread_mutex_lock(&s->lock);
        cJSON_ArrayForEach(k, v) {
            cJSON_DeleteItemFromObjectCaseSensitive(c->info, k->string);
            cJSON_AddItemToObject(c->info, k->string, cJSON_Duplicate(k, 1));
        }
        snap = cJSON_Duplicate(c->info, 1);
        pthread_mutex_unlock(&s->lock);
        text = vdon__json_text(snap);
        {
            EV(ev, VDON_EVENT_PEER_INFO);
            ev.uuid = c->uuid;
            ev.stream_id = sid;
            ev.json = text;
            vdon__emit(s, &ev);
        }
        free(text);
        cJSON_Delete(snap);
    }

    if (jget(msg, "description")) {
        handle_sdp(s, msg, c);
    } else if (jget(msg, "candidate")) {
        handle_remote_candidates(s, msg, c, 1);
    } else if (jget(msg, "candidates")) {
        handle_remote_candidates(s, msg, c, 0);
    } else if (cJSON_IsBool(jget(msg, "audio")) || cJSON_IsBool(jget(msg, "video"))) {
        pthread_mutex_lock(&s->lock);
        if (cJSON_IsBool((v = jget(msg, "audio"))))
            c->allow_audio = cJSON_IsTrue(v);
        if (cJSON_IsBool((v = jget(msg, "video"))))
            c->allow_video = cJSON_IsTrue(v);
        pthread_mutex_unlock(&s->lock);
    } else if ((v = jget(msg, "ping"))) {
        cJSON *r = cJSON_CreateObject();
        cJSON_AddItemToObject(r, "pong", cJSON_Duplicate(v, 1));
        vdon__conn_send_control(s, c, r);
        cJSON_Delete(r);
    } else if (cJSON_IsNumber((v = jget(msg, "pong")))) {
        int64_t ts = (int64_t)cJSON_GetNumberValue(v), latency = vdon_now_ms() - ts;
        pthread_mutex_lock(&s->lock);
        if (c->pending_ping == ts) {
            c->pending_ping = 0;
            c->missed_pings = 0;
        }
        pthread_mutex_unlock(&s->lock);
        {
            EV(ev, VDON_EVENT_PEER_LATENCY);
            ev.uuid = c->uuid;
            ev.stream_id = sid;
            ev.number = latency;
            vdon__emit(s, &ev);
        }
    } else if (jget(msg, "bye")) {
        handle_bye(s, c->uuid, VDON_EVENT_BYE, msg);
    } else if ((v = jget(msg, "videoMuted"))) {
        char *text = vdon__json_text(msg);
        {
            EV(ev, VDON_EVENT_REMOTE_VIDEO_MUTE);
            ev.uuid = c->uuid;
            ev.stream_id = sid;
            ev.connection_type = c->type;
            ev.flag = cJSON_IsTrue(v);
            ev.json = text;
            vdon__emit(s, &ev);
        }
        {
            EV(ev, VDON_EVENT_DATA_RECEIVED);
            ev.uuid = c->uuid;
            ev.stream_id = sid;
            ev.json = text;
            vdon__emit(s, &ev);
        }
        free(text);
    } else if ((v = jget(msg, "pipe"))) {
        if (!(cJSON_IsObject(v) && vdon__handle_pipe_special(s, c, v))) {
            char *text = vdon__json_text(v);
            EV(ev, VDON_EVENT_DATA_RECEIVED);
            ev.uuid = c->uuid;
            ev.stream_id = sid;
            ev.json = text;
            vdon__emit(s, &ev);
            free(text);
        }
    } else if (jget(msg, "iceRestartRequest")) {
        vdon__logf(s, "ICE restart requested by %s (not supported by libdatachannel)", c->uuid);
    }
    free(sid);
}

/* ------------------------------------------------------------ view flow */

static int do_view(vdon_sdk *s, const char *stream_id, const vdon_view_options *opts, int timeout_ms, int from_retry) {
    char sid[80], hashed[96];
    pview_t *pv, *vi;
    cJSON *m;
    int connected;
    if (vdon_sanitize_stream_id(stream_id, sid, sizeof(sid)) != VDON_OK || !stream_id)
        return VDON_ERR_INVALID;
    pthread_mutex_lock(&s->lock);
    if (!from_retry)
        strnode_remove(&s->stopped_views, sid);
    else if (strnode_has(s->stopped_views, sid) || s->intentional) {
        pthread_mutex_unlock(&s->lock);
        return VDON_ERR_CANCELLED;
    }
    for (pv = s->pending_views; pv; pv = pv->next)
        if (strcmp(pv->sid, sid) == 0)
            break;
    if (!pv) {
        pv = (pview_t *)calloc(1, sizeof(*pv));
        pv->sid = vdon_strdup(sid);
        pv->next = s->pending_views;
        s->pending_views = pv;
    }
    if (opts) {
        pv->opts = *opts;
        free(pv->label);
        pv->label = opts->label ? vdon_strdup(opts->label) : NULL;
    } else {
        vdon_view_options_init(&pv->opts);
    }
    pv->opts.label = NULL;
    for (vi = s->view_intent; vi; vi = vi->next)
        if (strcmp(vi->sid, sid) == 0)
            break;
    if (!vi) {
        vi = (pview_t *)calloc(1, sizeof(*vi));
        vi->sid = vdon_strdup(sid);
        vi->next = s->view_intent;
        s->view_intent = vi;
    }
    vi->opts = pv->opts;
    free(vi->label);
    vi->label = pv->label ? vdon_strdup(pv->label) : NULL;
    hashed_stream_id(s, sid, hashed, sizeof(hashed));
    connected = s->connected;
    pthread_mutex_unlock(&s->lock);
    if (!connected)
        return VDON_ERR_NOT_CONNECTED;
    m = cJSON_CreateObject();
    cJSON_AddStringToObject(m, "request", "play");
    cJSON_AddStringToObject(m, "streamID", hashed);
    ws_send_free(s, m);
    if (timeout_ms <= 0)
        return VDON_ERR_PENDING;
    {
        int64_t deadline = vdon_now_ms() + timeout_ms;
        int rc = VDON_ERR_PENDING;
        pthread_mutex_lock(&s->lock);
        for (;;) {
            if (find_viewer_for_stream(s, sid)) {
                rc = VDON_OK;
                break;
            }
            if (s->intentional || strnode_has(s->stopped_views, sid)) {
                rc = VDON_ERR_CANCELLED;
                break;
            }
            if (!vdon__wait_until(s, deadline))
                break;
        }
        pthread_mutex_unlock(&s->lock);
        return rc;
    }
}

int vdon_view(vdon_sdk *s, const char *stream_id, const vdon_view_options *opts, int timeout_ms) {
    if (!s || !stream_id)
        return VDON_ERR_INVALID;
    return do_view(s, stream_id, opts, timeout_ms, 0);
}

int vdon_stop_viewing(vdon_sdk *s, const char *stream_id) {
    char sid[80];
    conn_t *c;
    conn_t *list[64];
    int n = 0, i;
    pview_t **pp;
    if (!s || !stream_id || vdon_sanitize_stream_id(stream_id, sid, sizeof(sid)) != VDON_OK)
        return VDON_ERR_INVALID;
    pthread_mutex_lock(&s->lock);
    strnode_add(&s->stopped_views, sid);
    for (pp = &s->pending_views; *pp;) {
        if (strcmp((*pp)->sid, sid) == 0) {
            pview_t *d = *pp;
            *pp = d->next;
            free(d->sid);
            free(d->label);
            free(d);
        } else
            pp = &(*pp)->next;
    }
    for (pp = &s->view_intent; *pp;) {
        if (strcmp((*pp)->sid, sid) == 0) {
            pview_t *d = *pp;
            *pp = d->next;
            free(d->sid);
            free(d->label);
            free(d);
        } else
            pp = &(*pp)->next;
    }
    for (c = s->conns; c && n < 64; c = c->next)
        if (!c->closed && c->type == TYPE_VIEWER && c->stream_id && strcmp(c->stream_id, sid) == 0)
            list[n++] = c;
    pthread_mutex_unlock(&s->lock);
    for (i = 0; i < n; i++)
        conn_bye(s, list[i]);
    if (n)
        vdon__sleep_ms(50);
    pthread_mutex_lock(&s->lock);
    for (i = 0; i < n; i++)
        conn_retire(s, list[i]);
    pthread_mutex_unlock(&s->lock);
    {
        EV(ev, VDON_EVENT_VIEWING_STOPPED);
        ev.stream_id = sid;
        vdon__emit(s, &ev);
    }
    return VDON_OK;
}

static void auto_consider(vdon_sdk *s, const char *sid) {
    int go = 0;
    vdon_view_options vo;
    pthread_mutex_lock(&s->lock);
    if (s->auto_on && s->stream_id && strcmp(sid, s->stream_id) != 0 && !find_viewer_for_stream(s, sid) &&
        !strnode_has(s->stopped_views, sid))
        go = s->auto_full || strcmp(sid, s->stream_id) < 0;
    pthread_mutex_unlock(&s->lock);
    if (go) {
        vdon_view_options_init(&vo);
        do_view(s, sid, &vo, 0, 0);
    }
}

/* -------------------------------------------------------------- rooms */

int vdon_join_room(vdon_sdk *s, const char *room, const char *password, int claim, int timeout_ms) {
    char clean[64], roomid[80], hashed[96];
    char pw[1024];
    cJSON *m;
    int64_t deadline;
    int rc = VDON_OK, publishing;
    if (!s)
        return VDON_ERR_INVALID;
    if (!room)
        room = s->o.room;
    if (!room || vdon_sanitize_room(room, clean, sizeof(clean)) != VDON_OK || !clean[0])
        return VDON_ERR_INVALID;
    pthread_mutex_lock(&s->lock);
    if (password) {
        vdon_sanitize_password(password, pw, sizeof(pw));
        free(s->password);
        s->password = vdon_strdup(pw);
        s->has_password = pw[0] != 0;
        refresh_password(s);
    }
    if (s->has_password) {
        char buf[1200];
        snprintf(buf, sizeof(buf), "%s%s%s", clean, s->password, s->salt);
        vdon_generate_hash(buf, 16, roomid);
    } else {
        snprintf(roomid, sizeof(roomid), "%s", clean);
    }
    free(s->room_intent);
    s->room_intent = vdon_strdup(clean);
    s->room_claim = claim;
    free(s->room);
    s->room = vdon_strdup(clean);
    s->room_joined = 0;
    s->room_join_pending = 1;
    publishing = s->publishing && s->stream_id;
    if (publishing)
        hashed_stream_id(s, s->stream_id, hashed, sizeof(hashed));
    if (!s->connected) {
        pthread_mutex_unlock(&s->lock);
        return VDON_ERR_NOT_CONNECTED;
    }
    pthread_mutex_unlock(&s->lock);
    m = cJSON_CreateObject();
    cJSON_AddStringToObject(m, "request", "joinroom");
    cJSON_AddStringToObject(m, "roomid", roomid);
    if (claim)
        cJSON_AddBoolToObject(m, "claim", 1);
    if (publishing)
        cJSON_AddStringToObject(m, "streamID", hashed);
    ws_send_free(s, m);
    if (timeout_ms <= 0)
        return VDON_OK;
    deadline = vdon_now_ms() + timeout_ms;
    pthread_mutex_lock(&s->lock);
    while (!s->room_joined && s->connected) {
        if (!vdon__wait_until(s, deadline)) {
            rc = VDON_ERR_TIMEOUT;
            break;
        }
    }
    if (!s->connected && rc == VDON_OK && !s->room_joined)
        rc = VDON_ERR_NOT_CONNECTED;
    pthread_mutex_unlock(&s->lock);
    return rc;
}

void vdon_leave_room(vdon_sdk *s) {
    int had_room;
    if (!s)
        return;
    pthread_mutex_lock(&s->lock);
    had_room = s->room != NULL;
    free(s->room);
    s->room = NULL;
    free(s->room_intent);
    s->room_intent = NULL;
    s->room_joined = 0;
    pthread_mutex_unlock(&s->lock);
    if (!had_room)
        return;
    {
        cJSON *m = cJSON_CreateObject(); /* the JavaScript SDK sends this too */
        cJSON_AddBoolToObject(m, "leave", 1);
        ws_send_free(s, m);
    }
    {
        EV(ev, VDON_EVENT_ROOM_LEFT);
        vdon__emit(s, &ev);
    }
}

int vdon_room(vdon_sdk *s, char *out, size_t out_size) {
    if (!s || !out || !out_size)
        return VDON_ERR_INVALID;
    pthread_mutex_lock(&s->lock);
    snprintf(out, out_size, "%s", s->room ? s->room : "");
    pthread_mutex_unlock(&s->lock);
    return VDON_OK;
}

/* ---------------------------------------------------------- publishing */

static int seed(vdon_sdk *s, const char *stream_id, const char *room, const vdon_track_init *tracks, int track_count,
                char *out_stream_id, size_t out_size) {
    char sid[80], hashed[96];
    cJSON *m;
    int i, rc;
    if (!s || track_count < 0 || track_count > VDON_MAX_TRACKS || (track_count && !tracks))
        return VDON_ERR_INVALID;
    if (vdon_sanitize_stream_id(stream_id, sid, sizeof(sid)) != VDON_OK)
        return VDON_ERR_INVALID;
    pthread_mutex_lock(&s->lock);
    rc = s->publishing ? VDON_ERR_ALREADY_PUBLISHING : VDON_OK; /* one publish per connection, like the JS SDK */
    pthread_mutex_unlock(&s->lock);
    if (rc != VDON_OK)
        return rc;
    if (room && *room) {
        rc = vdon_join_room(s, room, NULL, 0, 10000);
        if (rc != VDON_OK && rc != VDON_ERR_TIMEOUT)
            return rc;
    }
    pthread_mutex_lock(&s->lock);
    free(s->stream_id);
    s->stream_id = vdon_strdup(sid);
    s->publishing = 1;
    s->data_only = track_count == 0;
    s->track_count = track_count;
    for (i = 0; i < track_count; i++) {
        s->tracks[i].init = tracks[i];
        snprintf(s->tracks[i].mid, sizeof(s->tracks[i].mid), "%s", tracks[i].mid ? tracks[i].mid : (i == 0 ? "1" : "2"));
        if (!tracks[i].mid)
            snprintf(s->tracks[i].mid, sizeof(s->tracks[i].mid), "%d", i + 1);
        s->tracks[i].init.mid = s->tracks[i].mid;
    }
    hashed_stream_id(s, sid, hashed, sizeof(hashed));
    if (!s->connected) {
        pthread_mutex_unlock(&s->lock);
        return VDON_ERR_NOT_CONNECTED;
    }
    pthread_mutex_unlock(&s->lock);
    m = cJSON_CreateObject();
    cJSON_AddStringToObject(m, "request", "seed");
    cJSON_AddStringToObject(m, "streamID", hashed);
    ws_send_free(s, m);
    if (out_stream_id && out_size)
        snprintf(out_stream_id, out_size, "%s", sid);
    {
        EV(ev, VDON_EVENT_PUBLISHING);
        ev.stream_id = sid;
        ev.flag = track_count == 0;
        vdon__emit(s, &ev);
    }
    return VDON_OK;
}

int vdon_announce(vdon_sdk *s, const char *stream_id, const char *room, char *out, size_t out_size) {
    return seed(s, stream_id, room, NULL, 0, out, out_size);
}

int vdon_publish(vdon_sdk *s, const char *stream_id, const char *room, const vdon_track_init *tracks, int track_count,
                 char *out, size_t out_size) {
    return seed(s, stream_id, room, tracks, track_count, out, out_size);
}

int vdon_stop_publishing(vdon_sdk *s) {
    conn_t *c, *list[128];
    int n = 0, i;
    char *sid;
    if (!s)
        return VDON_ERR_INVALID;
    pthread_mutex_lock(&s->lock);
    sid = s->stream_id;
    s->stream_id = NULL;
    s->publishing = 0;
    s->data_only = 0;
    s->track_count = 0;
    for (c = s->conns; c && n < 128; c = c->next)
        if (!c->closed && c->type == TYPE_PUBLISHER)
            list[n++] = c;
    pthread_mutex_unlock(&s->lock);
    for (i = 0; i < n; i++)
        conn_bye(s, list[i]);
    if (n)
        vdon__sleep_ms(50);
    pthread_mutex_lock(&s->lock);
    for (i = 0; i < n; i++)
        conn_retire(s, list[i]);
    pthread_mutex_unlock(&s->lock);
    {
        EV(ev, VDON_EVENT_PUBLISHING_STOPPED);
        ev.stream_id = sid;
        vdon__emit(s, &ev);
    }
    free(sid);
    return VDON_OK;
}

int vdon_stream_id(vdon_sdk *s, char *out, size_t out_size) {
    if (!s || !out || !out_size)
        return VDON_ERR_INVALID;
    pthread_mutex_lock(&s->lock);
    snprintf(out, out_size, "%s", s->stream_id ? s->stream_id : "");
    pthread_mutex_unlock(&s->lock);
    return VDON_OK;
}

static int collect_tracks(vdon_sdk *s, vdon_media_kind kind, int want_packetize, ptrack_t **out, int max) {
    conn_t *c;
    ptrack_t *t;
    int n = 0;
    pthread_mutex_lock(&s->lock);
    for (c = s->conns; c && n < max; c = c->next) {
        if (c->closed || c->type != TYPE_PUBLISHER)
            continue;
        if ((kind == VDON_MEDIA_AUDIO && !c->allow_audio) || (kind == VDON_MEDIA_VIDEO && !c->allow_video))
            continue;
        for (t = c->tracks; t && n < max; t = t->next)
            if (t->kind == kind && t->tr >= 0 && (want_packetize < 0 || t->packetize == want_packetize))
                out[n++] = t;
    }
    pthread_mutex_unlock(&s->lock);
    return n;
}

int vdon_send_rtp(vdon_sdk *s, vdon_media_kind kind, const uint8_t *packet, size_t size) {
    ptrack_t *list[256];
    int n, i, sent = 0;
    if (!s || !packet || size < 12)
        return VDON_ERR_INVALID;
    n = collect_tracks(s, kind, 0, list, 256);
    for (i = 0; i < n; i++)
        if (rtcIsOpen(list[i]->tr) && rtcSendMessage(list[i]->tr, (const char *)packet, (int)size) >= 0)
            sent++;
    return sent;
}

int vdon_send_sample(vdon_sdk *s, vdon_media_kind kind, const uint8_t *data, size_t size, uint32_t duration_us) {
    ptrack_t *list[256];
    int n, i, sent = 0;
    if (!s || !data || !size)
        return VDON_ERR_INVALID;
    n = collect_tracks(s, kind, 1, list, 256);
    for (i = 0; i < n; i++) {
        ptrack_t *t = list[i];
        if (!rtcIsOpen(t->tr))
            continue;
        rtcSetTrackRtpTimestamp(t->tr, t->ts);
        if (rtcSendMessage(t->tr, (const char *)data, (int)size) >= 0)
            sent++;
        t->ts += (uint32_t)(((uint64_t)duration_us * t->clock_rate) / 1000000ULL);
    }
    return sent;
}

/* --------------------------------------------------------------- peers */

int vdon_peers_json(vdon_sdk *s, char **out_json) {
    cJSON *arr;
    conn_t *c;
    if (!s || !out_json)
        return VDON_ERR_INVALID;
    arr = cJSON_CreateArray();
    pthread_mutex_lock(&s->lock);
    for (c = s->conns; c; c = c->next) {
        cJSON *it;
        int dup = 0;
        if (c->closed)
            continue;
        cJSON_ArrayForEach(it, arr) if (strcmp(cJSON_GetStringValue(it), c->uuid) == 0) dup = 1;
        if (!dup)
            cJSON_AddItemToArray(arr, cJSON_CreateString(c->uuid));
    }
    pthread_mutex_unlock(&s->lock);
    *out_json = cJSON_PrintUnformatted(arr);
    cJSON_Delete(arr);
    return VDON_OK;
}

int vdon_streams_json(vdon_sdk *s, char **out_json) {
    cJSON *arr;
    stream_t *st;
    if (!s || !out_json)
        return VDON_ERR_INVALID;
    arr = cJSON_CreateArray();
    pthread_mutex_lock(&s->lock);
    for (st = s->streams; st; st = st->next) {
        cJSON *e = cJSON_CreateObject();
        cJSON_AddStringToObject(e, "streamID", st->sid);
        if (st->uuid)
            cJSON_AddStringToObject(e, "uuid", st->uuid);
        cJSON_AddStringToObject(e, "state", st->state);
        cJSON_AddItemToArray(arr, e);
    }
    pthread_mutex_unlock(&s->lock);
    *out_json = cJSON_PrintUnformatted(arr);
    cJSON_Delete(arr);
    return VDON_OK;
}

int vdon_peer_connection(vdon_sdk *s, const char *uuid, const char *connection_type) {
    conn_t *c;
    int pc;
    if (!s || !uuid)
        return VDON_ERR_INVALID;
    pthread_mutex_lock(&s->lock);
    c = vdon__find_conn(s, uuid, connection_type);
    pc = c ? c->pc : VDON_ERR_NOT_FOUND;
    pthread_mutex_unlock(&s->lock);
    return pc;
}

/* --------------------------------------------------------------- jobs */

static void run_job(vdon_sdk *s, job_t *j) {
    switch (j->type) {
    case JOB_ICE_FLUSH: {
        conn_t *c = j->conn;
        cJSON *bundle;
        pthread_mutex_lock(&s->lock);
        c->ice_scheduled = 0;
        bundle = c->ice_bundle;
        c->ice_bundle = NULL;
        if (c->closed || !bundle || cJSON_GetArraySize(bundle) == 0) {
            pthread_mutex_unlock(&s->lock);
            cJSON_Delete(bundle);
            return;
        }
        pthread_mutex_unlock(&s->lock);
        on_candidate_message(s, c, bundle, 0);
        return;
    }
    case JOB_VIEW_RETRY: {
        pview_t *vi;
        vdon_view_options vo;
        int ok = 0;
        pthread_mutex_lock(&s->lock);
        for (vi = s->view_intent; vi; vi = vi->next)
            if (strcmp(vi->sid, j->str) == 0)
                break;
        if (vi && s->connected && !s->intentional && !strnode_has(s->stopped_views, j->str) &&
            !find_viewer_for_stream(s, j->str)) {
            vo = vi->opts;
            vo.label = vi->label;
            ok = 1;
        }
        pthread_mutex_unlock(&s->lock);
        if (ok) {
            vdon__logf(s, "Retrying view of %s", j->str);
            do_view(s, j->str, &vo, 0, 1);
        }
        return;
    }
    case JOB_RECONNECT: {
        int attempt;
        pthread_mutex_lock(&s->lock);
        if (s->intentional || s->stopping || s->connected || s->ws >= 0) {
            pthread_mutex_unlock(&s->lock);
            return;
        }
        attempt = ++s->reconnects;
        ws_open(s);
        pthread_mutex_unlock(&s->lock);
        {
            EV(ev, VDON_EVENT_RECONNECTING);
            ev.number = attempt;
            vdon__emit(s, &ev);
        }
        return;
    }
    case JOB_PING: {
        conn_t *c = j->conn;
        int iv = s->o.auto_ping_interval_ms < 1000 ? 1000 : s->o.auto_ping_interval_ms;
        int send = 0, restart = 0;
        int64_t now = vdon_now_ms();
        pthread_mutex_lock(&s->lock);
        if (c->closed || !c->control || !c->control->open) {
            if (!c->closed)
                vdon__schedule(s, JOB_PING, now + iv, c, NULL, 0);
            pthread_mutex_unlock(&s->lock);
            return;
        }
        if (c->pending_ping) {
            int64_t timeout = iv + 5000 > iv * 3 / 2 ? iv + 5000 : iv * 3 / 2;
            if (now - c->pending_ping >= timeout) {
                c->missed_pings++;
                c->pending_ping = 0;
                if (c->missed_pings >= 2) {
                    c->missed_pings = 0;
                    restart = 1;
                } else
                    send = 1;
            }
        } else
            send = 1;
        if (send)
            c->pending_ping = now;
        if (!restart)
            vdon__schedule(s, JOB_PING, now + iv, c, NULL, 0);
        pthread_mutex_unlock(&s->lock);
        if (restart) {
            recover_connection(s, c, "missed_pings");
            return;
        }
        if (send) {
            cJSON *m = cJSON_CreateObject();
            cJSON_AddNumberToObject(m, "ping", (double)now);
            vdon__conn_send_control(s, c, m);
            cJSON_Delete(m);
        }
        return;
    }
    case JOB_CLOSE_CONN: {
        conn_t *c = j->conn;
        int emit_disc;
        char *sid;
        conn_close_rtc(s, c);
        pthread_mutex_lock(&s->lock);
        emit_disc = !c->disc_emitted;
        c->disc_emitted = 1;
        sid = c->stream_id ? vdon_strdup(c->stream_id) : NULL;
        c->next = s->graveyard;
        s->graveyard = c;
        vdon__drop_peer_subs(s, c->uuid);
        vdon__schedule(s, JOB_FREE_CONN, vdon_now_ms() + VDON_GRAVEYARD_MS, c, NULL, 0);
        pthread_cond_broadcast(&s->cond);
        pthread_mutex_unlock(&s->lock);
        if (emit_disc) {
            EV(ev, VDON_EVENT_PEER_DISCONNECTED);
            ev.uuid = c->uuid;
            ev.stream_id = sid;
            ev.connection_type = c->type;
            vdon__emit(s, &ev);
        }
        free(sid);
        return;
    }
    case JOB_FREE_CONN: {
        conn_t *c = j->conn, **pp;
        pthread_mutex_lock(&s->lock);
        for (pp = &s->graveyard; *pp; pp = &(*pp)->next)
            if (*pp == c) {
                *pp = c->next;
                break;
            }
        pthread_mutex_unlock(&s->lock);
        conn_free(c);
        return;
    }
    case JOB_CONNECT_TIMEOUT: {
        conn_t *c = j->conn;
        int fire;
        pthread_mutex_lock(&s->lock);
        fire = !c->closed && !c->connected_once;
        pthread_mutex_unlock(&s->lock);
        if (fire)
            recover_connection(s, c, "timeout");
        return;
    }
    case JOB_DISCONNECT_GRACE: {
        conn_t *c = j->conn;
        int fire;
        pthread_mutex_lock(&s->lock);
        c->grace_pending = 0;
        fire = !c->closed;
        pthread_mutex_unlock(&s->lock);
        if (fire)
            recover_connection(s, c, "disconnected");
        return;
    }
    case JOB_DELETE_WS:
        rtcDelete(j->id);
        return;
    case JOB_CLOSE_DC:
        rtcClose(j->id);
        return;
    default:
        return;
    }
}

static void *worker_main(void *arg) {
    vdon_sdk *s = (vdon_sdk *)arg;
    pthread_mutex_lock(&s->lock);
    while (!s->stopping) {
        job_t *j = s->jobs;
        int64_t now = vdon_now_ms();
        if (!j) {
            pthread_cond_wait(&s->cond, &s->lock);
            continue;
        }
        if (j->at > now) {
            vdon__wait_until(s, j->at);
            continue;
        }
        s->jobs = j->next;
        pthread_mutex_unlock(&s->lock);
        run_job(s, j);
        job_free(j);
        pthread_mutex_lock(&s->lock);
    }
    pthread_mutex_unlock(&s->lock);
    return NULL;
}

/* -------------------------------------------------------- restore intent */

static void restore_intent(vdon_sdk *s) {
    char *room = NULL;
    int claim, publishing, has_room;
    char hashed[96];
    pview_t *vi, *copy = NULL;
    pthread_mutex_lock(&s->lock);
    has_room = s->room_intent != NULL;
    room = has_room ? vdon_strdup(s->room_intent) : NULL;
    claim = s->room_claim;
    publishing = s->publishing && s->stream_id;
    if (publishing)
        hashed_stream_id(s, s->stream_id, hashed, sizeof(hashed));
    for (vi = s->view_intent; vi; vi = vi->next) {
        pview_t *n;
        if (strnode_has(s->stopped_views, vi->sid) || find_viewer_for_stream(s, vi->sid))
            continue;
        n = (pview_t *)calloc(1, sizeof(*n));
        n->sid = vdon_strdup(vi->sid);
        n->opts = vi->opts;
        n->label = vi->label ? vdon_strdup(vi->label) : NULL;
        n->next = copy;
        copy = n;
    }
    pthread_mutex_unlock(&s->lock);
    if (room) {
        vdon_join_room(s, room, NULL, claim, 10000);
        free(room);
    }
    if (publishing) {
        cJSON *m = cJSON_CreateObject();
        cJSON_AddStringToObject(m, "request", "seed");
        cJSON_AddStringToObject(m, "streamID", hashed);
        ws_send_free(s, m);
    }
    while (copy) {
        pview_t *n = copy;
        vdon_view_options vo = n->opts;
        copy = n->next;
        vo.label = n->label;
        do_view(s, n->sid, &vo, 0, 1);
        free(n->sid);
        free(n->label);
        free(n);
    }
}

/* ------------------------------------------------------------ lifecycle */

static void rtc_log_cb(rtcLogLevel level, const char *message) {
    (void)level;
    fprintf(stderr, "[libdatachannel] %s\n", message);
}

vdon_sdk *vdon_create(const vdon_options *opts, vdon_event_callback cb, void *user) {
    static int logger_init = 0;
    vdon_sdk *s = (vdon_sdk *)calloc(1, sizeof(*s));
    vdon_options d;
    char pw[1024];
    int i;
    if (!s)
        return NULL;
    if (!opts) {
        vdon_options_init(&d);
        opts = &d;
    }
    s->o = *opts;
    s->o.host = vdon_strdup(opts->host ? opts->host : VDON_DEFAULT_HOST);
    s->o.room = vdon_strdup(opts->room);
    s->o.password = vdon_strdup(opts->password);
    s->o.salt = vdon_strdup(opts->salt ? opts->salt : VDON_DEFAULT_SALT);
    s->o.label = vdon_strdup(opts->label);
    s->o.meta_json = vdon_strdup(opts->meta_json);
    s->o.bind_address = vdon_strdup(opts->bind_address);
    s->o.client_id = vdon_strdup(opts->client_id);
    if (opts->turn_servers && opts->turn_server_count > 0) {
        s->turn_copy = (char **)calloc((size_t)opts->turn_server_count, sizeof(char *));
        for (i = 0; i < opts->turn_server_count; i++)
            s->turn_copy[i] = vdon_strdup(opts->turn_servers[i]);
    } else
        s->o.turn_server_count = 0;
    if (opts->stun_servers) {
        s->stun_copy = (char **)calloc((size_t)(opts->stun_server_count > 0 ? opts->stun_server_count : 1), sizeof(char *));
        for (i = 0; i < opts->stun_server_count; i++)
            s->stun_copy[i] = vdon_strdup(opts->stun_servers[i]);
    } else
        s->o.stun_server_count = 0;
    s->o.turn_servers = (const char **)s->turn_copy;
    s->o.stun_servers = (const char **)s->stun_copy;
    if (s->o.max_reconnect_attempts < 0)
        s->o.max_reconnect_attempts = 0;
    if (s->o.reconnect_delay_ms <= 0)
        s->o.reconnect_delay_ms = 1000;
    if (s->o.connection_timeout_ms <= 0)
        s->o.connection_timeout_ms = 20000;
    if (s->o.auto_ping_interval_ms <= 0)
        s->o.auto_ping_interval_ms = 10000;
    s->cb = cb;
    s->user = user;
    s->ws = -1;
    s->salt = vdon_strdup(s->o.salt);
    if (opts->no_password) {
        s->has_password = 0;
        s->password = vdon_strdup("");
    } else {
        vdon_sanitize_password(opts->password && *opts->password ? opts->password : VDON_DEFAULT_PASSWORD, pw, sizeof(pw));
        s->password = vdon_strdup(pw);
        s->has_password = pw[0] != 0;
    }
    refresh_password(s);
    s->publisher_info = cJSON_CreateObject();
    if (s->o.label) {
        char label[512];
        vdon_sanitize_label(s->o.label, label, sizeof(label));
        if (label[0])
            cJSON_AddStringToObject(s->publisher_info, "label", label);
    }
    if (s->o.meta_json) {
        cJSON *meta = cJSON_Parse(s->o.meta_json);
        if (meta)
            cJSON_AddItemToObject(s->publisher_info, "meta", meta);
    }
    s->reconnect_delay = s->o.reconnect_delay_ms;
    pthread_mutex_init(&s->lock, NULL);
    pthread_cond_init(&s->cond, NULL);
    if (!logger_init) {
        logger_init = 1;
        rtcInitLogger(s->o.debug ? RTC_LOG_WARNING : RTC_LOG_NONE, s->o.debug ? rtc_log_cb : NULL);
    }
    if (pthread_create(&s->worker, NULL, worker_main, s) == 0)
        s->worker_started = 1;
    return s;
}

int vdon_connect(vdon_sdk *s, int timeout_ms) {
    int rc = VDON_OK;
    int64_t deadline;
    if (!s)
        return VDON_ERR_INVALID;
    ensure_ice_servers(s);
    pthread_mutex_lock(&s->lock);
    s->intentional = 0;
    if (s->connected) {
        pthread_mutex_unlock(&s->lock);
        return VDON_OK;
    }
    if (s->ws < 0) {
        rc = ws_open(s);
        if (rc != VDON_OK) {
            pthread_mutex_unlock(&s->lock);
            return rc;
        }
    }
    if (timeout_ms > 0) {
        deadline = vdon_now_ms() + timeout_ms;
        while (!s->connected && !s->ws_failed) {
            if (!vdon__wait_until(s, deadline)) {
                rc = VDON_ERR_TIMEOUT;
                break;
            }
        }
        if (!s->connected && rc == VDON_OK)
            rc = VDON_ERR_FAILURE;
    }
    pthread_mutex_unlock(&s->lock);
    return rc;
}

int vdon_is_connected(vdon_sdk *s) {
    int c;
    if (!s)
        return 0;
    pthread_mutex_lock(&s->lock);
    c = s->connected;
    pthread_mutex_unlock(&s->lock);
    return c;
}

static void free_pviews(pview_t **list) {
    while (*list) {
        pview_t *d = *list;
        *list = d->next;
        free(d->sid);
        free(d->label);
        free(d);
    }
}

void vdon_disconnect(vdon_sdk *s) {
    conn_t *c, **list;
    int n = 0, i, ws, was_connected;
    job_t **pp;
    if (!s)
        return;
    pthread_mutex_lock(&s->lock);
    s->intentional = 1;
    s->auto_on = 0;
    for (c = s->conns; c; c = c->next)
        n++;
    list = (conn_t **)calloc((size_t)n + 1, sizeof(*list));
    n = 0;
    for (c = s->conns; c; c = c->next)
        list[n++] = c;
    pthread_mutex_unlock(&s->lock);
    for (i = 0; i < n; i++)
        conn_bye(s, list[i]);
    if (n)
        vdon__sleep_ms(50);
    pthread_mutex_lock(&s->lock);
    for (i = 0; i < n; i++)
        conn_retire(s, list[i]);
    /* Run the close jobs synchronously so the caller sees a quiet SDK on return. */
    for (pp = &s->jobs; *pp;) {
        job_t *j = *pp;
        if (j->type == JOB_CLOSE_CONN || j->type == JOB_RECONNECT || j->type == JOB_VIEW_RETRY || j->type == JOB_ICE_FLUSH) {
            *pp = j->next;
            if (j->type == JOB_CLOSE_CONN) {
                pthread_mutex_unlock(&s->lock);
                run_job(s, j);
                pthread_mutex_lock(&s->lock);
                pp = &s->jobs; /* restart: run_job touched the list */
            }
            job_free(j);
            continue;
        }
        pp = &j->next;
    }
    ws = s->ws;
    s->ws = -1;
    was_connected = s->connected;
    s->connected = 0;
    s->room_joined = 0;
    s->room_join_pending = 0;
    free(s->room);
    s->room = NULL;
    free(s->room_intent);
    s->room_intent = NULL;
    s->publishing = 0;
    free(s->stream_id);
    s->stream_id = NULL;
    free_pviews(&s->pending_views);
    free_pviews(&s->view_intent);
    strnode_free(&s->stopped_views);
    while (s->pending_ice)
        drop_pending_ice(s, s->pending_ice->uuid);
    vdon__fail_all_waiters(s);
    pthread_cond_broadcast(&s->cond);
    pthread_mutex_unlock(&s->lock);
    free(list);
    if (ws >= 0)
        rtcDelete(ws);
    if (was_connected) {
        EV(ev, VDON_EVENT_DISCONNECTED);
        ev.flag = 1;
        vdon__emit(s, &ev);
    }
}

void vdon_destroy(vdon_sdk *s) {
    job_t *j;
    conn_t *c;
    stream_t *st;
    int i;
    if (!s)
        return;
    vdon_disconnect(s);
    pthread_mutex_lock(&s->lock);
    s->stopping = 1;
    s->cb = NULL;
    pthread_cond_broadcast(&s->cond);
    pthread_mutex_unlock(&s->lock);
    if (s->worker_started)
        pthread_join(s->worker, NULL);
    while ((j = s->jobs)) {
        s->jobs = j->next;
        if (j->type == JOB_CLOSE_CONN)
            conn_close_rtc(s, j->conn); /* graveyard below frees it */
        else if (j->type == JOB_DELETE_WS)
            rtcDelete(j->id);
        if (j->type == JOB_CLOSE_CONN) {
            j->conn->next = s->graveyard;
            s->graveyard = j->conn;
        }
        job_free(j);
    }
    while ((c = s->graveyard)) {
        s->graveyard = c->next;
        conn_free(c);
    }
    while ((st = s->streams)) {
        s->streams = st->next;
        free(st->sid);
        free(st->uuid);
        free(st);
    }
    vdon__free_data_state(s);
    for (i = 0; i < s->ice_count; i++)
        free(s->ice_servers[i]);
    free(s->ice_servers);
    for (i = 0; i < s->o.turn_server_count; i++)
        free(s->turn_copy[i]);
    free(s->turn_copy);
    for (i = 0; i < s->o.stun_server_count; i++)
        free(s->stun_copy[i]);
    free(s->stun_copy);
    free((char *)s->o.host);
    free((char *)s->o.room);
    free((char *)s->o.password);
    free((char *)s->o.salt);
    free((char *)s->o.label);
    free((char *)s->o.meta_json);
    free((char *)s->o.bind_address);
    free((char *)s->o.client_id);
    free(s->password);
    free(s->salt);
    free(s->phrase);
    cJSON_Delete(s->publisher_info);
    pthread_cond_destroy(&s->cond);
    pthread_mutex_destroy(&s->lock);
    free(s);
}

/* ---------------------------------------------------------- autoconnect */

int vdon_auto_connect(vdon_sdk *s, const char *room, const char *stream_id, int full_mode, int timeout_ms,
                      char *out_stream_id, size_t out_size) {
    char sid[80];
    int rc;
    stream_t *st;
    cJSON *known = cJSON_CreateArray(), *it;
    if (!s || !room)
        return VDON_ERR_INVALID;
    if (vdon_sanitize_stream_id(stream_id, sid, sizeof(sid)) != VDON_OK)
        return VDON_ERR_INVALID;
    rc = vdon_connect(s, timeout_ms);
    if (rc != VDON_OK)
        return rc;
    pthread_mutex_lock(&s->lock);
    free(s->stream_id);
    s->stream_id = vdon_strdup(sid);
    s->auto_on = 1;
    s->auto_full = full_mode;
    pthread_mutex_unlock(&s->lock);
    rc = vdon_join_room(s, room, NULL, 0, timeout_ms);
    if (rc != VDON_OK)
        return rc;
    rc = vdon_announce(s, sid, NULL, out_stream_id, out_size);
    if (rc != VDON_OK)
        return rc;
    pthread_mutex_lock(&s->lock);
    for (st = s->streams; st; st = st->next)
        cJSON_AddItemToArray(known, cJSON_CreateString(st->sid));
    pthread_mutex_unlock(&s->lock);
    cJSON_ArrayForEach(it, known) auto_consider(s, cJSON_GetStringValue(it));
    cJSON_Delete(known);
    return VDON_OK;
}

void vdon_auto_connect_stop(vdon_sdk *s) {
    if (!s)
        return;
    pthread_mutex_lock(&s->lock);
    s->auto_on = 0;
    pthread_mutex_unlock(&s->lock);
}

void vdon__schedule_close_dc(vdon_sdk *s, int dc) {
    pthread_mutex_lock(&s->lock);
    vdon__schedule(s, JOB_CLOSE_DC, vdon_now_ms(), NULL, NULL, dc);
    pthread_mutex_unlock(&s->lock);
}
