/*
 * Views a VDO.Ninja stream and forwards its RTP packets to local UDP ports,
 * where any RTP-capable tool can decode them. The received SDP media
 * descriptions are printed so you know the payload types in use.
 *
 *   vdon_view_rtp --stream STREAMID [--password pw] [--room r] [--video-port 5004] [--audio-port 5006] [--host ws://...]
 *
 * Play back with, for example:
 *
 *   gst-launch-1.0 udpsrc port=5004 caps="application/x-rtp,media=video,encoding-name=VP8,payload=96" \
 *     ! rtpvp8depay ! vp8dec ! autovideosink
 *
 * Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MIT
 */
#include <vdoninja.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

typedef struct ctx {
    int fd;
    struct sockaddr_in video, audio;
    int video_track, audio_track;
    unsigned long packets;
} ctx;

static void on_event(vdon_sdk *sdk, const vdon_event *ev, void *user) {
    ctx *c = (ctx *)user;
    switch (ev->type) {
    case VDON_EVENT_CONNECTED: printf("* connected\n"); break;
    case VDON_EVENT_PEER_CONNECTED: printf("* publisher %s connected\n", ev->uuid); break;
    case VDON_EVENT_PEER_INFO: printf("* publisher info %s\n", ev->json); break;
    case VDON_EVENT_TRACK:
        printf("* %s track %d:\n%s\n", ev->label, ev->track, ev->message ? ev->message : "");
        if (!strcmp(ev->label, "video"))
            c->video_track = ev->track;
        else
            c->audio_track = ev->track;
        break;
    case VDON_EVENT_RTP: {
        const struct sockaddr_in *to = !strcmp(ev->label, "video") ? &c->video : &c->audio;
        if (to->sin_port)
            sendto(c->fd, ev->bytes, ev->size, 0, (const struct sockaddr *)to, sizeof(*to));
        if (++c->packets % 500 == 0)
            printf("* %lu RTP packets forwarded\n", c->packets);
        break;
    }
    case VDON_EVENT_PEER_DISCONNECTED: printf("* publisher %s disconnected (will retry)\n", ev->uuid); break;
    case VDON_EVENT_DATA_RECEIVED: printf("* data: %s\n", ev->json); break;
    case VDON_EVENT_ERROR:
    case VDON_EVENT_ALERT: printf("* %s: %s\n", vdon_event_name(ev->type), ev->message ? ev->message : ""); break;
    default: break;
    }
    (void)sdk;
}

int main(int argc, char **argv) {
    vdon_options o;
    vdon_sdk *sdk;
    ctx c;
    const char *stream = NULL, *room = NULL;
    int vport = 5004, aport = 5006, i, rc;
    vdon_options_init(&o);
    memset(&c, 0, sizeof(c));
    c.video_track = c.audio_track = -1;
    for (i = 1; i + 1 < argc; i += 2) {
        if (!strcmp(argv[i], "--stream"))
            stream = argv[i + 1];
        else if (!strcmp(argv[i], "--password"))
            o.password = argv[i + 1];
        else if (!strcmp(argv[i], "--room"))
            room = argv[i + 1];
        else if (!strcmp(argv[i], "--video-port"))
            vport = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--audio-port"))
            aport = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--host"))
            o.host = argv[i + 1];
        else if (!strcmp(argv[i], "--debug"))
            o.debug = atoi(argv[i + 1]);
    }
    if (!stream) {
        fprintf(stderr, "usage: vdon_view_rtp --stream STREAMID [--password pw] [--room r]\n");
        return 2;
    }
    c.fd = socket(AF_INET, SOCK_DGRAM, 0);
    c.video.sin_family = c.audio.sin_family = AF_INET;
    c.video.sin_addr.s_addr = c.audio.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    c.video.sin_port = htons((uint16_t)vport);
    c.audio.sin_port = htons((uint16_t)aport);
    sdk = vdon_create(&o, on_event, &c);
    if ((rc = vdon_connect(sdk, 10000)) != VDON_OK) {
        fprintf(stderr, "connect failed: %s\n", vdon_strerror(rc));
        return 1;
    }
    if (room && (rc = vdon_join_room(sdk, room, NULL, 0, 10000)) != VDON_OK)
        fprintf(stderr, "join room: %s\n", vdon_strerror(rc));
    rc = vdon_view(sdk, stream, NULL, 15000);
    printf("* view: %s\n", vdon_strerror(rc));
    for (;;) {
        sleep(5);
        if (c.video_track >= 0 && c.packets == 0)
            vdon_request_keyframe(sdk, c.video_track);
    }
}
