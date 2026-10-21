// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
//
// cargo run --example av -- --publish rustcam
// cargo run --example av -- --view browsercam --out received
// See ../../README.md for browser links and the signaling sequence.

use bytes::Bytes;
use rtc::{
    media::io::{
        ivf_reader::{IVFFileHeader, IVFReader},
        ivf_writer::IVFWriter,
        ogg_reader::OggReader,
        ogg_writer::OggWriter,
        Writer,
    },
    rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication,
};
use std::{
    fs::{self, File},
    io::BufReader,
    path::PathBuf,
    process::Command,
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{broadcast, watch},
    task::JoinSet,
    time::{Instant, MissedTickBehavior},
};
use vdoninja::{
    core::{encode_uri_component, generate_stream_id, sanitize_room, sanitize_stream_id},
    media::SampleTrack,
    webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent},
    Error, Event, Options, PublishOptions, VdoNinja, ViewOptions,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

struct Args {
    publish: Option<String>,
    view: Option<String>,
    room: Option<String>,
    out: PathBuf,
    host: String,
    browser_host: Option<String>,
    salt: String,
    no_password: bool,
    seconds: Option<u64>,
}

impl Args {
    fn parse() -> Result<Option<Self>> {
        let mut result = Self {
            publish: None,
            view: None,
            room: None,
            out: "received".into(),
            host: Options::default().host,
            browser_host: None,
            salt: Options::default().salt,
            no_password: false,
            seconds: None,
        };
        let mut args = std::env::args().skip(1);
        while let Some(key) = args.next() {
            if key == "--help" || key == "-h" {
                println!("av [--publish ID] [--view ID] [--room ROOM] [--out DIR] [--host WS_URL] [--browser-host WSS_URL] [--salt TEXT] [--no-password] [--seconds N]\n\
                    No mode specified: publish a randomly named test stream. Both modes may be combined.\n\
                    Set VDONINJA_PASSWORD to an original, unescaped password (default: SDK shared password).\n\
                    --no-password disables password hashing and signaling encryption, even if the environment is set.\n\
                    --browser-host selects a browser-accessible WSS endpoint when --host uses a local WS proxy.\n\
                    Publishing requires ffmpeg with libvpx/libopus. Receiving writes VP8/VP9 IVF and Opus OGG.\n\
                    Ctrl-C / SIGTERM sends bye, closes WebRTC, and finalizes recordings.");
                return Ok(None);
            }
            if key == "--no-password" {
                result.no_password = true;
                continue;
            }
            let value = args
                .next()
                .ok_or_else(|| format!("missing value for {key}"))?;
            match key.as_str() {
                "--publish" => result.publish = Some(value),
                "--view" => result.view = Some(value),
                "--room" => result.room = Some(sanitize_room(&value)),
                "--out" => result.out = value.into(),
                "--host" => result.host = value,
                "--browser-host" => result.browser_host = Some(value),
                "--salt" => result.salt = value,
                "--seconds" => {
                    result.seconds = Some(
                        value
                            .parse::<u64>()
                            .ok()
                            .filter(|v| *v > 0)
                            .ok_or("--seconds must be positive")?,
                    )
                }
                _ => return Err(format!("unknown option {key}; use --help").into()),
            }
        }
        if result.publish.is_none() && result.view.is_none() {
            result.publish = Some(generate_stream_id());
        }
        for id in [&result.publish, &result.view].into_iter().flatten() {
            if id.is_empty() || sanitize_stream_id(id) != *id {
                return Err("stream IDs must contain only letters, digits and underscores".into());
            }
        }
        if result.room.as_deref() == Some("") {
            return Err("room must not be empty".into());
        }
        if result.publish.is_some() && result.publish == result.view {
            return Err("use different publish and view IDs".into());
        }
        Ok(Some(result))
    }
}

