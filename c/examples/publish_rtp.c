/*
 * Publishes RTP received on a local UDP port to VDO.Ninja viewers.
 *
 * Point any encoder at the UDP port, e.g. with GStreamer (H.264, PT 96, SSRC 1234):
 *
 *   gst-launch-1.0 videotestsrc is-live=true ! x264enc tune=zerolatency key-int-max=30 \
 *     ! rtph264pay pt=96 ssrc=1234 config-interval=1 ! udpsink host=127.0.0.1 port=5004
 *
 * or with ffmpeg (VP8):
 *
 *   ffmpeg -re -f lavfi -i testsrc=size=640x360:rate=30 -c:v libvpx -deadline realtime \
 *     -f rtp -payload_type 96 -ssrc 1234 rtp://127.0.0.1:5004
 *
 * then open https://vdo.ninja/?view=STREAMID&password=PASSWORD in a browser.
 *
 *   vdon_publish_rtp --stream mystream [--codec h264|vp8|vp9|h265|av1] [--pt 96] [--ssrc 1234]
 *                    [--port 5004] [--audio-port 5006] [--password pw] [--room r] [--host ws://...]
 *
 * Keyframe requests from viewers are printed; wire them to your encoder.
 *
 * Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MIT
 */
#include <vdoninja.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static void on_event(vdon_sdk *sdk, const vdon_event *ev, void *user) {
    (void)sdk;
    (void)user;
    switch (ev->type) {
    case VDON_EVENT_CONNECTED: printf("* connected\n"); break;
    case VDON_EVENT_PUBLISHING: printf("* publishing %s\n", ev->stream_id); break;
    case VDON_EVENT_PEER_CONNECTED: printf("* viewer %s connected\n", ev->uuid); break;
    case VDON_EVENT_PEER_DISCONNECTED: printf("* viewer %s disconnected\n", ev->uuid); break;
    case VDON_EVENT_KEYFRAME_REQUEST: printf("* keyframe requested by %s (%s)\n", ev->uuid, ev->label); break;
    case VDON_EVENT_PEER_INFO: printf("* viewer %s info %s\n", ev->uuid, ev->json); break;
    case VDON_EVENT_DATA_RECEIVED: printf("* data from %s: %s\n", ev->uuid, ev->json); break;
    case VDON_EVENT_ERROR:
    case VDON_EVENT_ALERT: printf("* %s: %s\n", vdon_event_name(ev->type), ev->message ? ev->message : ""); break;
    default: break;
    }
}

static int udp_listen(int port) {
    struct sockaddr_in addr;
    int fd = socket(AF_INET, SOCK_DGRAM, 0), one = 1;
    if (fd < 0)
        return -1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons((uint16_t)port);
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

int main(int argc, char **argv) {
    vdon_options o;
    vdon_sdk *sdk;
    vdon_track_init tracks[2];
    const char *stream = "cstream", *room = NULL, *codec = "h264";
    int pt = 96, port = 5004, audio_port = 0, i, rc, vfd, afd = -1, ntracks = 1;
    uint32_t ssrc = 1234;
    char sid[64];
    struct pollfd pfd[2];
    vdon_options_init(&o);
    for (i = 1; i + 1 < argc; i += 2) {
        if (!strcmp(argv[i], "--stream"))
            stream = argv[i + 1];
        else if (!strcmp(argv[i], "--codec"))
            codec = argv[i + 1];
        else if (!strcmp(argv[i], "--pt"))
            pt = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--ssrc"))
            ssrc = (uint32_t)strtoul(argv[i + 1], NULL, 0);
        else if (!strcmp(argv[i], "--port"))
            port = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--audio-port"))
            audio_port = atoi(argv[i + 1]);
        else if (!strcmp(argv[i], "--password"))
            o.password = argv[i + 1];
        else if (!strcmp(argv[i], "--room"))
            room = argv[i + 1];
        else if (!strcmp(argv[i], "--host"))
            o.host = argv[i + 1];
        else if (!strcmp(argv[i], "--debug"))
            o.debug = atoi(argv[i + 1]);
    }
    vdon_track_init_defaults(&tracks[0], VDON_MEDIA_VIDEO,
                             !strcmp(codec, "vp8")    ? VDON_CODEC_VP8
                             : !strcmp(codec, "vp9")  ? VDON_CODEC_VP9
                             : !strcmp(codec, "h265") ? VDON_CODEC_H265
                             : !strcmp(codec, "av1")  ? VDON_CODEC_AV1
                                                      : VDON_CODEC_H264);
    tracks[0].payload_type = pt;
    tracks[0].ssrc = ssrc;
    if (audio_port) {
        vdon_track_init_defaults(&tracks[1], VDON_MEDIA_AUDIO, VDON_CODEC_OPUS);
        tracks[1].ssrc = ssrc + 1;
        ntracks = 2;
    }
    vfd = udp_listen(port);
    if (vfd < 0) {
        perror("bind video port");
        return 1;
    }
    if (audio_port && (afd = udp_listen(audio_port)) < 0) {
        perror("bind audio port");
        return 1;
    }
    sdk = vdon_create(&o, on_event, NULL);
    if ((rc = vdon_connect(sdk, 10000)) != VDON_OK || (rc = vdon_publish(sdk, stream, room, tracks, ntracks, sid, sizeof(sid))) != VDON_OK) {
        fprintf(stderr, "failed: %s\n", vdon_strerror(rc));
        vdon_destroy(sdk);
        return 1;
    }
    printf("* view at https://vdo.ninja/?view=%s%s%s (audio SSRC must be %u)\n", sid, o.password ? "&password=" : "",
           o.password ? o.password : "", ssrc + 1);
    pfd[0].fd = vfd;
    pfd[0].events = POLLIN;
    pfd[1].fd = afd;
    pfd[1].events = POLLIN;
    for (;;) {
        uint8_t buf[2048];
        ssize_t n;
        if (poll(pfd, afd >= 0 ? 2 : 1, 1000) <= 0)
            continue;
        if (pfd[0].revents & POLLIN) {
            n = recv(vfd, buf, sizeof(buf), 0);
            if (n > 12)
                vdon_send_rtp(sdk, VDON_MEDIA_VIDEO, buf, (size_t)n);
        }
        if (afd >= 0 && (pfd[1].revents & POLLIN)) {
            n = recv(afd, buf, sizeof(buf), 0);
            if (n > 12)
                vdon_send_rtp(sdk, VDON_MEDIA_AUDIO, buf, (size_t)n);
        }
    }
}
