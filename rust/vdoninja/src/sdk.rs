// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The [`VdoNinja`] peer: signaling, peer connections, data, files.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::{Bytes, BytesMut};
use futures_util::{SinkExt, StreamExt};
use rtc::peer_connection::configuration::RTCOfferOptions;
use rtc::rtp_transceiver::rtp_sender::RtpCodecKind;
use serde_json::{json, Map, Value};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use vdoninja_core::protocol::{self, FileEntry, IceCandidate, ListingEntry, SessionDescription};
use vdoninja_core::turn::{fallback_turn_servers, select_turn_servers, IceServer, TurnList};
use vdoninja_core::*;
use webrtc::data_channel::{
    DataChannel, DataChannelEvent, RTCDataChannelInit, RTCDataChannelState,
};
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_remote::TrackRemote;
use webrtc::peer_connection::{
    register_default_interceptors, MediaEngine, PeerConnection, PeerConnectionBuilder,
    PeerConnectionEventHandler, RTCConfigurationBuilder, RTCIceCandidateInit,
    RTCIceConnectionState, RTCIceServer, RTCIceTransportPolicy, RTCPeerConnectionIceEvent,
    RTCPeerConnectionState, RTCSessionDescription, Registry, SettingEngineBuilder,
};
use webrtc::rtp_transceiver::RtpSender;

use crate::events::{Event, FileInfo};
use crate::options::{
    AutoConnectOptions, DataTarget, Options, PublishOptions, TurnMode, ViewOptions,
};
use crate::{Error, Result};

const BUFFER_HIGH: usize = 1_048_576;
const SIGNALING_QUEUE_LIMIT: usize = 30;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn jstr(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

/// A completed file download.
#[derive(Debug, Clone)]
pub struct FileResult {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub uuid: String,
    pub stream_id: Option<String>,
    /// `None` when the download was streamed through `FileChunk` events.
    pub data: Option<Bytes>,
}

/// Handler for incoming requests: `(data, from_uuid) -> Ok(response) | Err(message)`.
pub type RequestHandler = Arc<
    dyn Fn(
            Value,
            String,
        ) -> Pin<Box<dyn Future<Output = std::result::Result<Value, String>> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone)]
struct StreamInfo {
    uuid: Option<String>,
    state: &'static str,
    last_seen: Instant,
}

struct PendingCandidate {
    candidate: IceCandidate,
    session: Option<String>,
    ts: Instant,
}

struct HostedFile {
    id: String,
    name: String,
    data: Bytes,
    restricted: Option<String>,
    cancelled: AtomicBool,
}

struct InboundTransfer {
    id: String,
    stream: bool,
    state: Mutex<InboundState>,
}

struct InboundState {
    started: bool,
    received: u64,
    chunks: Vec<Bytes>,
    done: Option<oneshot::Sender<Result<FileResult>>>,
}

#[derive(Clone)]
struct RoomIntent {
    room: String,
    claim: bool,
}

#[derive(Default)]
struct PeerPair {
    publisher: Option<Arc<Connection>>,
    viewer: Option<Arc<Connection>>,
}

impl PeerPair {
    fn get(&self, kind: &str) -> Option<Arc<Connection>> {
        if kind == "publisher" {
            self.publisher.clone()
        } else {
            self.viewer.clone()
        }
    }
    fn set(&mut self, kind: &str, c: Option<Arc<Connection>>) -> Option<Arc<Connection>> {
        if kind == "publisher" {
            std::mem::replace(&mut self.publisher, c)
        } else {
            std::mem::replace(&mut self.viewer, c)
        }
    }
    fn is_empty(&self) -> bool {
        self.publisher.is_none() && self.viewer.is_none()
    }
}

struct State {
    connected: bool,
    intentional: bool,
    generation: u64,
    reconnects: u32,
    /// A reconnect cycle is in progress (kept apart from the attempt counter).
    reconnecting: bool,
    queue: Vec<String>,
    password: String,
    no_password: bool,
    salt: String,
    password_hash: String,
    room: String,
    room_joined: bool,
    room_waiters: Vec<oneshot::Sender<()>>,
    intent_room: Option<RoomIntent>,
    publishing: bool,
    data_only: bool,
    stream_id: Option<String>,
    local_tracks: Vec<Arc<dyn TrackLocal>>,
    publisher_info: Map<String, Value>,
    pending_views: HashMap<String, ViewOptions>,
    view_intent: HashMap<String, ViewOptions>,
    stopped_views: HashSet<String>,
    view_retry: HashMap<String, JoinHandle<()>>,
    view_waiters: HashMap<String, Vec<oneshot::Sender<Arc<Connection>>>>,
    streams: HashMap<String, StreamInfo>,
    pending_ice: HashMap<String, Vec<PendingCandidate>>,
    subscriptions: HashSet<String>,
    peer_subs: HashMap<String, HashSet<String>>,
    pending_requests: HashMap<String, (String, oneshot::Sender<Result<Value>>)>,
    hosted_files: HashMap<String, Arc<HostedFile>>,
    inbound: HashMap<String, Arc<InboundTransfer>>,
    tasks: Vec<JoinHandle<()>>,
    reconnect_task: Option<JoinHandle<()>>,
}

struct TurnCache {
    list: Option<Vec<IceServer>>,
    fetched: Instant,
}

struct Inner {
    opts: Options,
    events: broadcast::Sender<Event>,
    st: Mutex<State>,
    conns: Mutex<HashMap<String, PeerPair>>,
    ws_tx: Mutex<Option<mpsc::UnboundedSender<String>>>,
    turn: tokio::sync::Mutex<TurnCache>,
    request_handlers: Mutex<HashMap<String, RequestHandler>>,
    self_weak: OnceLock<Weak<Inner>>,
}

/// One WebRTC connection in one direction (`publisher` or `viewer`).
pub struct Connection {
    /// Remote peer UUID.
    pub uuid: String,
    /// `"publisher"` (we send our stream) or `"viewer"` (we receive theirs).
    pub kind: &'static str,
    pc: Arc<dyn PeerConnection>,
    cs: Mutex<ConnState>,
    control_open: AtomicBool,
    remote_set: AtomicBool,
}

struct ConnState {
    control: Option<Arc<dyn DataChannel>>,
    channels: HashMap<String, Arc<dyn DataChannel>>,
    stream_id: Option<String>,
    session: Option<String>,
    info: Map<String, Value>,
    obs_state: Map<String, Value>,
    allow_audio: bool,
    allow_video: bool,
    allow_downloads: bool,
    allow_resources: bool,
    view_options: ViewOptions,
    senders: Vec<(Arc<dyn RtpSender>, RtpCodecKind)>,
    ice_bundle: Vec<IceCandidate>,
    ice_timer_running: bool,
    ice_delay: Duration,
    pending_ping: Option<i64>,
    missed_pings: u32,
    peer_state: RTCPeerConnectionState,
    ice_state: RTCIceConnectionState,
    connected_once: bool,
    finalized: bool,
    recovering: bool,
    disconnect_timer: Option<JoinHandle<()>>,
    connect_timer: Option<JoinHandle<()>>,
    /// Bounded wait after a failure-triggered ICE restart.
    recovery_timer: Option<JoinHandle<()>>,
    ping_task: Option<JoinHandle<()>>,
    advertised: HashSet<String>,
    tasks: Vec<JoinHandle<()>>,
}

impl Connection {
    /// The stream ID carried by this connection.
    pub fn stream_id(&self) -> Option<String> {
        self.cs.lock().unwrap().stream_id.clone()
    }
    /// The negotiated session ID.
    pub fn session(&self) -> Option<String> {
        self.cs.lock().unwrap().session.clone()
    }
    /// Remote metadata (label, meta, ...).
    pub fn info(&self) -> Value {
        Value::Object(self.cs.lock().unwrap().info.clone())
    }
    /// The underlying webrtc-rs peer connection (stats, transceivers, ...).
    pub fn peer_connection(&self) -> Arc<dyn PeerConnection> {
        self.pc.clone()
    }
    /// The control data channel, if any.
    pub fn control_channel(&self) -> Option<Arc<dyn DataChannel>> {
        self.cs.lock().unwrap().control.clone()
    }
    /// A data channel by label.
    pub fn channel(&self, label: &str) -> Option<Arc<dyn DataChannel>> {
        self.cs.lock().unwrap().channels.get(label).cloned()
    }
    /// Whether the control channel is open.
    pub fn is_control_open(&self) -> bool {
        self.control_open.load(Ordering::Acquire)
    }
    /// RTP senders of a publisher connection.
    pub fn senders(&self) -> Vec<Arc<dyn RtpSender>> {
        self.cs
            .lock()
            .unwrap()
            .senders
            .iter()
            .map(|(s, _)| s.clone())
            .collect()
    }

    async fn send_control(&self, v: &Value) -> bool {
        if !self.is_control_open() {
            return false;
        }
        let dc = self.cs.lock().unwrap().control.clone();
        let Some(dc) = dc else { return false };
        let text = v.to_string();
        log::debug!(
            "-> DC({}/{}) {}",
            self.uuid,
            self.kind,
            truncate(&text, 300)
        );
        dc.send_text(&text).await.is_ok()
    }

    async fn close(&self) {
        let handles: Vec<JoinHandle<()>> = {
            let mut cs = self.cs.lock().unwrap();
            cs.finalized = true;
            let mut h = std::mem::take(&mut cs.tasks);
            h.extend(cs.disconnect_timer.take());
            h.extend(cs.connect_timer.take());
            h.extend(cs.recovery_timer.take());
            h.extend(cs.ping_task.take());
            h
        };
        for h in handles {
            h.abort();
        }
        let _ = self.pc.close().await;
    }
}

fn truncate(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((i, _)) => format!("{}...", &s[..i]),
        None => s.to_string(),
    }
}

struct PcHandler {
    inner: Weak<Inner>,
    conn: Arc<OnceLock<Weak<Connection>>>,
}

impl PcHandler {
    fn get(&self) -> Option<(Arc<Inner>, Arc<Connection>)> {
        let inner = self.inner.upgrade()?;
        let conn = self.conn.get()?.upgrade()?;
        Some((inner, conn))
    }
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for PcHandler {
    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        if let Some((inner, conn)) = self.get() {
            if let Ok(init) = event.candidate.to_json() {
                let cand = IceCandidate {
                    candidate: init.candidate,
                    sdp_mid: init.sdp_mid,
                    sdp_mline_index: init.sdp_mline_index,
                };
                inner.handle_local_candidate(conn, cand).await;
            }
        }
    }
    async fn on_ice_connection_state_change(&self, state: RTCIceConnectionState) {
        if let Some((inner, conn)) = self.get() {
            conn.cs.lock().unwrap().ice_state = state;
            inner.handle_peer_state(conn).await;
        }
    }
    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        if let Some((inner, conn)) = self.get() {
            conn.cs.lock().unwrap().peer_state = state;
            inner.handle_peer_state(conn).await;
        }
    }
    async fn on_data_channel(&self, dc: Arc<dyn DataChannel>) {
        if let Some((inner, conn)) = self.get() {
            inner.handle_incoming_channel(conn, dc).await;
        }
    }
    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        if let Some((inner, conn)) = self.get() {
            log::debug!("track from {}", conn.uuid);
            inner.emit(Event::Track {
                uuid: conn.uuid.clone(),
                stream_id: conn.stream_id(),
                track,
            });
        }
    }
}

/// Controller returned by `auto_connect`.
pub struct AutoConnectController {
    pub stream_id: String,
    task: JoinHandle<()>,
}

impl AutoConnectController {
    /// Stops discovery (existing connections stay open).
    pub fn stop(&self) {
        self.task.abort();
    }
}

impl Drop for AutoConnectController {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// A VDO.Ninja peer. Cheap to clone (shared handle).
#[derive(Clone)]
pub struct VdoNinja {
    inner: Arc<Inner>,
}

impl VdoNinja {
    /// Creates a peer. Nothing connects until [`connect`](Self::connect).
    pub fn new(opts: Options) -> Self {
        let (events, _) = broadcast::channel(512);
        let (password, no_password) = if opts.no_password {
            (String::new(), true)
        } else {
            let password = sanitize_password(opts.password.as_deref().unwrap_or(DEFAULT_PASSWORD));
            (
                if password.is_empty() {
                    DEFAULT_PASSWORD.into()
                } else {
                    password
                },
                false,
            )
        };
        let salt = if opts.salt.is_empty() {
            vdoninja_core::DEFAULT_SALT.into()
        } else {
            opts.salt.clone()
        };
        let password_hash = if no_password {
            String::new()
        } else {
            stream_hash_suffix(&password, &salt)
        };
        let mut publisher_info = Map::new();
        apply_publisher_info(
            &mut publisher_info,
            opts.label.as_deref(),
            opts.meta.as_ref(),
            opts.order.as_deref(),
            opts.info.as_ref(),
        );
        let room = opts.room.as_deref().map(sanitize_room).unwrap_or_default();
        let inner = Arc::new(Inner {
            opts,
            events,
            st: Mutex::new(State {
                connected: false,
                intentional: false,
                generation: 0,
                reconnects: 0,
                reconnecting: false,
                queue: vec![],
                password,
                no_password,
                salt,
                password_hash,
                room,
                room_joined: false,
                room_waiters: vec![],
                intent_room: None,
                publishing: false,
                data_only: false,
                stream_id: None,
                local_tracks: vec![],
                publisher_info,
                pending_views: HashMap::new(),
                view_intent: HashMap::new(),
                stopped_views: HashSet::new(),
                view_retry: HashMap::new(),
                view_waiters: HashMap::new(),
                streams: HashMap::new(),
                pending_ice: HashMap::new(),
                subscriptions: HashSet::new(),
                peer_subs: HashMap::new(),
                pending_requests: HashMap::new(),
                hosted_files: HashMap::new(),
                inbound: HashMap::new(),
                tasks: vec![],
                reconnect_task: None,
            }),
            conns: Mutex::new(HashMap::new()),
            ws_tx: Mutex::new(None),
            turn: tokio::sync::Mutex::new(TurnCache {
                list: None,
                fetched: Instant::now(),
            }),
            request_handlers: Mutex::new(HashMap::new()),
            self_weak: OnceLock::new(),
        });
        let _ = inner.self_weak.set(Arc::downgrade(&inner));
        Self { inner }
    }

    /// Subscribes to SDK events.
    pub fn events(&self) -> broadcast::Receiver<Event> {
        self.inner.events.subscribe()
    }

    /// Opens the signaling WebSocket.
    pub async fn connect(&self) -> Result<()> {
        self.inner.clone().connect().await
    }

    /// Sends bye to peers, closes every connection and the socket, and emits
    /// a single `Disconnected` event.
    pub async fn disconnect(&self) {
        self.inner.clone().disconnect().await
    }

    /// Whether the signaling socket is open.
    pub fn connected(&self) -> bool {
        self.inner.st.lock().unwrap().connected
    }

    /// Joins a room (hashed with password and salt) and waits for the listing.
    pub async fn join_room(&self, room: &str) -> Result<()> {
        self.inner.clone().join_room(room, None, false).await
    }

    /// Joins a room with an explicit password and/or director claim.
    pub async fn join_room_with(
        &self,
        room: &str,
        password: Option<&str>,
        claim: bool,
    ) -> Result<()> {
        self.inner.clone().join_room(room, password, claim).await
    }

    /// Leaves by disconnecting peers and signaling; the server has no leave message.
    /// Call connect() before joining another room or publishing again.
    pub async fn leave_room(&self) {
        let room = {
            let mut st = self.inner.st.lock().unwrap();
            st.room_joined = false;
            st.intent_room = None;
            std::mem::take(&mut st.room)
        };
        if !room.is_empty() {
            self.disconnect().await;
            self.inner.emit(Event::RoomLeft { room });
        }
    }

    /// The joined room, if any.
    pub fn room(&self) -> Option<String> {
        let st = self.inner.st.lock().unwrap();
        if st.room_joined {
            Some(st.room.clone())
        } else {
            None
        }
    }

    /// Registers a data-only stream so peers can connect to it. Returns the stream ID.
    pub async fn announce(&self, opts: PublishOptions) -> Result<String> {
        self.ensure_not_publishing()?;
        self.inner.clone().seed(vec![], true, opts).await
    }

    /// One publish per signaling connection, like the JavaScript SDK (the
    /// server rejects a changed stream ID on a live socket).
    fn ensure_not_publishing(&self) -> Result<()> {
        if self.inner.st.lock().unwrap().publishing {
            Err(Error::AlreadyPublishing)
        } else {
            Ok(())
        }
    }

    /// Registers a media stream (webrtc-rs local tracks). Returns the stream ID.
    pub async fn publish(
        &self,
        tracks: Vec<Arc<dyn TrackLocal>>,
        opts: PublishOptions,
    ) -> Result<String> {
        self.ensure_not_publishing()?;
        self.inner.clone().seed(tracks, false, opts).await
    }

    /// Closes publisher connections and stops offering the stream.
    pub async fn stop_publishing(&self) {
        self.inner.clone().stop_publishing().await
    }

    /// Our published/announced stream ID.
    pub fn stream_id(&self) -> Option<String> {
        self.inner.st.lock().unwrap().stream_id.clone()
    }

