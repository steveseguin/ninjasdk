use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use serde_json::json;
use tokio::sync::broadcast;
use vdoninja::media::SampleTrack;
use vdoninja::signalserver::SignalServer;
use vdoninja::webrtc::media_stream::track_remote::TrackRemoteEvent;
use vdoninja::{
    AutoConnectOptions, Error, Event, Options, PublishOptions, TurnMode, VdoNinja, ViewOptions,
};

fn opts(host: &str) -> Options {
    Options {
        host: host.to_string(),
        password: Some("test pass!".into()),
        turn: TurnMode::Disabled,
        stun_servers: vec![],
        include_loopback: true,
        bind_addrs: vec!["127.0.0.1:0".into()],
        connection_timeout: Duration::from_secs(10),
        ..Default::default()
    }
}

/// Binds the test signaling server, retrying transient socket errors: Windows runners can
/// report WSAENOBUFS while the ICE sockets of a previous test are still being released.
async fn bind_server() -> SignalServer {
    let mut delay = Duration::from_millis(100);
    let mut attempt = 0;
    loop {
        match SignalServer::bind("127.0.0.1:0").await {
            Ok(server) => return server,
            Err(e) if attempt < 5 => {
                eprintln!("signal server bind failed ({e}); retrying");
                tokio::time::sleep(delay).await;
                delay *= 2;
                attempt += 1;
            }
            Err(e) => panic!("signal server bind failed: {e}"),
        }
    }
}

async fn wait_for<F>(rx: &mut broadcast::Receiver<Event>, timeout: Duration, mut pred: F) -> Event
where
    F: FnMut(&Event) -> bool,
{
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(ev)) => {
                if pred(&ev) {
                    return ev;
                }
            }
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => panic!("event channel closed"),
            Err(_) => panic!("timeout waiting for event"),
        }
    }
}

