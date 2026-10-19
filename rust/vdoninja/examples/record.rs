// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
//
// Record a VDO.Ninja stream to IVF (VP8/VP9) and OGG (Opus) files.
//
//   cargo run --example record -- --stream mycam --room myroom --out capture

use std::fs::File;
use std::sync::Arc;
use std::time::Duration;

use rtc::media::io::ivf_reader::IVFFileHeader;
use rtc::media::io::ivf_writer::IVFWriter;
use rtc::media::io::ogg_writer::OggWriter;
use rtc::media::io::Writer;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use vdoninja::webrtc::media_stream::track_remote::TrackRemoteEvent;
use vdoninja::{Error, Event, Options, VdoNinja, ViewOptions};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
}

#[tokio::main]
async fn main() -> vdoninja::Result<()> {
    env_logger::init();
    let args: Vec<String> = std::env::args().collect();
    let Some(stream) = arg(&args, "--stream") else {
        eprintln!("usage: record --stream id [--room room] [--password pw] [--out prefix]");
        std::process::exit(2);
    };
    let room = arg(&args, "--room");
    let password = arg(&args, "--password");
    let out = arg(&args, "--out").unwrap_or_else(|| "recording".into());

    let sdk = VdoNinja::new(Options {
        password,
        label: Some("Rust recorder".into()),
        ..Default::default()
    });
    let mut events = sdk.events();
    let out2 = out.clone();
    tokio::spawn(async move {
        while let Ok(ev) = events.recv().await {
            if let Event::Track { track, .. } = ev {
                let ssrc = track.ssrcs().await.first().copied().unwrap_or(0);
                let mime = track
                    .codec(ssrc)
                    .await
                    .map(|c| c.mime_type.to_lowercase())
                    .unwrap_or_default();
                println!("track {mime}");
                let out = out2.clone();
                tokio::spawn(async move {
                    if mime == "audio/opus" {
                        let Ok(file) = File::create(format!("{out}.ogg")) else {
                            return;
                        };
                        let Ok(mut w) = OggWriter::new(file, 48000, 2) else {
                            return;
                        };
                        while let Some(ev) = track.poll().await {
                            if let TrackRemoteEvent::OnRtpPacket(p) = ev {
                                let _ = w.write_rtp(&p);
                            }
                        }
                        let _ = w.close();
                    } else if mime == "video/vp8" || mime == "video/vp9" {
                        let Ok(file) = File::create(format!("{out}.ivf")) else {
                            return;
                        };
                        let header = IVFFileHeader {
                            signature: *b"DKIF",
                            version: 0,
                            header_size: 32,
                            four_cc: if mime == "video/vp9" {
                                *b"VP90"
                            } else {
                                *b"VP80"
                            },
                            width: 1280,
                            height: 720,
                            timebase_denominator: 30,
                            timebase_numerator: 1,
                            num_frames: 0,
                            unused: 0,
                        };
                        let Ok(mut w) = IVFWriter::new(file, &header) else {
                            return;
                        };
                        let pli = Arc::clone(&track);
                        tokio::spawn(async move {
                            loop {
                                tokio::time::sleep(Duration::from_secs(2)).await;
                                if pli
                                    .write_rtcp(vec![Box::new(PictureLossIndication {
                                        sender_ssrc: 0,
                                        media_ssrc: ssrc,
                                    })])
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        });
                        while let Some(ev) = track.poll().await {
                            if let TrackRemoteEvent::OnRtpPacket(p) = ev {
                                let _ = w.write_rtp(&p);
                            }
                        }
                        let _ = w.close();
                    } else {
                        println!("codec {mime} is not written by this example");
                    }
                });
            }
        }
    });
    sdk.connect().await?;
    if let Some(r) = &room {
        sdk.join_room(r).await?;
    }
    match sdk.view(&stream, ViewOptions::default()).await {
        Ok(_) | Err(Error::StreamNotYetAvailable) => {}
        Err(e) => return Err(e),
    }
    println!("recording {stream} to {out}.{{ivf,ogg}}; Ctrl-C to stop");
    tokio::signal::ctrl_c().await.ok();
    sdk.disconnect().await;
    Ok(())
}
