// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

//! Events emitted by the SDK (received through `VdoNinja::events()`).

use std::fmt;
use std::sync::Arc;

use bytes::Bytes;
use serde_json::Value;
use vdoninja_core::protocol::{FileEntry, ListingEntry};
use webrtc::data_channel::DataChannel;
use webrtc::media_stream::track_remote::TrackRemote;

/// File transfer progress details.
#[derive(Debug, Clone)]
pub struct FileInfo {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub bytes: u64,
    /// "inbound" or "outbound".
    pub direction: &'static str,
}

/// An SDK event. Names follow the JavaScript SDK events.
#[derive(Clone)]
pub enum Event {
    Connected,
    Disconnected {
        intentional: bool,
        reason: String,
        will_reconnect: bool,
    },
    Reconnecting {
        attempt: u32,
    },
    Reconnected,
    ReconnectFailed,
    RoomJoined {
        room: String,
    },
    RoomLeft {
        room: String,
    },
    Listing {
        list: Vec<ListingEntry>,
        raw: Value,
    },
    VideoAddedToRoom {
        stream_id: String,
        uuid: Option<String>,
    },
    SomeoneJoined {
        stream_id: Option<String>,
        uuid: Option<String>,
        raw: Value,
    },
    Transferred {
        raw: Value,
    },
    Publishing {
        stream_id: String,
        data_only: bool,
    },
    PublishingStopped {
        stream_id: Option<String>,
    },
    ViewingStopped {
        stream_id: String,
    },
    PeerConnected {
        uuid: String,
        stream_id: Option<String>,
        connection_type: String,
    },
    PeerDisconnected {
        uuid: String,
    },
    ConnectionFailed {
        uuid: String,
        stream_id: Option<String>,
        connection_type: String,
        reason: String,
    },
    IceRestart {
        uuid: String,
        reason: String,
    },
    DataChannelOpen {
        uuid: String,
        stream_id: Option<String>,
        connection_type: String,
    },
    DataChannelClose {
        uuid: String,
        stream_id: Option<String>,
        connection_type: String,
    },
    DataReceived {
        uuid: String,
        stream_id: Option<String>,
        data: Value,
        fallback: bool,
    },
    PeerInfo {
        uuid: String,
        stream_id: Option<String>,
        info: Value,
    },
    PeerLatency {
        uuid: String,
        stream_id: Option<String>,
        latency_ms: i64,
    },
    RemoteVideoMuteState {
        uuid: String,
        muted: bool,
        raw: Value,
    },
    ObsState {
        uuid: String,
        state: Value,
        update: Value,
    },
    /// A remote media track. Read RTP with `track.poll().await`.
    Track {
        uuid: String,
        stream_id: Option<String>,
        track: Arc<dyn TrackRemote>,
    },
    ChannelMessage {
        uuid: String,
        channel: String,
        data: Value,
        timestamp: i64,
    },
    PeerSubscribed {
        uuid: String,
        channels: Vec<String>,
        all_channels: Vec<String>,
    },
    PeerUnsubscribed {
        uuid: String,
        channels: Vec<String>,
        all_channels: Vec<String>,
    },
    /// A peer opened a reserved `x-` channel (other than `x-bin`).
    ChannelOpen {
        uuid: String,
        label: String,
        channel: Arc<dyn DataChannel>,
    },
    BinaryReceived {
        uuid: String,
        stream_id: Option<String>,
        data: Bytes,
    },
    FileList {
        uuid: String,
        stream_id: Option<String>,
        files: Vec<FileEntry>,
    },
    FileTransferStart {
        uuid: String,
        file: FileInfo,
        requested: bool,
    },
    FileTransferProgress {
        uuid: String,
        file: FileInfo,
    },
    FileChunk {
        uuid: String,
        file: FileInfo,
        chunk: Bytes,
    },
    FileTransferComplete {
        uuid: String,
        file: FileInfo,
    },
    FileTransferCancelled {
        uuid: String,
        file: FileInfo,
    },
    FileTransferError {
        uuid: String,
        file: FileInfo,
        error: String,
    },
    ResourceReceived {
        uuid: String,
        template_name: String,
        metadata: Value,
        data: Bytes,
    },
    UnsupportedChannel {
        uuid: String,
        label: String,
    },
    Bye {
        uuid: String,
        raw: Value,
    },
    Hangup {
        uuid: String,
        raw: Value,
    },
    Alert {
        message: String,
        raw: Value,
    },
    Error {
        message: String,
        uuid: Option<String>,
    },
}

