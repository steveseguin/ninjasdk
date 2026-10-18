/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
#include "vdon_internal.h"
#include "vdoninja.h"

#include <ctype.h>
#include <string.h>

static int is_word(unsigned char c) { return isalnum(c) || c == '_'; }

static int trim_bounds(const char *in, size_t *start, size_t *end) {
    size_t s = 0, e = strlen(in);
    while (s < e && isspace((unsigned char)in[s]))
        s++;
    while (e > s && isspace((unsigned char)in[e - 1]))
        e--;
    *start = s;
    *end = e;
    return e > s;
}

/* Replaces runs of non [A-Za-z0-9_] with "_" (ASCII \W, multi-byte UTF-8 counts as non-word). */
static int replace_non_word(const char *in, size_t s, size_t e, size_t max_len, char *out, size_t out_size) {
    size_t n = 0, i;
    int in_run = 0;
    for (i = s; i < e && n < max_len; i++) {
        unsigned char c = (unsigned char)in[i];
        if (c < 0x80 && is_word(c)) {
            if (n + 1 >= out_size)
                return VDON_ERR_TOO_SMALL;
            out[n++] = (char)c;
            in_run = 0;
        } else if (!in_run) {
            if (n + 1 >= out_size)
                return VDON_ERR_TOO_SMALL;
            out[n++] = '_';
            in_run = 1;
        }
    }
    out[n] = 0;
    return VDON_OK;
}

int vdon_sanitize_stream_id(const char *in, char *out, size_t out_size) {
    size_t s, e;
    if (!out || out_size < 13)
        return VDON_ERR_TOO_SMALL;
    if (!in || !trim_bounds(in, &s, &e)) {
        vdon_generate_stream_id(out);
        return VDON_OK;
    }
    return replace_non_word(in, s, e, 64, out, out_size);
}

int vdon_sanitize_room(const char *in, char *out, size_t out_size) {
    size_t s, e;
    if (!out || out_size < 1)
        return VDON_ERR_TOO_SMALL;
    out[0] = 0;
    if (!in || !trim_bounds(in, &s, &e))
        return VDON_OK;
    return replace_non_word(in, s, e, 30, out, out_size);
}

int vdon_sanitize_label(const char *in, char *out, size_t out_size) {
    /* Drop line breaks, keep at most 100 code points, trim. */
    size_t n = 0, cps = 0, i, len;
    size_t s, e;
    if (!out || out_size < 1)
        return VDON_ERR_TOO_SMALL;
    out[0] = 0;
    if (!in)
        return VDON_OK;
    len = strlen(in);
    for (i = 0; i < len; i++) {
        unsigned char c = (unsigned char)in[i];
        if (c == '\r' || c == '\n')
            continue;
        if ((c & 0xc0) != 0x80) {
            if (cps == 100)
                break;
            cps++;
        }
        if (n + 1 >= out_size)
            return VDON_ERR_TOO_SMALL;
        out[n++] = (char)c;
    }
    out[n] = 0;
    if (!trim_bounds(out, &s, &e)) {
        out[0] = 0;
        return VDON_OK;
    }
    memmove(out, out + s, e - s);
    out[e - s] = 0;
    return VDON_OK;
}

int vdon_encode_uri_component(const char *in, char *out, size_t out_size) {
    static const char *H = "0123456789ABCDEF";
    size_t n = 0, i, len;
    if (!out || out_size < 1)
        return VDON_ERR_TOO_SMALL;
    out[0] = 0;
    if (!in)
        return VDON_OK;
    len = strlen(in);
    for (i = 0; i < len; i++) {
        unsigned char c = (unsigned char)in[i];
        if (isalnum(c) || strchr("-_.!~*'()", c)) {
            if (n + 1 >= out_size)
                return VDON_ERR_TOO_SMALL;
            out[n++] = (char)c;
        } else {
            if (n + 3 >= out_size)
                return VDON_ERR_TOO_SMALL;
            out[n++] = '%';
            out[n++] = H[c >> 4];
            out[n++] = H[c & 15];
        }
    }
    out[n] = 0;
    return VDON_OK;
}

int vdon_sanitize_password(const char *in, char *out, size_t out_size) {
    size_t s, e;
    char trimmed[1024];
    if (!out || out_size < 1)
        return VDON_ERR_TOO_SMALL;
    out[0] = 0;
    if (!in || !trim_bounds(in, &s, &e))
        return VDON_OK;
    if (e - s >= sizeof(trimmed))
        return VDON_ERR_TOO_SMALL;
    memcpy(trimmed, in + s, e - s);
    trimmed[e - s] = 0;
    return vdon_encode_uri_component(trimmed, out, out_size);
}
