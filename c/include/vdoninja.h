/*
 * VDO.Ninja SDK for C
 * Copyright (c) 2025-2026 Steve Seguin
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * WebRTC engine: libdatachannel (MPL-2.0). JSON: cJSON (MIT, vendored).
 *
 * Hosted-service notice: use of signaling, TURN and related services operated
 * by Steve Seguin is subject to the applicable Terms of Service and
 * operational policies. This SDK is the supported way to use them; only
 * WebRTC handshake data may pass through the signaling server.
 */
#ifndef VDONINJA_H
#define VDONINJA_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32) && defined(VDON_SHARED)
#  ifdef VDON_BUILDING
#    define VDON_API __declspec(dllexport)
#  else
#    define VDON_API __declspec(dllimport)
#  endif
#else
#  define VDON_API
#endif

#define VDON_VERSION "0.1.0"

/* Defaults shared with the other SDKs. */
#define VDON_DEFAULT_HOST "wss://wss.vdo.ninja"
#define VDON_DEFAULT_PASSWORD "someEncryptionKey123"
#define VDON_DEFAULT_SALT "vdo.ninja"
#define VDON_CONTROL_CHANNEL "sendChannel"
#define VDON_BINARY_CHANNEL "x-bin"
#define VDON_FILE_CHUNK_SIZE 16384

/* Return codes. */
#define VDON_OK 0
#define VDON_ERR_INVALID -1        /* invalid argument */
#define VDON_ERR_FAILURE -2        /* runtime/engine failure */
#define VDON_ERR_NOT_CONNECTED -3  /* signaling socket not open */
#define VDON_ERR_TIMEOUT -4
#define VDON_ERR_PENDING -5        /* stream not available yet; the view request stays pending */
#define VDON_ERR_NO_CHANNEL -6     /* no open data channel to that peer */
#define VDON_ERR_NOT_FOUND -7
#define VDON_ERR_REMOTE -8         /* peer returned an error (request/response) */
#define VDON_ERR_CANCELLED -9      /* cancelled by disconnect */
#define VDON_ERR_TOO_SMALL -10     /* output buffer too small */
#define VDON_ERR_UNSUPPORTED -11

typedef struct vdon_sdk vdon_sdk;

typedef enum vdon_turn_mode {
    VDON_TURN_AUTO = 0,     /* hosted list (built-in fallback), closest 2 UDP + 1 TCP */
    VDON_TURN_DISABLED = 1, /* STUN only */
    VDON_TURN_CUSTOM = 2    /* use vdon_options.turn_servers verbatim */
} vdon_turn_mode;

/*
 * Options. Call vdon_options_init() first, then override fields. Strings are
 * copied by vdon_create().
 */
typedef struct vdon_options {
    const char *host;          /* signaling URL, default wss://wss.vdo.ninja */
    const char *room;          /* default room for vdon_join_room(NULL) */
    const char *password;      /* original password text; NULL = shared default */
    int no_password;           /* 1 disables hashing/encryption (JS password:false) */
    const char *salt;          /* default "vdo.ninja" */
    const char *label;         /* publisher label sent to viewers */
    const char *meta_json;     /* publisher meta as a JSON object string (optional) */
    vdon_turn_mode turn_mode;
    const char **turn_servers; /* libdatachannel URLs: "turn:user:pass@host:3478" */
    int turn_server_count;
    int force_turn;            /* relay-only ICE */
    int force_tcp;             /* skip UDP TURN servers from the hosted list */
    const char **stun_servers; /* NULL = defaults (Google + Cloudflare); count 0 with non-NULL = none */
    int stun_server_count;
    const char *bind_address;  /* local bind address for ICE, NULL = any */
    int max_reconnect_attempts;/* default 5 */
    int reconnect_delay_ms;    /* default 1000 (doubles, capped at 30s) */
    int connection_timeout_ms; /* default 20000 */
    int view_retry_interval_ms;/* default 900000 */
    int auto_ping_viewer;      /* viewer-side keepalive pings */
    int auto_ping_interval_ms; /* default 10000 */
    const char *client_id;     /* adds a "from" field (legacy fan-out servers only) */
    int debug;                 /* log to stderr */
} vdon_options;

