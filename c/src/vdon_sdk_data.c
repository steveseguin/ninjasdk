/*
 * VDO.Ninja SDK for C — data layer: pipe messages, pub/sub, request/response,
 * native file transfer, binary and reserved channels, resources.
 *
 * Copyright (c) 2025-2026 Steve Seguin
 * SPDX-License-Identifier: MPL-2.0
 */
#include "vdon_sdk_internal.h"

#define EV(var, t)                                                                                                     \
    vdon_event var;                                                                                                    \
    memset(&var, 0, sizeof(var));                                                                                      \
    var.type = (t)

static const char *jstr(const cJSON *o, const char *k) {
    return o ? cJSON_GetStringValue(cJSON_GetObjectItemCaseSensitive(o, k)) : NULL;
}
static cJSON *jget(const cJSON *o, const char *k) { return o ? cJSON_GetObjectItemCaseSensitive(o, k) : NULL; }

static char *conn_sid(vdon_sdk *s, conn_t *c) {
    char *sid;
    pthread_mutex_lock(&s->lock);
    sid = c->stream_id ? vdon_strdup(c->stream_id) : NULL;
    pthread_mutex_unlock(&s->lock);
    return sid;
}

/* ------------------------------------------------------------ send data */

/* Sends {"pipe": payload} (payload consumed) to matching peers. Returns number of peers reached. */
static int send_pipe(vdon_sdk *s, cJSON *payload, const char *uuid, const char *type, const char *pref, int fallback) {
    cJSON *msg = cJSON_CreateObject();
    conn_t *c, *list[256];
    char *text;
    int n = 0, i, sent = 0;
    cJSON_AddItemToObject(msg, "pipe", payload);
    text = cJSON_PrintUnformatted(msg);
    if (!text) {
        cJSON_Delete(msg);
        return 0;
    }
    if (!pref)
        pref = "any";
    pthread_mutex_lock(&s->lock);
    for (c = s->conns; c && n < 256; c = c->next) {
        if (c->closed || !c->control || !c->control->open)
            continue;
        if (uuid && strcmp(c->uuid, uuid) != 0)
            continue;
        if (type && strcmp(c->type, type) != 0)
            continue;
        if (strcmp(pref, "publisher") == 0 && strcmp(c->type, "publisher") != 0)
            continue;
        if (strcmp(pref, "viewer") == 0 && strcmp(c->type, "viewer") != 0)
            continue;
        if (strcmp(pref, "any") == 0) {
            /* one channel per peer: prefer the publisher side */
            int dup = 0;
            for (i = 0; i < n; i++)
                if (strcmp(list[i]->uuid, c->uuid) == 0) {
                    if (strcmp(c->type, "publisher") == 0)
                        list[i] = c;
                    dup = 1;
                }
            if (dup)
                continue;
        }
        list[n++] = c;
    }
    pthread_mutex_unlock(&s->lock);
    for (i = 0; i < n; i++) {
        int dc;
        pthread_mutex_lock(&s->lock);
        dc = (!list[i]->closed && list[i]->control && list[i]->control->open) ? list[i]->control->dc : -1;
        pthread_mutex_unlock(&s->lock);
        if (dc >= 0 && rtcSendMessage(dc, text, -1) >= 0) {
            vdon__logf(s, "-> DC(%s/%s) %.300s", list[i]->uuid, list[i]->type, text);
            sent++;
        }
    }
    if (!sent && fallback) {
        /* WebSocket relay, explicit opt-in only */
        char **targets = NULL;
        int tn = 0;
        if (uuid) {
            targets = (char **)calloc(1, sizeof(char *));
            targets[tn++] = vdon_strdup(uuid);
        } else {
            pthread_mutex_lock(&s->lock);
            for (c = s->conns; c; c = c->next) {
                int dup = 0;
                if (c->closed)
                    continue;
                for (i = 0; i < tn; i++)
                    if (strcmp(targets[i], c->uuid) == 0)
                        dup = 1;
                if (dup)
                    continue;
                targets = (char **)realloc(targets, sizeof(char *) * (size_t)(tn + 1));
                targets[tn++] = vdon_strdup(c->uuid);
            }
            pthread_mutex_unlock(&s->lock);
        }
        for (i = 0; i < tn; i++) {
            cJSON *fb = cJSON_CreateObject();
            cJSON_AddBoolToObject(fb, "__fallback", 1);
            cJSON_AddStringToObject(fb, "UUID", targets[i]);
            cJSON_AddItemToObject(fb, "pipe", cJSON_Duplicate(jget(msg, "pipe"), 1));
            if (vdon__ws_send(s, fb))
                sent++;
            cJSON_Delete(fb);
            free(targets[i]);
        }
        free(targets);
    }
    free(text);
    cJSON_Delete(msg);
    return sent;
}

int vdon_send_data_ex(vdon_sdk *s, const char *json, const vdon_data_target *t) {
    cJSON *payload;
    int n;
    if (!s || !json)
        return VDON_ERR_INVALID;
    payload = vdon__parse_or_string(json);
    n = send_pipe(s, payload, t ? t->uuid : NULL, t ? t->connection_type : NULL, t ? t->preference : NULL,
                  t ? t->allow_fallback : 0);
    return n > 0 ? VDON_OK : VDON_ERR_NO_CHANNEL;
}

int vdon_send_data(vdon_sdk *s, const char *json, const char *uuid) {
    vdon_data_target t;
    memset(&t, 0, sizeof(t));
    t.uuid = uuid;
    return vdon_send_data_ex(s, json, &t);
}

