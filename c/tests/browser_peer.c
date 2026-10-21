/* Test-only RTP/application-data peer for tests/interop/native-av-live.cjs. */
#include <vdoninja.h>
#include <arpa/inet.h>
#include <poll.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

static volatile sig_atomic_t stopping;
static atomic_int video_track = -1, video_pt = 96, red_pt = -1;
static int output_fd;
static struct sockaddr_in output[2];
static void stop(int sig) { (void)sig; stopping = 1; }
static void event(vdon_sdk *sdk, const vdon_event *ev, void *user) {
    static unsigned counts[2];
    (void)user;
    if (ev->type == VDON_EVENT_DATA_RECEIVED) vdon_send_data(sdk, ev->json, ev->uuid);
    if (ev->type == VDON_EVENT_TRACK && !strcmp(ev->label, "video")) {
        video_track = ev->track;
        const char *line = ev->message;
        while (line && (line = strstr(line, "a=rtpmap:"))) {
            int pt; char codec[32];
            if (sscanf(line, "a=rtpmap:%d %31s", &pt, codec) == 2) {
                if (!strcmp(codec, "VP8/90000")) video_pt = pt;
                if (!strcmp(codec, "red/90000")) red_pt = pt;
            }
            line++;
        }
        printf("CODEC video PT=%d\n", (int)video_pt);
    }
    if (ev->type == VDON_EVENT_RTP) {
        int video = !strcmp(ev->label, "video");
        const unsigned char *packet = ev->bytes;
        size_t size = ev->size;
        unsigned char decoded[65536];
        if (size < 12 || size > sizeof(decoded)) return;
        if (video && (packet[1] & 127) == red_pt) {
            // The C SDK exposes RTP unchanged. The test's FFmpeg bridge unwraps
            // RFC 2198 RED; FFmpeg's VP8 RTP input does not accept RED directly.
            size_t header = 12 + (packet[0] & 15) * 4;
            if (header > size) return;
            if (packet[0] & 16) {
                if (header + 4 > size) return;
                header += 4 + 4 * ((packet[header+2] << 8) | packet[header+3]);
            }
            size_t cursor = header, redundant = 0;
            while (cursor < size && (packet[cursor] & 128)) {
                if (cursor + 4 > size) return;
                redundant += ((packet[cursor+2] & 3) << 8) | packet[cursor+3];
                cursor += 4;
            }
            if (cursor >= size || (packet[cursor] & 127) != video_pt) return;
            size_t payload = cursor + 1 + redundant;
            if (payload >= size) return;
            memcpy(decoded, packet, header);
            memcpy(decoded + header, packet + payload, size - payload);
            decoded[1] = (packet[1] & 128) | video_pt;
            size = header + size - payload; packet = decoded;
        }
        // Retransmissions/FEC are unnecessary for this lossless loopback decoder.
        if (video && (packet[1] & 127) != video_pt) return;
        if (!video && counts[video] == 0) printf("CODEC audio PT=%u\n", packet[1] & 127);
        sendto(output_fd, packet, size, 0, (struct sockaddr *)&output[video], sizeof(output[video]));
        if (++counts[video] == 100) printf("RX %s 100\n", video ? "video" : "audio");
    }
    if (ev->type == VDON_EVENT_ERROR) fprintf(stderr, "ERROR %s\n", ev->message ? ev->message : "unknown");
}
static int udp(int *port) {
    struct sockaddr_in a = {0}; socklen_t n = sizeof(a);
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (fd < 0 || bind(fd, (struct sockaddr *)&a, sizeof(a)) < 0) exit(2);
    getsockname(fd, (struct sockaddr *)&a, &n); *port = ntohs(a.sin_port); return fd;
}
int main(void) {
    vdon_options o; vdon_track_init tracks[2]; vdon_view_options view;
    int ports[2], rc, tick = 0; struct pollfd inputs[2]; char sid[128];
    setbuf(stdout, NULL); signal(SIGINT, stop); signal(SIGTERM, stop);
    for (int i = 0; i < 2; i++) { inputs[i].fd = udp(&ports[i]); inputs[i].events = POLLIN; }
    output_fd = socket(AF_INET, SOCK_DGRAM, 0);
    for (int i = 0; i < 2; i++) {
        output[i].sin_family = AF_INET; output[i].sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        output[i].sin_port = htons(atoi(getenv(i ? "VDO_RX_VIDEO" : "VDO_RX_AUDIO")));
    }
    vdon_options_init(&o); o.host = getenv("VDO_HOST"); o.password = getenv("VDO_PASSWORD"); o.salt = getenv("VDO_SALT");
    vdon_track_init_defaults(&tracks[0], VDON_MEDIA_VIDEO, VDON_CODEC_VP8);
    vdon_track_init_defaults(&tracks[1], VDON_MEDIA_AUDIO, VDON_CODEC_OPUS);
    tracks[0].payload_type = 96; tracks[0].ssrc = 1234; tracks[0].mid = "video"; tracks[0].packetize = 0;
    tracks[1].payload_type = 111; tracks[1].ssrc = 1235; tracks[1].mid = "audio"; tracks[1].packetize = 0;
    vdon_sdk *sdk = vdon_create(&o, event, NULL);
    if (!sdk || vdon_connect(sdk, 15000) != VDON_OK) return 2;
    rc = vdon_publish(sdk, getenv("VDO_PUBLISH"), getenv("VDO_ROOM"), tracks, 2, sid, sizeof(sid));
    if (rc != VDON_OK) { fprintf(stderr, "%s\n", vdon_strerror(rc)); return 2; }
    printf("UDP video=%d audio=%d\nREADY\n", ports[1], ports[0]);
    vdon_view_options_init(&view); view.downloads = 0;
    rc = vdon_view(sdk, getenv("VDO_VIEW"), &view, 3000);
    if (rc != VDON_OK && rc != VDON_ERR_PENDING) return 2;
    while (!stopping) {
        if (poll(inputs, 2, 50) > 0) for (int i = 0; i < 2; i++) if (inputs[i].revents & POLLIN) {
            unsigned char packet[2048]; ssize_t n = recv(inputs[i].fd, packet, sizeof(packet), 0);
            if (n > 12) vdon_send_rtp(sdk, i ? VDON_MEDIA_VIDEO : VDON_MEDIA_AUDIO, packet, n);
        }
        if (++tick % 100 == 0 && video_track >= 0) vdon_request_keyframe(sdk, video_track);
    }
    vdon_disconnect(sdk); vdon_destroy(sdk);
    close(inputs[0].fd); close(inputs[1].fd); close(output_fd);
    puts("STOPPED"); return 0;
}