struct TempMedia(PathBuf);
impl Drop for TempMedia {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// Encode once, then loop immutable complete packets. No Ogg headers are sent as
// Opus, and -page_duration guarantees exactly one 20 ms packet per audio page.
fn test_media() -> Result<(Vec<Bytes>, Vec<Bytes>)> {
    let dir = TempMedia(std::env::temp_dir().join(format!("vdoninja-av-{}", generate_stream_id())));
    fs::create_dir(&dir.0)?;
    let video = dir.0.join("test.ivf");
    let audio = dir.0.join("test.ogg");
    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=30",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000",
            "-map",
            "0:v",
            "-t",
            "5",
            "-c:v",
            "libvpx",
            "-deadline",
            "realtime",
            "-cpu-used",
            "8",
            "-b:v",
            "700k",
            "-g",
            "30",
            "-an",
            "-f",
            "ivf",
        ])
        .arg(&video)
        .args([
            "-map",
            "1:a",
            "-t",
            "5",
            "-c:a",
            "libopus",
            "-b:a",
            "64k",
            "-ac",
            "2",
            "-frame_duration",
            "20",
            "-page_duration",
            "20000",
            "-vn",
            "-f",
            "ogg",
        ])
        .arg(&audio)
        .status()
        .map_err(|e| format!("cannot run ffmpeg (install it with libvpx/libopus): {e}"))?;
    if !status.success() {
        return Err("ffmpeg could not generate the test stream".into());
    }
    let (mut ivf, _) = IVFReader::new(BufReader::new(File::open(video)?))?;
    let mut frames = Vec::with_capacity(150);
    for _ in 0..150 {
        frames.push(ivf.parse_next_frame()?.0.freeze());
    }
    let (mut ogg, _) = OggReader::new(BufReader::new(File::open(audio)?), true)?;
    let mut packets = Vec::with_capacity(250);
    while packets.len() < 250 {
        let (packet, header) = ogg.parse_next_page()?;
        if header.opus_header_type(&packet).is_none() {
            packets.push(packet.freeze());
        }
    }
    Ok((frames, packets))
}

async fn feed(
    track: SampleTrack,
    samples: Vec<Bytes>,
    duration: Duration,
    start: Instant,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let mut tick = tokio::time::interval_at(start, duration);
    tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut i = 0;
    loop {
        tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            _ = tick.tick() => {
                match track.write(samples[i].clone(), duration).await {
                    Ok(()) => {},
                    // A live source outlives individual viewer transports. The
                    // next viewer binds this track again; keep advancing samples.
                    Err(ref e) if viewer_teardown(e) => {},
                    Err(e) => return Err(e.into()),
                }
                i = (i + 1) % samples.len();
            }
        }
    }
}

fn viewer_teardown(error: &Error) -> bool {
    let Error::WebRtc(message) = error else {
        return false;
    };
    // webrtc-rs 0.21 flattens per-packet errors into newline-separated strings.
    // Its static RTP track reports a closed driver queue as SendError(SenderRtp).
    // Do not swallow codec, packetization, or other media errors.
    !message.is_empty()
        && message.lines().all(|line| {
            line == "bind failed"
                || line == "track is not binding yet"
                || (line.starts_with("SendError(SenderRtp(") && line.ends_with("))"))
        })
}