    /// Requests a stream. Returns the viewer connection once the publisher's
    /// offer is answered, or `Error::StreamNotYetAvailable` after the timeout
    /// while keeping the request pending (it connects when the stream appears).
    pub async fn view(&self, stream_id: &str, opts: ViewOptions) -> Result<Arc<Connection>> {
        self.inner
            .clone()
            .view(&sanitize_stream_id(stream_id), opts)
            .await
    }

    /// Sends bye to the publisher and closes the viewer connection.
    pub async fn stop_viewing(&self, stream_id: &str) {
        self.inner
            .clone()
            .stop_viewing(&sanitize_stream_id(stream_id))
            .await
    }

    /// Connected peer UUIDs.
    pub fn peers(&self) -> Vec<String> {
        self.inner.conns.lock().unwrap().keys().cloned().collect()
    }

    /// A connection to a peer by type (`"publisher"`/`"viewer"`).
    pub fn connection(&self, uuid: &str, kind: &str) -> Option<Arc<Connection>> {
        self.inner
            .conns
            .lock()
            .unwrap()
            .get(uuid)
            .and_then(|p| p.get(kind))
    }

    /// Streams seen so far (listings, announcements, view requests) as `(stream_id, uuid, state)`.
    pub fn streams(&self) -> Vec<(String, Option<String>, &'static str)> {
        let st = self.inner.st.lock().unwrap();
        let mut v: Vec<(String, Option<String>, &'static str, Instant)> = st
            .streams
            .iter()
            .map(|(k, v)| (k.clone(), v.uuid.clone(), v.state, v.last_seen))
            .collect();
        v.sort_by_key(|e| std::cmp::Reverse(e.3));
        v.into_iter().map(|(a, b, c, _)| (a, b, c)).collect()
    }

    /// Sends application data (wrapped in `{"pipe": ...}`) to every peer.
    pub async fn send_data(&self, data: Value) -> bool {
        self.send_data_with(data, DataTarget::default()).await
    }

    /// Sends application data to one peer.
    pub async fn send_data_to(&self, uuid: &str, data: Value) -> bool {
        self.send_data_with(
            data,
            DataTarget {
                uuid: Some(uuid.to_string()),
                ..Default::default()
            },
        )
        .await
    }

    /// Sends application data with explicit routing.
    pub async fn send_data_with(&self, data: Value, target: DataTarget) -> bool {
        self.inner.send_data_with(data, target).await
    }

    /// Sends a ping on the control channel (`""` = every peer); the reply emits `PeerLatency`.
    pub async fn send_ping(&self, uuid: &str) -> bool {
        self.inner.send_ping(uuid).await
    }

    /// Joins pub/sub channels and tells connected peers.
    pub async fn subscribe(&self, channels: &[&str]) {
        let list: Vec<String> = channels.iter().map(|s| s.to_string()).collect();
        let connected = {
            let mut st = self.inner.st.lock().unwrap();
            st.subscriptions.extend(list.iter().cloned());
            st.connected
        };
        if connected {
            self.inner
                .send_data_with(
                    json!({"type": "subscribe", "channels": list}),
                    DataTarget::default(),
                )
                .await;
        }
    }

    /// Leaves pub/sub channels.
    pub async fn unsubscribe(&self, channels: &[&str]) {
        let list: Vec<String> = channels.iter().map(|s| s.to_string()).collect();
        let connected = {
            let mut st = self.inner.st.lock().unwrap();
            for c in &list {
                st.subscriptions.remove(c);
            }
            st.connected
        };
        if connected {
            self.inner
                .send_data_with(
                    json!({"type": "unsubscribe", "channels": list}),
                    DataTarget::default(),
                )
                .await;
        }
    }

    /// Local pub/sub subscriptions.
    pub fn subscriptions(&self) -> Vec<String> {
        self.inner
            .st
            .lock()
            .unwrap()
            .subscriptions
            .iter()
            .cloned()
            .collect()
    }

    /// Channels a peer told us it subscribed to.
    pub fn peer_subscriptions(&self, uuid: &str) -> Vec<String> {
        self.inner
            .st
            .lock()
            .unwrap()
            .peer_subs
            .get(uuid)
            .map(|s| s.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Publishes a pub/sub message (`None` target = everyone).
    pub async fn publish_to_channel(
        &self,
        channel: &str,
        data: Value,
        target: Option<&str>,
    ) -> bool {
        let msg = json!({"type": "channelMessage", "channel": channel, "data": data, "timestamp": now_ms()});
        match target {
            Some(uuid) if !uuid.is_empty() && uuid != "all" => self.send_data_to(uuid, msg).await,
            _ => self.send_data(msg).await,
        }
    }

    /// Registers a request handler.
    pub fn on_request<F, Fut>(&self, request_type: &str, handler: F)
    where
        F: Fn(Value, String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = std::result::Result<Value, String>> + Send + 'static,
    {
        let h: RequestHandler = Arc::new(move |v, u| Box::pin(handler(v, u)));
        self.inner
            .request_handlers
            .lock()
            .unwrap()
            .insert(request_type.to_string(), h);
    }

    /// Sends a request to a peer and awaits the response.
    pub async fn request(
        &self,
        request_type: &str,
        data: Value,
        target_uuid: &str,
        timeout: Duration,
    ) -> Result<Value> {
        let id = generate_uuid();
        let (tx, rx) = oneshot::channel();
        self.inner
            .st
            .lock()
            .unwrap()
            .pending_requests
            .insert(id.clone(), (target_uuid.to_string(), tx));
        let sent = self
            .send_data_to(target_uuid, json!({"type": "request", "requestType": request_type, "requestId": id, "data": data}))
            .await;
        if !sent {
            self.inner.st.lock().unwrap().pending_requests.remove(&id);
            return Err(Error::NoDataChannel);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(Error::Cancelled),
            Err(_) => {
                self.inner.st.lock().unwrap().pending_requests.remove(&id);
                Err(Error::RequestTimeout(request_type.to_string()))
            }
        }
    }

    /// Sends a response to a request ID.
    pub async fn respond(&self, request_id: &str, data: Value, target_uuid: &str) -> bool {
        self.send_data_to(
            target_uuid,
            json!({"type": "response", "requestId": request_id, "data": data}),
        )
        .await
    }

    /// Connects, joins the room, announces this peer and views peers as they appear.
    pub async fn auto_connect(
        &self,
        room: &str,
        opts: AutoConnectOptions,
    ) -> Result<AutoConnectController> {
        if room.is_empty() {
            return Err(Error::RoomRequired);
        }
        let mode = opts.mode.clone().unwrap_or_else(|| "half".into());
        let view = opts.view.clone().unwrap_or(ViewOptions {
            audio: mode == "full",
            video: mode == "full",
            ..Default::default()
        });
        let mut events = self.events();
        if !self.connected() {
            self.connect().await?;
        }
        if self.room() != Some(sanitize_room(room)) {
            self.inner
                .clone()
                .join_room(room, opts.password.as_deref(), false)
                .await?;
        }
        let my_id = self
            .announce(PublishOptions {
                stream_id: opts.stream_id.clone(),
                label: opts.label.clone(),
                ..Default::default()
            })
            .await?;
        let sdk = self.clone();
        let me = my_id.clone();
        let known: Vec<String> = self.streams().into_iter().map(|(s, _, _)| s).collect();
        let task = tokio::spawn(async move {
            let viewed = Arc::new(Mutex::new(HashSet::<String>::new()));
            let consider = {
                let sdk = sdk.clone();
                let viewed = viewed.clone();
                let view = view.clone();
                let me = me.clone();
                let mode = mode.clone();
                move |sid: String| {
                    if sid.is_empty() || sid == me {
                        return;
                    }
                    if mode == "half" && sid >= me {
                        return;
                    }
                    if !viewed.lock().unwrap().insert(sid.clone()) {
                        return;
                    }
                    let sdk = sdk.clone();
                    let viewed = viewed.clone();
                    let view = view.clone();
                    tokio::spawn(async move {
                        match sdk.view(&sid, view).await {
                            Ok(_) | Err(Error::StreamNotYetAvailable) => {}
                            Err(_) => {
                                viewed.lock().unwrap().remove(&sid);
                            }
                        }
                    });
                }
            };
            for sid in known {
                consider(sid);
            }
            loop {
                match events.recv().await {
                    Ok(Event::Listing { list, .. }) => {
                        for e in list {
                            if let Some(sid) = e.stream_id {
                                consider(sid);
                            }
                        }
                    }
                    Ok(Event::VideoAddedToRoom { stream_id, .. }) => consider(stream_id),
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => break,
                }
            }
        });
        Ok(AutoConnectController {
            stream_id: my_id,
            task,
        })
    }

    /// Offers bytes to peers using VDO.Ninja's native file transfer. The file
    /// shows up as a download in a VDO.Ninja viewer's chat.
    pub async fn host_file(
        &self,
        name: &str,
        data: Bytes,
        file_id: Option<&str>,
        restricted: Option<&str>,
    ) -> Result<FileEntry> {
        if name.is_empty() {
            return Err(Error::Other("file name required".into()));
        }
        if let Some(id) = file_id {
            if id.starts_with(RESERVED_CHANNEL_PREFIX) {
                return Err(Error::ReservedChannelLabel);
            }
        }
        let entry = {
            let mut st = self.inner.st.lock().unwrap();
            let mut id = file_id.map(|s| s.to_string()).unwrap_or_default();
            while id.is_empty()
                || id == CONTROL_CHANNEL_LABEL
                || id == CHUNKED_CHANNEL_LABEL
                || id == RESOURCES_CHANNEL_LABEL
                || id.starts_with(RESERVED_CHANNEL_PREFIX)
                || st.hosted_files.contains_key(&id)
            {
                id = generate_stream_id();
            }
            let f = Arc::new(HostedFile {
                id: id.clone(),
                name: name.to_string(),
                data: data.clone(),
                restricted: restricted.map(|s| s.to_string()),
                cancelled: AtomicBool::new(false),
            });
            st.hosted_files.insert(id.clone(), f);
            FileEntry {
                id,
                name: name.to_string(),
                size: data.len() as u64,
            }
        };
        let targets: Vec<Arc<Connection>> = self
            .inner
            .conns
            .lock()
            .unwrap()
            .iter()
            .filter(|(uuid, _)| restricted.map(|r| r == uuid.as_str()).unwrap_or(true))
            .filter_map(|(_, p)| p.publisher.clone())
            .collect();
        for c in targets {
            self.inner.send_file_entries(&c, vec![entry.clone()]).await;
        }
        Ok(entry)
    }

    /// Stops offering a file; transfers in flight are cancelled.
    pub fn unhost_file(&self, file_id: &str) -> bool {
        match self.inner.st.lock().unwrap().hosted_files.remove(file_id) {
            Some(f) => {
                f.cancelled.store(true, Ordering::Release);
                true
            }
            None => false,
        }
    }

    /// Files currently offered.
    pub fn hosted_files(&self) -> Vec<FileEntry> {
        self.inner
            .st
            .lock()
            .unwrap()
            .hosted_files
            .values()
            .map(|f| FileEntry {
                id: f.id.clone(),
                name: f.name.clone(),
                size: f.data.len() as u64,
            })
            .collect()
    }

    /// Downloads a file a peer advertised (`FileList` event). With `stream`
    /// the bytes arrive as `FileChunk` events and `FileResult::data` is `None`.
    pub async fn request_file(
        &self,
        uuid: &str,
        file_id: &str,
        stream: bool,
        timeout: Duration,
    ) -> Result<FileResult> {
        let (tx, rx) = oneshot::channel();
        let transfer = Arc::new(InboundTransfer {
            id: file_id.to_string(),
            stream,
            state: Mutex::new(InboundState {
                started: false,
                received: 0,
                chunks: vec![],
                done: Some(tx),
            }),
        });
        let key = format!("{uuid}:{file_id}");
        self.inner
            .st
            .lock()
            .unwrap()
            .inbound
            .insert(key.clone(), transfer.clone());
        if !self
            .inner
            .send_raw_control(uuid, &json!({"requestFile": file_id}))
            .await
        {
            self.inner.st.lock().unwrap().inbound.remove(&key);
            return Err(Error::NoDataChannel);
        }
        let inner = self.inner.clone();
        let t2 = transfer.clone();
        let k2 = key.clone();
        let start_timer = tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            let mut s = t2.state.lock().unwrap();
            if !s.started {
                inner.st.lock().unwrap().inbound.remove(&k2);
                if let Some(done) = s.done.take() {
                    let _ = done.send(Err(Error::FileTransfer(format!(
                        "file transfer {} did not start",
                        t2.id
                    ))));
                }
            }
        });
        let result = rx.await.unwrap_or(Err(Error::Cancelled));
        start_timer.abort();
        result
    }

    /// Opens an additional data channel in the reserved `x-` namespace
    /// (ignored by VDO.Ninja peers). Idempotent.
    pub async fn open_channel(
        &self,
        uuid: &str,
        label: &str,
        init: Option<RTCDataChannelInit>,
    ) -> Result<Arc<dyn DataChannel>> {
        self.inner.open_channel(uuid, label, init).await
    }

    /// Sends raw bytes on the dedicated `x-bin` lane (never the control channel).
    /// webrtc-rs receivers accept messages up to 16384 bytes; split larger payloads.
    pub async fn send_binary(&self, uuid: &str, data: Bytes) -> Result<()> {
        let dc = self
            .inner
            .open_channel(uuid, BINARY_CHANNEL_LABEL, None)
            .await?;
        wait_below(&dc, BUFFER_HIGH, Duration::from_secs(30)).await?;
        dc.send(BytesMut::from(&data[..])).await?;
        Ok(())
    }

    /// Sends bytes on VDO.Ninja's `resources` channel to a peer that advertised `allowresources`.
    pub async fn send_resource(
        &self,
        uuid: &str,
        template_name: &str,
        mime_type: &str,
        data: Bytes,
    ) -> Result<()> {
        let conn = self
            .inner
            .find_connection(uuid, Some("publisher"))
            .or_else(|| self.inner.find_connection(uuid, None))
            .ok_or(Error::PeerNotFound)?;
        let (allowed, existing) = {
            let cs = conn.cs.lock().unwrap();
            (
                cs.allow_resources,
                cs.channels.get(RESOURCES_CHANNEL_LABEL).cloned(),
            )
        };
        if !allowed {
            return Err(Error::ResourcesNotAdvertised);
        }
        let dc = match existing {
            Some(dc) => dc,
            None => {
                let init = RTCDataChannelInit {
                    ordered: true,
                    max_retransmits: Some(30),
                    ..Default::default()
                };
                let dc = conn
                    .pc
                    .create_data_channel(RESOURCES_CHANNEL_LABEL, Some(init))
                    .await?;
                conn.cs
                    .lock()
                    .unwrap()
                    .channels
                    .insert(RESOURCES_CHANNEL_LABEL.into(), dc.clone());
                self.inner.wait_open(&dc, Duration::from_secs(15)).await?;
                dc
            }
        };
        dc.send_text(
            &json!({"templateName": template_name, "type": mime_type, "size": data.len()})
                .to_string(),
        )
        .await?;
        for chunk in data.chunks(FILE_CHUNK_SIZE) {
            wait_below(&dc, BUFFER_HIGH, Duration::from_secs(30)).await?;
            dc.send(BytesMut::from(chunk)).await?;
        }
        Ok(())
    }
}

fn apply_publisher_info(
    info: &mut Map<String, Value>,
    label: Option<&str>,
    meta: Option<&Value>,
    order: Option<&str>,
    extra: Option<&Value>,
) {
    if let Some(l) = label {
        if !l.is_empty() {
            info.insert("label".into(), Value::String(sanitize_label(l)));
        }
    }
    if let Some(m) = meta {
        if let Some(safe) = sanitize_meta(m, 0) {
            if safe != Value::String(String::new()) {
                info.insert("meta".into(), safe);
            }
        }
    }
    if let Some(o) = order {
        if !o.is_empty() {
            info.insert("order".into(), Value::String(sanitize_label(o)));
        }
    }
    if let Some(Value::Object(extra)) = extra {
        for (k, v) in extra {
            match k.as_str() {
                "broadcast" | "allowdrawing" | "iframe" | "widget" | "allowmidi"
                | "allowresources" => {
                    if v.is_boolean() {
                        info.insert(k.clone(), v.clone());
                    }
                }
                "allowchunked" => {
                    if v.is_boolean() || v.is_number() {
                        info.insert(k.clone(), v.clone());
                    }
                }
                "label" => {
                    if let Some(s) = v.as_str() {
                        info.insert("label".into(), Value::String(sanitize_label(s)));
                    }
                }
                "meta" => {
                    if let Some(safe) = sanitize_meta(v, 0) {
                        info.insert("meta".into(), safe);
                    }
                }
                "order" => {
                    if let Some(s) = v.as_str() {
                        info.insert("order".into(), Value::String(sanitize_label(s)));
                    }
                }
                _ => {}
            }
        }
    }
}

async fn wait_below(dc: &Arc<dyn DataChannel>, threshold: usize, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        let outstanding = dc.outstanding_bytes().await?;
        if outstanding < threshold {
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err(Error::Other("data channel did not drain".into()));
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

impl Inner {
    fn emit(&self, ev: Event) {
        let _ = self.events.send(ev);
    }

    fn me(&self) -> Arc<Inner> {
        self.self_weak
            .get()
            .and_then(|w| w.upgrade())
            .expect("sdk alive")
    }

    fn effective_password(&self) -> Option<String> {
        let st = self.st.lock().unwrap();
        if st.no_password {
            None
        } else if st.password.is_empty() {
            Some(sanitize_password(DEFAULT_PASSWORD))
        } else {
            Some(st.password.clone())
        }
    }

    fn phrase(&self) -> Option<String> {
        let salt = self.st.lock().unwrap().salt.clone();
        self.effective_password().map(|p| format!("{p}{salt}"))
    }

    fn encrypt(&self, v: &Value) -> Result<(String, String)> {
        let phrase = self.phrase().ok_or(Error::EncryptionDisabled)?;
        Ok(encrypt_message(&v.to_string(), &phrase))
    }

    fn decrypt(&self, ciphertext: &str, iv: &str) -> Result<Value> {
        let phrase = self.phrase().ok_or(Error::EncryptionDisabled)?;
        let plain =
            decrypt_message(ciphertext, iv, &phrase).map_err(|e| Error::Other(e.to_string()))?;
        serde_json::from_str(&plain).map_err(|e| Error::Other(e.to_string()))
    }

    fn hashed_stream_id(&self, stream_id: &str) -> String {
        let st = self.st.lock().unwrap();
        if st.no_password {
            stream_id.to_string()
        } else {
            format!("{stream_id}{}", st.password_hash)
        }
    }

    fn strip_hash(&self, stream_id: &str) -> String {
        let st = self.st.lock().unwrap();
        if st.no_password {
            stream_id.to_string()
        } else {
            protocol::strip_hash(stream_id, &st.password_hash).to_string()
        }
    }

    // ------------------------------------------------------------ signaling

    async fn connect(self: Arc<Self>) -> Result<()> {
        let (host, generation) = {
            let mut st = self.st.lock().unwrap();
            if st.connected {
                return Ok(());
            }
            st.intentional = false;
            (self.opts.host.clone(), st.generation)
        };
        let (ws, _) = tokio_tungstenite::connect_async(&host).await?;
        let (mut sink, mut source) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        let queued = {
            let mut st = self.st.lock().unwrap();
            if generation != st.generation || st.intentional {
                return Err(Error::Cancelled);
            }
            st.connected = true;
            if !st.reconnecting {
                st.reconnects = 0;
            }
            std::mem::take(&mut st.queue)
        };
        *self.ws_tx.lock().unwrap() = Some(tx.clone());
        for text in queued {
            let _ = tx.send(text);
        }
        let writer = tokio::spawn(async move {
            while let Some(text) = rx.recv().await {
                if sink.send(Message::text(text)).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });
        let me = self.clone();
        let reader = tokio::spawn(async move {
            while let Some(Ok(msg)) = source.next().await {
                if let Message::Text(text) = msg {
                    let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else {
                        continue;
                    };
                    if !value.is_object() {
                        continue;
                    }
                    log::debug!("<- WS {}", truncate(text.as_str(), 300));
                    me.clone().handle_signaling(value).await;
                }
            }
            writer.abort();
            me.on_socket_closed(generation).await;
        });
        self.st.lock().unwrap().tasks.push(reader);
        log::debug!("WebSocket connected to {host}");
        self.emit(Event::Connected);
        Ok(())
    }

    async fn on_socket_closed(self: Arc<Self>, generation: u64) {
        let (intentional, will_reconnect) = {
            let mut st = self.st.lock().unwrap();
            if generation != st.generation {
                return;
            }
            st.connected = false;
            st.room_joined = false;
            st.publishing = false;
            (
                st.intentional,
                !st.intentional && st.reconnects < self.opts.max_reconnect_attempts,
            )
        };
        *self.ws_tx.lock().unwrap() = None;
        if intentional {
            return;
        }
        self.emit(Event::Disconnected {
            intentional: false,
            reason: "socket-closed".into(),
            will_reconnect,
        });
        if will_reconnect {
            let me = self.clone();
            let task = tokio::spawn(async move { me.reconnect(generation).await });
            self.st.lock().unwrap().reconnect_task = Some(task);
        }
    }

    // Boxed to break the async type cycle connect -> reader task -> on_socket_closed -> reconnect -> connect.
    fn reconnect(self: Arc<Self>, generation: u64) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        Box::pin(async move {
            loop {
                let attempt = {
                    let mut st = self.st.lock().unwrap();
                    if st.intentional || generation != st.generation || st.connected {
                        if st.connected {
                            st.reconnects = 0;
                        }
                        st.reconnecting = false;
                        return;
                    }
                    if st.reconnects >= self.opts.max_reconnect_attempts {
                        st.reconnecting = false;
                        drop(st);
                        self.emit(Event::ReconnectFailed);
                        return;
                    }
                    st.reconnecting = true;
                    st.reconnects += 1;
                    st.reconnects
                };
                let delay = (self.opts.reconnect_delay * 2u32.saturating_pow(attempt - 1))
                    .min(Duration::from_secs(30));
                self.emit(Event::Reconnecting { attempt });
                tokio::time::sleep(delay).await;
                match tokio::time::timeout(Duration::from_secs(20), self.clone().connect()).await {
                    Ok(Ok(())) => {}
                    _ => continue,
                }
                self.clone().restore_intent().await;
                {
                    let mut st = self.st.lock().unwrap();
                    st.reconnects = 0;
                    st.reconnecting = false;
                }
                self.emit(Event::Reconnected);
                return;
            }
        })
    }

    async fn restore_intent(self: Arc<Self>) {
        let (room, stream_id, data_only, tracks, views) = {
            let st = self.st.lock().unwrap();
            let views: Vec<(String, ViewOptions)> = st
                .view_intent
                .iter()
                .filter(|(k, _)| !st.stopped_views.contains(*k))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            (
                st.intent_room.clone(),
                st.stream_id.clone(),
                st.data_only,
                st.local_tracks.clone(),
                views,
            )
        };
        if let Some(room) = room {
            if let Err(e) = self.clone().join_room(&room.room, None, room.claim).await {
                log::debug!("restore room failed: {e}");
            }
        }
        if let Some(sid) = stream_id {
            if data_only || !tracks.is_empty() {
                let _ = self
                    .clone()
                    .seed(
                        tracks,
                        data_only,
                        PublishOptions {
                            stream_id: Some(sid),
                            ..Default::default()
                        },
                    )
                    .await;
            }
        }
        for (sid, opts) in views {
            let me = self.clone();
            tokio::spawn(async move {
                let _ = me.view(&sid, opts).await;
            });
        }
    }

    async fn disconnect(self: Arc<Self>) {
        let (conns, pending, inbound, tasks) = {
            let mut st = self.st.lock().unwrap();
            st.intentional = true;
            st.generation += 1;
            st.connected = false;
            st.room_joined = false;
            st.publishing = false;
            // A full local teardown: a later connect() must not replay this state.
            st.intent_room = None;
            st.stream_id = None;
            st.data_only = false;
            st.local_tracks.clear();
            st.view_intent.clear();
            st.stopped_views.clear();
            st.reconnects = 0;
            st.reconnecting = false;
            st.queue.clear();
            for (_, t) in st.view_retry.drain() {
                t.abort();
            }
            if let Some(t) = st.reconnect_task.take() {
                t.abort();
            }
            st.pending_views.clear();
            st.pending_ice.clear();
            st.room_waiters.clear();
            st.view_waiters.clear();
            let pending: Vec<_> = st.pending_requests.drain().map(|(_, (_, tx))| tx).collect();
            let inbound: Vec<Arc<InboundTransfer>> = st.inbound.drain().map(|(_, t)| t).collect();
            let tasks = std::mem::take(&mut st.tasks);
            let conns: Vec<Arc<Connection>> = self
                .conns
                .lock()
                .unwrap()
                .drain()
                .flat_map(|(_, p)| [p.publisher, p.viewer])
                .flatten()
                .collect();
            (conns, pending, inbound, tasks)
        };
        for tx in pending {
            let _ = tx.send(Err(Error::Cancelled));
        }
        for t in inbound {
            if let Some(done) = t.state.lock().unwrap().done.take() {
                let _ = done.send(Err(Error::Cancelled));
            }
        }
        for c in &conns {
            c.send_control(&json!({"bye": true})).await;
        }
        flush_byes(&conns).await;
        for c in &conns {
            c.close().await;
        }
        *self.ws_tx.lock().unwrap() = None;
        for t in tasks {
            t.abort();
        }
        self.emit(Event::Disconnected {
            intentional: true,
            reason: "local-disconnect".into(),
            will_reconnect: false,
        });
    }

    fn send_ws(&self, msg: Value) -> bool {
        let text = msg.to_string();
        log::debug!("-> WS {}", truncate(&text, 300));
        let tx = self.ws_tx.lock().unwrap().clone();
        match tx {
            Some(tx) => tx.send(text).is_ok(),
            None => {
                let mut st = self.st.lock().unwrap();
                if st.intentional {
                    return false;
                }
                st.queue.push(text);
                if st.queue.len() > SIGNALING_QUEUE_LIMIT {
                    let excess = st.queue.len() - SIGNALING_QUEUE_LIMIT;
                    st.queue.drain(..excess);
                }
                true
            }
        }
    }

    // ------------------------------------------------------------------ rooms

    async fn join_room(
        self: Arc<Self>,
        room: &str,
        password: Option<&str>,
        claim: bool,
    ) -> Result<()> {
        let (hashed, room, rx, generation) = {
            let mut st = self.st.lock().unwrap();
            if !st.connected {
                return Err(Error::NotConnected);
            }
            let mut r = sanitize_room(room);
            if r.is_empty() {
                r = st.room.clone();
            }
            if r.is_empty() {
                return Err(Error::RoomRequired);
            }
            if st.room_joined {
                if st.room == r {
                    return Ok(());
                }
                return Err(Error::AlreadyInRoom);
            }
            if let Some(pw) = password {
                st.password = sanitize_password(pw);
                if st.password.is_empty() {
                    st.password = DEFAULT_PASSWORD.into();
                }
                st.no_password = false;
                let salt = st.salt.clone();
                st.password_hash = stream_hash_suffix(&st.password, &salt);
            }
            st.intent_room = Some(RoomIntent {
                room: r.clone(),
                claim,
            });
            let hashed = if st.no_password {
                r.clone()
            } else {
                let pw = if st.password.is_empty() {
                    sanitize_password(DEFAULT_PASSWORD)
                } else {
                    st.password.clone()
                };
                hash_room(&r, &pw, &st.salt)
            };
            let (tx, rx) = oneshot::channel();
            st.room_waiters.push(tx);
            (hashed, r, rx, st.generation)
        };
        let mut msg = json!({"request": "joinroom", "roomid": hashed});
        if claim {
            msg["claim"] = json!(true);
        }
        log::debug!("joining room {room:?} as {hashed:?}");
        self.send_ws(msg);
        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => return Err(Error::Cancelled),
            Err(_) => return Err(Error::RoomJoinTimeout),
        }
        {
            let mut st = self.st.lock().unwrap();
            if generation != st.generation || st.intentional {
                return Err(Error::Cancelled);
            }
            st.room = room.clone();
            st.room_joined = true;
        }
        self.emit(Event::RoomJoined { room });
        Ok(())
    }

    // ------------------------------------------------------------- publishing

    async fn seed(
        self: Arc<Self>,
        tracks: Vec<Arc<dyn TrackLocal>>,
        data_only: bool,
        opts: PublishOptions,
    ) -> Result<String> {
        let (generation, stream_id, room_joined) = {
            let mut st = self.st.lock().unwrap();
            if !st.connected {
                return Err(Error::NotConnected);
            }
            apply_publisher_info(
                &mut st.publisher_info,
                opts.label.as_deref(),
                opts.meta.as_ref(),
                opts.order.as_deref(),
                opts.info.as_ref(),
            );
            let sid = match &opts.stream_id {
                Some(s) if !s.is_empty() => sanitize_stream_id(s),
                _ => st.stream_id.clone().unwrap_or_else(generate_stream_id),
            };
            (st.generation, sid, st.room_joined)
        };
        if !room_joined {
            if let Some(room) = &opts.room {
                self.clone()
                    .join_room(room, opts.password.as_deref(), false)
                    .await?;
            }
        }
        {
            let mut st = self.st.lock().unwrap();
            if generation != st.generation || st.intentional {
                return Err(Error::Cancelled);
            }
            st.stream_id = Some(stream_id.clone());
            st.publishing = true;
            st.data_only = data_only;
            if !data_only {
                st.local_tracks = tracks;
            }
            st.streams.insert(
                stream_id.clone(),
                StreamInfo {
                    uuid: None,
                    state: "connected",
                    last_seen: Instant::now(),
                },
            );
        }
        let hashed = self.hashed_stream_id(&stream_id);
        log::debug!("seeding {stream_id:?} as {hashed:?} (data_only={data_only})");
        self.send_ws(json!({"request": "seed", "streamID": hashed}));
        self.emit(Event::Publishing {
            stream_id: stream_id.clone(),
            data_only,
        });
        Ok(stream_id)
    }

    async fn stop_publishing(self: Arc<Self>) {
        let sid = {
            let mut st = self.st.lock().unwrap();
            if !st.publishing && st.stream_id.is_none() {
                return;
            }
            st.publishing = false;
            st.local_tracks.clear();
            st.stream_id.take()
        };
        let closing: Vec<Arc<Connection>> = {
            let mut conns = self.conns.lock().unwrap();
            let mut out = vec![];
            conns.retain(|_, p| {
                if let Some(c) = p.publisher.take() {
                    out.push(c);
                }
                !p.is_empty()
            });
            out
        };
        for c in &closing {
            c.send_control(&json!({"bye": true})).await;
        }
        flush_byes(&closing).await;
        for c in closing {
            c.close().await;
        }
        self.emit(Event::PublishingStopped { stream_id: sid });
    }

    // ---------------------------------------------------------------- viewing

    async fn view(self: Arc<Self>, stream_id: &str, opts: ViewOptions) -> Result<Arc<Connection>> {
        let mut opts = opts;
        opts.label = opts
            .label
            .as_deref()
            .map(sanitize_label)
            .filter(|l| !l.is_empty());
        let existing = self
            .conns
            .lock()
            .unwrap()
            .values()
            .filter_map(|p| p.viewer.clone())
            .find(|c| c.stream_id().as_deref() == Some(stream_id));
        let (hashed, rx, generation) = {
            let mut st = self.st.lock().unwrap();
            if !st.connected {
                return Err(Error::NotConnected);
            }
            let info = st
                .streams
                .entry(stream_id.to_string())
                .or_insert(StreamInfo {
                    uuid: None,
                    state: "pending",
                    last_seen: Instant::now(),
                });
            info.last_seen = Instant::now();
            info.state = "pending";
            st.view_intent.insert(stream_id.to_string(), opts.clone());
            st.stopped_views.remove(stream_id);
            st.pending_views.insert(stream_id.to_string(), opts.clone());
            if let Some(t) = st.view_retry.remove(stream_id) {
                t.abort();
            }
            let (tx, rx) = oneshot::channel();
            st.view_waiters
                .entry(stream_id.to_string())
                .or_default()
                .push(tx);
            let hashed = if st.no_password {
                stream_id.to_string()
            } else {
                format!("{stream_id}{}", st.password_hash)
            };
            (hashed, rx, st.generation)
        };
        if let Some(c) = existing {
            drop(rx);
            self.prune_view_waiters(stream_id);
            return Ok(c);
        }
        log::debug!("requesting stream {stream_id:?} as {hashed:?}");
        self.send_ws(json!({"request": "play", "streamID": hashed}));
        match tokio::time::timeout(opts.timeout, rx).await {
            Ok(Ok(c)) => Ok(c),
            Ok(Err(_)) => Err(Error::Cancelled),
            Err(_) => {
                // The receiver was dropped with the timeout; forget its sender so
                // retries of a stream that never appears do not accumulate.
                self.prune_view_waiters(stream_id);
                {
                    let st = self.st.lock().unwrap();
                    if generation != st.generation || st.intentional {
                        return Err(Error::Cancelled);
                    }
                }
                self.schedule_view_retry(stream_id, opts, self.opts.view_retry_interval);
                Err(Error::StreamNotYetAvailable)
            }
        }
    }

    /// Removes view waiters whose receiver is gone (timed out or returned early).
    fn prune_view_waiters(&self, stream_id: &str) {
        let mut st = self.st.lock().unwrap();
        if let Some(list) = st.view_waiters.get_mut(stream_id) {
            list.retain(|tx| !tx.is_closed());
            if list.is_empty() {
                st.view_waiters.remove(stream_id);
            }
        }
    }

    fn schedule_view_retry(self: &Arc<Self>, stream_id: &str, opts: ViewOptions, delay: Duration) {
        let mut st = self.st.lock().unwrap();
        if st.intentional || st.stopped_views.contains(stream_id) {
            return;
        }
        if let Some(t) = st.view_retry.remove(stream_id) {
            t.abort();
        }
        let generation = st.generation;
        let me = self.clone();
        let sid = stream_id.to_string();
        let task = tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            {
                let mut st = me.st.lock().unwrap();
                st.view_retry.remove(&sid);
                if generation != st.generation
                    || st.intentional
                    || st.stopped_views.contains(&sid)
                    || !st.connected
                {
                    return;
                }
            }
            log::debug!("retrying view for {sid:?}");
            let _ = me.view(&sid, opts).await;
        });
        st.view_retry.insert(stream_id.to_string(), task);
    }

    async fn stop_viewing(self: Arc<Self>, stream_id: &str) {
        {
            let mut st = self.st.lock().unwrap();
            st.view_intent.remove(stream_id);
            st.stopped_views.insert(stream_id.to_string());
            if let Some(t) = st.view_retry.remove(stream_id) {
                t.abort();
            }
            st.pending_views.remove(stream_id);
            if let Some(info) = st.streams.get_mut(stream_id) {
                info.state = "available";
            }
        }
        let closing: Vec<Arc<Connection>> = {
            let mut conns = self.conns.lock().unwrap();
            let mut out = vec![];
            conns.retain(|_, p| {
                let matches = p
                    .viewer
                    .as_ref()
                    .map(|c| c.stream_id().as_deref() == Some(stream_id))
                    .unwrap_or(false);
                if matches {
                    if let Some(c) = p.viewer.take() {
                        out.push(c);
                    }
                }
                !p.is_empty()
            });
            out
        };
        for c in &closing {
            c.send_control(&json!({"bye": true})).await;
        }
        flush_byes(&closing).await;
        for c in closing {
            c.close().await;
        }
        self.emit(Event::ViewingStopped {
            stream_id: stream_id.to_string(),
        });
    }

    fn find_connection(&self, uuid: &str, kind: Option<&str>) -> Option<Arc<Connection>> {
        let conns = self.conns.lock().unwrap();
        let p = conns.get(uuid)?;
        match kind {
            Some("publisher") => p.publisher.clone(),
            Some("viewer") => p.viewer.clone(),
            _ => p.publisher.clone().or_else(|| p.viewer.clone()),
        }
    }

    fn is_current(&self, c: &Arc<Connection>) -> bool {
        let conns = self.conns.lock().unwrap();
        conns
            .get(&c.uuid)
            .map(|p| {
                p.publisher
                    .as_ref()
                    .map(|x| Arc::ptr_eq(x, c))
                    .unwrap_or(false)
                    || p.viewer
                        .as_ref()
                        .map(|x| Arc::ptr_eq(x, c))
                        .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    // ------------------------------------------------------- signaling input

    async fn handle_signaling(self: Arc<Self>, msg: Value) {
        let uuid = jstr(&msg, "UUID");
        if msg.get("description").is_some() {
            self.handle_sdp(&msg, None).await;
        } else if msg.get("candidate").is_some() {
            self.handle_candidates(&msg, None, true).await;
        } else if msg.get("candidates").is_some() {
            self.handle_candidates(&msg, None, false).await;
        } else if msg.get("iceRestartRequest").is_some() && uuid.is_some() {
            if let Some(c) = self.find_connection(uuid.as_deref().unwrap(), Some("publisher")) {
                self.restart_ice(&c, "remote_request", true).await;
            }
        } else if let Some(request) = jstr(&msg, "request") {
            match request.as_str() {
                "joinroom" => {
                    if let Some(u) = uuid {
                        if self.st.lock().unwrap().publishing {
                            let session = jstr(&msg, "session").unwrap_or_else(|| u.clone());
                            self.handle_offer_request(&u, Some(session)).await;
                        }
                    }
                }
                "play" => {
                    let requested = self.strip_hash(&jstr(&msg, "streamID").unwrap_or_default());
                    let ok = {
                        let st = self.st.lock().unwrap();
                        st.publishing && st.stream_id.as_deref() == Some(requested.as_str())
                    };
                    if ok {
                        if let Some(u) = uuid {
                            self.handle_offer_request(&u, None).await;
                        }
                    }
                }
                "listing" => self.handle_listing(&msg),
                "videoaddedtoroom" => self.handle_video_added(&msg),
                "someonejoined" => {
                    let clean = jstr(&msg, "streamID").map(|s| self.strip_hash(&s));
                    if let Some(c) = &clean {
                        self.emit(Event::VideoAddedToRoom {
                            stream_id: c.clone(),
                            uuid: uuid.clone(),
                        });
                    }
                    self.emit(Event::SomeoneJoined {
                        stream_id: clean,
                        uuid,
                        raw: msg.clone(),
                    });
                }
                "error" => self.emit(Event::Error {
                    message: jstr(&msg, "message").unwrap_or_default(),
                    uuid: None,
                }),
                "alert" => {
                    let text = jstr(&msg, "message").unwrap_or_default();
                    if text.contains("Stream ID is already in use") {
                        let mut st = self.st.lock().unwrap();
                        st.publishing = false;
                        st.stream_id = None;
                    }
                    self.emit(Event::Alert {
                        message: text,
                        raw: msg.clone(),
                    });
                }
                "transferred" => {
                    self.emit(Event::Transferred { raw: msg.clone() });
                    self.handle_listing(&msg);
                }
                "offerSDP" => {
                    if let Some(u) = uuid {
                        self.handle_offer_request(&u, None).await;
                    }
                }
                _ => {}
            }
        } else if msg.get("rejected").is_some() {
            self.emit(Event::Alert {
                message: "connection rejected".into(),
                raw: msg.clone(),
            });
        } else if msg.get("approved").is_some() {
            self.emit(Event::Alert {
                message: "connection approved".into(),
                raw: msg.clone(),
            });
        } else if is_truthy(msg.get("bye")) {
            if let Some(u) = uuid {
                self.handle_bye(&u, "bye", msg.clone()).await;
            }
        } else if is_truthy(msg.get("hangup")) {
            if let Some(u) = uuid {
                self.handle_bye(&u, "hangup", msg.clone()).await;
            }
        }
    }

    fn handle_listing(&self, msg: &Value) {
        let (waiters, entries) = {
            let mut st = self.st.lock().unwrap();
            let waiters = std::mem::take(&mut st.room_waiters);
            let suffix = if st.no_password {
                String::new()
            } else {
                st.password_hash.clone()
            };
            let mut entries = vec![];
            if let Some(list) = msg.get("list").and_then(|l| l.as_array()) {
                for item in list {
                    let mut e = ListingEntry::default();
                    match item {
                        Value::String(s) => {
                            e.stream_id = Some(protocol::strip_hash(s, &suffix).to_string())
                        }
                        Value::Object(_) => {
                            e.stream_id = jstr(item, "streamID")
                                .map(|s| protocol::strip_hash(&s, &suffix).to_string());
                            e.uuid = jstr(item, "UUID").or_else(|| jstr(item, "uuid"));
                            e.label = jstr(item, "label");
                            e.director = item
                                .get("director")
                                .and_then(|d| d.as_bool())
                                .unwrap_or(false);
                        }
                        _ => {}
                    }
                    if let Some(sid) = &e.stream_id {
                        let info = st.streams.entry(sid.clone()).or_insert(StreamInfo {
                            uuid: None,
                            state: "available",
                            last_seen: Instant::now(),
                        });
                        info.last_seen = Instant::now();
                        if e.uuid.is_some() {
                            info.uuid = e.uuid.clone();
                        }
                        if info.state == "disconnected" {
                            info.state = "available";
                        }
                    }
                    entries.push(e);
                }
            } else if let Some(sid) = jstr(msg, "streamID") {
                entries.push(ListingEntry {
                    stream_id: Some(protocol::strip_hash(&sid, &suffix).to_string()),
                    uuid: jstr(msg, "UUID"),
                    ..Default::default()
                });
            }
            (waiters, entries)
        };
        for w in waiters {
            let _ = w.send(());
        }
        self.emit(Event::Listing {
            list: entries,
            raw: msg.clone(),
        });
    }

    fn handle_video_added(self: &Arc<Self>, msg: &Value) {
        let uuid = jstr(msg, "UUID");
        let clean = jstr(msg, "streamID")
            .map(|s| self.strip_hash(&s))
            .unwrap_or_default();
        let pending = {
            let mut st = self.st.lock().unwrap();
            if !clean.is_empty() {
                let info = st.streams.entry(clean.clone()).or_insert(StreamInfo {
                    uuid: None,
                    state: "available",
                    last_seen: Instant::now(),
                });
                info.last_seen = Instant::now();
                if uuid.is_some() {
                    info.uuid = uuid.clone();
                }
            }
            // Keep preferences until SDP arrives: the server may immediately
            // wake a waiting viewer before our delayed play retry runs.
            st.pending_views.get(&clean).cloned()
        };
        if let Some(opts) = pending {
            log::debug!("re-requesting pending stream {clean:?}");
            let me = self.clone();
            let sid = clean.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let _ = me.view(&sid, opts).await;
            });
        }
        self.emit(Event::VideoAddedToRoom {
            stream_id: clean,
            uuid,
        });
    }

    async fn handle_offer_request(self: &Arc<Self>, uuid: &str, session: Option<String>) {
        let stream_id = {
            let st = self.st.lock().unwrap();
            if !st.publishing {
                return;
            }
            st.stream_id.clone()
        };
        let conn = match self.create_connection(uuid, "publisher").await {
            Ok(c) => c,
            Err(e) => {
                self.emit(Event::Error {
                    message: e.to_string(),
                    uuid: Some(uuid.into()),
                });
                return;
            }
        };
        {
            let mut cs = conn.cs.lock().unwrap();
            cs.stream_id = stream_id;
            cs.session = Some(session.unwrap_or_else(generate_session));
        }
        match self.create_offer(&conn, false).await {
            Ok(offer) => self.send_description(&conn, &offer, true, true).await,
            Err(e) => {
                log::debug!("create offer for {uuid} failed: {e}");
                self.emit(Event::Error {
                    message: format!("failed to create offer: {e}"),
                    uuid: Some(uuid.into()),
                });
            }
        }
    }

    async fn handle_bye(self: &Arc<Self>, uuid: &str, kind: &str, raw: Value) {
        let pair = {
            let mut st = self.st.lock().unwrap();
            st.pending_ice.remove(&format!("local:{uuid}"));
            st.pending_ice.remove(&format!("remote:{uuid}"));
            drop(st);
            self.conns.lock().unwrap().remove(uuid)
        };
        let mut retry = None;
        let mut closing = vec![];
        if let Some(p) = pair {
            // Only bye re-requests the stream (JS _handleBye); hangup does not.
            if let (Some(v), "bye") = (&p.viewer, kind) {
                if let Some(sid) = v.stream_id() {
                    let st = self.st.lock().unwrap();
                    if !st.intentional && !st.stopped_views.contains(&sid) {
                        retry = Some((sid, v.cs.lock().unwrap().view_options.clone()));
                    }
                }
            }
            closing.extend([p.publisher, p.viewer].into_iter().flatten());
        }
        if let Some((sid, opts)) = retry {
            if let Some(info) = self.st.lock().unwrap().streams.get_mut(&sid) {
                info.state = "disconnected";
            }
            self.schedule_view_retry(&sid, opts, Duration::from_secs(2));
        }
        if kind == "bye" {
            self.emit(Event::Bye {
                uuid: uuid.into(),
                raw,
            });
        } else {
            self.emit(Event::Hangup {
                uuid: uuid.into(),
                raw,
            });
        }
        self.emit(Event::PeerDisconnected { uuid: uuid.into() });
        // A bye usually arrives on the connection's own control-channel task;
        // closing aborts that task, so the close must run elsewhere.
        for c in closing {
            close_later(c);
        }
    }

    // -------------------------------------------------------- peer connection

    async fn ice_servers(&self) -> Vec<RTCIceServer> {
        let mut servers: Vec<RTCIceServer> = self
            .opts
            .stun_servers
            .iter()
            .map(|u| RTCIceServer {
                urls: vec![u.clone()],
                ..Default::default()
            })
            .collect();
        let turn: Vec<IceServer> = match &self.opts.turn {
            TurnMode::Disabled => vec![],
            TurnMode::Custom(list) => list.clone(),
            TurnMode::Auto => {
                let mut cache = self.turn.lock().await;
                if cache.list.is_none() || cache.fetched.elapsed() > self.opts.turn_cache_ttl {
                    let list = fetch_turn_list(&self.opts.turn_url).await;
                    cache.list = Some(select_turn_servers(
                        &list,
                        local_tz_offset_minutes(),
                        self.opts.force_tcp,
                    ));
                    cache.fetched = Instant::now();
                }
                cache.list.clone().unwrap_or_default()
            }
        };
        servers.extend(turn.into_iter().map(|s| RTCIceServer {
            urls: s.urls,
            username: s.username,
            credential: s.credential,
        }));
        servers
    }

    async fn create_connection(
        self: &Arc<Self>,
        uuid: &str,
        kind: &'static str,
    ) -> Result<Arc<Connection>> {
        let mut cfg = RTCConfigurationBuilder::new().with_ice_servers(self.ice_servers().await);
        if self.opts.force_turn {
            cfg = cfg.with_ice_transport_policy(RTCIceTransportPolicy::Relay);
        }
        let mut media = MediaEngine::default();
        media.register_default_codecs()?;
        let registry = register_default_interceptors(Registry::new(), &mut media)?;
        // Answer as the DTLS server: the SCTP association is then initiated by the
        // offerer, which every engine does, instead of by both sides at once
        // (aiortc rejects the resulting INIT collision).
        let setting = SettingEngineBuilder::new()
            .with_include_loopback_candidate(self.opts.include_loopback)
            .with_answering_dtls_role(rtc::peer_connection::transport::RTCDtlsRole::Server)
            .build();
        let slot: Arc<OnceLock<Weak<Connection>>> = Arc::new(OnceLock::new());
        let handler = Arc::new(PcHandler {
            inner: Arc::downgrade(self),
            conn: slot.clone(),
        });
        let pc = PeerConnectionBuilder::new()
            .with_configuration(cfg.build())
            .with_media_engine(media)
            .with_interceptor_registry(registry)
            .with_setting_engine(setting)
            .with_handler(handler)
            .with_udp_addrs(self.opts.bind_addrs.clone())
            .build()
            .await?;
        let pc: Arc<dyn PeerConnection> = Arc::new(pc);
        let conn = Arc::new(Connection {
            uuid: uuid.to_string(),
            kind,
            pc: pc.clone(),
            cs: Mutex::new(ConnState {
                control: None,
                channels: HashMap::new(),
                stream_id: None,
                session: None,
                info: Map::new(),
                obs_state: Map::new(),
                allow_audio: true,
                allow_video: true,
                allow_downloads: false,
                allow_resources: false,
                view_options: ViewOptions::default(),
                senders: vec![],
                ice_bundle: vec![],
                ice_timer_running: false,
                ice_delay: Duration::from_millis(70),
                pending_ping: None,
                missed_pings: 0,
                peer_state: RTCPeerConnectionState::New,
                ice_state: RTCIceConnectionState::New,
                connected_once: false,
                finalized: false,
                recovering: false,
                disconnect_timer: None,
                connect_timer: None,
                recovery_timer: None,
                ping_task: None,
                advertised: HashSet::new(),
                tasks: vec![],
            }),
            control_open: AtomicBool::new(false),
            remote_set: AtomicBool::new(false),
        });
        let _ = slot.set(Arc::downgrade(&conn));
        if kind == "publisher" {
            let dc = pc
                .create_data_channel(
                    CONTROL_CHANNEL_LABEL,
                    Some(RTCDataChannelInit {
                        ordered: true,
                        ..Default::default()
                    }),
                )
                .await?;
            {
                let mut cs = conn.cs.lock().unwrap();
                cs.control = Some(dc.clone());
                cs.channels.insert(CONTROL_CHANNEL_LABEL.into(), dc.clone());
            }
            self.pump_control_channel(conn.clone(), dc);
        }
        let old = {
            let mut conns = self.conns.lock().unwrap();
            conns
                .entry(uuid.to_string())
                .or_default()
                .set(kind, Some(conn.clone()))
        };
        if let Some(old) = old {
            log::debug!("replacing existing {kind} connection to {uuid}");
            old.close().await;
        }
        let me = self.clone();
        let c2 = conn.clone();
        let timeout = self.opts.connection_timeout;
        let timer = tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            c2.cs.lock().unwrap().connect_timer = None;
            if !me.is_current(&c2) {
                return;
            }
            if !is_transport_connected(&c2) {
                me.recover(&c2, "connect-timeout").await;
            }
        });
        conn.cs.lock().unwrap().connect_timer = Some(timer);
        Ok(conn)
    }