VDON_API void vdon_options_init(vdon_options *opts);

typedef enum vdon_event_type {
    VDON_EVENT_CONNECTED = 1,
    VDON_EVENT_DISCONNECTED,
    VDON_EVENT_RECONNECTING,
    VDON_EVENT_RECONNECTED,
    VDON_EVENT_RECONNECT_FAILED,
    VDON_EVENT_ROOM_JOINED,
    VDON_EVENT_ROOM_LEFT,
    VDON_EVENT_LISTING,            /* json: array of {streamID, UUID, label, director} */
    VDON_EVENT_VIDEO_ADDED_TO_ROOM,/* stream_id, uuid */
    VDON_EVENT_SOMEONE_JOINED,     /* json: raw message */
    VDON_EVENT_PUBLISHING,         /* stream_id; flag = data only */
    VDON_EVENT_PUBLISHING_STOPPED,
    VDON_EVENT_VIEWING_STOPPED,
    VDON_EVENT_PEER_CONNECTED,     /* uuid, stream_id, connection_type */
    VDON_EVENT_PEER_DISCONNECTED,
    VDON_EVENT_CONNECTION_FAILED,
    VDON_EVENT_DATA_CHANNEL_OPEN,  /* uuid, connection_type */
    VDON_EVENT_DATA_CHANNEL_CLOSE,
    VDON_EVENT_DATA_RECEIVED,      /* uuid, json = application payload; flag = via fallback */
    VDON_EVENT_PEER_INFO,          /* uuid, json = merged remote info */
    VDON_EVENT_PEER_LATENCY,       /* uuid, number = latency ms */
    VDON_EVENT_REMOTE_VIDEO_MUTE,  /* uuid, flag = muted */
    VDON_EVENT_OBS_STATE,          /* uuid, json = merged OBS state */
    VDON_EVENT_TRACK,              /* uuid, track = libdatachannel track id, label = "audio"/"video", message = media SDP */
    VDON_EVENT_RTP,                /* track, bytes/size = one RTP packet */
    VDON_EVENT_KEYFRAME_REQUEST,   /* uuid, track: a viewer sent PLI; send a keyframe */
    VDON_EVENT_CHANNEL_MESSAGE,    /* uuid, label = channel, json = data */
    VDON_EVENT_PEER_SUBSCRIBED,    /* uuid, json = channels array */
    VDON_EVENT_PEER_UNSUBSCRIBED,
    VDON_EVENT_CHANNEL_OPEN,       /* uuid, label, channel = libdatachannel dc id (reserved x- channel) */
    VDON_EVENT_BINARY_RECEIVED,    /* uuid, bytes/size */
    VDON_EVENT_FILE_LIST,          /* uuid, json = [{id,name,size}] */
    VDON_EVENT_FILE_TRANSFER_START,/* uuid, file_* fields, direction */
    VDON_EVENT_FILE_TRANSFER_PROGRESS,
    VDON_EVENT_FILE_CHUNK,         /* bytes/size (streaming downloads) */
    VDON_EVENT_FILE_TRANSFER_COMPLETE,
    VDON_EVENT_FILE_TRANSFER_CANCELLED,
    VDON_EVENT_FILE_TRANSFER_ERROR,/* message */
    VDON_EVENT_RESOURCE_RECEIVED,  /* uuid, label = templateName, json = metadata, bytes */
    VDON_EVENT_UNSUPPORTED_CHANNEL,/* uuid, label */
    VDON_EVENT_BYE,                /* uuid */
    VDON_EVENT_HANGUP,
    VDON_EVENT_ALERT,              /* message */
    VDON_EVENT_ERROR               /* message */
} vdon_event_type;

