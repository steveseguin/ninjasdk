// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
//
// Publish a VP8/VP9 IVF video and/or an Opus OGG audio file as a VDO.Ninja stream.
//
//   ffmpeg -i input.mp4 -c:v libvpx -b:v 2M -f ivf video.ivf
//   ffmpeg -i input.mp4 -c:a libopus -page_duration 20000 -vn audio.ogg
//   cargo run --example publish_file -- --video video.ivf --audio audio.ogg --stream rsfile --room myroom
//   open https://vdo.ninja/?view=rsfile&room=myroom&scene

use std::fs::File;
use std::io::{BufReader, Seek, SeekFrom};
use std::time::Duration;

use bytes::Bytes;
use rtc::media::io::ivf_reader::IVFReader;
use rtc::media::io::ogg_reader::OggReader;
use vdoninja::core::{encode_uri_component, sanitize_room};
use vdoninja::media::SampleTrack;
use vdoninja::{Event, Options, PublishOptions, VdoNinja};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main]
async fn main() -> vdoninja::Result<()> {
    env_logger::init();
    let args: Vec<String> = std::env::args().collect();
    let video = arg(&args, "--video");
    let audio = arg(&args, "--audio");
    let stream = arg(&args, "--stream");
    let room = arg(&args, "--room");
    let password = arg(&args, "--password");
    if video.is_none() && audio.is_none() {
        eprintln!("usage: publish_file --video file.ivf [--audio file.ogg] [--stream id] [--room room] [--password pw]");
        std::process::exit(2);
    }

    let mut tracks = vec![];
    if let Some(path) = video {
        let mut file = File::open(&path).map_err(|e| vdoninja::Error::Other(e.to_string()))?;
        let (mut ivf, header) = IVFReader::new(BufReader::new(file.try_clone().unwrap()))
            .map_err(|e| vdoninja::Error::Other(e.to_string()))?;
        let mime = if &header.four_cc == b"VP90" {
            "video/VP9"
        } else {
            "video/VP8"
        };
        let track = SampleTrack::new(mime, "rsfile", "video")?;
        tracks.push(track.local());
        let frame_ms = (1000 * header.timebase_numerator as u64
            / header.timebase_denominator.max(1) as u64)
            .max(1);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_millis(frame_ms));
            loop {
                ticker.tick().await;
                match ivf.parse_next_frame() {
                    Ok((frame, _)) => {
                        let _ = track
                            .write(frame.freeze(), Duration::from_millis(frame_ms))
                            .await;
                    }
                    Err(_) => {
                        let _ = file.seek(SeekFrom::Start(0));
                        if let Ok((reader, _)) =
                            IVFReader::new(BufReader::new(file.try_clone().unwrap()))
                        {
                            ivf = reader;
                        }
                    }
                }
            }
        });
    }
    if let Some(path) = audio {
        let mut file = File::open(&path).map_err(|e| vdoninja::Error::Other(e.to_string()))?;
        let (mut ogg, _) = OggReader::new(BufReader::new(file.try_clone().unwrap()), true)
            .map_err(|e| vdoninja::Error::Other(e.to_string()))?;
        let track = SampleTrack::new("audio/opus", "rsfile", "audio")?;
        tracks.push(track.local());
        tokio::spawn(async move {
            let mut last_granule = 0u64;
            let mut ticker = tokio::time::interval(Duration::from_millis(20));
            loop {
                ticker.tick().await;
                match ogg.parse_next_page() {
                    Ok((page, header)) => {
                        let samples = header.granule_position.saturating_sub(last_granule);
                        last_granule = header.granule_position;
                        let dur = Duration::from_millis(samples * 1000 / 48000);
                        let _ = track.write(Bytes::from(page.to_vec()), dur).await;
                    }
                    Err(_) => {
                        let _ = file.seek(SeekFrom::Start(0));
                        if let Ok((reader, _)) =
                            OggReader::new(BufReader::new(file.try_clone().unwrap()), true)
                        {
                            ogg = reader;
                        }
                        last_granule = 0;
                    }
                }
            }
        });
    }

    let sdk = VdoNinja::new(Options {
        password: password.clone(),
        label: Some("Rust file publisher".into()),
        ..Default::default()
    });
    let mut events = sdk.events();
    tokio::spawn(async move {
        while let Ok(ev) = events.recv().await {
            match ev {
                Event::PeerConnected { uuid, .. } => println!("viewer connected: {uuid}"),
                Event::PeerDisconnected { uuid } => println!("viewer left: {uuid}"),
                _ => {}
            }
        }
    });
    sdk.connect().await?;
    let sid = sdk
        .publish(
            tracks,
            PublishOptions {
                stream_id: stream,
                room: room.clone(),
                ..Default::default()
            },
        )
        .await?;
    let mut url = format!("https://vdo.ninja/?view={sid}");
    if let Some(r) = &room {
        url += &format!("&room={}&scene", sanitize_room(r));
    }
    if let Some(p) = &password {
        url += &format!(
            "&password={}",
            encode_uri_component(&encode_uri_component(p))
        );
    }
    println!("Publishing. Watch at: {url}");
    tokio::signal::ctrl_c().await.ok();
    sdk.disconnect().await;
    Ok(())
}