async fn receive(
    track: Arc<dyn TrackRemote>,
    out: PathBuf,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let ssrc = track
        .ssrcs()
        .await
        .first()
        .copied()
        .ok_or("track has no SSRC")?;
    let mime = track
        .codec(ssrc)
        .await
        .ok_or("track has no codec")?
        .mime_type
        .to_ascii_lowercase();
    let path = out.with_extension(if mime == "audio/opus" { "ogg" } else { "ivf" });
    let mut writer: Box<dyn Writer + Send> = match mime.as_str() {
        "audio/opus" => Box::new(OggWriter::new(File::create_new(&path)?, 48000, 2)?),
        "video/vp8" | "video/vp9" => Box::new(IVFWriter::new(
            File::create_new(&path)?,
            &IVFFileHeader {
                signature: *b"DKIF",
                version: 0,
                header_size: 32,
                four_cc: if mime == "video/vp8" {
                    *b"VP80"
                } else {
                    *b"VP90"
                },
                // IVFWriter timestamps by frame count; these are playback hints,
                // not a claim about the incoming stream's negotiated resolution/fps.
                width: 640,
                height: 360,
                timebase_denominator: 30,
                timebase_numerator: 1,
                num_frames: 0,
                unused: 0,
            },
        )?),
        _ => {
            return Err(format!(
                "unsupported recording codec {mime}; use &codec=vp8 on the browser publisher"
            )
            .into())
        }
    };
    println!("TRACK {mime} -> {}", path.display());
    let mut pli = tokio::time::interval(Duration::from_secs(2));
    pli.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut packets = 0u64;
    let result: Result<()> = async {
        loop {
            tokio::select! {
                biased;
                _ = stop.changed() => break,
                _ = pli.tick(), if mime.starts_with("video/") => {
                    track.write_rtcp(vec![Box::new(PictureLossIndication { sender_ssrc: 0, media_ssrc: ssrc })]).await?;
                }
                event = track.poll() => match event {
                    Some(TrackRemoteEvent::OnRtpPacket(packet)) => {
                        writer.write_rtp(&packet)?;
                        packets += 1;
                        if packets == 1 || packets % 250 == 0 { println!("RTP {mime} packets={packets}"); }
                    }
                    None => break,
                    _ => {}
                }
            }
        }
        Ok(())
    }.await;
    // Finalize even on an RTP/write error, before propagating it.
    let closed = writer.close();
    println!("SAVED {} packets={packets}", path.display());
    result?;
    closed?;
    Ok(())
}

fn browser_url(args: &Args, mode: &str, id: &str, password: Option<&str>) -> Result<String> {
    let mut url = reqwest::Url::parse("https://vdo.ninja/")?;
    let host = reqwest::Url::parse(args.browser_host.as_deref().unwrap_or(&args.host))?;
    if host.scheme() != "wss" || host.host_str().is_none() {
        return Err("VDO.Ninja browser links require WSS; use --browser-host wss://… with a local ws:// --host".into());
    }
    let mut query = url.query_pairs_mut();
    query
        .append_pair(mode, id)
        .append_pair("wss2", host.as_str());
    query.append_pair("salt", &args.salt);
    if let Some(room) = &args.room {
        query.append_pair("room", room);
    }
    if mode == "view" {
        query.append_pair("scene", "0");
    } else {
        // An empty view disables room auto-subscriptions. Use the WATCH page
        // for receiving: webrtc-rs sample tracks currently have one binding.
        query
            .append_pair("codec", "vp8")
            .append_pair("webcam", "1")
            .append_pair("view", "")
            .append_pair("autostart", "1");
    }
    // VDO.Ninja decodes the parsed query value again; URL serialization supplies
    // the outer escaping. SDK Options.password always receives the original text.
    if args.no_password {
        query.append_pair("password", "false");
    } else if let Some(password) = password.filter(|p| !p.trim().is_empty()) {
        let mut encoded = encode_uri_component(password.trim());
        // main.js checks disable keywords BEFORE its extra decodeURIComponent.
        // Escape their first byte so literal SDK strings stay literal passwords.
        if matches!(encoded.as_str(), "false" | "0" | "off") {
            encoded = format!("%{:02X}{}", encoded.as_bytes()[0], &encoded[1..]);
        }
        query.append_pair("password", &encoded);
    }
    drop(query);
    Ok(url.to_string())
}

