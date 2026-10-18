/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
/* Private structures shared by vdon_sdk.c and vdon_sdk_data.c. */
#ifndef VDON_SDK_INTERNAL_H
#define VDON_SDK_INTERNAL_H

#include "vdon_internal.h"
#include "vdoninja.h"

#include <cJSON.h>
#include <pthread.h>
#include <rtc/rtc.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define VDON_MAX_TRACKS 8
#define VDON_BUFFER_HIGH (1024 * 1024)
#define VDON_GRAVEYARD_MS 5000

enum chan_kind { CH_CONTROL = 1, CH_FILE_IN, CH_FILE_OUT, CH_BINARY, CH_RESERVED, CH_RESOURCE, CH_IGNORED };

enum job_type {
    JOB_ICE_FLUSH = 1,
    JOB_VIEW_RETRY,
    JOB_RECONNECT,
    JOB_PING,
    JOB_CLOSE_CONN,
    JOB_FREE_CONN,
    JOB_CONNECT_TIMEOUT,
    JOB_DISCONNECT_GRACE,
    JOB_DELETE_WS,
    JOB_CLOSE_DC
};

typedef struct conn conn_t;
typedef struct inbound inbound_t;
typedef struct hosted hosted_t;

typedef struct chan {
    int dc;
    int kind;
    int open;
    char *label;
    conn_t *conn;
    /* inbound file */
    int have_header;
    char *fid;
    char *fname;
    int64_t fsize;
    int64_t received;
    inbound_t *inbound;
    int finished;
    /* outbound file */
    hosted_t *out_file;
    /* resources */
    cJSON *res_meta;
    int64_t res_size;
    uint8_t *res_buf;
    size_t res_len;
    struct chan *next;
} chan_t;

typedef struct ptrack {
    int tr;
    vdon_media_kind kind;
    int packetize;
    uint32_t ts;
    uint32_t clock_rate;
    conn_t *conn;
    struct ptrack *next;
} ptrack_t;

struct conn {
    vdon_sdk *sdk;
    char *uuid;
    const char *type; /* "publisher" or "viewer" (static) */
    char *stream_id;
    char session[9];
    int pc;
    int closed;
    int connected_once;
    int disc_emitted;
    int remote_set;
    int recovering;
    int grace_pending;
    chan_t *chans;
    chan_t *control;
    ptrack_t *tracks;
    cJSON *info;
    cJSON *obs;
    int allow_audio, allow_video, allow_download, allow_resource;
    vdon_view_options vopts;
    char *vlabel;
    cJSON *ice_bundle;
    int ice_delay_ms;
    int ice_scheduled;
    cJSON *advertised;
    int64_t pending_ping;
    int missed_pings;
    int64_t last_message;
    int64_t created_at;
    struct conn *next;
};

struct hosted {
    char *id;
    char *name;
    uint8_t *data;
    size_t size;
    char *restricted;
    int cancelled;
    int refs;
    struct hosted *next;
};

struct inbound {
    char *uuid;
    char *id;
    uint8_t *buf;
    size_t len, cap;
    int done;
    int err;
    char *name;
    int64_t size;
    int64_t received;
    struct inbound *next;
};

typedef struct preq {
    char *id;
    char *target;
    char *result;
    int done;
    int err;
    struct preq *next;
} preq_t;

typedef struct handler {
    char *type;
    vdon_request_handler fn;
    void *user;
    struct handler *next;
} handler_t;

typedef struct strnode {
    char *s;
    struct strnode *next;
} strnode_t;

typedef struct peersub {
    char *uuid;
    strnode_t *chans;
    struct peersub *next;
} peersub_t;

typedef struct pview {
    char *sid;
    vdon_view_options opts;
    char *label;
    struct pview *next;
} pview_t;

typedef struct stream {
    char *sid;
    char *uuid;
    const char *state;
    struct stream *next;
} stream_t;

