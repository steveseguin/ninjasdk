// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! VDO.Ninja SDK for Rust.
//!
//! Publish, view and exchange data with VDO.Ninja peers over WebRTC using
//! [`webrtc-rs`](https://webrtc.rs) as the engine and VDO.Ninja's hosted (or a
//! self-hosted) signaling server. The wire protocol matches the JavaScript SDK
//! and VDO.Ninja browser pages: hashed room and stream IDs, AES-CBC encrypted
//! SDP/ICE, the `sendChannel` control channel, publisher/viewer roles,
//! ping/pong, pub/sub, request/response and native file transfer.
//!
//! ```no_run
//! use vdoninja::{Event, Options, VdoNinja};
//!
//! #[tokio::main]
//! async fn main() -> vdoninja::Result<()> {
//!     let sdk = VdoNinja::new(Options::default());
//!     let mut events = sdk.events();
//!     let ctl = sdk.auto_connect("replace_with_a_unique_room", Default::default()).await?;
//!     while let Ok(ev) = events.recv().await {
//!         match ev {
//!             Event::DataChannelOpen { uuid, .. } => {
//!                 sdk.send_data_to(&uuid, serde_json::json!({"message": "Hello from Rust"})).await;
//!             }
//!             Event::DataReceived { uuid, data, .. } => println!("{uuid}: {data}"),
//!             _ => {}
//!         }
//!     }
//!     ctl.stop();
//!     Ok(())
//! }
//! ```
//!
//! Hosted-service notice: use of signaling, TURN and related services operated
//! by Steve Seguin is subject to the applicable Terms of Service and
//! operational policies. This SDK is the supported way to use them; only
//! WebRTC handshake data may pass through the signaling server.

pub mod events;
pub mod media;
pub mod options;
pub mod sdk;
pub mod signalserver;
pub mod whip;

pub use events::{Event, FileInfo};
pub use options::{AutoConnectOptions, DataTarget, Options, PublishOptions, TurnMode, ViewOptions};
pub use sdk::{AutoConnectController, Connection, FileResult, VdoNinja};
pub use vdoninja_core as core;
pub use vdoninja_core::protocol::{FileEntry, ListingEntry};
pub use webrtc;

/// Errors returned by the SDK.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not connected to signaling server")]
    NotConnected,
    #[error("room name is required")]
    RoomRequired,
    #[error("room join timeout")]
    RoomJoinTimeout,
    #[error("stream not available yet; the view request stays pending")]
    StreamNotYetAvailable,
    #[error("not publishing")]
    NotPublishing,
    #[error("already publishing on this connection; disconnect and reconnect to publish a different stream")]
    AlreadyPublishing,
    #[error("no open data channel to peer")]
    NoDataChannel,
    #[error("peer not found")]
    PeerNotFound,
    #[error("request timeout: {0}")]
    RequestTimeout(String),
    #[error("operation cancelled by disconnect")]
    Cancelled,
    #[error("password encryption disabled")]
    EncryptionDisabled,
    #[error("label uses the reserved x- prefix")]
    ReservedChannelLabel,
    #[error("peer did not advertise allowresources")]
    ResourcesNotAdvertised,
    #[error("file transfer error: {0}")]
    FileTransfer(String),
    #[error("remote error: {0}")]
    Remote(String),
    #[error("signaling: {0}")]
    Signaling(String),
    #[error("webrtc: {0}")]
    WebRtc(String),
    #[error("http: {0}")]
    Http(String),
    #[error("{0}")]
    Other(String),
}

impl From<webrtc::error::Error> for Error {
    fn from(e: webrtc::error::Error) -> Self {
        Error::WebRtc(e.to_string())
    }
}

impl From<tokio_tungstenite::tungstenite::Error> for Error {
    fn from(e: tokio_tungstenite::tungstenite::Error) -> Self {
        Error::Signaling(e.to_string())
    }
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        Error::Http(e.to_string())
    }
}

/// Result alias.
pub type Result<T> = std::result::Result<T, Error>;