/*
 * Event payload. Pointers are valid only during the callback; copy what you
 * keep. Only the fields relevant to the event type are set.
 */
typedef struct vdon_event {
    vdon_event_type type;
    const char *uuid;
    const char *stream_id;
    const char *connection_type; /* "publisher" or "viewer" */
    const char *json;            /* JSON text (payload, info, listing, ...) */
    const char *message;
    const char *label;           /* channel label / pub-sub channel / track kind */
    const uint8_t *bytes;
    size_t size;
    int64_t number;              /* latency ms, reconnect attempt, ... */
    int flag;                    /* muted / intentional / data_only / fallback / requested */
    int track;                   /* libdatachannel track id */
    int channel;                 /* libdatachannel data channel id */
    const char *file_id;
    const char *file_name;
    int64_t file_size;
    int64_t file_bytes;
    const char *direction;       /* "inbound" or "outbound" */
} vdon_event;

/*
 * Events are delivered on libdatachannel's threads. The SDK lock is not held
 * during the callback, so SDK functions may be called from it; avoid blocking
 * for long and copy data you keep.
 */
typedef void (*vdon_event_callback)(vdon_sdk *sdk, const vdon_event *ev, void *user);

VDON_API const char *vdon_event_name(vdon_event_type type);
VDON_API const char *vdon_strerror(int code);

/* ------------------------------------------------------------------ lifecycle */

VDON_API vdon_sdk *vdon_create(const vdon_options *opts, vdon_event_callback cb, void *user);
VDON_API void vdon_destroy(vdon_sdk *sdk);
VDON_API const char *vdon_version(void);

/* Opens the signaling socket; waits up to timeout_ms (0 = return immediately). */
VDON_API int vdon_connect(vdon_sdk *sdk, int timeout_ms);
/* Sends bye to peers, closes connections and the socket; emits DISCONNECTED once. */
VDON_API void vdon_disconnect(vdon_sdk *sdk);
VDON_API int vdon_is_connected(vdon_sdk *sdk);

/* ---------------------------------------------------------------------- rooms */

/* Joins a room (hashed with password and salt). password NULL keeps the current one. */
VDON_API int vdon_join_room(vdon_sdk *sdk, const char *room, const char *password, int claim, int timeout_ms);
VDON_API void vdon_leave_room(vdon_sdk *sdk);
/* Copies the joined room into out (empty string if none). */
VDON_API int vdon_room(vdon_sdk *sdk, char *out, size_t out_size);

/* ----------------------------------------------------------------- publishing */

typedef enum vdon_media_kind { VDON_MEDIA_AUDIO = 1, VDON_MEDIA_VIDEO = 2 } vdon_media_kind;

typedef enum vdon_codec {
    VDON_CODEC_H264 = 0,
    VDON_CODEC_VP8 = 1,
    VDON_CODEC_VP9 = 2,
    VDON_CODEC_H265 = 3,
    VDON_CODEC_AV1 = 4,
    VDON_CODEC_OPUS = 128,
    VDON_CODEC_PCMU = 129,
    VDON_CODEC_PCMA = 130,
    VDON_CODEC_AAC = 131,
    VDON_CODEC_G722 = 132
} vdon_codec;

/*
 * A track to publish. With packetize=0 the application sends complete RTP
 * packets (vdon_send_rtp) whose SSRC/payload type match these values. With
 * packetize=1 the application sends encoded frames (vdon_send_sample) and
 * libdatachannel packetizes them (H264/H265/AV1/Opus/PCMU/PCMA/G722).
 */
typedef struct vdon_track_init {
    vdon_media_kind kind;
    vdon_codec codec;
    int payload_type;       /* e.g. 96 video, 111 opus */
    uint32_t ssrc;          /* 0 = random */
    const char *mid;        /* NULL = "0"/"1" */
    int packetize;
    int clock_rate;         /* 0 = codec default (90000 video, 48000 opus, 8000 g711) */
    int nal_separator;      /* H264/H265 with packetize: 0 length-prefixed, 1 long start code, 2 short, 3 either */
} vdon_track_init;