int vdon_send_ping(vdon_sdk *s, const char *uuid) {
    conn_t *c, *list[256];
    int n = 0, i, sent = 0;
    int64_t now = vdon_now_ms();
    cJSON *m;
    if (!s)
        return VDON_ERR_INVALID;
    pthread_mutex_lock(&s->lock);
    for (c = s->conns; c && n < 256; c = c->next)
        if (!c->closed && c->control && c->control->open && (!uuid || strcmp(c->uuid, uuid) == 0)) {
            c->pending_ping = now;
            list[n++] = c;
        }
    pthread_mutex_unlock(&s->lock);
    m = cJSON_CreateObject();
    cJSON_AddNumberToObject(m, "ping", (double)now);
    for (i = 0; i < n; i++)
        sent += vdon__conn_send_control(s, list[i], m);
    cJSON_Delete(m);
    return sent > 0 ? VDON_OK : VDON_ERR_NO_CHANNEL;
}

/* -------------------------------------------------------------- pub/sub */

static void broadcast_sub(vdon_sdk *s, const char *type, const char *channel, conn_t *only) {
    cJSON *p = cJSON_CreateObject(), *arr = cJSON_AddArrayToObject(p, "channels");
    cJSON_AddStringToObject(p, "type", type);
    if (channel)
        cJSON_AddItemToArray(arr, cJSON_CreateString(channel));
    else {
        strnode_t *n;
        pthread_mutex_lock(&s->lock);
        for (n = s->subs; n; n = n->next)
            cJSON_AddItemToArray(arr, cJSON_CreateString(n->s));
        pthread_mutex_unlock(&s->lock);
    }
    if (only) {
        cJSON *m = cJSON_CreateObject();
        cJSON_AddItemToObject(m, "pipe", p);
        vdon__conn_send_control(s, only, m);
        cJSON_Delete(m);
    } else
        send_pipe(s, p, NULL, NULL, "all", 0);
}

void vdon__send_subscriptions(vdon_sdk *s, conn_t *c) {
    int any;
    pthread_mutex_lock(&s->lock);
    any = s->subs != NULL;
    pthread_mutex_unlock(&s->lock);
    if (any)
        broadcast_sub(s, "subscribe", NULL, c);
}

int vdon_subscribe(vdon_sdk *s, const char *channel) {
    strnode_t *n;
    if (!s || !channel || !*channel)
        return VDON_ERR_INVALID;
    pthread_mutex_lock(&s->lock);
    for (n = s->subs; n; n = n->next)
        if (strcmp(n->s, channel) == 0)
            break;
    if (!n) {
        n = (strnode_t *)calloc(1, sizeof(*n));
        n->s = vdon_strdup(channel);
        n->next = s->subs;
        s->subs = n;
    }
    pthread_mutex_unlock(&s->lock);
    broadcast_sub(s, "subscribe", channel, NULL);
    return VDON_OK;
}

int vdon_unsubscribe(vdon_sdk *s, const char *channel) {
    strnode_t **pp;
    if (!s || !channel)
        return VDON_ERR_INVALID;
    pthread_mutex_lock(&s->lock);
    for (pp = &s->subs; *pp; pp = &(*pp)->next)
        if (strcmp((*pp)->s, channel) == 0) {
            strnode_t *d = *pp;
            *pp = d->next;
            free(d->s);
            free(d);
            break;
        }
    pthread_mutex_unlock(&s->lock);
    broadcast_sub(s, "unsubscribe", channel, NULL);
    return VDON_OK;
}

int vdon_publish_to_channel(vdon_sdk *s, const char *channel, const char *json, const char *uuid) {
    cJSON *p;
    if (!s || !channel || !json)
        return VDON_ERR_INVALID;
    p = cJSON_CreateObject();
    cJSON_AddStringToObject(p, "type", "channelMessage");
    cJSON_AddStringToObject(p, "channel", channel);
    cJSON_AddItemToObject(p, "data", vdon__parse_or_string(json));
    cJSON_AddNumberToObject(p, "timestamp", (double)vdon_now_ms());
    return send_pipe(s, p, uuid, NULL, "any", 0) > 0 ? VDON_OK : VDON_ERR_NO_CHANNEL;
}

void vdon__drop_peer_subs(vdon_sdk *s, const char *uuid) {
    peersub_t **pp;
    conn_t *c;
    for (c = s->conns; c; c = c->next)
        if (!c->closed && strcmp(c->uuid, uuid) == 0)
            return; /* another connection to the peer is still alive */
    for (pp = &s->peersubs; *pp; pp = &(*pp)->next)
        if (strcmp((*pp)->uuid, uuid) == 0) {
            peersub_t *d = *pp;
            *pp = d->next;
            while (d->chans) {
                strnode_t *n = d->chans;
                d->chans = n->next;
                free(n->s);
                free(n);
            }
            free(d->uuid);
            free(d);
            return;
        }
}

/* ------------------------------------------------------ request/response */

int vdon_on_request(vdon_sdk *s, const char *request_type, vdon_request_handler fn, void *user) {
    handler_t *h;
    if (!s || !request_type)
        return VDON_ERR_INVALID;
    pthread_mutex_lock(&s->lock);
    for (h = s->handlers; h; h = h->next)
        if (strcmp(h->type, request_type) == 0)
            break;
    if (!fn) {
        if (h) {
            handler_t **pp;
            for (pp = &s->handlers; *pp; pp = &(*pp)->next)
                if (*pp == h) {
                    *pp = h->next;
                    break;
                }
            free(h->type);
            free(h);
        }
    } else {
        if (!h) {
            h = (handler_t *)calloc(1, sizeof(*h));
            h->type = vdon_strdup(request_type);
            h->next = s->handlers;
            s->handlers = h;
        }
        h->fn = fn;
        h->user = user;
    }
    pthread_mutex_unlock(&s->lock);
    return VDON_OK;
}