typedef struct pice {
    char *uuid;
    const char *type; /* "local" / "remote" */
    char *session;
    cJSON *cands;
    struct pice *next;
} pice_t;

typedef struct job {
    int type;
    int64_t at;
    conn_t *conn;
    char *str;
    int id;
    struct job *next;
} job_t;

typedef struct track_tmpl {
    vdon_track_init init;
    char mid[8];
} track_tmpl;

struct vdon_sdk {
    vdon_options o;
    char **turn_copy;
    char **stun_copy;
    vdon_event_callback cb;
    void *user;

    pthread_mutex_t lock;
    pthread_cond_t cond;
    pthread_t worker;
    int worker_started;
    int stopping;

    int ws;
    int connected;
    int ever_connected;
    int ws_failed;
    int intentional;
    int reconnects;
    int reconnect_delay;

    char *password; /* sanitized */
    int has_password;
    char *salt;
    char hash6[7];
    char *phrase;

    char *room;
    char *room_intent;
    int room_claim;
    int room_joined;
    int room_join_pending;

    char *stream_id;
    int publishing;
    int data_only;
    track_tmpl tracks[VDON_MAX_TRACKS];
    int track_count;
    cJSON *publisher_info;

    conn_t *conns;
    conn_t *graveyard;
    pview_t *pending_views;
    pview_t *view_intent;
    strnode_t *stopped_views;
    stream_t *streams;
    pice_t *pending_ice;

    hosted_t *hosted;
    inbound_t *inbound;
    preq_t *requests;
    handler_t *handlers;
    strnode_t *subs;
    peersub_t *peersubs;
    int auto_on, auto_full;

    job_t *jobs;
    char **ice_servers;
    int ice_count;
    int turn_fetched;
};

/* core (vdon_sdk.c) */
void vdon__logf(vdon_sdk *s, const char *fmt, ...);
void vdon__emit(vdon_sdk *s, vdon_event *ev);
int vdon__wait_until(vdon_sdk *s, int64_t deadline_ms); /* lock held; 0 = timed out */
void vdon__schedule(vdon_sdk *s, int type, int64_t at, conn_t *c, const char *str, int id); /* lock held */
conn_t *vdon__find_conn(vdon_sdk *s, const char *uuid, const char *type);                 /* lock held */
int vdon__conn_send_control(vdon_sdk *s, conn_t *c, cJSON *msg); /* lock NOT held; does not free msg */
int vdon__ws_send(vdon_sdk *s, cJSON *msg);                      /* lock NOT held; does not free msg */
char *vdon__json_text(cJSON *v);
cJSON *vdon__parse_or_string(const char *json);
chan_t *vdon__chan_new(conn_t *c, int dc, int kind, const char *label); /* lock held */
void vdon__chan_install_callbacks(chan_t *ch);
void vdon__sleep_ms(int ms);
void vdon__schedule_close_dc(vdon_sdk *s, int dc); /* lock NOT held */

/* data layer (vdon_sdk_data.c) */
void vdon__handle_pipe(vdon_sdk *s, conn_t *c, cJSON *pipe);
int vdon__handle_pipe_special(vdon_sdk *s, conn_t *c, cJSON *pipe); /* 1 = consumed */
void vdon__handle_file_request(vdon_sdk *s, conn_t *c, const char *id);
void vdon__send_file_list(vdon_sdk *s, conn_t *c);
void vdon__chan_message(chan_t *ch, const char *msg, int size);
void vdon__chan_opened_extra(chan_t *ch);
void vdon__chan_closed_extra(chan_t *ch);
void vdon__send_subscriptions(vdon_sdk *s, conn_t *c);
void vdon__fail_all_waiters(vdon_sdk *s); /* lock held */
void vdon__free_data_state(vdon_sdk *s);  /* lock held, at destroy */
void vdon__drop_peer_subs(vdon_sdk *s, const char *uuid); /* lock held */
void vdon__hosted_unref(vdon_sdk *s, hosted_t *h);          /* lock held */

#endif
