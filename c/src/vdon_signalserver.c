/*
 * Copyright (c) 2025-2026 Steve Seguin
 * SPDX-License-Identifier: MPL-2.0
 *
 * A small VDO.Ninja-compatible signaling server (routed "wss2" protocol) built
 * on libdatachannel's WebSocket server. For LAN, offline and test use; no TURN
 * and no rate limiting. See https://github.com/steveseguin/websocket_server for
 * production hosting.
 */
#include "vdon_internal.h"
#include "vdoninja.h"

#include <cJSON.h>
#include <pthread.h>
#include <rtc/rtc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct ss_client {
    int ws;
    char uuid[37];
    char *stream_id;
    char *room;
    struct ss_client *next;
} ss_client;

typedef struct ss_waiting {
    char *stream_id;
    char *viewer_uuid;
    struct ss_waiting *next;
} ss_waiting;

typedef struct ss_director {
    char *room;
    char *uuid;
    struct ss_director *next;
} ss_director;

struct vdon_signal_server {
    int server;
    pthread_mutex_t lock;
    ss_client *clients;
    ss_waiting *waiting;
    ss_director *directors;
};

static vdon_signal_server *g_server; /* libdatachannel's server callback carries no user pointer */

static void ss_send(ss_client *c, cJSON *msg) {
    char *text = cJSON_PrintUnformatted(msg);
    if (text) {
        rtcSendMessage(c->ws, text, -1);
        free(text);
    }
}

static ss_client *ss_find(vdon_signal_server *s, const char *uuid) {
    ss_client *c;
    for (c = s->clients; c; c = c->next)
        if (strcmp(c->uuid, uuid) == 0)
            return c;
    return NULL;
}

static ss_client *ss_find_stream(vdon_signal_server *s, const char *sid) {
    ss_client *c;
    for (c = s->clients; c; c = c->next)
        if (c->stream_id && strcmp(c->stream_id, sid) == 0)
            return c;
    return NULL;
}

static const char *ss_director_of(vdon_signal_server *s, const char *room) {
    ss_director *d;
    for (d = s->directors; d; d = d->next)
        if (strcmp(d->room, room) == 0)
            return d->uuid;
    return NULL;
}

static void ss_notify_room(vdon_signal_server *s, const char *room, cJSON *msg, const char *skip) {
    ss_client *c;
    for (c = s->clients; c; c = c->next)
        if (c->room && strcmp(c->room, room) == 0 && strcmp(c->uuid, skip) != 0)
            ss_send(c, msg);
}

static void ss_queue(vdon_signal_server *s, const char *sid, const char *viewer) {
    ss_waiting *w;
    for (w = s->waiting; w; w = w->next)
        if (strcmp(w->stream_id, sid) == 0 && strcmp(w->viewer_uuid, viewer) == 0)
            return;
    w = (ss_waiting *)calloc(1, sizeof(*w));
    w->stream_id = vdon_strdup(sid);
    w->viewer_uuid = vdon_strdup(viewer);
    w->next = s->waiting;
    s->waiting = w;
}

/* Drops the room membership ({"leave": true}). */
static void ss_leave_room(vdon_signal_server *s, ss_client *c) {
    ss_director **pd = &s->directors;
    if (!c->room)
        return;
    while (*pd) {
        ss_director *d = *pd;
        if (strcmp(d->uuid, c->uuid) == 0 && strcmp(d->room, c->room) == 0) {
            *pd = d->next;
            free(d->room);
            free(d->uuid);
            free(d);
        } else {
            pd = &d->next;
        }
    }
    free(c->room);
    c->room = NULL;
}