int vdon_respond(vdon_sdk *s, const char *request_id, const char *json, const char *uuid) {
    cJSON *p;
    if (!s || !request_id)
        return VDON_ERR_INVALID;
    p = cJSON_CreateObject();
    cJSON_AddStringToObject(p, "type", "response");
    cJSON_AddStringToObject(p, "requestId", request_id);
    cJSON_AddItemToObject(p, "data", vdon__parse_or_string(json));
    return send_pipe(s, p, uuid, NULL, "any", 0) > 0 ? VDON_OK : VDON_ERR_NO_CHANNEL;
}

int vdon_request(vdon_sdk *s, const char *request_type, const char *json, const char *uuid, int timeout_ms,
                 char **out_json) {
    char id[37];
    preq_t *r, **pp;
    cJSON *p;
    int rc = VDON_OK;
    int64_t deadline;
    if (!s || !request_type)
        return VDON_ERR_INVALID;
    if (out_json)
        *out_json = NULL;
    if (timeout_ms <= 0)
        timeout_ms = 5000;
    vdon_generate_uuid(id);
    r = (preq_t *)calloc(1, sizeof(*r));
    r->id = vdon_strdup(id);
    r->target = uuid ? vdon_strdup(uuid) : NULL;
    pthread_mutex_lock(&s->lock);
    r->next = s->requests;
    s->requests = r;
    pthread_mutex_unlock(&s->lock);
    p = cJSON_CreateObject();
    cJSON_AddStringToObject(p, "type", "request");
    cJSON_AddStringToObject(p, "requestType", request_type);
    cJSON_AddStringToObject(p, "requestId", id);
    cJSON_AddItemToObject(p, "data", vdon__parse_or_string(json));
    if (send_pipe(s, p, uuid, NULL, "any", 0) == 0)
        rc = VDON_ERR_NO_CHANNEL;
    deadline = vdon_now_ms() + timeout_ms;
    pthread_mutex_lock(&s->lock);
    while (rc == VDON_OK && !r->done) {
        if (!vdon__wait_until(s, deadline)) {
            rc = VDON_ERR_TIMEOUT;
            break;
        }
    }
    for (pp = &s->requests; *pp; pp = &(*pp)->next)
        if (*pp == r) {
            *pp = r->next;
            break;
        }
    pthread_mutex_unlock(&s->lock);
    if (rc == VDON_OK) {
        if (r->err == VDON_ERR_CANCELLED)
            rc = VDON_ERR_CANCELLED;
        else if (r->err)
            rc = VDON_ERR_REMOTE;
        if (out_json)
            *out_json = r->result ? r->result : vdon_strdup("null");
        else
            free(r->result);
        r->result = NULL;
    }
    free(r->result);
    free(r->id);
    free(r->target);
    free(r);
    return rc;
}

void vdon__fail_all_waiters(vdon_sdk *s) {
    preq_t *r;
    inbound_t *in;
    for (r = s->requests; r; r = r->next)
        if (!r->done) {
            r->done = 1;
            r->err = VDON_ERR_CANCELLED;
        }
    for (in = s->inbound; in; in = in->next)
        if (!in->done) {
            in->done = 1;
            in->err = VDON_ERR_CANCELLED;
        }
}

