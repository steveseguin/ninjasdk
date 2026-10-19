// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

//! `vdoninja-signal [addr]` runs a local VDO.Ninja-compatible signaling server
//! (default `0.0.0.0:8080`). Point SDKs at `ws://host:port` and browser pages at
//! `&wss2=host:port` (TLS needed for https pages; put it behind a reverse proxy).

use vdoninja::signalserver::SignalServer;

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let addr = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "0.0.0.0:8080".to_string());
    let server = SignalServer::bind(&addr).await?;
    println!("vdoninja-signal listening on {}", server.url());
    tokio::signal::ctrl_c().await?;
    Ok(())
}
