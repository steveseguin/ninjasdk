// Test-only peer for tests/interop/native-av-live.cjs. No automatic greetings.
use serde_json::Value;
use vdoninja::{Event, Options, PublishOptions, VdoNinja, ViewOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let env = |key| std::env::var(key).expect(key);
    let sdk = VdoNinja::new(Options {
        host: env("VDO_HOST"),
        password: Some(env("VDO_PASSWORD")),
        salt: env("VDO_SALT"),
        ..Default::default()
    });
    let mut events = sdk.events();
    sdk.connect().await?;
    sdk.announce(PublishOptions {
        stream_id: Some(env("VDO_PUBLISH")),
        room: Some(env("VDO_ROOM")),
        ..Default::default()
    })
    .await?;
    println!("READY");
    let viewing = sdk.clone();
    let view = tokio::spawn(async move {
        viewing
            .view(
                &env("VDO_VIEW"),
                ViewOptions {
                    audio: false,
                    video: false,
                    downloads: false,
                    ..Default::default()
                },
            )
            .await
    });
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            event = events.recv() => match event? {
                Event::DataReceived { uuid, data, .. } => {
                    // Echo only an explicit application probe on the existing pipe.
                    if matches!(data, Value::String(_)) { sdk.send_data_to(&uuid, data).await; }
                }
                error @ Event::Error { .. } => eprintln!("{error:?}"),
                _ => {}
            }
        }
    }
    sdk.disconnect().await;
    view.abort();
    println!("STOPPED");
    Ok(())
}