static void ss_handle(vdon_signal_server *s, ss_client *c, cJSON *msg) {
    const char *request = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(msg, "request"));
    if (!request) {
        const char *target = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(msg, "UUID"));
        ss_client *t;
        if (cJSON_GetObjectItemCaseSensitive(msg, "leave")) {
            ss_leave_room(s, c);
            return;
        }
        t = target ? ss_find(s, target) : NULL;
        if (t) {
            cJSON_DeleteItemFromObjectCaseSensitive(msg, "from");
            cJSON_ReplaceItemInObjectCaseSensitive(msg, "UUID", cJSON_CreateString(c->uuid));
            ss_send(t, msg);
        }
        return;
    }
    if (strcmp(request, "play") == 0) {
        const char *sid = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(msg, "streamID"));
        ss_client *seeder;
        if (!sid || !*sid)
            return;
        seeder = ss_find_stream(s, sid);
        if (!seeder) {
            ss_queue(s, sid, c->uuid);
            return;
        }
        if (seeder == c)
            return;
        if (seeder->room && (!c->room || strcmp(c->room, seeder->room) != 0)) {
            ss_queue(s, sid, c->uuid);
            return;
        }
        {
            cJSON *o = cJSON_CreateObject();
            cJSON_AddStringToObject(o, "request", "offerSDP");
            cJSON_AddStringToObject(o, "UUID", c->uuid);
            ss_send(seeder, o);
            cJSON_Delete(o);
        }
    } else if (strcmp(request, "seed") == 0) {
        const char *sid = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(msg, "streamID"));
        ss_client *owner;
        if (!sid || !*sid)
            return;
        if (c->stream_id && strcmp(c->stream_id, sid) != 0) {
            cJSON *a = cJSON_CreateObject();
            cJSON_AddStringToObject(a, "request", "alert");
            cJSON_AddStringToObject(a, "message", "Stream ID cannot change on an existing connection.");
            ss_send(c, a);
            cJSON_Delete(a);
            return;
        }
        owner = ss_find_stream(s, sid);
        if (owner && owner != c) {
            cJSON *a = cJSON_CreateObject();
            cJSON_AddStringToObject(a, "request", "alert");
            cJSON_AddStringToObject(a, "message", "Stream ID is already in use.");
            ss_send(c, a);
            cJSON_Delete(a);
            return;
        }
        free(c->stream_id);
        c->stream_id = vdon_strdup(sid);
        if (c->room) {
            cJSON *n = cJSON_CreateObject();
            cJSON_AddStringToObject(n, "request", "videoaddedtoroom");
            cJSON_AddStringToObject(n, "UUID", c->uuid);
            cJSON_AddStringToObject(n, "streamID", sid);
            ss_notify_room(s, c->room, n, c->uuid);
            cJSON_Delete(n);
        }
        {
            ss_waiting **pw = &s->waiting;
            while (*pw) {
                ss_waiting *w = *pw;
                ss_client *viewer = ss_find(s, w->viewer_uuid);
                if (strcmp(w->stream_id, sid) == 0 &&
                    (!viewer || !c->room || (viewer->room && strcmp(viewer->room, c->room) == 0))) {
                    if (viewer) {
                        cJSON *o = cJSON_CreateObject();
                        cJSON_AddStringToObject(o, "request", "offerSDP");
                        cJSON_AddStringToObject(o, "UUID", w->viewer_uuid);
                        ss_send(c, o);
                        cJSON_Delete(o);
                    }
                    *pw = w->next;
                    free(w->stream_id);
                    free(w->viewer_uuid);
                    free(w);
                } else {
                    pw = &w->next;
                }
            }
        }
    } else if (strcmp(request, "joinroom") == 0) {
        const char *roomid = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(msg, "roomid"));
        const char *sid = cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(msg, "streamID"));
        int claim = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(msg, "claim"));
        char room[128];
        size_t i;
        cJSON *resp, *list, *notice;
        const char *director;
        int is_director = 0;
        ss_client *m;
        if (!roomid || !*roomid || c->room)
            return;
        strncpy(room, roomid, sizeof(room) - 1);
        room[sizeof(room) - 1] = 0;
        for (i = 0; room[i]; i++)
            if (room[i] >= 'A' && room[i] <= 'Z')
                room[i] = (char)(room[i] + 32);
        if (sid && *sid && !c->stream_id) {
            /* Same live-owner check as seed: joinroom must not take over a stream ID. */
            ss_client *owner = ss_find_stream(s, sid);
            if (owner && owner != c) {
                cJSON *a = cJSON_CreateObject();
                cJSON_AddStringToObject(a, "request", "alert");
                cJSON_AddStringToObject(a, "message", "Stream ID is already in use.");
                ss_send(c, a);
                cJSON_Delete(a);
                return;
            }
            c->stream_id = vdon_strdup(sid);
        }
        resp = cJSON_CreateObject();
        cJSON_AddStringToObject(resp, "request", "listing");
        director = ss_director_of(s, room);
        if (claim) {
            if (!director || !ss_find(s, director)) {
                ss_director *d = (ss_director *)calloc(1, sizeof(*d));
                d->room = vdon_strdup(room);
                d->uuid = vdon_strdup(c->uuid);
                d->next = s->directors;
                s->directors = d;
                cJSON_AddBoolToObject(resp, "claim", 1);
                is_director = 1;
                director = d->uuid;
            } else {
                cJSON_AddBoolToObject(resp, "claim", strcmp(director, c->uuid) == 0);
                if (strcmp(director, c->uuid) != 0)
                    cJSON_AddStringToObject(resp, "director", director);
            }
        } else if (director) {
            cJSON_AddStringToObject(resp, "director", director);
        }
        list = cJSON_AddArrayToObject(resp, "list");
        for (m = s->clients; m; m = m->next) {
            if (m != c && m->room && strcmp(m->room, room) == 0) {
                cJSON *e = cJSON_CreateObject();
                cJSON_AddStringToObject(e, "UUID", m->uuid);
                if (m->stream_id)
                    cJSON_AddStringToObject(e, "streamID", m->stream_id);
                if (director && strcmp(director, m->uuid) == 0)
                    cJSON_AddBoolToObject(e, "director", 1);
                cJSON_AddItemToArray(list, e);
            }
        }
        ss_send(c, resp);
        cJSON_Delete(resp);
        notice = cJSON_CreateObject();
        cJSON_AddStringToObject(notice, "request", "someonejoined");
        cJSON_AddStringToObject(notice, "UUID", c->uuid);
        if (is_director)
            cJSON_AddBoolToObject(notice, "director", 1);
        if (c->stream_id)
            cJSON_AddStringToObject(notice, "streamID", c->stream_id);
        ss_notify_room(s, room, notice, c->uuid);
        cJSON_Delete(notice);
        c->room = vdon_strdup(room);
        if (c->stream_id) {
            ss_waiting **pw = &s->waiting;
            while (*pw) {
                ss_waiting *w = *pw;
                ss_client *v = ss_find(s, w->viewer_uuid);
                if (strcmp(w->stream_id, c->stream_id) == 0 && v && v->room && strcmp(v->room, room) == 0) {
                    cJSON *o = cJSON_CreateObject();
                    cJSON_AddStringToObject(o, "request", "offerSDP");
                    cJSON_AddStringToObject(o, "UUID", w->viewer_uuid);
                    ss_send(c, o);
                    cJSON_Delete(o);
                    *pw = w->next;
                    free(w->stream_id);
                    free(w->viewer_uuid);
                    free(w);
                } else {
                    pw = &w->next;
                }
            }
        }
    }
}

