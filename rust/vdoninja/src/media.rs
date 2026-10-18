// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

//! Helpers for building local media tracks for webrtc-rs.
//!
//! `webrtc-rs` tracks carry their codec and SSRC. [`SampleTrack`] wraps a
//! `TrackLocalStaticSample` with the payload type the SDK's default media
//! engine negotiates for that codec, so encoded frames can be written with one
//! call.

use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use rtc::media::Sample;
use rtc::peer_connection::configuration::media_engine::{
    MIME_TYPE_AV1, MIME_TYPE_H264, MIME_TYPE_OPUS, MIME_TYPE_VP8, MIME_TYPE_VP9,
};
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind,
};
use rtc::rtp_transceiver::SSRC;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::MediaStreamTrack;

use crate::{Error, Result};

/// A sample-based local track plus the metadata needed to write to it.
#[derive(Clone)]
pub struct SampleTrack {
    pub track: Arc<TrackLocalStaticSample>,
    pub ssrc: SSRC,
    pub payload_type: u8,
    pub kind: RtpCodecKind,
}

/// Default payload types registered by `MediaEngine::register_default_codecs`.
pub fn default_payload_type(mime: &str) -> Option<u8> {
    let m = mime.to_ascii_lowercase();
    match m.as_str() {
        "audio/opus" => Some(111),
        "video/vp8" => Some(96),
        "video/vp9" => Some(98),
        "video/h264" => Some(102),
        "video/av1" => Some(45),
        _ => None,
    }
}

impl SampleTrack {
    /// Creates a track for an encoded codec: `video/VP8`, `video/VP9`,
    /// `video/H264`, `video/AV1` or `audio/opus`.
    pub fn new(mime: &str, stream_id: &str, track_id: &str) -> Result<Self> {
        let mime_lower = mime.to_ascii_lowercase();
        let (kind, clock_rate, channels, canonical) = match mime_lower.as_str() {
            "audio/opus" => (RtpCodecKind::Audio, 48000, 2, MIME_TYPE_OPUS),
            "video/vp8" => (RtpCodecKind::Video, 90000, 0, MIME_TYPE_VP8),
            "video/vp9" => (RtpCodecKind::Video, 90000, 0, MIME_TYPE_VP9),
            "video/h264" => (RtpCodecKind::Video, 90000, 0, MIME_TYPE_H264),
            "video/av1" => (RtpCodecKind::Video, 90000, 0, MIME_TYPE_AV1),
            _ => return Err(Error::Other(format!("unsupported codec {mime}"))),
        };
        let payload_type = default_payload_type(mime).unwrap();
        let ssrc: SSRC = rand_ssrc();
        let codec = RTCRtpCodec {
            mime_type: canonical.to_string(),
            clock_rate,
            channels,
            sdp_fmtp_line: String::new(),
            rtcp_feedback: vec![],
        };
        let media_track = MediaStreamTrack::new(
            stream_id.to_string(),
            track_id.to_string(),
            track_id.to_string(),
            kind,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(ssrc),
                    ..Default::default()
                },
                codec,
                ..Default::default()
            }],
        );
        let track = Arc::new(TrackLocalStaticSample::new(Instant::now(), media_track)?);
        Ok(Self {
            track,
            ssrc,
            payload_type,
            kind,
        })
    }

    /// The track as `Arc<dyn TrackLocal>` for `VdoNinja::publish`.
    pub fn local(&self) -> Arc<dyn TrackLocal> {
        self.track.clone() as Arc<dyn TrackLocal>
    }

    /// Writes one encoded frame (a full VP8/VP9/AV1 frame, an H264 access unit
    /// with Annex-B start codes, or one Opus packet) with its duration.
    pub async fn write(&self, data: Bytes, duration: Duration) -> Result<()> {
        self.track
            .sample_writer(self.ssrc, self.payload_type)
            .write_sample(&Sample {
                data,
                duration,
                ..Sample::new(Instant::now())
            })
            .await?;
        Ok(())
    }
}

fn rand_ssrc() -> SSRC {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut h = RandomState::new().build_hasher();
    h.write_u64(Instant::now().elapsed().as_nanos() as u64);
    (h.finish() as u32) | 1
}