/* Returns 1 if the pipe payload was a protocol message handled here. */
int vdon__handle_pipe_special(vdon_sdk *s, conn_t *c, cJSON *pipe) {
    const char *type = jstr(pipe, "type");
    if (!type)
        return 0;
    if (strcmp(type, "subscribe") == 0 || strcmp(type, "unsubscribe") == 0) {
        cJSON *chs = jget(pipe, "channels"), *it, *all = cJSON_CreateArray(), *list = cJSON_CreateArray();
        peersub_t *ps;
        strnode_t *n;
        int sub = type[0] == 's';
        char *all_text, *list_text;
        if (cJSON_IsString(chs))
            cJSON_AddItemToArray(list, cJSON_CreateString(cJSON_GetStringValue(chs)));
        else
            cJSON_ArrayForEach(it, chs) if (cJSON_IsString(it)) cJSON_AddItemToArray(list, cJSON_CreateString(cJSON_GetStringValue(it)));
        pthread_mutex_lock(&s->lock);
        for (ps = s->peersubs; ps; ps = ps->next)
            if (strcmp(ps->uuid, c->uuid) == 0)
                break;
        if (!ps) {
            ps = (peersub_t *)calloc(1, sizeof(*ps));
            ps->uuid = vdon_strdup(c->uuid);
            ps->next = s->peersubs;
            s->peersubs = ps;
        }
        cJSON_ArrayForEach(it, list) {
            const char *ch = cJSON_GetStringValue(it);
            strnode_t **pp;
            for (pp = &ps->chans; *pp && strcmp((*pp)->s, ch) != 0; pp = &(*pp)->next)
                ;
            if (sub && !*pp) {
                n = (strnode_t *)calloc(1, sizeof(*n));
                n->s = vdon_strdup(ch);
                n->next = ps->chans;
                ps->chans = n;
            } else if (!sub && *pp) {
                n = *pp;
                *pp = n->next;
                free(n->s);
                free(n);
            }
        }
        for (n = ps->chans; n; n = n->next)
            cJSON_AddItemToArray(all, cJSON_CreateString(n->s));
        pthread_mutex_unlock(&s->lock);
        all_text = cJSON_PrintUnformatted(all);
        list_text = cJSON_PrintUnformatted(list);
        {
            EV(ev, sub ? VDON_EVENT_PEER_SUBSCRIBED : VDON_EVENT_PEER_UNSUBSCRIBED);
            ev.uuid = c->uuid;
            ev.json = all_text;
            ev.message = list_text; /* the channels in this message */
            vdon__emit(s, &ev);
        }
        free(all_text);
        free(list_text);
        cJSON_Delete(all);
        cJSON_Delete(list);
        return 1;
    }
    if (strcmp(type, "channelMessage") == 0) {
        const char *ch = jstr(pipe, "channel");
        int subscribed = 0;
        strnode_t *n;
        if (!ch)
            return 1;
        pthread_mutex_lock(&s->lock);
        for (n = s->subs; n; n = n->next)
            if (strcmp(n->s, ch) == 0)
                subscribed = 1;
        pthread_mutex_unlock(&s->lock);
        if (subscribed) {
            char *text = vdon__json_text(jget(pipe, "data"));
            EV(ev, VDON_EVENT_CHANNEL_MESSAGE);
            ev.uuid = c->uuid;
            ev.label = ch;
            ev.json = text ? text : "null";
            ev.number = (int64_t)cJSON_GetNumberValue(jget(pipe, "timestamp"));
            vdon__emit(s, &ev);
            free(text);
        }
        return 1;
    }
    if (strcmp(type, "request") == 0) {
        const char *rt = jstr(pipe, "requestType"), *rid = jstr(pipe, "requestId");
        handler_t *h;
        vdon_request_handler fn = NULL;
        void *user = NULL;
        char *data_text, *reply;
        if (!rt || !rid)
            return 1;
        pthread_mutex_lock(&s->lock);
        for (h = s->handlers; h; h = h->next)
            if (strcmp(h->type, rt) == 0) {
                fn = h->fn;
                user = h->user;
            }
        pthread_mutex_unlock(&s->lock);
        if (!fn)
            return 1;
        data_text = vdon__json_text(jget(pipe, "data"));
        reply = fn(s, data_text ? data_text : "null", c->uuid, user);
        free(data_text);
        if (reply) {
            vdon_respond(s, rid, reply, c->uuid);
            free(reply);
        } else {
            vdon_respond(s, rid, "{\"error\":\"request failed\"}", c->uuid);
        }
        return 1;
    }
    if (strcmp(type, "response") == 0) {
        const char *rid = jstr(pipe, "requestId");
        preq_t *r;
        cJSON *data = jget(pipe, "data");
        if (!rid)
            return 1;
        pthread_mutex_lock(&s->lock);
        for (r = s->requests; r; r = r->next)
            if (!r->done && strcmp(r->id, rid) == 0 && (!r->target || strcmp(r->target, c->uuid) == 0))
                break;
        if (r) {
            r->done = 1;
            r->result = vdon__json_text(data);
            if (cJSON_IsObject(data) && jstr(data, "error") && *jstr(data, "error"))
                r->err = VDON_ERR_REMOTE;
            pthread_cond_broadcast(&s->cond);
        }
        pthread_mutex_unlock(&s->lock);
        return 1;
    }
    return 0;
}

/* --------------------------------------------------------- file hosting */

void vdon__hosted_unref(vdon_sdk *s, hosted_t *h) {
    hosted_t **pp;
    if (--h->refs > 0)
        return;
    for (pp = &s->hosted; *pp; pp = &(*pp)->next)
        if (*pp == h) {
            *pp = h->next;
            break;
        }
    free(h->id);
    free(h->name);
    free(h->data);
    free(h->restricted);
    free(h);
}

static cJSON *file_entry(hosted_t *h) {
    cJSON *e = cJSON_CreateObject();
    cJSON_AddStringToObject(e, "id", h->id);
    cJSON_AddStringToObject(e, "name", h->name);
    cJSON_AddNumberToObject(e, "size", (double)h->size);
    return e;
}

static void send_entries(vdon_sdk *s, conn_t *c, hosted_t *only) {
    cJSON *m = cJSON_CreateObject(), *arr = cJSON_AddArrayToObject(m, "fileList"), *it;
    hosted_t *h;
    pthread_mutex_lock(&s->lock);
    if (c->closed || !c->allow_download) {
        pthread_mutex_unlock(&s->lock);
        cJSON_Delete(m);
        return;
    }
    for (h = s->hosted; h; h = h->next) {
        int seen = 0;
        if (only && h != only)
            continue;
        if (h->cancelled || (h->restricted && strcmp(h->restricted, c->uuid) != 0))
            continue;
        cJSON_ArrayForEach(it, c->advertised) if (strcmp(cJSON_GetStringValue(it), h->id) == 0) seen = 1;
        if (!seen)
            cJSON_AddItemToArray(arr, file_entry(h));
    }
    pthread_mutex_unlock(&s->lock);
    if (cJSON_GetArraySize(arr) > 0 && vdon__conn_send_control(s, c, m)) {
        pthread_mutex_lock(&s->lock);
        cJSON_ArrayForEach(it, arr) cJSON_AddItemToArray(c->advertised, cJSON_CreateString(jstr(it, "id")));
        pthread_mutex_unlock(&s->lock);
    }
    cJSON_Delete(m);
}

void vdon__send_file_list(vdon_sdk *s, conn_t *c) { send_entries(s, c, NULL); }