static void ss_remove(vdon_signal_server *s, ss_client *c) {
    ss_client **pc = &s->clients;
    ss_waiting **pw = &s->waiting;
    ss_director **pd = &s->directors;
    while (*pc) {
        if (*pc == c) {
            *pc = c->next;
            break;
        }
        pc = &(*pc)->next;
    }
    while (*pw) {
        ss_waiting *w = *pw;
        if (strcmp(w->viewer_uuid, c->uuid) == 0) {
            *pw = w->next;
            free(w->stream_id);
            free(w->viewer_uuid);
            free(w);
        } else {
            pw = &w->next;
        }
    }
    while (*pd) {
        ss_director *d = *pd;
        if (strcmp(d->uuid, c->uuid) == 0) {
            *pd = d->next;
            free(d->room);
            free(d->uuid);
            free(d);
        } else {
            pd = &d->next;
        }
    }
    free(c->stream_id);
    free(c->room);
    free(c);
}

static void RTC_API ss_on_message(int ws, const char *message, int size, void *ptr) {
    ss_client *c = (ss_client *)ptr;
    vdon_signal_server *s = g_server;
    cJSON *msg;
    if (!c || !s || size >= 0)
        return;
    msg = cJSON_Parse(message);
    if (!msg)
        return;
    if (cJSON_IsObject(msg)) {
        pthread_mutex_lock(&s->lock);
        ss_handle(s, c, msg);
        pthread_mutex_unlock(&s->lock);
    }
    cJSON_Delete(msg);
}

static void RTC_API ss_on_closed(int ws, void *ptr) {
    ss_client *c = (ss_client *)ptr;
    vdon_signal_server *s = g_server;
    if (!c || !s)
        return;
    pthread_mutex_lock(&s->lock);
    ss_remove(s, c);
    pthread_mutex_unlock(&s->lock);
    rtcDelete(ws);
}

static void RTC_API ss_on_client(int wsserver, int ws, void *ptr) {
    vdon_signal_server *s = g_server;
    ss_client *c;
    if (!s)
        return;
    c = (ss_client *)calloc(1, sizeof(*c));
    c->ws = ws;
    vdon_generate_uuid(c->uuid);
    pthread_mutex_lock(&s->lock);
    c->next = s->clients;
    s->clients = c;
    pthread_mutex_unlock(&s->lock);
    rtcSetUserPointer(ws, c);
    rtcSetMessageCallback(ws, ss_on_message);
    rtcSetClosedCallback(ws, ss_on_closed);
}

vdon_signal_server *vdon_signal_server_create(uint16_t port) {
    vdon_signal_server *s;
    rtcWsServerConfiguration cfg;
    if (g_server)
        return NULL; /* one server per process (libdatachannel server callbacks carry no user pointer) */
    s = (vdon_signal_server *)calloc(1, sizeof(*s));
    pthread_mutex_init(&s->lock, NULL);
    memset(&cfg, 0, sizeof(cfg));
    cfg.port = port;
    g_server = s;
    s->server = rtcCreateWebSocketServer(&cfg, ss_on_client);
    if (s->server < 0) {
        /* dual-stack bind failed (no IPv6 on this host): fall back to IPv4 */
        cfg.bindAddress = "0.0.0.0";
        s->server = rtcCreateWebSocketServer(&cfg, ss_on_client);
    }
    if (s->server < 0) {
        g_server = NULL;
        pthread_mutex_destroy(&s->lock);
        free(s);
        return NULL;
    }
    return s;
}

int vdon_signal_server_port(vdon_signal_server *s) { return s ? rtcGetWebSocketServerPort(s->server) : VDON_ERR_INVALID; }

void vdon_signal_server_destroy(vdon_signal_server *s) {
    if (!s)
        return;
    rtcDeleteWebSocketServer(s->server);
    pthread_mutex_lock(&s->lock);
    while (s->clients)
        ss_remove(s, s->clients);
    pthread_mutex_unlock(&s->lock);
    pthread_mutex_destroy(&s->lock);
    if (g_server == s)
        g_server = NULL;
    free(s);
}
