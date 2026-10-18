// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT

//! WHIP (publish) and WHEP (view) clients for WebRTC-HTTP endpoints such as
//! Cloudflare Stream, Twitch, Meshcast and MediaMTX.

use std::sync::Arc;
use std::time::Duration;

use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use tokio::sync::{mpsc, Mutex};
use vdoninja_core::turn::IceServer;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_remote::TrackRemote;
use webrtc::peer_connection::{
    register_default_interceptors, MediaEngine, PeerConnection, PeerConnectionBuilder,
    PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceGatheringState, RTCIceServer,
    RTCSessionDescription, Registry,
};
use webrtc::rtp_transceiver::{RTCRtpTransceiverDirection, RTCRtpTransceiverInit};

use crate::{Error, Result};

/// Options shared by the WHIP and WHEP clients.
#[derive(Debug, Clone)]
pub struct WhipOptions {
    pub token: Option<String>,
    pub headers: Vec<(String, String)>,
    pub ice_servers: Vec<IceServer>,
    pub bind_addrs: Vec<String>,
    /// Bound on ICE gathering before the offer is posted (default 3s).
    pub gather_timeout: Duration,
    pub audio: bool,
    pub video: bool,
}

impl Default for WhipOptions {
    fn default() -> Self {
        Self {
            token: None,
            headers: vec![],
            ice_servers: vec![
                IceServer {
                    urls: vec!["stun:stun.l.google.com:19302".into()],
                    username: String::new(),
                    credential: String::new(),
                },
                IceServer {
                    urls: vec!["stun:stun.cloudflare.com:3478".into()],
                    username: String::new(),
                    credential: String::new(),
                },
            ],
            bind_addrs: vec!["0.0.0.0:0".into()],
            gather_timeout: Duration::from_secs(3),
            audio: true,
            video: true,
        }
    }
}

/// Parses WHIP/WHEP `Link` headers of the form
/// `<stun:host>; rel="ice-server"; username="u"; credential="c"`.
pub fn parse_ice_servers_from_link(header: &str) -> Vec<IceServer> {
    let mut out = Vec::new();
    for part in header.split(',') {
        let Some(start) = part.find('<') else {
            continue;
        };
        let Some(end) = part.find('>') else { continue };
        if start >= end {
            continue;
        }
        let url = part[start + 1..end].to_string();
        let params = &part[end + 1..];
        if !params.contains("ice-server") {
            continue;
        }
        let mut srv = IceServer {
            urls: vec![url],
            username: String::new(),
            credential: String::new(),
        };
        for kv in params.split(';') {
            if let Some((k, v)) = kv.trim().split_once('=') {
                let v = v.trim().trim_matches('"').to_string();
                match k.trim() {
                    "username" => srv.username = v,
                    "credential" => srv.credential = v,
                    _ => {}
                }
            }
        }
        out.push(srv);
    }
    out
}

struct Handler {
    gathered: mpsc::Sender<()>,
    tracks: Option<mpsc::UnboundedSender<Arc<dyn TrackRemote>>>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        if state == RTCIceGatheringState::Complete {
            let _ = self.gathered.try_send(());
        }
    }
    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        if let Some(tx) = &self.tracks {
            let _ = tx.send(track);
        }
    }
}

struct Session {
    pc: Arc<dyn PeerConnection>,
    resource: Option<String>,
}

async fn build_pc(
    opts: &WhipOptions,
    handler: Arc<dyn PeerConnectionEventHandler>,
) -> Result<Arc<dyn PeerConnection>> {
    let mut media = MediaEngine::default();
    media.register_default_codecs()?;
    let registry = register_default_interceptors(Registry::new(), &mut media)?;
    let ice: Vec<RTCIceServer> = opts
        .ice_servers
        .iter()
        .map(|s| RTCIceServer {
            urls: s.urls.clone(),
            username: s.username.clone(),
            credential: s.credential.clone(),
        })
        .collect();
    let pc = PeerConnectionBuilder::new()
        .with_configuration(RTCConfigurationBuilder::new().with_ice_servers(ice).build())
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_handler(handler)
        .with_udp_addrs(opts.bind_addrs.clone())
        .build()
        .await?;
    Ok(Arc::new(pc))
}

async fn post_sdp(
    endpoint: &str,
    sdp: &str,
    opts: &WhipOptions,
) -> Result<(String, Option<String>)> {
    let client = reqwest::Client::new();
    let mut req = client
        .post(endpoint)
        .header("Content-Type", "application/sdp")
        .body(sdp.to_string());
    if let Some(token) = &opts.token {
        req = req.bearer_auth(token);
    }
    for (k, v) in &opts.headers {
        req = req.header(k, v);
    }
    let resp = req.send().await?;
    let status = resp.status();
    let location = resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let body = resp.text().await?;
    if !status.is_success() {
        return Err(Error::Http(format!(
            "endpoint returned {status}: {}",
            body.chars().take(200).collect::<String>()
        )));
    }
    let resource = location.map(
        |l| match reqwest::Url::parse(endpoint).and_then(|b| b.join(&l)) {
            Ok(u) => u.to_string(),
            Err(_) => l,
        },
    );
    Ok((body, resource))
}