async fn run(
    sdk: &VdoNinja,
    args: &Args,
    media: Option<(Vec<Bytes>, Vec<Bytes>)>,
    password: Option<&str>,
    jobs: &mut JoinSet<Result<()>>,
    stop: watch::Receiver<bool>,
) -> Result<()> {
    let mut events = sdk.events(); // Subscribe before connect/publish/view.
    sdk.connect().await?;
    if let Some((frames, packets)) = media {
        let video = SampleTrack::new("video/VP8", "rust-av", "video")?;
        let audio = SampleTrack::new("audio/opus", "rust-av", "audio")?;
        let id = sdk
            .publish(
                vec![video.local(), audio.local()],
                PublishOptions {
                    stream_id: args.publish.clone(),
                    room: args.room.clone(),
                    ..Default::default()
                },
            )
            .await?;
        let start = Instant::now();
        jobs.spawn(feed(
            video,
            frames,
            Duration::from_nanos(33_333_334),
            start,
            stop.clone(),
        ));
        jobs.spawn(feed(
            audio,
            packets,
            Duration::from_millis(20),
            start,
            stop.clone(),
        ));
        println!("WATCH {}", browser_url(args, "view", &id, password)?);
    } else if let Some(room) = &args.room {
        sdk.join_room(room).await?;
    }
    if let Some(id) = &args.view {
        fs::create_dir_all(&args.out)?;
        println!(
            "PUBLISH FROM BROWSER {}",
            browser_url(args, "push", id, password)?
        );
        // play -> offerSDP at publisher -> encrypted offer/answer + ICE ->
        // sendChannel opens -> {audio:true,video:true} -> media renegotiation.
        match sdk
            .view(
                id,
                ViewOptions {
                    timeout: Duration::from_secs(3),
                    downloads: false,
                    ..Default::default()
                },
            )
            .await
        {
            Ok(_) => {}
            Err(Error::StreamNotYetAvailable) => println!(
                "Waiting for publisher {id}; start the browser link above (same room/password)."
            ),
            Err(e) => return Err(e.into()),
        }
    }
    println!("READY (Ctrl-C to send bye and stop)");
    let mut track_number = 0;
    loop {
        tokio::select! {
            job = jobs.join_next(), if !jobs.is_empty() => { job.expect("nonempty task set")??; }
            event = events.recv() => match event {
                Ok(Event::DataChannelOpen { uuid, connection_type, .. }) => {
                    println!("CONTROL OPEN {connection_type} {uuid}");
                    // Use the native ping/pong control protocol; no application
                    // payload or metadata is needed for an A/V connection.
                    sdk.send_ping(&uuid).await;
                }
                Ok(Event::PeerLatency { uuid, latency_ms, .. }) => println!("PONG {uuid} latency_ms={latency_ms}"),
                Ok(Event::PeerDisconnected { uuid }) => println!("PEER LEFT {uuid}"),
                Ok(Event::Track { track, .. }) => {
                    track_number += 1;
                    let out = args.out.join(format!("track-{}-{track_number}", generate_stream_id()));
                    jobs.spawn(receive(track, out, stop.clone()));
                }
                Ok(Event::Error { message, .. }) => eprintln!("SDK: {message}"),
                Ok(Event::ConnectionFailed { reason, .. }) => eprintln!("Peer connection failed: {reason}; waiting for a peer/retry."),
                Ok(Event::ReconnectFailed) => return Err("signaling reconnect failed".into()),
                Err(broadcast::error::RecvError::Lagged(n)) => return Err(format!("missed {n} SDK events").into()),
                Err(broadcast::error::RecvError::Closed) => return Err("SDK event stream closed".into()),
                _ => {}
            }
        }
    }
}