    async fn create_offer(
        &self,
        conn: &Arc<Connection>,
        ice_restart: bool,
    ) -> Result<RTCSessionDescription> {
        if conn.kind == "publisher" && conn.cs.lock().unwrap().senders.is_empty() {
            let tracks = self.st.lock().unwrap().local_tracks.clone();
            for t in tracks {
                let kind = t.kind().await;
                let (allow_audio, allow_video) = {
                    let cs = conn.cs.lock().unwrap();
                    (cs.allow_audio, cs.allow_video)
                };
                if (kind == RtpCodecKind::Audio && !allow_audio)
                    || (kind == RtpCodecKind::Video && !allow_video)
                {
                    continue;
                }
                let sender = conn.pc.add_track(t).await?;
                conn.cs.lock().unwrap().senders.push((sender, kind));
            }
        }
        let options = if ice_restart {
            Some(RTCOfferOptions { ice_restart: true })
        } else {
            None
        };
        let offer = conn.pc.create_offer(options).await?;
        conn.pc.set_local_description(offer.clone()).await?;
        Ok(offer)
    }

    /// `allow_dc`: send over the control channel when it is open (renegotiation);
    /// a failure-triggered ICE restart passes `false` since that channel may be dead.
    async fn send_description(
        &self,
        conn: &Arc<Connection>,
        desc: &RTCSessionDescription,
        include_stream_id: bool,
        allow_dc: bool,
    ) {
        let wire = SessionDescription {
            kind: desc.sdp_type.to_string(),
            sdp: desc.sdp.clone(),
        };
        let mut msg = json!({"UUID": conn.uuid, "session": conn.session()});
        if include_stream_id {
            if let Some(sid) = conn.stream_id() {
                msg["streamID"] = json!(self.hashed_stream_id(&sid));
            }
        }
        if self.effective_password().is_some() {
            match self.encrypt(&serde_json::to_value(&wire).unwrap()) {
                Ok((enc, iv)) => {
                    msg["description"] = json!(enc);
                    msg["vector"] = json!(iv);
                }
                Err(e) => {
                    self.emit(Event::Error {
                        message: format!("failed to encrypt description: {e}"),
                        uuid: Some(conn.uuid.clone()),
                    });
                    return;
                }
            }
        } else {
            msg["description"] = serde_json::to_value(&wire).unwrap();
        }
        if allow_dc && conn.is_control_open() {
            let mut dc_msg = json!({"description": msg["description"], "session": msg["session"]});
            if let Some(v) = msg.get("vector") {
                dc_msg["vector"] = v.clone();
            }
            if conn.send_control(&dc_msg).await {
                return;
            }
        }
        self.send_ws(msg);
    }