async fn negotiate(
    pc: &Arc<dyn PeerConnection>,
    endpoint: &str,
    opts: &WhipOptions,
    mut gathered: mpsc::Receiver<()>,
) -> Result<Option<String>> {
    let offer = pc.create_offer(None).await?;
    pc.set_local_description(offer).await?;
    let _ = tokio::time::timeout(opts.gather_timeout, gathered.recv()).await;
    let local = pc
        .local_description()
        .await
        .ok_or_else(|| Error::WebRtc("no local description".into()))?;
    let (answer, resource) = post_sdp(endpoint, &local.sdp, opts).await?;
    pc.set_remote_description(RTCSessionDescription::answer(answer)?)
        .await?;
    Ok(resource)
}

async fn stop_session(session: Option<Session>, opts: &WhipOptions) -> Result<()> {
    if let Some(session) = session {
        if let Some(resource) = session.resource {
            let client = reqwest::Client::new();
            let mut req = client.delete(&resource);
            if let Some(token) = &opts.token {
                req = req.bearer_auth(token);
            }
            for (k, v) in &opts.headers {
                req = req.header(k, v);
            }
            let _ = req.send().await;
        }
        session.pc.close().await?;
    }
    Ok(())
}

/// Publishes local tracks to a WHIP endpoint.
pub struct WhipClient {
    pub endpoint: String,
    opts: WhipOptions,
    session: Mutex<Option<Session>>,
}

impl WhipClient {
    pub fn new(endpoint: impl Into<String>, opts: WhipOptions) -> Self {
        Self {
            endpoint: endpoint.into(),
            opts,
            session: Mutex::new(None),
        }
    }

    /// Negotiates with the endpoint and starts sending the tracks.
    pub async fn publish(&self, tracks: Vec<Arc<dyn TrackLocal>>) -> Result<()> {
        if tracks.is_empty() {
            return Err(Error::Other("at least one track is required".into()));
        }
        let (gtx, grx) = mpsc::channel(1);
        let pc = build_pc(
            &self.opts,
            Arc::new(Handler {
                gathered: gtx,
                tracks: None,
            }),
        )
        .await?;
        for t in tracks {
            pc.add_track(t).await?;
        }
        let resource = negotiate(&pc, &self.endpoint, &self.opts, grx).await?;
        *self.session.lock().await = Some(Session { pc, resource });
        Ok(())
    }

    /// Returns the peer connection after `publish` (for stats, senders, ...).
    pub async fn peer_connection(&self) -> Option<Arc<dyn PeerConnection>> {
        self.session.lock().await.as_ref().map(|s| s.pc.clone())
    }

    /// DELETEs the resource and closes the connection.
    pub async fn stop(&self) -> Result<()> {
        let session = self.session.lock().await.take();
        stop_session(session, &self.opts).await
    }
}

/// Consumes media from a WHEP endpoint; tracks arrive on the receiver returned by `view`.
pub struct WhepClient {
    pub endpoint: String,
    opts: WhipOptions,
    session: Mutex<Option<Session>>,
}

impl WhepClient {
    pub fn new(endpoint: impl Into<String>, opts: WhipOptions) -> Self {
        Self {
            endpoint: endpoint.into(),
            opts,
            session: Mutex::new(None),
        }
    }

    /// Negotiates and returns a receiver of incoming tracks.
    pub async fn view(&self) -> Result<mpsc::UnboundedReceiver<Arc<dyn TrackRemote>>> {
        let (gtx, grx) = mpsc::channel(1);
        let (ttx, trx) = mpsc::unbounded_channel();
        let pc = build_pc(
            &self.opts,
            Arc::new(Handler {
                gathered: gtx,
                tracks: Some(ttx),
            }),
        )
        .await?;
        let init = RTCRtpTransceiverInit {
            direction: RTCRtpTransceiverDirection::Recvonly,
            ..Default::default()
        };
        if self.opts.audio {
            pc.add_transceiver_from_kind(RtpCodecKind::Audio, Some(init.clone()))
                .await?;
        }
        if self.opts.video {
            pc.add_transceiver_from_kind(RtpCodecKind::Video, Some(init))
                .await?;
        }
        let resource = negotiate(&pc, &self.endpoint, &self.opts, grx).await?;
        *self.session.lock().await = Some(Session { pc, resource });
        Ok(trx)
    }

    pub async fn peer_connection(&self) -> Option<Arc<dyn PeerConnection>> {
        self.session.lock().await.as_ref().map(|s| s.pc.clone())
    }

    pub async fn stop(&self) -> Result<()> {
        let session = self.session.lock().await.take();
        stop_session(session, &self.opts).await
    }
}
