// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
//
// Terminal P2P chat over VDO.Ninja data channels.
//
//   cargo run --example chat -- <room> [name] [password]

use std::io::BufRead;

use serde_json::json;
use vdoninja::{AutoConnectOptions, Event, Options, VdoNinja};

#[tokio::main]
async fn main() -> vdoninja::Result<()> {
    env_logger::init();
    let args: Vec<String> = std::env::args().collect();
    let room = args.get(1).cloned().unwrap_or_else(|| {
        eprintln!("usage: chat <room> [name] [password]");
        std::process::exit(2)
    });
    let name = args.get(2).cloned();
    let password = args.get(3).cloned();

    let sdk = VdoNinja::new(Options {
        password,
        label: name.clone(),
        ..Default::default()
    });
    let mut events = sdk.events();
    let ctl = sdk
        .auto_connect(
            &room,
            AutoConnectOptions {
                stream_id: name.clone(),
                label: name.clone(),
                ..Default::default()
            },
        )
        .await?;
    let me = ctl.stream_id.clone();
    println!("Joined {room:?} as {me:?}. Type messages and press enter; Ctrl-C to quit.");

    let printer = tokio::spawn(async move {
        while let Ok(ev) = events.recv().await {
            match ev {
                Event::DataChannelOpen { uuid, .. } => {
                    println!("* {} connected", &uuid[..8.min(uuid.len())])
                }
                Event::PeerDisconnected { uuid } => {
                    println!("* {} left", &uuid[..8.min(uuid.len())])
                }
                Event::DataReceived { uuid, data, .. } => {
                    let from = data
                        .get("from")
                        .and_then(|f| f.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| uuid[..8.min(uuid.len())].to_string());
                    match data.get("message").and_then(|m| m.as_str()) {
                        Some(m) => println!("<{from}> {m}"),
                        None => println!("<{from}> {data}"),
                    }
                }
                _ => {}
            }
        }
    });

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    loop {
        tokio::select! {
            Some(line) = rx.recv() => {
                if line.is_empty() { continue; }
                if !sdk.send_data(json!({"message": line, "from": me})).await {
                    println!("(no peers connected yet)");
                }
            }
            _ = tokio::signal::ctrl_c() => break,
        }
    }
    printer.abort();
    ctl.stop();
    sdk.disconnect().await;
    Ok(())
}