impl Event {
    /// Event name as used by the JavaScript SDK.
    pub fn name(&self) -> &'static str {
        match self {
            Event::Connected => "connected",
            Event::Disconnected { .. } => "disconnected",
            Event::Reconnecting { .. } => "reconnecting",
            Event::Reconnected => "reconnected",
            Event::ReconnectFailed => "reconnectFailed",
            Event::RoomJoined { .. } => "roomJoined",
            Event::RoomLeft { .. } => "roomLeft",
            Event::Listing { .. } => "listing",
            Event::VideoAddedToRoom { .. } => "videoaddedtoroom",
            Event::SomeoneJoined { .. } => "someoneJoined",
            Event::Transferred { .. } => "transferred",
            Event::Publishing { .. } => "publishing",
            Event::PublishingStopped { .. } => "publishingStopped",
            Event::ViewingStopped { .. } => "viewingStopped",
            Event::PeerConnected { .. } => "peerConnected",
            Event::PeerDisconnected { .. } => "peerDisconnected",
            Event::ConnectionFailed { .. } => "connectionFailed",
            Event::IceRestart { .. } => "iceRestart",
            Event::DataChannelOpen { .. } => "dataChannelOpen",
            Event::DataChannelClose { .. } => "dataChannelClose",
            Event::DataReceived { .. } => "dataReceived",
            Event::PeerInfo { .. } => "peerInfo",
            Event::PeerLatency { .. } => "peerLatency",
            Event::RemoteVideoMuteState { .. } => "remoteVideoMuteState",
            Event::ObsState { .. } => "obsState",
            Event::Track { .. } => "track",
            Event::ChannelMessage { .. } => "channelMessage",
            Event::PeerSubscribed { .. } => "peerSubscribed",
            Event::PeerUnsubscribed { .. } => "peerUnsubscribed",
            Event::ChannelOpen { .. } => "channelOpen",
            Event::BinaryReceived { .. } => "binaryReceived",
            Event::FileList { .. } => "fileList",
            Event::FileTransferStart { .. } => "fileTransferStart",
            Event::FileTransferProgress { .. } => "fileTransferProgress",
            Event::FileChunk { .. } => "fileChunk",
            Event::FileTransferComplete { .. } => "fileTransferComplete",
            Event::FileTransferCancelled { .. } => "fileTransferCancelled",
            Event::FileTransferError { .. } => "fileTransferError",
            Event::ResourceReceived { .. } => "resourceReceived",
            Event::UnsupportedChannel { .. } => "unsupportedChannel",
            Event::Bye { .. } => "bye",
            Event::Hangup { .. } => "hangup",
            Event::Alert { .. } => "alert",
            Event::Error { .. } => "error",
        }
    }
}

impl fmt::Debug for Event {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Event::Track {
                uuid, stream_id, ..
            } => f
                .debug_struct("Track")
                .field("uuid", uuid)
                .field("stream_id", stream_id)
                .finish(),
            Event::ChannelOpen { uuid, label, .. } => f
                .debug_struct("ChannelOpen")
                .field("uuid", uuid)
                .field("label", label)
                .finish(),
            Event::DataReceived { uuid, data, .. } => f
                .debug_struct("DataReceived")
                .field("uuid", uuid)
                .field("data", data)
                .finish(),
            Event::BinaryReceived { uuid, data, .. } => f
                .debug_struct("BinaryReceived")
                .field("uuid", uuid)
                .field("len", &data.len())
                .finish(),
            Event::FileChunk { uuid, file, chunk } => f
                .debug_struct("FileChunk")
                .field("uuid", uuid)
                .field("file", file)
                .field("len", &chunk.len())
                .finish(),
            Event::Error { message, uuid } => f
                .debug_struct("Error")
                .field("message", message)
                .field("uuid", uuid)
                .finish(),
            Event::Alert { message, .. } => {
                f.debug_struct("Alert").field("message", message).finish()
            }
            other => write!(f, "{}", other.name()),
        }
    }
}
