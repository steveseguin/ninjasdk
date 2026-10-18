// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
//
// The Rust peer of the cross-language interoperability test
// (spec/interop/run_interop.py).
//
//   cargo run --example interop -- --role publish --stream s1 --host ws://127.0.0.1:8080
//   cargo run --example interop -- --role view --stream s1 --host ws://127.0.0.1:8080

use std::time::Duration;

use serde_json::{json, Value};
use vdoninja::{Event, Options, PublishOptions, VdoNinja, ViewOptions};

fn arg(args: &[String], name: &str, default: &str) -> String {
    args.windows(2)
        .find(|w| w[0] == name)
        .map(|w| w[1].clone())
        .unwrap_or_else(|| default.to_string())
}

fn fail(msg: &str) -> ! {
    println!("FAIL {msg}");
    std::process::exit(1)
}

#[tokio::main]
async fn main() {
    env_logger::init();
    let args: Vec<String> = std::env::args().collect();
    let role = arg(&args, "--role", "view");
    let stream = arg(&args, "--stream", "interop");
    let host = arg(&args, "--host", "wss://wss.vdo.ninja");
    let password = args
        .windows(2)
        .find(|w| w[0] == "--password")
        .map(|w| w[1].clone());

    let sdk = VdoNinja::new(Options {
        host,
        password,
        label: Some("rust".into()),
        ..Default::default()
    });
    let mut events = sdk.events();
    if let Err(e) = sdk.connect().await {
        fail(&format!("connect: {e}"));
    }
    if role == "publish" {
        sdk.on_request("whoami", |data, _from| async move {
            Ok::<Value, String>(json!({"lang": "rust", "got": data}))
        });
        if let Err(e) = sdk
            .announce(PublishOptions {
                stream_id: Some(stream),
                ..Default::default()
            })
            .await
        {
            fail(&format!("announce: {e}"));
        }
        println!("READY");
        while let Ok(ev) = events.recv().await {
            if let Event::DataReceived { uuid, data, .. } = ev {
                if let Some(probe) = data.get("probe") {
                    sdk.send_data_to(&uuid, json!({"echo": probe, "lang": "rust"}))
                        .await;
                }
            }
        }
        return;
    }

    let conn = match tokio::time::timeout(
        Duration::from_secs(30),
        sdk.view(&stream, ViewOptions::default()),
    )
    .await
    {
        Ok(Ok(c)) => c,
        Ok(Err(e)) => fail(&format!("view: {e}")),
        Err(_) => fail("view timeout"),
    };
    let uuid = conn.uuid.clone();
    let probe = format!("rust-{}", std::process::id() % 100000);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut sent = false;
    loop {
        let ev = match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Ok(ev)) => ev,
            Ok(Err(_)) => fail("event stream closed"),
            Err(_) => fail("timeout waiting for echo"),
        };
        match ev {
            Event::DataChannelOpen { uuid: u, .. } if !sent && u == uuid => {
                sdk.send_data_to(&uuid, json!({"probe": probe})).await;
                sent = true;
            }
            Event::DataReceived { data, .. } if data.get("echo").is_some() => {
                if data["echo"] != json!(probe) {
                    fail(&format!("echo mismatch {data}"));
                }
                println!(
                    "OK echo {probe} from {}",
                    data["lang"].as_str().unwrap_or("?")
                );
                break;
            }
            _ => {}
        }
    }
    match sdk
        .request("whoami", json!({"q": 1}), &uuid, Duration::from_secs(10))
        .await
    {
        Ok(res) => println!("OK rpc {res}"),
        Err(e) => fail(&format!("request: {e}")),
    }
    sdk.disconnect().await;
}