async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! { r = tokio::signal::ctrl_c() => r, _ = term.recv() => Ok(()) }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    env_logger::init();
    let Some(args) = Args::parse()? else {
        return Ok(());
    };
    let password = std::env::var("VDONINJA_PASSWORD").ok();
    // Validate browser configuration before starting producers or connecting.
    browser_url(&args, "view", "check", password.as_deref())?;
    let media = if args.publish.is_some() {
        println!("Generating 640x360 VP8 test pattern + 440 Hz Opus tone...");
        println!("Use one WATCH peer at a time (sample-track backend limit).");
        Some(test_media()?)
    } else {
        None
    };
    let sdk = VdoNinja::new(Options {
        host: args.host.clone(),
        password: password.clone(),
        salt: args.salt.clone(),
        no_password: args.no_password,
        auto_ping_viewer: true,
        ..Default::default()
    });
    let (stop, rx) = watch::channel(false);
    let mut jobs = JoinSet::new();
    let deadline = async {
        match args.seconds {
            Some(n) => tokio::time::sleep(Duration::from_secs(n)).await,
            None => std::future::pending::<()>().await,
        }
    };
    let mut result = tokio::select! {
        r = run(&sdk, &args, media, password.as_deref(), &mut jobs, rx) => r,
        r = shutdown_signal() => r.map_err(Into::into),
        _ = deadline => Ok(()),
    };
    println!("Stopping: send bye, close peers/signaling, finalize media.");
    stop.send_replace(true);
    // disconnect() sends {bye:true} over each open control channel, drains its
    // buffer, closes peer connections, cancels retries and closes signaling.
    sdk.disconnect().await;
    while let Some(job) = jobs.join_next().await {
        match job {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                eprintln!("media: {e}");
                result = Err(e);
            }
            Err(e) => result = Err(e.into()),
        }
    }
    println!("STOPPED");
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> Args {
        Args {
            publish: Some("camera".into()),
            view: None,
            room: Some("room".into()),
            out: "received".into(),
            host: "wss://example.com:8443/signaling?token=abc%26def&route=1".into(),
            browser_host: None,
            salt: "custom.example".into(),
            no_password: false,
            seconds: None,
        }
    }

    #[test]
    fn links_preserve_signaling_endpoint_and_password_mode() {
        for mode in ["view", "push"] {
            for (password, expected) in [
                (None, None),
                (Some(""), None),
                (Some("  "), None),
                (Some("false"), Some("%66alse")),
                (Some("0"), Some("%30")),
                (Some("off"), Some("%6Fff")),
                (
                    Some(" café & literal%20 "),
                    Some("caf%C3%A9%20%26%20literal%2520"),
                ),
            ] {
                let a = args();
                let url = reqwest::Url::parse(&browser_url(&a, mode, "camera", password).unwrap())
                    .unwrap();
                let query: std::collections::HashMap<_, _> =
                    url.query_pairs().into_owned().collect();
                assert_eq!(query["wss2"], a.host);
                assert_eq!(query["salt"], a.salt);
                assert_eq!(query.get("password").map(String::as_str), expected);
            }
        }
        let mut a = args();
        a.no_password = true;
        let url = browser_url(&a, "view", "camera", Some("private")).unwrap();
        assert!(reqwest::Url::parse(&url)
            .unwrap()
            .query_pairs()
            .any(|(k, v)| k == "password" && v == "false"));
        a.host = "ws://127.0.0.1:8080/signaling?token=abc".into();
        assert!(browser_url(&a, "view", "camera", None).is_err());
        a.browser_host = Some("wss://example.com/signaling?token=abc".into());
        let url = reqwest::Url::parse(&browser_url(&a, "view", "camera", None).unwrap()).unwrap();
        assert!(url
            .query_pairs()
            .any(|(k, v)| k == "wss2" && v == a.browser_host.as_deref().unwrap()));
    }

    #[test]
    fn only_expected_viewer_transport_errors_are_recoverable() {
        for text in [
            "bind failed",
            "track is not binding yet",
            "SendError(SenderRtp(1, Packet { payload: [] }))",
            "bind failed\nSendError(SenderRtp(1, Packet { payload: [] }))",
        ] {
            assert!(viewer_teardown(&Error::WebRtc(text.into())));
        }
        for text in [
            "",
            "codec not found",
            "bind failed\ninvalid packet",
            "SendError(Other)",
        ] {
            assert!(!viewer_teardown(&Error::WebRtc(text.into())));
        }
        assert!(!viewer_teardown(&Error::Other("bind failed".into())));
    }
}