#[tokio::test]
async fn data_round_trip() {
    let _ = env_logger::try_init();
    let server = bind_server().await;
    let host = server.url();
    let pub_sdk = VdoNinja::new(Options {
        label: Some("Rust publisher".into()),
        ..opts(&host)
    });
    let view_sdk = VdoNinja::new(opts(&host));
    let mut pub_ev = pub_sdk.events();
    let mut view_ev = view_sdk.events();

    pub_sdk.connect().await.unwrap();
    pub_sdk.join_room("rs-test-room").await.unwrap();
    let sid = pub_sdk
        .announce(PublishOptions {
            stream_id: Some("rspub".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(sid, "rspub");

    view_sdk.connect().await.unwrap();
    view_sdk.join_room("rs-test-room").await.unwrap();
    let conn = view_sdk
        .view(
            "rspub",
            ViewOptions {
                label: Some("Rust viewer".into()),
                ..ViewOptions::data_only()
            },
        )
        .await
        .unwrap();
    assert_eq!(conn.stream_id().as_deref(), Some("rspub"));
    assert_eq!(conn.kind, "viewer");

    let open = wait_for(&mut pub_ev, Duration::from_secs(15), |e| {
        matches!(e, Event::DataChannelOpen { .. })
    })
    .await;
    let viewer_uuid = match open {
        Event::DataChannelOpen { uuid, .. } => uuid,
        _ => unreachable!(),
    };
    let info = wait_for(&mut view_ev, Duration::from_secs(10), |e| {
        matches!(e, Event::PeerInfo { .. })
    })
    .await;
    if let Event::PeerInfo { info, .. } = info {
        assert_eq!(info["label"], "Rust publisher");
    }

    assert!(view_sdk.send_data(json!({"hello": "publisher"})).await);
    let ev = wait_for(&mut pub_ev, Duration::from_secs(10), |e| {
        matches!(e, Event::DataReceived { .. })
    })
    .await;
    if let Event::DataReceived { uuid, data, .. } = ev {
        assert_eq!(data, json!({"hello": "publisher"}));
        assert_eq!(uuid, viewer_uuid);
    }
    assert!(
        pub_sdk
            .send_data_to(&viewer_uuid, json!("plain string"))
            .await
    );
    let ev = wait_for(&mut view_ev, Duration::from_secs(10), |e| {
        matches!(e, Event::DataReceived { .. })
    })
    .await;
    if let Event::DataReceived { data, .. } = ev {
        assert_eq!(data, json!("plain string"));
    }

    assert!(view_sdk.send_ping(&conn.uuid).await);
    let ev = wait_for(&mut view_ev, Duration::from_secs(10), |e| {
        matches!(e, Event::PeerLatency { .. })
    })
    .await;
    if let Event::PeerLatency { latency_ms, .. } = ev {
        assert!((0..5000).contains(&latency_ms));
    }

    pub_sdk.on_request("add", |data, _from| async move {
        Ok(json!(
            data["a"].as_f64().unwrap_or(0.0) + data["b"].as_f64().unwrap_or(0.0)
        ))
    });
    let res = view_sdk
        .request(
            "add",
            json!({"a": 2, "b": 3}),
            &conn.uuid,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert_eq!(res, json!(5.0));
    pub_sdk.on_request("fail", |_d, _f| async move {
        Err::<serde_json::Value, _>("nope".to_string())
    });
    match view_sdk
        .request("fail", json!(null), &conn.uuid, Duration::from_secs(5))
        .await
    {
        Err(Error::Remote(m)) => assert_eq!(m, "nope"),
        other => panic!("expected remote error, got {other:?}"),
    }

    pub_sdk.subscribe(&["news"]).await;
    wait_for(&mut view_ev, Duration::from_secs(10), |e| {
        matches!(e, Event::PeerSubscribed { .. })
    })
    .await;
    view_sdk
        .publish_to_channel("news", json!("headline"), None)
        .await;
    let ev = wait_for(&mut pub_ev, Duration::from_secs(10), |e| {
        matches!(e, Event::ChannelMessage { .. })
    })
    .await;
    if let Event::ChannelMessage { channel, data, .. } = ev {
        assert_eq!(channel, "news");
        assert_eq!(data, json!("headline"));
    }

    let payload: Vec<u8> = (0..100_000u32).map(|i| (i * 7 % 251) as u8).collect();
    let payload = Bytes::from(payload);
    view_sdk
        .send_binary(&conn.uuid, payload.slice(0..16000))
        .await
        .unwrap();
    let ev = wait_for(&mut pub_ev, Duration::from_secs(10), |e| {
        matches!(e, Event::BinaryReceived { .. })
    })
    .await;
    if let Event::BinaryReceived { data, .. } = ev {
        assert_eq!(data, payload.slice(0..16000));
    }

    let entry = pub_sdk
        .host_file("blob.bin", payload.clone(), None, None)
        .await
        .unwrap();
    let ev = wait_for(&mut view_ev, Duration::from_secs(10), |e| {
        matches!(e, Event::FileList { .. })
    })
    .await;
    if let Event::FileList { files, .. } = ev {
        assert_eq!(files[0].id, entry.id);
        assert_eq!(files[0].size, payload.len() as u64);
    }
    let result = view_sdk
        .request_file(&conn.uuid, &entry.id, false, Duration::from_secs(30))
        .await
        .unwrap();
    assert_eq!(result.name, "blob.bin");
    assert_eq!(result.data.unwrap(), payload);

    view_sdk.stop_viewing("rspub").await;
    wait_for(&mut pub_ev, Duration::from_secs(10), |e| {
        matches!(e, Event::PeerDisconnected { .. })
    })
    .await;
    pub_sdk.disconnect().await;
    view_sdk.disconnect().await;
}

#[tokio::test]
async fn media_publish_view() {
    let _ = env_logger::try_init();
    let server = bind_server().await;
    let host = server.url();
    let pub_sdk = VdoNinja::new(opts(&host));
    let view_sdk = VdoNinja::new(opts(&host));
    let mut view_ev = view_sdk.events();

    let video = SampleTrack::new("video/VP8", "rscam", "video").unwrap();
    let audio = SampleTrack::new("audio/opus", "rscam", "audio").unwrap();
    let v2 = video.clone();
    let a2 = audio.clone();
    let feeder = tokio::spawn(async move {
        let frame =
            Bytes::from_static(&[0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00]);
        let mut ticker = tokio::time::interval(Duration::from_millis(33));
        loop {
            ticker.tick().await;
            let _ = v2.write(frame.clone(), Duration::from_millis(33)).await;
            let _ = a2
                .write(
                    Bytes::from_static(&[0xfc, 0xff, 0xfe]),
                    Duration::from_millis(20),
                )
                .await;
        }
    });

    pub_sdk.connect().await.unwrap();
    pub_sdk
        .publish(
            vec![video.local(), audio.local()],
            PublishOptions {
                stream_id: Some("rscam".into()),
                room: Some("rs-media".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    view_sdk.connect().await.unwrap();
    view_sdk.join_room("rs-media").await.unwrap();
    view_sdk
        .view("rscam", ViewOptions::default())
        .await
        .unwrap();

    let mut kinds = std::collections::HashSet::new();
    while kinds.len() < 2 {
        let ev = wait_for(&mut view_ev, Duration::from_secs(20), |e| {
            matches!(e, Event::Track { .. })
        })
        .await;
        if let Event::Track { track, .. } = ev {
            let kind = track.kind().await;
            kinds.insert(format!("{kind:?}"));
            if format!("{kind:?}").to_lowercase().contains("video") {
                let t = track.clone();
                let packet = tokio::time::timeout(Duration::from_secs(10), async move {
                    while let Some(ev) = t.poll().await {
                        if let TrackRemoteEvent::OnRtpPacket(p) = ev {
                            return Some(p);
                        }
                    }
                    None
                })
                .await
                .expect("rtp packet timeout")
                .expect("track ended");
                assert!(!packet.payload.is_empty());
            }
        }
    }
    feeder.abort();
    pub_sdk.disconnect().await;
    view_sdk.disconnect().await;
}

#[tokio::test]
async fn auto_connect_half_mesh() {
    let _ = env_logger::try_init();
    let server = bind_server().await;
    let host = server.url();
    let a = VdoNinja::new(opts(&host));
    let b = VdoNinja::new(opts(&host));
    let mut a_ev = a.events();
    let mut b_ev = b.events();
    let ca = a
        .auto_connect(
            "rs-mesh",
            AutoConnectOptions {
                stream_id: Some("peer_a".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let cb = b
        .auto_connect(
            "rs-mesh",
            AutoConnectOptions {
                stream_id: Some("peer_b".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    wait_for(&mut b_ev, Duration::from_secs(15), |e| {
        matches!(e, Event::DataChannelOpen { .. })
    })
    .await;
    assert!(b.send_data(json!("mesh hello")).await);
    let ev = wait_for(&mut a_ev, Duration::from_secs(10), |e| {
        matches!(e, Event::DataReceived { .. })
    })
    .await;
    if let Event::DataReceived { data, .. } = ev {
        assert_eq!(data, json!("mesh hello"));
    }
    assert_eq!(a.peers().len(), 1);
    assert_eq!(b.peers().len(), 1);
    let pa = a.peers()[0].clone();
    assert!(!(a.connection(&pa, "publisher").is_some() && a.connection(&pa, "viewer").is_some()));
    ca.stop();
    cb.stop();
    a.disconnect().await;
    b.disconnect().await;
}

#[tokio::test]
async fn no_password_and_pending_view() {
    let _ = env_logger::try_init();
    let server = bind_server().await;
    let host = server.url();
    let pub_sdk = VdoNinja::new(Options {
        no_password: true,
        ..opts(&host)
    });
    let view_sdk = VdoNinja::new(Options {
        no_password: true,
        ..opts(&host)
    });
    let mut view_ev = view_sdk.events();
    view_sdk.connect().await.unwrap();
    view_sdk.join_room("late-room").await.unwrap();
    match view_sdk
        .view(
            "late",
            ViewOptions {
                timeout: Duration::from_millis(500),
                ..ViewOptions::data_only()
            },
        )
        .await
    {
        Err(Error::StreamNotYetAvailable) => {}
        other => panic!("expected pending, got {:?}", other.map(|_| ())),
    }
    pub_sdk.connect().await.unwrap();
    pub_sdk.join_room("late-room").await.unwrap();
    pub_sdk
        .announce(PublishOptions {
            stream_id: Some("late".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    wait_for(&mut view_ev, Duration::from_secs(15), |e| {
        matches!(e, Event::DataChannelOpen { .. })
    })
    .await;
    pub_sdk.disconnect().await;
    view_sdk.disconnect().await;
    let _ = Arc::new(());
}

#[tokio::test]
async fn request_file_fails_when_connection_closes() {
    let _ = env_logger::try_init();
    let server = bind_server().await;
    let host = server.url();
    let pub_sdk = VdoNinja::new(opts(&host));
    let view_sdk = VdoNinja::new(opts(&host));
    let mut view_ev = view_sdk.events();

    pub_sdk.connect().await.unwrap();
    pub_sdk.join_room("rs-file-room").await.unwrap();
    pub_sdk
        .announce(PublishOptions {
            stream_id: Some("rsfile".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    view_sdk.connect().await.unwrap();
    view_sdk.join_room("rs-file-room").await.unwrap();
    let conn = view_sdk
        .view("rsfile", ViewOptions::data_only())
        .await
        .unwrap();
    wait_for(&mut view_ev, Duration::from_secs(10), |e| {
        matches!(e, Event::DataChannelOpen { .. })
    })
    .await;

    // Large enough that the download is still in flight when we close.
    let payload = Bytes::from(vec![0x5au8; 96 * 1024 * 1024]);
    let entry = pub_sdk
        .host_file("big.bin", payload, None, None)
        .await
        .unwrap();
    wait_for(&mut view_ev, Duration::from_secs(10), |e| {
        matches!(e, Event::FileList { .. })
    })
    .await;
    let viewer = view_sdk.clone();
    let uuid = conn.uuid.clone();
    let id = entry.id.clone();
    let download = tokio::spawn(async move {
        viewer
            .request_file(&uuid, &id, false, Duration::from_secs(60))
            .await
    });
    wait_for(&mut view_ev, Duration::from_secs(10), |e| {
        matches!(e, Event::FileTransferStart { .. })
    })
    .await;

    // Closing our own side mid-transfer must fail the download promptly, not hang.
    view_sdk.stop_viewing("rsfile").await;
    let result = tokio::time::timeout(Duration::from_secs(10), download)
        .await
        .expect("request_file hung after the connection closed")
        .unwrap();
    assert!(
        result.is_err(),
        "download must fail once the connection is closed"
    );

    pub_sdk.disconnect().await;
    view_sdk.disconnect().await;
}