int vdon_host_file(vdon_sdk *s, const char *name, const uint8_t *data, size_t size, const char *restricted_uuid,
                   char *out_id, size_t out_size) {
    hosted_t *h;
    conn_t *c, *list[256];
    int n = 0, i;
    char id[13];
    if (!s || !name || (!data && size))
        return VDON_ERR_INVALID;
    vdon_generate_stream_id(id);
    h = (hosted_t *)calloc(1, sizeof(*h));
    h->id = vdon_strdup(id);
    h->name = vdon_strdup(name);
    h->size = size;
    h->data = (uint8_t *)malloc(size ? size : 1);
    if (size)
        memcpy(h->data, data, size);
    h->restricted = restricted_uuid ? vdon_strdup(restricted_uuid) : NULL;
    h->refs = 1;
    pthread_mutex_lock(&s->lock);
    h->next = s->hosted;
    s->hosted = h;
    for (c = s->conns; c && n < 256; c = c->next)
        if (!c->closed)
            list[n++] = c;
    pthread_mutex_unlock(&s->lock);
    if (out_id && out_size)
        snprintf(out_id, out_size, "%s", id);
    for (i = 0; i < n; i++)
        send_entries(s, list[i], h);
    return VDON_OK;
}

int vdon_unhost_file(vdon_sdk *s, const char *file_id) {
    hosted_t *h;
    if (!s || !file_id)
        return VDON_ERR_INVALID;
    pthread_mutex_lock(&s->lock);
    for (h = s->hosted; h; h = h->next)
        if (strcmp(h->id, file_id) == 0)
            break;
    if (!h) {
        pthread_mutex_unlock(&s->lock);
        return VDON_ERR_NOT_FOUND;
    }
    h->cancelled = 1;
    vdon__hosted_unref(s, h);
    pthread_mutex_unlock(&s->lock);
    return VDON_OK;
}

static void emit_file(vdon_sdk *s, vdon_event_type t, conn_t *c, const char *id, const char *name, int64_t size,
                      int64_t bytes, const char *dir, const char *message, const uint8_t *chunk, size_t chunk_len) {
    char *sid = conn_sid(s, c);
    EV(ev, t);
    ev.uuid = c->uuid;
    ev.stream_id = sid;
    ev.file_id = id;
    ev.file_name = name;
    ev.file_size = size;
    ev.file_bytes = bytes;
    ev.direction = dir;
    ev.message = message;
    ev.bytes = chunk;
    ev.size = chunk_len;
    vdon__emit(s, &ev);
    free(sid);
}

static int wait_buffer_below(chan_t *ch, int threshold, int timeout_ms) {
    int64_t deadline = vdon_now_ms() + timeout_ms;
    for (;;) {
        int amount;
        if (!rtcIsOpen(ch->dc))
            return 0;
        amount = rtcGetBufferedAmount(ch->dc);
        if (amount < 0 || amount <= threshold)
            return 1;
        if (vdon_now_ms() > deadline)
            return 0;
        vdon__sleep_ms(2);
    }
}

typedef struct send_ctx {
    vdon_sdk *s;
    chan_t *ch;
} send_ctx;

static void *file_send_thread(void *arg) {
    send_ctx *ctx = (send_ctx *)arg;
    vdon_sdk *s = ctx->s;
    chan_t *ch = ctx->ch;
    conn_t *c = ch->conn;
    hosted_t *h = ch->out_file;
    cJSON *hdr = cJSON_CreateObject();
    char *text;
    size_t off = 0;
    int ok = 1;
    free(ctx);
    cJSON_AddStringToObject(hdr, "type", "filetransfer");
    cJSON_AddNumberToObject(hdr, "size", (double)h->size);
    cJSON_AddStringToObject(hdr, "filename", h->name);
    cJSON_AddStringToObject(hdr, "id", h->id);
    text = cJSON_PrintUnformatted(hdr);
    cJSON_Delete(hdr);
    if (rtcSendMessage(ch->dc, text, -1) < 0)
        ok = 0;
    free(text);
    if (ok)
        emit_file(s, VDON_EVENT_FILE_TRANSFER_START, c, h->id, h->name, (int64_t)h->size, 0, "outbound", NULL, NULL, 0);
    while (ok && off < h->size) {
        size_t n = h->size - off < VDON_FILE_CHUNK_SIZE ? h->size - off : VDON_FILE_CHUNK_SIZE;
        int cancelled;
        pthread_mutex_lock(&s->lock);
        cancelled = h->cancelled || c->closed;
        pthread_mutex_unlock(&s->lock);
        if (cancelled) {
            rtcSendMessage(ch->dc, "EOF2", -1);
            emit_file(s, VDON_EVENT_FILE_TRANSFER_CANCELLED, c, h->id, h->name, (int64_t)h->size, (int64_t)off, "outbound",
                      NULL, NULL, 0);
            wait_buffer_below(ch, 0, 5000);
            ok = 0;
            break;
        }
        if (!wait_buffer_below(ch, VDON_BUFFER_HIGH, 30000) || rtcSendMessage(ch->dc, (const char *)h->data + off, (int)n) < 0) {
            emit_file(s, VDON_EVENT_FILE_TRANSFER_ERROR, c, h->id, h->name, (int64_t)h->size, (int64_t)off, "outbound",
                      "send failed", NULL, 0);
            ok = 0;
            break;
        }
        off += n;
        emit_file(s, VDON_EVENT_FILE_TRANSFER_PROGRESS, c, h->id, h->name, (int64_t)h->size, (int64_t)off, "outbound", NULL,
                  NULL, 0);
    }
    if (ok) {
        if (wait_buffer_below(ch, 0, 30000) && rtcSendMessage(ch->dc, "EOF1", -1) >= 0) {
            int64_t deadline;
            wait_buffer_below(ch, 0, 10000);
            emit_file(s, VDON_EVENT_FILE_TRANSFER_COMPLETE, c, h->id, h->name, (int64_t)h->size, (int64_t)off, "outbound",
                      NULL, NULL, 0);
            /* the receiver closes after EOF1; give it a moment */
            deadline = vdon_now_ms() + 3000;
            while (vdon_now_ms() < deadline && rtcIsOpen(ch->dc))
                vdon__sleep_ms(20);
        } else {
            emit_file(s, VDON_EVENT_FILE_TRANSFER_ERROR, c, h->id, h->name, (int64_t)h->size, (int64_t)off, "outbound",
                      "send buffer did not drain", NULL, 0);
        }
    }
    if (rtcIsOpen(ch->dc))
        rtcClose(ch->dc);
    pthread_mutex_lock(&s->lock);
    ch->out_file = NULL;
    vdon__hosted_unref(s, h);
    pthread_mutex_unlock(&s->lock);
    return NULL;
}