    fn decode_description(&self, msg: &Value) -> Option<SessionDescription> {
        let desc = match msg.get("description")? {
            Value::String(ct) => {
                let iv = jstr(msg, "vector")?;
                match self.decrypt(ct, &iv) {
                    Ok(v) => v,
                    Err(e) => {
                        log::debug!("failed to decrypt description: {e}");
                        return None;
                    }
                }
            }
            v => v.clone(),
        };
        let d: SessionDescription = serde_json::from_value(desc).ok()?;
        if d.sdp.is_empty() {
            return None;
        }
        Some(d)
    }

    async fn handle_sdp(self: &Arc<Self>, msg: &Value, via: Option<&Arc<Connection>>) {
        let Some(desc) = self.decode_description(msg) else {
            return;
        };
        let uuid = via
            .map(|c| c.uuid.clone())
            .or_else(|| jstr(msg, "UUID"))
            .unwrap_or_default();
        let session = jstr(msg, "session").or_else(|| via.and_then(|c| c.session()));
        match desc.kind.as_str() {
            "offer" => self.handle_offer(&uuid, session, msg, desc, via).await,
            "answer" => self.handle_answer(&uuid, session, desc).await,
            _ => {}
        }
    }

    async fn handle_offer(
        self: &Arc<Self>,
        uuid: &str,
        session: Option<String>,
        msg: &Value,
        desc: SessionDescription,
        via: Option<&Arc<Connection>>,
    ) {
        let raw_stream = jstr(msg, "streamID");
        let clean = raw_stream.as_deref().map(|s| self.strip_hash(s));
        let mut conn = match via {
            Some(c) if c.kind == "viewer" => Some(c.clone()),
            _ => self.find_connection(uuid, Some("viewer")),
        };
        if let Some(c) = &conn {
            let cur = c.session();
            if cur.is_some() && session.is_some() && cur != session {
                log::debug!("session mismatch for {uuid}; replacing viewer connection");
                if let Some(p) = self.conns.lock().unwrap().get_mut(uuid) {
                    if p.viewer
                        .as_ref()
                        .map(|x| Arc::ptr_eq(x, c))
                        .unwrap_or(false)
                    {
                        p.viewer = None;
                    }
                }
                close_later(c.clone());
                conn = None;
            }
        }
        let conn = match conn {
            Some(c) => {
                {
                    let mut cs = c.cs.lock().unwrap();
                    if cs.session.is_none() {
                        cs.session = session.clone();
                    }
                    if cs.stream_id.is_none() {
                        cs.stream_id = clean.clone();
                    }
                }
                c
            }
            None => {
                let opts = clean.as_ref().and_then(|s| {
                    let st = self.st.lock().unwrap();
                    st.pending_views
                        .get(s)
                        .or_else(|| st.view_intent.get(s))
                        .cloned()
                });
                let c = match self.create_connection(uuid, "viewer").await {
                    Ok(c) => c,
                    Err(e) => {
                        self.emit(Event::Error {
                            message: e.to_string(),
                            uuid: Some(uuid.into()),
                        });
                        return;
                    }
                };
                {
                    let mut cs = c.cs.lock().unwrap();
                    cs.session = session.clone();
                    cs.stream_id = clean.clone();
                    cs.view_options = opts.unwrap_or_default();
                }
                if let Some(s) = &clean {
                    if let Some(info) = self.st.lock().unwrap().streams.get_mut(s) {
                        info.uuid = Some(uuid.to_string());
                    }
                }
                c
            }
        };
        let remote = match RTCSessionDescription::offer(desc.sdp) {
            Ok(d) => d,
            Err(e) => {
                self.emit(Event::Error {
                    message: format!("bad offer: {e}"),
                    uuid: Some(uuid.into()),
                });
                return;
            }
        };
        if let Err(e) = conn.pc.set_remote_description(remote).await {
            self.emit(Event::Error {
                message: format!("failed to handle offer: {e}"),
                uuid: Some(uuid.into()),
            });
            return;
        }
        conn.remote_set.store(true, Ordering::Release);
        self.drain_pending_ice(&conn, "local").await;
        let answer = match conn.pc.create_answer(None).await {
            Ok(a) => a,
            Err(e) => {
                self.emit(Event::Error {
                    message: format!("failed to create answer: {e}"),
                    uuid: Some(uuid.into()),
                });
                return;
            }
        };
        if let Err(e) = conn.pc.set_local_description(answer.clone()).await {
            self.emit(Event::Error {
                message: format!("failed to set answer: {e}"),
                uuid: Some(uuid.into()),
            });
            return;
        }
        let wire = SessionDescription {
            kind: "answer".into(),
            sdp: answer.sdp.clone(),
        };
        let mut out = json!({"UUID": uuid, "session": session});
        if let Some(raw) = &raw_stream {
            out["streamID"] = json!(raw);
        }
        if self.effective_password().is_some() {
            match self.encrypt(&serde_json::to_value(&wire).unwrap()) {
                Ok((enc, iv)) => {
                    out["description"] = json!(enc);
                    out["vector"] = json!(iv);
                }
                Err(e) => {
                    self.emit(Event::Error {
                        message: e.to_string(),
                        uuid: Some(uuid.into()),
                    });
                    return;
                }
            }
        } else {
            out["description"] = serde_json::to_value(&wire).unwrap();
        }
        if conn.is_control_open() {
            let mut dc_msg = json!({"description": out["description"]});
            if let Some(v) = out.get("vector") {
                dc_msg["vector"] = v.clone();
            }
            conn.send_control(&dc_msg).await;
        } else {
            self.send_ws(out);
        }
        if let Some(s) = clean {
            let waiters = {
                let mut st = self.st.lock().unwrap();
                st.pending_views.remove(&s);
                st.view_waiters.remove(&s).unwrap_or_default()
            };
            for w in waiters {
                let _ = w.send(conn.clone());
            }
        }
    }