VDON_API void vdon_track_init_defaults(vdon_track_init *init, vdon_media_kind kind, vdon_codec codec);

/* Registers a data-only stream. stream_id NULL = generated; room NULL = none. */
VDON_API int vdon_announce(vdon_sdk *sdk, const char *stream_id, const char *room, char *out_stream_id, size_t out_size);
/* Registers a media stream; each viewer connection gets its own tracks. */
VDON_API int vdon_publish(vdon_sdk *sdk, const char *stream_id, const char *room, const vdon_track_init *tracks, int track_count,
                          char *out_stream_id, size_t out_size);
/* Sends one complete RTP packet to every viewer for that media kind (packetize=0 tracks). */
VDON_API int vdon_send_rtp(vdon_sdk *sdk, vdon_media_kind kind, const uint8_t *packet, size_t size);
/* Sends one encoded frame/sample to every viewer for that media kind (packetize=1 tracks). */
VDON_API int vdon_send_sample(vdon_sdk *sdk, vdon_media_kind kind, const uint8_t *data, size_t size, uint32_t duration_us);
VDON_API int vdon_stop_publishing(vdon_sdk *sdk);
VDON_API int vdon_stream_id(vdon_sdk *sdk, char *out, size_t out_size);

/* -------------------------------------------------------------------- viewing */

typedef struct vdon_view_options {
    int audio;           /* default 1 */
    int video;           /* default 1 */
    const char *label;
    int downloads;       /* default 1: accept file offers */
    int allow_resources; /* default 0 */
} vdon_view_options;

VDON_API void vdon_view_options_init(vdon_view_options *opts);

/*
 * Requests a stream and waits for the publisher's offer up to timeout_ms.
 * Returns VDON_OK when the viewer connection exists, or VDON_ERR_PENDING when
 * the publisher is not there yet (the request stays pending and connects
 * automatically when the stream appears).
 */
VDON_API int vdon_view(vdon_sdk *sdk, const char *stream_id, const vdon_view_options *opts, int timeout_ms);
VDON_API int vdon_stop_viewing(vdon_sdk *sdk, const char *stream_id);
/* Asks the publisher of a received track for a keyframe (sends PLI). */
VDON_API int vdon_request_keyframe(vdon_sdk *sdk, int track);

/* Peers: JSON array of UUIDs (free with vdon_free). */
VDON_API int vdon_peers_json(vdon_sdk *sdk, char **out_json);
/* Streams seen so far: JSON array of {streamID, uuid, state} (free with vdon_free). */
VDON_API int vdon_streams_json(vdon_sdk *sdk, char **out_json);
/* libdatachannel peer connection id for a peer ("publisher"/"viewer"), or VDON_ERR_NOT_FOUND. */
VDON_API int vdon_peer_connection(vdon_sdk *sdk, const char *uuid, const char *connection_type);

/* ----------------------------------------------------------------------- data */

/* Sends application data (any JSON text) wrapped in {"pipe": ...}; uuid NULL = all peers. */
VDON_API int vdon_send_data(vdon_sdk *sdk, const char *json, const char *uuid);

typedef struct vdon_data_target {
    const char *uuid;
    const char *connection_type; /* "publisher" | "viewer" | NULL */
    const char *stream_id;
    const char *preference;      /* "any" (default) | "publisher" | "viewer" | "all" */
    int allow_fallback;          /* relay through signaling when no channel is open (off) */
} vdon_data_target;

VDON_API int vdon_send_data_ex(vdon_sdk *sdk, const char *json, const vdon_data_target *target);
/* Ping on the control channel; the reply emits VDON_EVENT_PEER_LATENCY. uuid NULL = all. */
VDON_API int vdon_send_ping(vdon_sdk *sdk, const char *uuid);