void vdon__handle_file_request(vdon_sdk *s, conn_t *c, const char *id) {
    hosted_t *h;
    chan_t *ch;
    int dc;
    pthread_mutex_lock(&s->lock);
    for (h = s->hosted; h; h = h->next)
        if (strcmp(h->id, id) == 0)
            break;
    if (!h || h->cancelled || (h->restricted && strcmp(h->restricted, c->uuid) != 0) || c->closed) {
        pthread_mutex_unlock(&s->lock);
        vdon__logf(s, "Refusing file request \"%s\" from %s", id, c->uuid);
        return;
    }
    h->refs++;
    dc = rtcCreateDataChannel(c->pc, id);
    if (dc < 0) {
        vdon__hosted_unref(s, h);
        pthread_mutex_unlock(&s->lock);
        emit_file(s, VDON_EVENT_FILE_TRANSFER_ERROR, c, id, h->name, (int64_t)h->size, 0, "outbound",
                  "failed to open channel", NULL, 0);
        return;
    }
    ch = vdon__chan_new(c, dc, CH_FILE_OUT, id);
    ch->out_file = h;
    pthread_mutex_unlock(&s->lock);
    vdon__chan_install_callbacks(ch);
}

void vdon__chan_opened_extra(chan_t *ch) {
    vdon_sdk *s = ch->conn->sdk;
    if (ch->kind == CH_FILE_OUT) {
        pthread_t th;
        send_ctx *ctx = (send_ctx *)calloc(1, sizeof(*ctx));
        ctx->s = s;
        ctx->ch = ch;
        if (pthread_create(&th, NULL, file_send_thread, ctx) == 0)
            pthread_detach(th);
        else
            free(ctx);
    } else if (ch->kind == CH_RESERVED || ch->kind == CH_BINARY) {
        char *sid = conn_sid(s, ch->conn);
        EV(ev, VDON_EVENT_CHANNEL_OPEN);
        ev.uuid = ch->conn->uuid;
        ev.stream_id = sid;
        ev.label = ch->label;
        ev.channel = ch->dc;
        vdon__emit(s, &ev);
        free(sid);
    }
}

/* lock held: forget every channel back-reference to a transfer about to be freed,
 * so a late chunk, EOF or close on a still-open channel cannot touch it. */
static void inbound_detach(vdon_sdk *s, inbound_t *in) {
    conn_t *c;
    chan_t *ch;
    for (c = s->conns; c; c = c->next)
        for (ch = c->chans; ch; ch = ch->next)
            if (ch->inbound == in)
                ch->inbound = NULL;
    for (c = s->graveyard; c; c = c->next)
        for (ch = c->chans; ch; ch = ch->next)
            if (ch->inbound == in)
                ch->inbound = NULL;
}

static void inbound_finish(vdon_sdk *s, chan_t *ch, int err) {
    pthread_mutex_lock(&s->lock);
    if (ch->inbound && !ch->inbound->done) {
        ch->inbound->done = 1;
        ch->inbound->err = err;
        pthread_cond_broadcast(&s->cond);
    }
    ch->finished = 1;
    pthread_mutex_unlock(&s->lock);
}

void vdon__chan_closed_extra(chan_t *ch) {
    vdon_sdk *s = ch->conn->sdk;
    if (ch->kind == CH_FILE_IN && ch->have_header && !ch->finished) {
        emit_file(s, VDON_EVENT_FILE_TRANSFER_ERROR, ch->conn, ch->fid, ch->fname, ch->fsize, ch->received, "inbound",
                  "file channel closed before completion", NULL, 0);
        inbound_finish(s, ch, VDON_ERR_FAILURE);
    }
}