    async fn handle_answer(
        self: &Arc<Self>,
        uuid: &str,
        session: Option<String>,
        desc: SessionDescription,
    ) {
        let Some(conn) = self
            .find_connection(uuid, Some("publisher"))
            .or_else(|| self.find_connection(uuid, None))
        else {
            log::debug!("no connection for answer from {uuid}");
            return;
        };
        let cur = conn.session();
        if session.is_some() && cur.is_some() && session != cur {
            log::debug!("session mismatch; ignoring answer from {uuid}");
            return;
        }
        match RTCSessionDescription::answer(desc.sdp) {
            Ok(remote) => {
                if let Err(e) = conn.pc.set_remote_description(remote).await {
                    self.emit(Event::Error {
                        message: format!("failed to handle answer: {e}"),
                        uuid: Some(uuid.into()),
                    });
                    return;
                }
                conn.remote_set.store(true, Ordering::Release);
                self.drain_pending_ice(&conn, "remote").await;
            }
            Err(e) => self.emit(Event::Error {
                message: format!("bad answer: {e}"),
                uuid: Some(uuid.into()),
            }),
        }
    }

    async fn renegotiate(
        &self,
        conn: &Arc<Connection>,
        ice_restart: bool,
        allow_dc: bool,
    ) -> Result<()> {
        let options = if ice_restart {
            Some(RTCOfferOptions { ice_restart: true })
        } else {
            None
        };
        let offer = conn.pc.create_offer(options).await?;
        conn.pc.set_local_description(offer.clone()).await?;
        self.send_description(conn, &offer, !allow_dc, allow_dc)
            .await;
        Ok(())
    }

    /// Starts an ICE restart; returns whether it was initiated. `allow_dc` is
    /// true only when answering a remote `iceRestartRequest`: a restart after a
    /// failure goes over the signaling socket because the channel may be dead.
    async fn restart_ice(&self, conn: &Arc<Connection>, reason: &str, allow_dc: bool) -> bool {
        if conn.kind == "viewer" {
            // The publisher owns the offer: ask it, over the control channel
            // when open, otherwise through signaling (JS _requestConnectionICERestart).
            let sent = conn.send_control(&json!({"iceRestartRequest": true})).await
                || self.send_ws(json!({"UUID": conn.uuid, "iceRestartRequest": true}));
            if sent {
                self.emit(Event::IceRestart {
                    uuid: conn.uuid.clone(),
                    reason: reason.into(),
                });
            }
            return sent;
        }
        match self.renegotiate(conn, true, allow_dc).await {
            Ok(()) => {
                self.emit(Event::IceRestart {
                    uuid: conn.uuid.clone(),
                    reason: reason.into(),
                });
                true
            }
            Err(e) => {
                log::debug!("ICE restart failed for {}: {e}", conn.uuid);
                false
            }
        }
    }

    // ------------------------------------------------------------------- ICE