/* Pub/sub */
VDON_API int vdon_subscribe(vdon_sdk *sdk, const char *channel);
VDON_API int vdon_unsubscribe(vdon_sdk *sdk, const char *channel);
VDON_API int vdon_publish_to_channel(vdon_sdk *sdk, const char *channel, const char *json, const char *uuid);

/*
 * Request/response. The handler returns a malloc'd JSON reply (freed by the
 * SDK) or NULL to send an error.
 */
typedef char *(*vdon_request_handler)(vdon_sdk *sdk, const char *request_json, const char *from_uuid, void *user);
VDON_API int vdon_on_request(vdon_sdk *sdk, const char *request_type, vdon_request_handler handler, void *user);
/* Blocks until the response arrives; *out_json is malloc'd (vdon_free). */
VDON_API int vdon_request(vdon_sdk *sdk, const char *request_type, const char *json, const char *uuid, int timeout_ms, char **out_json);
VDON_API int vdon_respond(vdon_sdk *sdk, const char *request_id, const char *json, const char *uuid);

/* Binary on the reserved x-bin lane (never the control channel). */
VDON_API int vdon_send_binary(vdon_sdk *sdk, const char *uuid, const uint8_t *data, size_t size);
/* Opens (or returns) a reserved x- channel; returns the libdatachannel dc id (>= 0). */
VDON_API int vdon_open_channel(vdon_sdk *sdk, const char *uuid, const char *label, int timeout_ms);

/* Native file transfer */
VDON_API int vdon_host_file(vdon_sdk *sdk, const char *name, const uint8_t *data, size_t size, const char *restricted_uuid,
                            char *out_id, size_t out_size);
VDON_API int vdon_unhost_file(vdon_sdk *sdk, const char *file_id);
/* Downloads an advertised file; *out_data is malloc'd (vdon_free). */
VDON_API int vdon_request_file(vdon_sdk *sdk, const char *uuid, const char *file_id, int timeout_ms, uint8_t **out_data, size_t *out_size);

/* Connect, join, announce and view peers in the room as they appear ("half" mesh by default). */
VDON_API int vdon_auto_connect(vdon_sdk *sdk, const char *room, const char *stream_id, int full_mode, int timeout_ms,
                               char *out_stream_id, size_t out_size);
VDON_API void vdon_auto_connect_stop(vdon_sdk *sdk);

VDON_API void vdon_free(void *ptr);

/* ----------------------------------------------------------- protocol helpers */

/* Hex SHA-256 truncated to `length` hex chars (0 = full). out needs 65 bytes. */
VDON_API void vdon_generate_hash(const char *input, int length, char *out);
VDON_API int vdon_sanitize_stream_id(const char *in, char *out, size_t out_size);
VDON_API int vdon_sanitize_room(const char *in, char *out, size_t out_size);
VDON_API int vdon_sanitize_label(const char *in, char *out, size_t out_size);
VDON_API int vdon_sanitize_password(const char *in, char *out, size_t out_size);
VDON_API int vdon_encode_uri_component(const char *in, char *out, size_t out_size);
/* AES-256-CBC with key SHA-256(phrase); outputs are malloc'd hex strings (vdon_free). */
VDON_API int vdon_encrypt_message(const char *plaintext, const char *phrase, char **out_hex, char **out_iv_hex);
VDON_API int vdon_decrypt_message(const char *cipher_hex, const char *iv_hex, const char *phrase, char **out_plaintext);

/* --------------------------------------------------------- local signaling */

/* A small VDO.Ninja-compatible signaling server (routed "wss2" protocol) for LAN, offline and test use. */
typedef struct vdon_signal_server vdon_signal_server;
VDON_API vdon_signal_server *vdon_signal_server_create(uint16_t port); /* 0 = automatic */
VDON_API int vdon_signal_server_port(vdon_signal_server *server);
VDON_API void vdon_signal_server_destroy(vdon_signal_server *server);

#ifdef __cplusplus
}
#endif
#endif /* VDONINJA_H */