static void file_in_message(chan_t *ch, const char *msg, int size) {
    vdon_sdk *s = ch->conn->sdk;
    conn_t *c = ch->conn;
    if (!ch->have_header) {
        cJSON *hdr;
        const char *type;
        inbound_t *in;
        if (size >= 0 || !(hdr = cJSON_Parse(msg)))
            return;
        type = jstr(hdr, "type");
        if (!type || strcmp(type, "filetransfer") != 0) {
            cJSON_Delete(hdr);
            return;
        }
        ch->have_header = 1;
        if (cJSON_IsString(jget(hdr, "id")))
            ch->fid = vdon_strdup(jstr(hdr, "id"));
        else if (cJSON_IsNumber(jget(hdr, "id"))) {
            char num[32];
            snprintf(num, sizeof(num), "%.0f", cJSON_GetNumberValue(jget(hdr, "id")));
            ch->fid = vdon_strdup(num);
        } else
            ch->fid = vdon_strdup(ch->label);
        ch->fname = vdon_strdup(jstr(hdr, "filename") ? jstr(hdr, "filename") : "");
        ch->fsize = (int64_t)cJSON_GetNumberValue(jget(hdr, "size"));
        cJSON_Delete(hdr);
        pthread_mutex_lock(&s->lock);
        for (in = s->inbound; in; in = in->next)
            if (!in->done && strcmp(in->uuid, c->uuid) == 0 &&
                (strcmp(in->id, ch->fid) == 0 || strcmp(in->id, ch->label) == 0))
                break;
        ch->inbound = in;
        if (in) {
            free(in->name);
            in->name = vdon_strdup(ch->fname);
            in->size = ch->fsize;
        }
        pthread_mutex_unlock(&s->lock);
        {
            char *sid = conn_sid(s, c);
            EV(ev, VDON_EVENT_FILE_TRANSFER_START);
            ev.uuid = c->uuid;
            ev.stream_id = sid;
            ev.file_id = ch->fid;
            ev.file_name = ch->fname;
            ev.file_size = ch->fsize;
            ev.direction = "inbound";
            ev.flag = in != NULL;
            vdon__emit(s, &ev);
            free(sid);
        }
        return;
    }
    if (size < 0) {
        if (strcmp(msg, "EOF1") == 0) {
            if (ch->inbound && ch->received != ch->fsize) {
                emit_file(s, VDON_EVENT_FILE_TRANSFER_ERROR, c, ch->fid, ch->fname, ch->fsize, ch->received, "inbound",
                          "size mismatch", NULL, 0);
                inbound_finish(s, ch, VDON_ERR_FAILURE);
            } else {
                emit_file(s, VDON_EVENT_FILE_TRANSFER_COMPLETE, c, ch->fid, ch->fname, ch->fsize, ch->received, "inbound",
                          NULL, NULL, 0);
                inbound_finish(s, ch, 0);
            }
            vdon__schedule_close_dc(s, ch->dc);
        } else if (strcmp(msg, "EOF2") == 0) {
            emit_file(s, VDON_EVENT_FILE_TRANSFER_CANCELLED, c, ch->fid, ch->fname, ch->fsize, ch->received, "inbound", NULL,
                      NULL, 0);
            inbound_finish(s, ch, VDON_ERR_CANCELLED);
            vdon__schedule_close_dc(s, ch->dc);
        }
        return;
    }
    ch->received += size;
    pthread_mutex_lock(&s->lock);
    if (ch->inbound && !ch->inbound->done) {
        inbound_t *in = ch->inbound;
        if (in->len + (size_t)size > in->cap) {
            size_t ncap = in->cap ? in->cap * 2 : 65536;
            while (ncap < in->len + (size_t)size)
                ncap *= 2;
            in->buf = (uint8_t *)realloc(in->buf, ncap);
            in->cap = ncap;
        }
        memcpy(in->buf + in->len, msg, (size_t)size);
        in->len += (size_t)size;
        in->received = ch->received;
    }
    pthread_mutex_unlock(&s->lock);
    emit_file(s, VDON_EVENT_FILE_TRANSFER_PROGRESS, c, ch->fid, ch->fname, ch->fsize, ch->received, "inbound", NULL, NULL, 0);
    if (!ch->inbound)
        emit_file(s, VDON_EVENT_FILE_CHUNK, c, ch->fid, ch->fname, ch->fsize, ch->received, "inbound", NULL,
                  (const uint8_t *)msg, (size_t)size);
}

static void resource_message(chan_t *ch, const char *msg, int size) {
    vdon_sdk *s = ch->conn->sdk;
    if (size < 0) {
        cJSON *meta = cJSON_Parse(msg);
        if (meta && jstr(meta, "templateName")) {
            cJSON_Delete(ch->res_meta);
            ch->res_meta = meta;
            ch->res_size = (int64_t)cJSON_GetNumberValue(jget(meta, "size"));
            ch->res_len = 0;
        } else
            cJSON_Delete(meta);
        return;
    }
    if (!ch->res_meta)
        return;
    ch->res_buf = (uint8_t *)realloc(ch->res_buf, ch->res_len + (size_t)size);
    memcpy(ch->res_buf + ch->res_len, msg, (size_t)size);
    ch->res_len += (size_t)size;
    if ((int64_t)ch->res_len >= ch->res_size) {
        char *text = cJSON_PrintUnformatted(ch->res_meta);
        char *sid = conn_sid(s, ch->conn);
        EV(ev, VDON_EVENT_RESOURCE_RECEIVED);
        ev.uuid = ch->conn->uuid;
        ev.stream_id = sid;
        ev.label = jstr(ch->res_meta, "templateName");
        ev.json = text;
        ev.bytes = ch->res_buf;
        ev.size = ch->res_len;
        vdon__emit(s, &ev);
        free(text);
        free(sid);
        cJSON_Delete(ch->res_meta);
        ch->res_meta = NULL;
        free(ch->res_buf);
        ch->res_buf = NULL;
        ch->res_len = 0;
    }
}

void vdon__chan_message(chan_t *ch, const char *msg, int size) {
    vdon_sdk *s = ch->conn->sdk;
    switch (ch->kind) {
    case CH_FILE_IN:
        file_in_message(ch, msg, size);
        return;
    case CH_RESOURCE:
        resource_message(ch, msg, size);
        return;
    case CH_BINARY:
    case CH_RESERVED: {
        char *sid = conn_sid(s, ch->conn);
        if (size >= 0) {
            EV(ev, VDON_EVENT_BINARY_RECEIVED);
            ev.uuid = ch->conn->uuid;
            ev.stream_id = sid;
            ev.label = ch->label;
            ev.channel = ch->dc;
            ev.bytes = (const uint8_t *)msg;
            ev.size = (size_t)size;
            vdon__emit(s, &ev);
        } else {
            EV(ev, VDON_EVENT_CHANNEL_MESSAGE);
            ev.uuid = ch->conn->uuid;
            ev.stream_id = sid;
            ev.label = ch->label;
            ev.channel = ch->dc;
            ev.json = msg;
            vdon__emit(s, &ev);
        }
        free(sid);
        return;
    }
    default:
        return;
    }
}