    async fn handle_local_candidate(self: &Arc<Self>, conn: Arc<Connection>, cand: IceCandidate) {
        let msg_type = protocol::candidate_type_for(conn.kind);
        if conn.is_control_open() {
            let mut msg = json!({"type": msg_type, "UUID": conn.uuid, "session": conn.session()});
            if self.effective_password().is_some() {
                match self.encrypt(&json!([cand])) {
                    Ok((enc, iv)) => {
                        msg["candidates"] = json!(enc);
                        msg["vector"] = json!(iv);
                    }
                    Err(e) => {
                        self.emit(Event::Error {
                            message: e.to_string(),
                            uuid: Some(conn.uuid.clone()),
                        });
                        return;
                    }
                }
            } else {
                msg["candidates"] = json!([cand]);
            }
            if conn.send_control(&msg).await {
                return;
            }
        }
        let delay = {
            let mut cs = conn.cs.lock().unwrap();
            cs.ice_bundle.push(cand);
            if cs.ice_timer_running {
                return;
            }
            cs.ice_timer_running = true;
            let d = cs.ice_delay;
            cs.ice_delay = (cs.ice_delay * 2).min(Duration::from_secs(1));
            d
        };
        let me = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            let (bundle, finalized) = {
                let mut cs = conn.cs.lock().unwrap();
                cs.ice_timer_running = false;
                (std::mem::take(&mut cs.ice_bundle), cs.finalized)
            };
            if finalized || bundle.is_empty() {
                return;
            }
            let mut msg = json!({"UUID": conn.uuid, "type": msg_type, "session": conn.session()});
            if me.effective_password().is_some() {
                match me.encrypt(&json!(bundle)) {
                    Ok((enc, iv)) => {
                        msg["candidates"] = json!(enc);
                        msg["vector"] = json!(iv);
                    }
                    Err(e) => {
                        me.emit(Event::Error {
                            message: format!("failed to encrypt ICE candidates: {e}"),
                            uuid: Some(conn.uuid.clone()),
                        });
                        return;
                    }
                }
            } else {
                msg["candidates"] = json!(bundle);
            }
            me.send_ws(msg);
        });
    }

    fn decode_candidates(&self, msg: &Value, single: bool) -> Vec<IceCandidate> {
        let key = if single { "candidate" } else { "candidates" };
        let value = match msg.get(key) {
            Some(Value::String(ct)) => {
                let Some(iv) = jstr(msg, "vector") else {
                    return vec![];
                };
                match self.decrypt(ct, &iv) {
                    Ok(v) => v,
                    Err(e) => {
                        log::debug!("failed to decrypt candidates: {e}");
                        return vec![];
                    }
                }
            }
            Some(v) => v.clone(),
            None => return vec![],
        };
        let list: Vec<Value> = match value {
            Value::Array(a) => a,
            Value::Object(_) => vec![value],
            _ => vec![],
        };
        list.into_iter()
            .filter_map(|v| serde_json::from_value::<IceCandidate>(v).ok())
            .filter(|c| !c.candidate.is_empty())
            .collect()
    }

    async fn handle_candidates(
        self: &Arc<Self>,
        msg: &Value,
        via: Option<&Arc<Connection>>,
        single: bool,
    ) {
        let cands = self.decode_candidates(msg, single);
        if cands.is_empty() {
            return;
        }
        let uuid = via
            .map(|c| c.uuid.clone())
            .or_else(|| jstr(msg, "UUID"))
            .unwrap_or_default();
        let msg_type = jstr(msg, "type");
        let conn = match msg_type.as_deref() {
            Some("remote") => self.find_connection(&uuid, Some("publisher")),
            Some("local") => self.find_connection(&uuid, Some("viewer")),
            _ => via.cloned().or_else(|| self.find_connection(&uuid, None)),
        };
        let session = jstr(msg, "session");
        let Some(conn) = conn.filter(|c| c.remote_set.load(Ordering::Acquire)) else {
            self.queue_pending_ice(&uuid, msg_type.as_deref(), session, cands);
            return;
        };
        let cur = conn.session();
        if session.is_some() && cur.is_some() && session != cur {
            log::debug!("session mismatch; ignoring candidates from {uuid}");
            return;
        }
        for c in cands {
            add_candidate(&conn, c).await;
        }
    }

    fn queue_pending_ice(
        &self,
        uuid: &str,
        msg_type: Option<&str>,
        session: Option<String>,
        cands: Vec<IceCandidate>,
    ) {
        let Some(t) = msg_type.filter(|t| *t == "local" || *t == "remote") else {
            return;
        };
        if uuid.is_empty() {
            return;
        }
        let mut st = self.st.lock().unwrap();
        let queue = st.pending_ice.entry(format!("{t}:{uuid}")).or_default();
        let n = cands.len();
        queue.extend(cands.into_iter().map(|c| PendingCandidate {
            candidate: c,
            session: session.clone(),
            ts: Instant::now(),
        }));
        if queue.len() > 100 {
            let excess = queue.len() - 100;
            queue.drain(..excess);
        }
        log::debug!("queued {n} ICE candidate(s) for {uuid} ({t})");
    }

    async fn drain_pending_ice(&self, conn: &Arc<Connection>, msg_type: &str) {
        let queue = self
            .st
            .lock()
            .unwrap()
            .pending_ice
            .remove(&format!("{msg_type}:{}", conn.uuid))
            .unwrap_or_default();
        let cur = conn.session();
        for item in queue {
            if item.ts.elapsed() > Duration::from_secs(15) {
                continue;
            }
            if item.session.is_some() && cur.is_some() && item.session != cur {
                continue;
            }
            add_candidate(conn, item.candidate).await;
        }
    }

    // ------------------------------------------------------------ peer state

    async fn handle_peer_state(self: &Arc<Self>, conn: Arc<Connection>) {
        if !self.is_current(&conn) {
            return;
        }
        let (peer, ice) = {
            let cs = conn.cs.lock().unwrap();
            (cs.peer_state, cs.ice_state)
        };
        let state =
            if peer == RTCPeerConnectionState::Failed || ice == RTCIceConnectionState::Failed {
                "failed"
            } else if peer == RTCPeerConnectionState::Disconnected
                || ice == RTCIceConnectionState::Disconnected
            {
                "disconnected"
            } else if peer == RTCPeerConnectionState::Connected
                || matches!(
                    ice,
                    RTCIceConnectionState::Connected | RTCIceConnectionState::Completed
                )
            {
                "connected"
            } else if peer == RTCPeerConnectionState::Closed {
                "closed"
            } else {
                return;
            };
        log::debug!("peer state for {}/{}: {state}", conn.uuid, conn.kind);
        match state {
            "connected" => {
                let first = {
                    let mut cs = conn.cs.lock().unwrap();
                    if let Some(t) = cs.connect_timer.take() {
                        t.abort();
                    }
                    if let Some(t) = cs.recovery_timer.take() {
                        t.abort();
                    }
                    if let Some(t) = cs.disconnect_timer.take() {
                        t.abort();
                    }
                    let first = !cs.connected_once;
                    cs.connected_once = true;
                    cs.recovering = false;
                    first
                };
                self.set_stream_state(conn.stream_id().as_deref(), "connected");
                if first {
                    self.emit(Event::PeerConnected {
                        uuid: conn.uuid.clone(),
                        stream_id: conn.stream_id(),
                        connection_type: conn.kind.into(),
                    });
                }
            }
            "disconnected" => {
                self.set_stream_state(conn.stream_id().as_deref(), "disconnected");
                let needs_timer = conn.cs.lock().unwrap().disconnect_timer.is_none();
                if needs_timer {
                    let me = self.clone();
                    let c2 = conn.clone();
                    let grace = self.opts.disconnect_grace_period;
                    let t = tokio::spawn(async move {
                        tokio::time::sleep(grace).await;
                        c2.cs.lock().unwrap().disconnect_timer = None;
                        if !is_transport_connected(&c2) && me.is_current(&c2) {
                            me.recover(&c2, "disconnected").await;
                        }
                    });
                    conn.cs.lock().unwrap().disconnect_timer = Some(t);
                }
            }
            "failed" => {
                self.set_stream_state(conn.stream_id().as_deref(), "failed");
                self.recover(&conn, "failed").await;
            }
            // Closed by the engine, not by us (we remove a connection from the
            // table before closing it, and `is_current` held above).
            _ => self.fail_connection(&conn, "closed").await,
        }
    }

    fn set_stream_state(&self, stream_id: Option<&str>, state: &'static str) {
        if let Some(sid) = stream_id {
            if let Some(info) = self.st.lock().unwrap().streams.get_mut(sid) {
                info.state = state;
            }
        }
    }

    /// Bounded recovery, as in the JavaScript SDK: the first failure triggers
    /// an ICE restart and arms a timer; a failure while already recovering (or
    /// the timer expiring unconnected) tears the connection down. Only the
    /// teardown emits `ConnectionFailed`, right after `PeerDisconnected`.
    async fn recover(self: &Arc<Self>, conn: &Arc<Connection>, reason: &str) {
        if !self.is_current(conn) {
            return;
        }
        let already = {
            let mut cs = conn.cs.lock().unwrap();
            if cs.finalized {
                return;
            }
            let a = cs.recovering;
            cs.recovering = true;
            a
        };
        if already {
            self.fail_connection(conn, reason).await;
            return;
        }
        log::debug!(
            "recovering {} connection to {} ({reason})",
            conn.kind,
            conn.uuid
        );
        if !self.restart_ice(conn, reason, false).await {
            self.fail_connection(conn, reason).await;
            return;
        }
        let me = self.clone();
        let c2 = conn.clone();
        let timeout = self.opts.connection_timeout;
        let reason = reason.to_string();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(timeout).await;
            c2.cs.lock().unwrap().recovery_timer = None;
            if !me.is_current(&c2) {
                return;
            }
            if is_transport_connected(&c2) {
                c2.cs.lock().unwrap().recovering = false;
            } else {
                // Still down after the restart: this is the second failure.
                me.fail_connection(&c2, &format!("{reason}-timeout")).await;
            }
        });
        let mut cs = conn.cs.lock().unwrap();
        if let Some(t) = cs.recovery_timer.replace(timer) {
            t.abort();
        }
    }

    /// Final teardown of a dead connection: removes it from the table, closes
    /// it and emits `PeerDisconnected` then `ConnectionFailed`. A viewer whose
    /// stream is still wanted is re-requested after 2 s.
    async fn fail_connection(self: &Arc<Self>, conn: &Arc<Connection>, reason: &str) {
        let removed = {
            let mut conns = self.conns.lock().unwrap();
            let mut removed = false;
            if let Some(p) = conns.get_mut(&conn.uuid) {
                if p.get(conn.kind)
                    .map(|x| Arc::ptr_eq(&x, conn))
                    .unwrap_or(false)
                {
                    p.set(conn.kind, None);
                    removed = true;
                }
                if p.is_empty() {
                    conns.remove(&conn.uuid);
                }
            }
            removed
        };
        if !removed {
            return;
        }
        let sid = conn.stream_id();
        let opts = conn.cs.lock().unwrap().view_options.clone();
        conn.close().await;
        self.emit(Event::PeerDisconnected {
            uuid: conn.uuid.clone(),
        });
        self.emit(Event::ConnectionFailed {
            uuid: conn.uuid.clone(),
            stream_id: sid.clone(),
            connection_type: conn.kind.into(),
            reason: reason.into(),
        });
        if conn.kind != "viewer" {
            return;
        }
        if let Some(sid) = sid {
            let wanted = {
                let st = self.st.lock().unwrap();
                !st.intentional
                    && !st.stopped_views.contains(&sid)
                    && st.view_intent.contains_key(&sid)
            };
            if wanted {
                self.schedule_view_retry(&sid, opts, Duration::from_secs(2));
            }
        }
    }

    // ---------------------------------------------------------- data channels

    async fn handle_incoming_channel(
        self: &Arc<Self>,
        conn: Arc<Connection>,
        dc: Arc<dyn DataChannel>,
    ) {
        let label = dc.label().await.unwrap_or_default();
        log::debug!("data channel from {}: {label:?}", conn.uuid);
        conn.cs
            .lock()
            .unwrap()
            .channels
            .insert(label.clone(), dc.clone());
        if label.is_empty() || label == CONTROL_CHANNEL_LABEL {
            conn.cs.lock().unwrap().control = Some(dc.clone());
            self.pump_control_channel(conn, dc);
        } else if label == CHUNKED_CHANNEL_LABEL {
            self.emit(Event::UnsupportedChannel {
                uuid: conn.uuid.clone(),
                label,
            });
        } else if label == RESOURCES_CHANNEL_LABEL {
            self.pump_resource_channel(conn, dc);
        } else if label.starts_with(RESERVED_CHANNEL_PREFIX) {
            if label == BINARY_CHANNEL_LABEL {
                self.pump_binary_channel(conn, dc);
            } else {
                self.emit(Event::ChannelOpen {
                    uuid: conn.uuid.clone(),
                    label,
                    channel: dc,
                });
            }
        } else {
            self.pump_file_receive_channel(conn, dc, label);
        }
    }

    fn pump_control_channel(self: &Arc<Self>, conn: Arc<Connection>, dc: Arc<dyn DataChannel>) {
        let me = self.clone();
        let c = conn.clone();
        let task = tokio::spawn(async move {
            let mut opened = false;
            if dc
                .ready_state()
                .await
                .map(|s| s == RTCDataChannelState::Open)
                .unwrap_or(false)
            {
                opened = true;
                me.on_control_open(&c).await;
            }
            while let Some(ev) = dc.poll().await {
                match ev {
                    DataChannelEvent::OnOpen => {
                        if !opened {
                            opened = true;
                            me.on_control_open(&c).await;
                        }
                    }
                    DataChannelEvent::OnMessage(m) => {
                        if !m.is_string {
                            continue; // VDO.Ninja renders binary control payloads as images; ignored.
                        }
                        let Ok(text) = std::str::from_utf8(&m.data) else {
                            continue;
                        };
                        let Ok(value) = serde_json::from_str::<Value>(text) else {
                            continue;
                        };
                        if !value.is_object() {
                            continue;
                        }
                        log::debug!("<- DC({}/{}) {}", c.uuid, c.kind, truncate(text, 300));
                        me.handle_control_message(&c, value).await;
                    }
                    DataChannelEvent::OnClose => break,
                    _ => {}
                }
            }
            c.control_open.store(false, Ordering::Release);
            if let Some(t) = c.cs.lock().unwrap().ping_task.take() {
                t.abort();
            }
            me.emit(Event::DataChannelClose {
                uuid: c.uuid.clone(),
                stream_id: c.stream_id(),
                connection_type: c.kind.into(),
            });
        });
        conn.cs.lock().unwrap().tasks.push(task);
    }

    async fn on_control_open(self: &Arc<Self>, conn: &Arc<Connection>) {
        conn.control_open.store(true, Ordering::Release);
        log::debug!("control channel open for {}/{}", conn.uuid, conn.kind);
        if conn.kind == "viewer" {
            let o = conn.cs.lock().unwrap().view_options.clone();
            let mut prefs = json!({"audio": o.audio, "video": o.video, "downloads": o.downloads});
            if let Some(l) = &o.label {
                prefs["info"] = json!({"label": l});
            }
            if o.allow_resources {
                prefs["allowresources"] = json!(true);
            }
            conn.send_control(&prefs).await;
        } else {
            let info = self.st.lock().unwrap().publisher_info.clone();
            if !info.is_empty() {
                conn.send_control(&json!({"info": info})).await;
            }
        }
        self.start_ping_monitor(conn);
        self.emit(Event::DataChannelOpen {
            uuid: conn.uuid.clone(),
            stream_id: conn.stream_id(),
            connection_type: conn.kind.into(),
        });
    }

    async fn handle_control_message(self: &Arc<Self>, conn: &Arc<Connection>, msg: Value) {
        if let Some(list) = msg.get("fileList").and_then(|l| l.as_array()) {
            let files: Vec<FileEntry> = list
                .iter()
                .filter_map(|f| {
                    let id = match f.get("id")? {
                        Value::String(s) => s.clone(),
                        Value::Number(n) => n.to_string(),
                        _ => return None,
                    };
                    Some(FileEntry {
                        id,
                        name: jstr(f, "name").unwrap_or_default(),
                        size: f.get("size").and_then(|s| s.as_u64()).unwrap_or(0),
                    })
                })
                .collect();
            self.emit(Event::FileList {
                uuid: conn.uuid.clone(),
                stream_id: conn.stream_id(),
                files,
            });
        }
        if let Some(v) = msg.get("requestFile") {
            let id = match v {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            };
            if let Some(id) = id {
                self.handle_file_request(conn, &id).await;
            }
        }
        if let Some(d) = msg.get("downloads") {
            let allowed = d.as_bool() == Some(true);
            conn.cs.lock().unwrap().allow_downloads = allowed;
            if conn.kind == "publisher" && allowed {
                let list = self.file_list_for(&conn.uuid);
                self.send_file_entries(conn, list).await;
            }
        }
        if let Some(r) = msg.get("allowresources") {
            conn.cs.lock().unwrap().allow_resources = r.as_bool() == Some(true);
        }
        if let Some(Value::Object(obs)) = msg.get("obsState") {
            let snapshot = {
                let mut cs = conn.cs.lock().unwrap();
                for (k, v) in obs {
                    cs.obs_state.insert(k.clone(), v.clone());
                }
                cs.obs_state.clone()
            };
            self.emit(Event::ObsState {
                uuid: conn.uuid.clone(),
                state: Value::Object(snapshot),
                update: Value::Object(obs.clone()),
            });
        }
        if let Some(Value::Object(info)) = msg.get("info") {
            let snapshot = {
                let mut cs = conn.cs.lock().unwrap();
                for (k, v) in info {
                    cs.info.insert(k.clone(), v.clone());
                }
                cs.info.clone()
            };
            self.emit(Event::PeerInfo {
                uuid: conn.uuid.clone(),
                stream_id: conn.stream_id(),
                info: Value::Object(snapshot),
            });
        }

        if msg.get("description").is_some() {
            self.handle_sdp(&msg, Some(conn)).await;
        } else if msg.get("candidate").is_some() {
            self.handle_candidates(&msg, Some(conn), true).await;
        } else if msg.get("candidates").is_some() {
            self.handle_candidates(&msg, Some(conn), false).await;
        } else if msg.get("audio").map(|v| v.is_boolean()).unwrap_or(false)
            || msg.get("video").map(|v| v.is_boolean()).unwrap_or(false)
        {
            {
                let mut cs = conn.cs.lock().unwrap();
                if let Some(a) = msg.get("audio").and_then(|v| v.as_bool()) {
                    cs.allow_audio = a;
                }
                if let Some(v) = msg.get("video").and_then(|v| v.as_bool()) {
                    cs.allow_video = v;
                }
            }
            self.update_tracks(conn).await;
        } else if let Some(p) = msg.get("ping") {
            conn.send_control(&json!({"pong": p})).await;
        } else if let Some(p) = msg.get("pong").and_then(|v| v.as_i64()) {
            let latency = now_ms() - p;
            {
                let mut cs = conn.cs.lock().unwrap();
                if cs.pending_ping == Some(p) {
                    cs.pending_ping = None;
                    cs.missed_pings = 0;
                }
            }
            self.emit(Event::PeerLatency {
                uuid: conn.uuid.clone(),
                stream_id: conn.stream_id(),
                latency_ms: latency,
            });
        } else if is_truthy(msg.get("bye")) {
            self.handle_bye(&conn.uuid, "bye", msg.clone()).await;
        } else if let Some(m) = msg.get("videoMuted") {
            self.emit(Event::RemoteVideoMuteState {
                uuid: conn.uuid.clone(),
                muted: m.as_bool().unwrap_or(false),
                raw: msg.clone(),
            });
            self.emit(Event::DataReceived {
                uuid: conn.uuid.clone(),
                stream_id: conn.stream_id(),
                data: msg.clone(),
                fallback: false,
            });
        } else if let Some(pipe) = msg.get("pipe") {
            if let Some(t) = pipe.get("type").and_then(|t| t.as_str()) {
                if matches!(
                    t,
                    "subscribe" | "unsubscribe" | "channelMessage" | "request" | "response"
                ) {
                    self.handle_data_message(pipe, conn.uuid.clone()).await;
                    return;
                }
            }
            self.emit(Event::DataReceived {
                uuid: conn.uuid.clone(),
                stream_id: conn.stream_id(),
                data: pipe.clone(),
                fallback: false,
            });
        } else if msg.get("iceRestartRequest").is_some() && conn.kind == "publisher" {
            self.restart_ice(conn, "remote_request", true).await;
        }
    }

    /// Applies viewer audio/video preferences by removing or re-adding senders
    /// and renegotiating (webrtc-rs has no `replaceTrack(null)`).
    async fn update_tracks(&self, conn: &Arc<Connection>) {
        if conn.kind != "publisher" {
            return;
        }
        let tracks = self.st.lock().unwrap().local_tracks.clone();
        if tracks.is_empty() {
            return;
        }
        let (allow_audio, allow_video, senders) = {
            let cs = conn.cs.lock().unwrap();
            (cs.allow_audio, cs.allow_video, cs.senders.clone())
        };
        let mut changed = false;
        let mut kept = vec![];
        for (sender, kind) in senders {
            let allow = (kind == RtpCodecKind::Audio && allow_audio)
                || (kind == RtpCodecKind::Video && allow_video);
            if allow {
                kept.push((sender, kind));
            } else if conn.pc.remove_track(&sender).await.is_ok() {
                changed = true;
            } else {
                kept.push((sender, kind));
            }
        }
        for t in tracks {
            let kind = t.kind().await;
            let allow = (kind == RtpCodecKind::Audio && allow_audio)
                || (kind == RtpCodecKind::Video && allow_video);
            if allow && !kept.iter().any(|(_, k)| *k == kind) {
                if let Ok(sender) = conn.pc.add_track(t).await {
                    kept.push((sender, kind));
                    changed = true;
                }
            }
        }
        conn.cs.lock().unwrap().senders = kept;
        if changed {
            if let Err(e) = self.renegotiate(conn, false, true).await {
                log::debug!("renegotiation after preference change failed: {e}");
            }
        }
    }

    fn start_ping_monitor(self: &Arc<Self>, conn: &Arc<Connection>) {
        if !self.opts.auto_ping_viewer || conn.kind != "viewer" {
            return;
        }
        let interval = self.opts.auto_ping_interval.max(Duration::from_secs(1));
        let me = self.clone();
        let c = conn.clone();
        let task = tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                if !c.is_control_open() {
                    continue;
                }
                let pending = c.cs.lock().unwrap().pending_ping;
                if let Some(p) = pending {
                    let elapsed = Duration::from_millis((now_ms() - p).max(0) as u64);
                    let timeout = (interval + Duration::from_secs(5)).max(interval * 3 / 2);
                    if elapsed < timeout {
                        continue;
                    }
                    let missed = {
                        let mut cs = c.cs.lock().unwrap();
                        cs.missed_pings += 1;
                        cs.pending_ping = None;
                        cs.missed_pings
                    };
                    if missed >= 2 {
                        c.cs.lock().unwrap().missed_pings = 0;
                        me.restart_ice(&c, "missed_pings", false).await;
                        continue;
                    }
                }
                me.send_ping(&c.uuid).await;
            }
        });
        let mut cs = conn.cs.lock().unwrap();
        if let Some(t) = cs.ping_task.replace(task) {
            t.abort();
        }
    }

    async fn send_ping(&self, uuid: &str) -> bool {
        let ts = now_ms();
        let conns: Vec<Arc<Connection>> = self
            .conns
            .lock()
            .unwrap()
            .iter()
            .filter(|(k, _)| uuid.is_empty() || k.as_str() == uuid)
            .flat_map(|(_, p)| [p.publisher.clone(), p.viewer.clone()])
            .flatten()
            .collect();
        for c in &conns {
            c.cs.lock().unwrap().pending_ping = Some(ts);
        }
        self.send_data_internal(
            json!({"ping": ts}),
            if uuid.is_empty() { None } else { Some(uuid) },
            None,
            "any",
        )
        .await
    }

    // ------------------------------------------------------------------ data

    async fn send_data_with(&self, data: Value, t: DataTarget) -> bool {
        let msg = json!({"pipe": data});
        let pref = match t.preference.as_deref() {
            None | Some("") | Some("any") | Some("pcs") => "any",
            Some("rpcs") => "viewer",
            Some(p) => p,
        }
        .to_string();
        let kind = match t.connection_type.as_deref() {
            Some("pcs") | Some("publisher") => Some("publisher"),
            Some("rpcs") | Some("viewer") => Some("viewer"),
            _ => None,
        };
        if let (Some(sid), None) = (&t.stream_id, &t.uuid) {
            let uuids: Vec<String> = self
                .conns
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, p)| {
                    [p.publisher.clone(), p.viewer.clone()]
                        .into_iter()
                        .flatten()
                        .any(|c| {
                            kind.map(|k| k == c.kind).unwrap_or(true)
                                && c.stream_id().as_deref() == Some(sid.as_str())
                        })
                })
                .map(|(k, _)| k.clone())
                .collect();
            let mut sent = false;
            for u in uuids {
                if self
                    .send_data_internal(msg.clone(), Some(&u), kind, &pref)
                    .await
                {
                    sent = true;
                }
            }
            return sent;
        }
        self.send_data_internal(msg, t.uuid.as_deref(), kind, &pref)
            .await
    }

    async fn send_data_internal(
        &self,
        msg: Value,
        uuid: Option<&str>,
        kind: Option<&str>,
        preference: &str,
    ) -> bool {
        type PeerPair = (String, Option<Arc<Connection>>, Option<Arc<Connection>>);
        let text = msg.to_string();
        let pairs: Vec<PeerPair> = {
            let conns = self.conns.lock().unwrap();
            conns
                .iter()
                .filter(|(k, _)| uuid.map(|u| u == k.as_str()).unwrap_or(true))
                .map(|(k, p)| (k.clone(), p.publisher.clone(), p.viewer.clone()))
                .collect()
        };
        let mut sent = false;
        for (_, publisher, viewer) in &pairs {
            match preference {
                "publisher" => sent |= try_send(publisher.as_ref(), kind, &text).await,
                "viewer" => sent |= try_send(viewer.as_ref(), kind, &text).await,
                "all" => {
                    sent |= try_send(publisher.as_ref(), kind, &text).await;
                    sent |= try_send(viewer.as_ref(), kind, &text).await;
                }
                _ => {
                    if try_send(publisher.as_ref(), kind, &text).await
                        || try_send(viewer.as_ref(), kind, &text).await
                    {
                        sent = true;
                    }
                }
            }
        }
        sent
    }

    async fn send_raw_control(&self, uuid: &str, msg: &Value) -> bool {
        let conns: Vec<Arc<Connection>> = self
            .conns
            .lock()
            .unwrap()
            .get(uuid)
            .map(|p| {
                [p.publisher.clone(), p.viewer.clone()]
                    .into_iter()
                    .flatten()
                    .collect()
            })
            .unwrap_or_default();
        for c in conns {
            if c.send_control(msg).await {
                return true;
            }
        }
        false
    }

    async fn handle_data_message(self: &Arc<Self>, data: &Value, uuid: String) {
        match data.get("type").and_then(|t| t.as_str()) {
            Some(t @ ("subscribe" | "unsubscribe")) => {
                let channels: Vec<String> = match data.get("channels") {
                    Some(Value::Array(a)) => a
                        .iter()
                        .filter_map(|c| c.as_str().map(|s| s.to_string()))
                        .collect(),
                    Some(Value::String(s)) => vec![s.clone()],
                    _ => vec![],
                };
                let all: Vec<String> = {
                    let mut st = self.st.lock().unwrap();
                    let set = st.peer_subs.entry(uuid.clone()).or_default();
                    for c in &channels {
                        if t == "subscribe" {
                            set.insert(c.clone());
                        } else {
                            set.remove(c);
                        }
                    }
                    set.iter().cloned().collect()
                };
                if t == "subscribe" {
                    self.emit(Event::PeerSubscribed {
                        uuid,
                        channels,
                        all_channels: all,
                    });
                } else {
                    self.emit(Event::PeerUnsubscribed {
                        uuid,
                        channels,
                        all_channels: all,
                    });
                }
            }
            Some("channelMessage") => {
                let channel = jstr(data, "channel").unwrap_or_default();
                if self.st.lock().unwrap().subscriptions.contains(&channel) {
                    self.emit(Event::ChannelMessage {
                        uuid,
                        channel,
                        data: data.get("data").cloned().unwrap_or(Value::Null),
                        timestamp: data.get("timestamp").and_then(|t| t.as_i64()).unwrap_or(0),
                    });
                }
            }
            Some("request") => {
                let rt = jstr(data, "requestType").unwrap_or_default();
                let Some(rid) = jstr(data, "requestId") else {
                    return;
                };
                let handler = self.request_handlers.lock().unwrap().get(&rt).cloned();
                let Some(handler) = handler else { return };
                let me = self.me();
                let payload = data.get("data").cloned().unwrap_or(Value::Null);
                tokio::spawn(async move {
                    let response = match handler(payload, uuid.clone()).await {
                        Ok(v) => v,
                        Err(e) => {
                            json!({"error": if e.is_empty() { "Request handler error".to_string() } else { e }})
                        }
                    };
                    me.send_data_internal(
                        json!({"pipe": {"type": "response", "requestId": rid, "data": response}}),
                        Some(&uuid),
                        None,
                        "any",
                    )
                    .await;
                });
            }
            Some("response") => {
                let Some(rid) = jstr(data, "requestId") else {
                    return;
                };
                let pending = {
                    let mut st = self.st.lock().unwrap();
                    let matches = match st.pending_requests.get(&rid) {
                        Some((target, _)) => target.is_empty() || *target == uuid,
                        None => false,
                    };
                    if matches {
                        st.pending_requests.remove(&rid)
                    } else {
                        None
                    }
                };
                if let Some((_, tx)) = pending {
                    let payload = data.get("data").cloned().unwrap_or(Value::Null);
                    let result = match payload.get("error").and_then(|e| e.as_str()) {
                        Some(e) if !e.is_empty() => Err(Error::Remote(e.to_string())),
                        _ => Ok(payload),
                    };
                    let _ = tx.send(result);
                }
            }
            _ => self.emit(Event::DataReceived {
                uuid,
                stream_id: None,
                data: data.clone(),
                fallback: false,
            }),
        }
    }

    // ----------------------------------------------------------------- files

    fn file_list_for(&self, uuid: &str) -> Vec<FileEntry> {
        self.st
            .lock()
            .unwrap()
            .hosted_files
            .values()
            .filter(|f| f.restricted.as_deref().map(|r| r == uuid).unwrap_or(true))
            .map(|f| FileEntry {
                id: f.id.clone(),
                name: f.name.clone(),
                size: f.data.len() as u64,
            })
            .collect()
    }

    async fn send_file_entries(&self, conn: &Arc<Connection>, list: Vec<FileEntry>) {
        let unsent: Vec<FileEntry> = {
            let cs = conn.cs.lock().unwrap();
            if !cs.allow_downloads {
                return;
            }
            list.into_iter()
                .filter(|f| !cs.advertised.contains(&f.id))
                .collect()
        };
        if unsent.is_empty() {
            return;
        }
        if conn.send_control(&json!({"fileList": unsent})).await {
            let mut cs = conn.cs.lock().unwrap();
            for f in unsent {
                cs.advertised.insert(f.id);
            }
        }
    }

    async fn handle_file_request(self: &Arc<Self>, conn: &Arc<Connection>, id: &str) {
        let file = self.st.lock().unwrap().hosted_files.get(id).cloned();
        let Some(file) = file.filter(|f| {
            f.restricted
                .as_deref()
                .map(|r| r == conn.uuid)
                .unwrap_or(true)
        }) else {
            log::debug!("refusing file request {id:?} from {}", conn.uuid);
            return;
        };
        let dc = match conn.pc.create_data_channel(id, None).await {
            Ok(dc) => dc,
            Err(e) => {
                self.emit(Event::FileTransferError {
                    uuid: conn.uuid.clone(),
                    file: FileInfo {
                        id: id.into(),
                        name: file.name.clone(),
                        size: file.data.len() as u64,
                        bytes: 0,
                        direction: "outbound",
                    },
                    error: e.to_string(),
                });
                return;
            }
        };
        conn.cs
            .lock()
            .unwrap()
            .channels
            .insert(id.to_string(), dc.clone());
        let me = self.clone();
        let c = conn.clone();
        let task = tokio::spawn(async move {
            let mut closed_tx: Option<oneshot::Sender<()>> = None;
            while let Some(ev) = dc.poll().await {
                match ev {
                    DataChannelEvent::OnOpen => {
                        let (tx, rx) = oneshot::channel();
                        closed_tx = Some(tx);
                        let me2 = me.clone();
                        let c2 = c.clone();
                        let dc2 = dc.clone();
                        let f2 = file.clone();
                        tokio::spawn(async move { me2.send_file(&c2, dc2, f2, rx).await });
                    }
                    DataChannelEvent::OnClose => {
                        if let Some(tx) = closed_tx.take() {
                            let _ = tx.send(());
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });
        conn.cs.lock().unwrap().tasks.push(task);
    }

    async fn send_file(
        &self,
        conn: &Arc<Connection>,
        dc: Arc<dyn DataChannel>,
        file: Arc<HostedFile>,
        closed: oneshot::Receiver<()>,
    ) {
        let size = file.data.len() as u64;
        let info = |bytes: u64| FileInfo {
            id: file.id.clone(),
            name: file.name.clone(),
            size,
            bytes,
            direction: "outbound",
        };
        let header =
            json!({"type": "filetransfer", "size": size, "filename": file.name, "id": file.id});
        if let Err(e) = dc.send_text(&header.to_string()).await {
            self.emit(Event::FileTransferError {
                uuid: conn.uuid.clone(),
                file: info(0),
                error: e.to_string(),
            });
            return;
        }
        self.emit(Event::FileTransferStart {
            uuid: conn.uuid.clone(),
            file: info(0),
            requested: true,
        });
        let mut sent = 0u64;
        for chunk in file.data.chunks(FILE_CHUNK_SIZE) {
            if file.cancelled.load(Ordering::Acquire) {
                let _ = dc.send_text(FILE_EOF_CANCELLED).await;
                self.emit(Event::FileTransferCancelled {
                    uuid: conn.uuid.clone(),
                    file: info(sent),
                });
                let _ = wait_below(&dc, 1, Duration::from_secs(5)).await;
                let _ = dc.close().await;
                return;
            }
            if let Err(e) = wait_below(&dc, BUFFER_HIGH, Duration::from_secs(30)).await {
                self.emit(Event::FileTransferError {
                    uuid: conn.uuid.clone(),
                    file: info(sent),
                    error: e.to_string(),
                });
                let _ = dc.close().await;
                return;
            }
            if let Err(e) = dc.send(BytesMut::from(chunk)).await {
                self.emit(Event::FileTransferError {
                    uuid: conn.uuid.clone(),
                    file: info(sent),
                    error: e.to_string(),
                });
                let _ = dc.close().await;
                return;
            }
            sent += chunk.len() as u64;
            self.emit(Event::FileTransferProgress {
                uuid: conn.uuid.clone(),
                file: info(sent),
            });
        }
        if let Err(e) = wait_below(&dc, 1, Duration::from_secs(30)).await {
            self.emit(Event::FileTransferError {
                uuid: conn.uuid.clone(),
                file: info(sent),
                error: e.to_string(),
            });
            let _ = dc.close().await;
            return;
        }
        if let Err(e) = dc.send_text(FILE_EOF_COMPLETE).await {
            self.emit(Event::FileTransferError {
                uuid: conn.uuid.clone(),
                file: info(sent),
                error: e.to_string(),
            });
            return;
        }
        let _ = wait_below(&dc, 1, Duration::from_secs(10)).await;
        self.emit(Event::FileTransferComplete {
            uuid: conn.uuid.clone(),
            file: info(sent),
        });
        // The receiver closes after EOF1; otherwise close ourselves after a grace period.
        if tokio::time::timeout(Duration::from_secs(3), closed)
            .await
            .is_err()
        {
            let _ = dc.close().await;
        }
    }

    fn pump_file_receive_channel(
        self: &Arc<Self>,
        conn: Arc<Connection>,
        dc: Arc<dyn DataChannel>,
        label: String,
    ) {
        let me = self.clone();
        let c = conn.clone();
        let task = tokio::spawn(async move {
            // Dropped with the task: when `Connection::close` aborts it
            // mid-transfer, the guard fails the download so `request_file` returns.
            let mut guard = InboundGuard {
                me: me.clone(),
                c: c.clone(),
                label: label.clone(),
                details: None,
                transfer: None,
            };
            let InboundGuard {
                details, transfer, ..
            } = &mut guard;
            let mut completed = false;
            while let Some(ev) = dc.poll().await {
                let m = match ev {
                    DataChannelEvent::OnMessage(m) => m,
                    DataChannelEvent::OnClose => break,
                    _ => continue,
                };
                if details.is_none() {
                    if !m.is_string {
                        continue;
                    }
                    let Ok(text) = std::str::from_utf8(&m.data) else {
                        continue;
                    };
                    let Ok(parsed) = serde_json::from_str::<Value>(text) else {
                        continue;
                    };
                    if parsed.get("type").and_then(|t| t.as_str()) != Some("filetransfer") {
                        continue;
                    }
                    let id = match parsed.get("id") {
                        Some(Value::String(s)) => s.clone(),
                        Some(Value::Number(n)) => n.to_string(),
                        _ => label.clone(),
                    };
                    let name = jstr(&parsed, "filename").unwrap_or_default();
                    let size = parsed.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
                    *details = Some((id.clone(), name.clone(), size));
                    *transfer = {
                        let st = me.st.lock().unwrap();
                        st.inbound
                            .get(&format!("{}:{}", c.uuid, id))
                            .or_else(|| st.inbound.get(&format!("{}:{}", c.uuid, label)))
                            .cloned()
                    };
                    if let Some(t) = &transfer {
                        t.state.lock().unwrap().started = true;
                    }
                    me.emit(Event::FileTransferStart {
                        uuid: c.uuid.clone(),
                        file: FileInfo {
                            id,
                            name,
                            size,
                            bytes: 0,
                            direction: "inbound",
                        },
                        requested: transfer.is_some(),
                    });
                    continue;
                }
                let (id, name, size) = details.clone().unwrap();
                if m.is_string {
                    let text = std::str::from_utf8(&m.data).unwrap_or("");
                    if text == FILE_EOF_COMPLETE {
                        let received = transfer
                            .as_ref()
                            .map(|t| t.state.lock().unwrap().received)
                            .unwrap_or(0);
                        if transfer.is_some() && received != size {
                            fail_transfer(
                                &me,
                                &c,
                                transfer,
                                &id,
                                &name,
                                size,
                                format!("size mismatch: received {received} of {size} bytes"),
                            );
                        } else {
                            me.emit(Event::FileTransferComplete {
                                uuid: c.uuid.clone(),
                                file: FileInfo {
                                    id: id.clone(),
                                    name: name.clone(),
                                    size,
                                    bytes: received,
                                    direction: "inbound",
                                },
                            });
                            if let Some(t) = transfer.take() {
                                me.st
                                    .lock()
                                    .unwrap()
                                    .inbound
                                    .remove(&format!("{}:{}", c.uuid, t.id));
                                let mut s = t.state.lock().unwrap();
                                let data = if t.stream {
                                    None
                                } else {
                                    let mut buf = BytesMut::with_capacity(s.received as usize);
                                    for ch in s.chunks.drain(..) {
                                        buf.extend_from_slice(&ch);
                                    }
                                    Some(buf.freeze())
                                };
                                if let Some(done) = s.done.take() {
                                    let _ = done.send(Ok(FileResult {
                                        id: id.clone(),
                                        name: name.clone(),
                                        size,
                                        uuid: c.uuid.clone(),
                                        stream_id: c.stream_id(),
                                        data,
                                    }));
                                }
                            }
                        }
                        completed = true;
                        let _ = dc.close().await;
                        break;
                    } else if text == FILE_EOF_CANCELLED {
                        me.emit(Event::FileTransferCancelled {
                            uuid: c.uuid.clone(),
                            file: FileInfo {
                                id: id.clone(),
                                name: name.clone(),
                                size,
                                bytes: 0,
                                direction: "inbound",
                            },
                        });
                        fail_transfer(
                            &me,
                            &c,
                            transfer,
                            &id,
                            &name,
                            size,
                            "transfer cancelled by remote peer".into(),
                        );
                        completed = true;
                        let _ = dc.close().await;
                        break;
                    }
                    continue;
                }
                let chunk = m.data.freeze();
                let received = match &transfer {
                    Some(t) => {
                        let mut s = t.state.lock().unwrap();
                        s.received += chunk.len() as u64;
                        if !t.stream {
                            s.chunks.push(chunk.clone());
                        }
                        s.received
                    }
                    None => chunk.len() as u64,
                };
                let file = FileInfo {
                    id: id.clone(),
                    name: name.clone(),
                    size,
                    bytes: received,
                    direction: "inbound",
                };
                me.emit(Event::FileTransferProgress {
                    uuid: c.uuid.clone(),
                    file: file.clone(),
                });
                if transfer.as_ref().map(|t| t.stream).unwrap_or(false) {
                    me.emit(Event::FileChunk {
                        uuid: c.uuid.clone(),
                        file,
                        chunk,
                    });
                }
            }
            if !completed && transfer.is_some() {
                let (id, name, size) = details.clone().unwrap_or((label.clone(), String::new(), 0));
                fail_transfer(
                    &me,
                    &c,
                    transfer,
                    &id,
                    &name,
                    size,
                    "file channel closed before completion".into(),
                );
            }
        });
        conn.cs.lock().unwrap().tasks.push(task);
    }

    fn pump_binary_channel(self: &Arc<Self>, conn: Arc<Connection>, dc: Arc<dyn DataChannel>) {
        let me = self.clone();
        let c = conn.clone();
        let task = tokio::spawn(async move {
            while let Some(ev) = dc.poll().await {
                match ev {
                    DataChannelEvent::OnMessage(m) if !m.is_string => {
                        me.emit(Event::BinaryReceived {
                            uuid: c.uuid.clone(),
                            stream_id: c.stream_id(),
                            data: m.data.freeze(),
                        });
                    }
                    DataChannelEvent::OnClose => break,
                    _ => {}
                }
            }
        });
        conn.cs.lock().unwrap().tasks.push(task);
    }

    fn pump_resource_channel(self: &Arc<Self>, conn: Arc<Connection>, dc: Arc<dyn DataChannel>) {
        let advertised = conn.cs.lock().unwrap().view_options.allow_resources;
        if !advertised {
            log::debug!(
                "peer {} opened an unsolicited resources channel; closing",
                conn.uuid
            );
            tokio::spawn(async move {
                let _ = dc.close().await;
            });
            return;
        }
        let me = self.clone();
        let c = conn.clone();
        let task = tokio::spawn(async move {
            let mut meta: Option<Value> = None;
            let mut buf = BytesMut::new();
            while let Some(ev) = dc.poll().await {
                match ev {
                    DataChannelEvent::OnMessage(m) => {
                        if m.is_string {
                            if let Ok(parsed) = serde_json::from_slice::<Value>(&m.data) {
                                if parsed.get("templateName").is_some() {
                                    meta = Some(parsed);
                                    buf.clear();
                                }
                            }
                            continue;
                        }
                        let Some(md) = &meta else { continue };
                        buf.extend_from_slice(&m.data);
                        let size = md.get("size").and_then(|s| s.as_u64()).unwrap_or(0);
                        if buf.len() as u64 >= size {
                            me.emit(Event::ResourceReceived {
                                uuid: c.uuid.clone(),
                                template_name: jstr(md, "templateName").unwrap_or_default(),
                                metadata: md.clone(),
                                data: buf.split().freeze(),
                            });
                            meta = None;
                        }
                    }
                    DataChannelEvent::OnClose => break,
                    _ => {}
                }
            }
        });
        conn.cs.lock().unwrap().tasks.push(task);
    }

    async fn wait_open(&self, dc: &Arc<dyn DataChannel>, timeout: Duration) -> Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            match dc.ready_state().await? {
                RTCDataChannelState::Open => return Ok(()),
                RTCDataChannelState::Closing | RTCDataChannelState::Closed => {
                    return Err(Error::NoDataChannel)
                }
                _ => {}
            }
            if Instant::now() > deadline {
                return Err(Error::Other("data channel open timeout".into()));
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn open_channel(
        self: &Arc<Self>,
        uuid: &str,
        label: &str,
        init: Option<RTCDataChannelInit>,
    ) -> Result<Arc<dyn DataChannel>> {
        if label.is_empty() {
            return Err(Error::Other("channel label required".into()));
        }
        let label = if label.starts_with(RESERVED_CHANNEL_PREFIX) {
            label.to_string()
        } else {
            format!("{RESERVED_CHANNEL_PREFIX}{label}")
        };
        let conn = self
            .find_connection(uuid, Some("publisher"))
            .or_else(|| self.find_connection(uuid, Some("viewer")))
            .ok_or(Error::PeerNotFound)?;
        let existing = conn.cs.lock().unwrap().channels.get(&label).cloned();
        if let Some(dc) = existing {
            if self.wait_open(&dc, Duration::from_secs(15)).await.is_ok() {
                return Ok(dc);
            }
        }
        let dc = conn.pc.create_data_channel(&label, init).await?;
        conn.cs
            .lock()
            .unwrap()
            .channels
            .insert(label.clone(), dc.clone());
        if label == BINARY_CHANNEL_LABEL {
            // Our own x-bin lane is bidirectional: surface incoming bytes too.
            self.pump_binary_channel(conn.clone(), dc.clone());
        }
        self.wait_open(&dc, Duration::from_secs(15)).await?;
        Ok(dc)
    }
}

/// Closes a connection on a fresh task, so it is safe to call from one of the
/// connection's own tasks (which `close` aborts).
fn close_later(c: Arc<Connection>) {
    tokio::spawn(async move { c.close().await });
}

/// Waits (up to 100 ms) until every control channel has delivered its bye, so
/// the message is not lost when the transport is torn down right after.
async fn flush_byes(conns: &[Arc<Connection>]) {
    let deadline = Instant::now() + Duration::from_millis(100);
    loop {
        let mut pending = false;
        for c in conns {
            if !c.is_control_open() {
                continue;
            }
            let dc = c.cs.lock().unwrap().control.clone();
            if let Some(dc) = dc {
                if dc.outstanding_bytes().await.unwrap_or(0) > 0 {
                    pending = true;
                    break;
                }
            }
        }
        if !pending || Instant::now() >= deadline {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn is_transport_connected(c: &Arc<Connection>) -> bool {
    let cs = c.cs.lock().unwrap();
    cs.peer_state == RTCPeerConnectionState::Connected
        || matches!(
            cs.ice_state,
            RTCIceConnectionState::Connected | RTCIceConnectionState::Completed
        )
}

/// Owned by a file receive task; fails the transfer it tracks if the task is
/// dropped (aborted by `Connection::close`) before the transfer finished.
struct InboundGuard {
    me: Arc<Inner>,
    c: Arc<Connection>,
    label: String,
    details: Option<(String, String, u64)>, // id, name, size
    transfer: Option<Arc<InboundTransfer>>,
}

impl Drop for InboundGuard {
    fn drop(&mut self) {
        if self.transfer.is_none() {
            return;
        }
        let (id, name, size) =
            self.details
                .clone()
                .unwrap_or((self.label.clone(), String::new(), 0));
        let me = self.me.clone();
        let c = self.c.clone();
        fail_transfer(
            &me,
            &c,
            &mut self.transfer,
            &id,
            &name,
            size,
            "connection closed".into(),
        );
    }
}

fn is_truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Some(Value::Object(_)) | Some(Value::Array(_)) => true,
        _ => false,
    }
}

async fn try_send(c: Option<&Arc<Connection>>, kind: Option<&str>, text: &str) -> bool {
    let Some(c) = c else { return false };
    if kind.map(|k| k != c.kind).unwrap_or(false) || !c.is_control_open() {
        return false;
    }
    let dc = c.cs.lock().unwrap().control.clone();
    let Some(dc) = dc else { return false };
    let ok = dc.send_text(text).await.is_ok();
    if ok {
        log::debug!("-> DC({}/{}) {}", c.uuid, c.kind, truncate(text, 300));
    }
    ok
}

fn fail_transfer(
    me: &Arc<Inner>,
    c: &Arc<Connection>,
    transfer: &mut Option<Arc<InboundTransfer>>,
    id: &str,
    name: &str,
    size: u64,
    err: String,
) {
    me.emit(Event::FileTransferError {
        uuid: c.uuid.clone(),
        file: FileInfo {
            id: id.into(),
            name: name.into(),
            size,
            bytes: 0,
            direction: "inbound",
        },
        error: err.clone(),
    });
    if let Some(t) = transfer.take() {
        me.st
            .lock()
            .unwrap()
            .inbound
            .remove(&format!("{}:{}", c.uuid, t.id));
        if let Some(done) = t.state.lock().unwrap().done.take() {
            let _ = done.send(Err(Error::FileTransfer(err)));
        }
    }
}

async fn add_candidate(conn: &Arc<Connection>, c: IceCandidate) {
    let init = RTCIceCandidateInit {
        candidate: c.candidate,
        sdp_mid: c.sdp_mid,
        sdp_mline_index: c.sdp_mline_index,
        ..Default::default()
    };
    if let Err(e) = conn.pc.add_ice_candidate(init).await {
        log::debug!("add_ice_candidate failed: {e}");
    }
}

async fn fetch_turn_list(url: &str) -> Vec<vdoninja_core::turn::TurnServer> {
    if let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        if let Ok(resp) = client.get(format!("{url}?ts={}", now_ms())).send().await {
            if let Ok(list) = resp.json::<TurnList>().await {
                if !list.servers.is_empty() {
                    return list.servers;
                }
            }
        }
    }
    log::debug!("TURN list fetch failed; using fallback list");
    fallback_turn_servers()
}

/// Local UTC offset in minutes (JavaScript's `-getTimezoneOffset()`), used to
/// pick nearby TURN servers. Falls back to 0 (UTC) when unavailable.
fn local_tz_offset_minutes() -> i64 {
    #[cfg(unix)]
    {
        #[repr(C)]
        struct Tm {
            tm_sec: i32,
            tm_min: i32,
            tm_hour: i32,
            tm_mday: i32,
            tm_mon: i32,
            tm_year: i32,
            tm_wday: i32,
            tm_yday: i32,
            tm_isdst: i32,
            tm_gmtoff: i64,
            tm_zone: *const std::os::raw::c_char,
        }
        extern "C" {
            fn time(t: *mut i64) -> i64;
            fn localtime_r(t: *const i64, tm: *mut Tm) -> *mut Tm;
        }
        // SAFETY: libc time()/localtime_r() with valid, properly sized out-pointers.
        unsafe {
            let mut t: i64 = 0;
            time(&mut t);
            let mut tm = std::mem::zeroed::<Tm>();
            if !localtime_r(&t, &mut tm).is_null() {
                return tm.tm_gmtoff / 60;
            }
        }
    }
    0
}

#[allow(dead_code)]
fn _assert_send_sync() {
    fn check<T: Send + Sync>() {}
    check::<VdoNinja>();
    check::<Event>();
}

#[cfg(test)]
mod protocol_tests {
    use super::*;

    #[tokio::test]
    async fn password_modes_match_javascript() {
        let vectors: Value =
            serde_json::from_str(include_str!("../../../spec/vectors.json")).unwrap();
        for c in vectors["passwordModes"].as_array().unwrap() {
            let sdk = VdoNinja::new(Options {
                password: c["rawPassword"].as_str().map(String::from),
                no_password: c["noPassword"].as_bool().unwrap(),
                salt: c["salt"].as_str().unwrap().into(),
                turn: TurnMode::Disabled,
                ..Default::default()
            });
            assert_eq!(
                sdk.inner.effective_password().as_deref(),
                c["effectivePassword"].as_str(),
                "{c}"
            );
            assert_eq!(
                sdk.inner.hashed_stream_id("camera"),
                c["hashedStreamID"].as_str().unwrap(),
                "{c}"
            );
            let st = sdk.inner.st.lock().unwrap();
            assert_eq!(st.salt, c["effectiveSalt"].as_str().unwrap());
            let room = if st.no_password {
                "room".into()
            } else {
                hash_room("room", &st.password, &st.salt)
            };
            assert_eq!(room, c["hashedRoom"].as_str().unwrap());
            drop(st);
            let value = json!({"type":"offer", "sdp":"v=0\r\n"});
            if c["encrypted"].as_bool().unwrap() {
                let (ct, iv) = sdk.inner.encrypt(&value).unwrap();
                assert_eq!(sdk.inner.decrypt(&ct, &iv).unwrap(), value);
            } else {
                assert!(matches!(
                    sdk.inner.encrypt(&value),
                    Err(Error::EncryptionDisabled)
                ));
            }
        }
    }

    #[tokio::test]
    async fn room_password_override_and_reconnect() {
        let server = crate::signalserver::SignalServer::bind("127.0.0.1:0")
            .await
            .unwrap();
        for password in ["", " \t ", "false", "0", "off", "café & literal%20"] {
            let sdk = VdoNinja::new(Options {
                host: server.url(),
                password: Some("old %20 password".into()),
                turn: TurnMode::Disabled,
                ..Default::default()
            });
            let expected = VdoNinja::new(Options {
                password: Some(password.into()),
                ..Default::default()
            });
            sdk.connect().await.unwrap();
            sdk.join_room_with("password_room", Some(password), false)
                .await
                .unwrap();
            for _ in 0..2 {
                assert_eq!(
                    sdk.inner.effective_password(),
                    expected.inner.effective_password()
                );
                assert_eq!(
                    sdk.inner.hashed_stream_id("camera"),
                    expected.inner.hashed_stream_id("camera")
                );
                sdk.leave_room().await;
                sdk.connect().await.unwrap();
                sdk.join_room("password_room").await.unwrap();
            }
            sdk.disconnect().await;
        }
    }

    #[tokio::test]
    async fn replacement_offer_preserves_view_preferences() {
        let sdk = VdoNinja::new(Options {
            turn: TurnMode::Disabled,
            stun_servers: vec![],
            bind_addrs: vec!["127.0.0.1:0".into()],
            include_loopback: true,
            ..Default::default()
        });
        // An established view has already consumed pending_views. A new
        // publisher session must still use the original requested preferences.
        sdk.inner.st.lock().unwrap().view_intent.insert(
            "camera".into(),
            ViewOptions {
                audio: false,
                video: false,
                downloads: false,
                ..Default::default()
            },
        );
        let old = sdk
            .inner
            .create_connection("publisher", "viewer")
            .await
            .unwrap();
        old.cs.lock().unwrap().session = Some("previous".into());
        let source = sdk
            .inner
            .create_connection("offer-source", "publisher")
            .await
            .unwrap();
        let offer = source.pc.create_offer(None).await.unwrap();
        sdk.inner
            .handle_offer(
                "publisher",
                Some("replaced".into()),
                &json!({"streamID": sdk.inner.hashed_stream_id("camera")}),
                SessionDescription {
                    kind: "offer".into(),
                    sdp: offer.sdp,
                },
                None,
            )
            .await;
        let replacement = sdk
            .inner
            .find_connection("publisher", Some("viewer"))
            .unwrap();
        assert!(!Arc::ptr_eq(&old, &replacement));
        assert!(replacement.remote_set.load(Ordering::Acquire));
        {
            let cs = replacement.cs.lock().unwrap();
            assert!(!cs.view_options.audio && !cs.view_options.video && !cs.view_options.downloads);
        }
        sdk.disconnect().await;
    }

    #[tokio::test]
    async fn stream_notice_preserves_view_preferences() {
        let sdk = VdoNinja::new(Options::default());
        sdk.inner.st.lock().unwrap().pending_views.insert(
            "late".into(),
            ViewOptions {
                audio: false,
                video: false,
                downloads: false,
                ..Default::default()
            },
        );
        sdk.inner.handle_video_added(
            &json!({"streamID": sdk.inner.hashed_stream_id("late"), "UUID": "publisher"}),
        );
        {
            let st = sdk.inner.st.lock().unwrap();
            let prefs = st
                .pending_views
                .get("late")
                .expect("offer arriving before retry must retain preferences");
            assert!(!prefs.audio && !prefs.video && !prefs.downloads);
        }
        sdk.disconnect().await;
    }

    #[tokio::test]
    async fn data_requires_peer_channel() {
        let sdk = VdoNinja::new(Options {
            turn: TurnMode::Disabled,
            stun_servers: vec![],
            bind_addrs: vec!["127.0.0.1:0".into()],
            include_loopback: true,
            ..Default::default()
        });
        let (tx, mut wire) = mpsc::unbounded_channel();
        *sdk.inner.ws_tx.lock().unwrap() = Some(tx);
        sdk.inner.st.lock().unwrap().connected = true;
        sdk.inner
            .create_connection("unopened-peer", "publisher")
            .await
            .unwrap();
        assert!(!sdk.send_data_to("unopened-peer", json!("payload")).await);
        assert!(!sdk.send_ping("unopened-peer").await);
        sdk.subscribe(&["updates"]).await;
        sdk.unsubscribe(&["updates"]).await;
        assert!(
            wire.try_recv().is_err(),
            "application data sent on signaling"
        );

        let mut events = sdk.events();
        sdk.inner
            .clone()
            .handle_signaling(json!({
                "UUID": "unopened-peer", "__fallback": true, "pipe": "payload"
            }))
            .await;
        assert!(
            events.try_recv().is_err(),
            "application data accepted from signaling"
        );
        sdk.disconnect().await;
        assert!(
            wire.try_recv().is_err(),
            "bye sent on signaling without a control channel"
        );
    }
}
