// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

//! Configuration types.

use std::time::Duration;

use serde_json::Value;
use vdoninja_core::turn::IceServer;

/// How TURN relay servers are obtained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnMode {
    /// Fetch the hosted TURN list (built-in fallback list on failure).
    Auto,
    /// STUN only. Cross-network connections may fail.
    Disabled,
    /// Use the given servers verbatim.
    Custom(Vec<IceServer>),
}

/// SDK options. `Options::default()` connects to the hosted service with the
/// shared default password and salt `vdo.ninja`.
#[derive(Debug, Clone)]
pub struct Options {
    /// Signaling WebSocket URL.
    pub host: String,
    /// Default room for `join_room(None)`.
    pub room: Option<String>,
    /// Original (not URL-encoded) password. `None` uses the shared default.
    pub password: Option<String>,
    /// Disable password hashing and signaling encryption (JS `password: false`).
    pub no_password: bool,
    /// Salt; must match the viewer's domain salt (`vdo.ninja` for vdo.ninja).
    pub salt: String,
    /// Publisher label sent to viewers when the control channel opens.
    pub label: Option<String>,
    /// Publisher `meta` (VDO.Ninja expects an object).
    pub meta: Option<Value>,
    /// Publisher ordering hint.
    pub order: Option<String>,
    /// Additional publisher info flags (`broadcast`, `allowdrawing`, ...).
    pub info: Option<Value>,
    /// TURN handling.
    pub turn: TurnMode,
    /// Relay-only ICE.
    pub force_turn: bool,
    /// Skip UDP TURN servers when selecting from the hosted list.
    pub force_tcp: bool,
    /// Hosted TURN list URL.
    pub turn_url: String,
    /// TURN list cache TTL.
    pub turn_cache_ttl: Duration,
    /// STUN URLs; empty disables STUN.
    pub stun_servers: Vec<String>,
    /// Local UDP bind addresses for ICE (`0.0.0.0:0` expands to all interfaces).
    pub bind_addrs: Vec<String>,
    /// Gather loopback host candidates (useful for tests on one machine).
    pub include_loopback: bool,
    pub max_reconnect_attempts: u32,
    pub reconnect_delay: Duration,
    pub connection_timeout: Duration,
    pub disconnect_grace_period: Duration,
    pub view_retry_interval: Duration,
    pub auto_ping_viewer: bool,
    pub auto_ping_interval: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            host: vdoninja_core::DEFAULT_HOST.into(),
            room: None,
            password: None,
            no_password: false,
            salt: vdoninja_core::DEFAULT_SALT.into(),
            label: None,
            meta: None,
            order: None,
            info: None,
            turn: TurnMode::Auto,
            force_turn: false,
            force_tcp: false,
            turn_url: vdoninja_core::DEFAULT_TURN_URL.into(),
            turn_cache_ttl: Duration::from_secs(300),
            stun_servers: vdoninja_core::DEFAULT_STUN_SERVERS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            bind_addrs: vec!["0.0.0.0:0".into()],
            include_loopback: false,
            max_reconnect_attempts: 5,
            reconnect_delay: Duration::from_secs(1),
            connection_timeout: Duration::from_secs(20),
            disconnect_grace_period: Duration::from_secs(5),
            view_retry_interval: Duration::from_secs(900),
            auto_ping_viewer: false,
            auto_ping_interval: Duration::from_secs(10),
        }
    }
}

/// Options for `publish`/`announce`.
#[derive(Debug, Clone, Default)]
pub struct PublishOptions {
    pub stream_id: Option<String>,
    pub room: Option<String>,
    pub password: Option<String>,
    pub label: Option<String>,
    pub meta: Option<Value>,
    pub order: Option<String>,
    pub info: Option<Value>,
}

/// Options for `view`.
#[derive(Debug, Clone)]
pub struct ViewOptions {
    pub audio: bool,
    pub video: bool,
    pub label: Option<String>,
    /// Advertise willingness to receive file offers (default true).
    pub downloads: bool,
    /// Opt in to VDO.Ninja's `resources` channel.
    pub allow_resources: bool,
    /// How long `view` waits for the publisher's offer (default 15s).
    pub timeout: Duration,
}

impl Default for ViewOptions {
    fn default() -> Self {
        Self {
            audio: true,
            video: true,
            label: None,
            downloads: true,
            allow_resources: false,
            timeout: Duration::from_secs(15),
        }
    }
}

impl ViewOptions {
    /// Audio and video off.
    pub fn data_only() -> Self {
        Self {
            audio: false,
            video: false,
            ..Default::default()
        }
    }
}

/// Routing for `send_data_with`.
#[derive(Debug, Clone, Default)]
pub struct DataTarget {
    pub uuid: Option<String>,
    /// "publisher" or "viewer".
    pub connection_type: Option<String>,
    pub stream_id: Option<String>,
    /// "any" (default), "publisher", "viewer" or "all".
    pub preference: Option<String>,
}

/// Options for `auto_connect`.
#[derive(Debug, Clone, Default)]
pub struct AutoConnectOptions {
    /// "half" (default, one channel per pair) or "full" (view everyone).
    pub mode: Option<String>,
    pub view: Option<ViewOptions>,
    pub label: Option<String>,
    pub password: Option<String>,
    pub stream_id: Option<String>,
}