int vdon_request_file(vdon_sdk *s, const char *uuid, const char *file_id, int timeout_ms, uint8_t **out_data,
                      size_t *out_size) {
    inbound_t *in, **pp;
    conn_t *c;
    cJSON *m;
    int rc = VDON_OK, sent;
    int64_t deadline;
    if (!s || !uuid || !file_id || !out_data)
        return VDON_ERR_INVALID;
    *out_data = NULL;
    if (out_size)
        *out_size = 0;
    if (timeout_ms <= 0)
        timeout_ms = 60000;
    in = (inbound_t *)calloc(1, sizeof(*in));
    in->uuid = vdon_strdup(uuid);
    in->id = vdon_strdup(file_id);
    pthread_mutex_lock(&s->lock);
    in->next = s->inbound;
    s->inbound = in;
    c = vdon__find_conn(s, uuid, NULL);
    pthread_mutex_unlock(&s->lock);
    m = cJSON_CreateObject();
    cJSON_AddStringToObject(m, "requestFile", file_id);
    sent = c ? vdon__conn_send_control(s, c, m) : 0;
    cJSON_Delete(m);
    if (!sent)
        rc = VDON_ERR_NO_CHANNEL;
    deadline = vdon_now_ms() + timeout_ms;
    pthread_mutex_lock(&s->lock);
    while (rc == VDON_OK && !in->done)
        if (!vdon__wait_until(s, deadline)) {
            rc = VDON_ERR_TIMEOUT;
            break;
        }
    if (rc == VDON_OK && in->err)
        rc = in->err;
    in->done = 1; /* late chunks are ignored */
    for (pp = &s->inbound; *pp; pp = &(*pp)->next)
        if (*pp == in) {
            *pp = in->next;
            break;
        }
    inbound_detach(s, in);
    pthread_mutex_unlock(&s->lock);
    if (rc == VDON_OK) {
        *out_data = in->buf ? in->buf : (uint8_t *)malloc(1);
        if (out_size)
            *out_size = in->len;
    } else
        free(in->buf);
    free(in->uuid);
    free(in->id);
    free(in->name);
    free(in);
    return rc;
}

/* -------------------------------------------------------- x- channels */

static int open_channel(vdon_sdk *s, const char *uuid, const char *label, int timeout_ms) {
    conn_t *c;
    chan_t *ch = NULL, *it;
    int64_t deadline;
    int dc;
    if (!s || !uuid || !label || strncmp(label, "x-", 2) != 0)
        return VDON_ERR_INVALID;
    if (timeout_ms <= 0)
        timeout_ms = 10000;
    pthread_mutex_lock(&s->lock);
    c = vdon__find_conn(s, uuid, NULL);
    if (!c) {
        pthread_mutex_unlock(&s->lock);
        return VDON_ERR_NOT_FOUND;
    }
    for (it = c->chans; it; it = it->next)
        if (strcmp(it->label, label) == 0 && it->dc >= 0 && (it->open || rtcIsOpen(it->dc)))
            ch = it;
    if (!ch) {
        dc = rtcCreateDataChannel(c->pc, label);
        if (dc < 0) {
            pthread_mutex_unlock(&s->lock);
            return VDON_ERR_FAILURE;
        }
        ch = vdon__chan_new(c, dc, strcmp(label, VDON_BINARY_CHANNEL) == 0 ? CH_BINARY : CH_RESERVED, label);
        pthread_mutex_unlock(&s->lock);
        vdon__chan_install_callbacks(ch);
        pthread_mutex_lock(&s->lock);
    }
    deadline = vdon_now_ms() + timeout_ms;
    while (!ch->open && !c->closed && ch->dc >= 0) {
        if (rtcIsOpen(ch->dc)) {
            ch->open = 1;
            break;
        }
        if (!vdon__wait_until(s, deadline))
            break;
    }
    dc = ch->open && !c->closed ? ch->dc : VDON_ERR_TIMEOUT;
    pthread_mutex_unlock(&s->lock);
    return dc;
}

int vdon_open_channel(vdon_sdk *s, const char *uuid, const char *label, int timeout_ms) {
    return open_channel(s, uuid, label, timeout_ms);
}

int vdon_send_binary(vdon_sdk *s, const char *uuid, const uint8_t *data, size_t size) {
    int dc;
    if (!s || !uuid || !data)
        return VDON_ERR_INVALID;
    dc = open_channel(s, uuid, VDON_BINARY_CHANNEL, 10000);
    if (dc < 0)
        return dc;
    return rtcSendMessage(dc, (const char *)data, (int)size) >= 0 ? VDON_OK : VDON_ERR_FAILURE;
}

/* ------------------------------------------------------------- cleanup */

void vdon__free_data_state(vdon_sdk *s) {
    while (s->hosted) {
        hosted_t *h = s->hosted;
        h->refs = 1;
        vdon__hosted_unref(s, h);
    }
    while (s->inbound) {
        inbound_t *in = s->inbound;
        s->inbound = in->next;
        free(in->buf);
        free(in->uuid);
        free(in->id);
        free(in->name);
        free(in);
    }
    while (s->requests) {
        preq_t *r = s->requests;
        s->requests = r->next;
        free(r->id);
        free(r->target);
        free(r->result);
        free(r);
    }
    while (s->handlers) {
        handler_t *h = s->handlers;
        s->handlers = h->next;
        free(h->type);
        free(h);
    }
    while (s->subs) {
        strnode_t *n = s->subs;
        s->subs = n->next;
        free(n->s);
        free(n);
    }
    while (s->peersubs) {
        peersub_t *p = s->peersubs;
        s->peersubs = p->next;
        while (p->chans) {
            strnode_t *n = p->chans;
            p->chans = n->next;
            free(n->s);
            free(n);
        }
        free(p->uuid);
        free(p);
    }
}
