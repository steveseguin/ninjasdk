"""Test-only A/V + application-data peer for tests/interop/native-av-live.cjs."""
import asyncio
import os
import signal
import traceback
import wave
from pathlib import Path

from aiortc.contrib.media import MediaPlayer
from vdoninja import VDONinja, StreamNotYetAvailable


async def main():
    env = os.environ
    sdk = VDONinja(env["VDO_HOST"], password=env["VDO_PASSWORD"], salt=env["VDO_SALT"])
    player = MediaPlayer(env["VDO_MEDIA"], loop=True)
    stopped = asyncio.Event()
    tasks = []
    failures = []
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stopped.set)

    async def consume(track):
        audio = None
        energy = 0
        try:
            if track.kind == "audio":
                audio = wave.open(env["VDO_OUT"] + "/received.wav", "wb")
                audio.setnchannels(2)
                audio.setsampwidth(2)
                audio.setframerate(48000)
            count = 0
            while True:
                frame = await track.recv()  # Actual decoded frames, not RTP counts.
                count += 1
                if track.kind == "video" and count == 100:
                    pixels = frame.to_ndarray(format="rgb24")
                    assert pixels.max() > pixels.min(), "blank decoded video"
                    Path(env["VDO_OUT"] + "/received.ppm").write_bytes(
                        f"P6\n{frame.width} {frame.height}\n255\n".encode() + pixels.tobytes())
                elif audio is not None:
                    assert frame.format.name == "s16" and frame.sample_rate == 48000
                    samples = frame.to_ndarray()
                    energy = max(energy, int(abs(samples.astype("int32")).max()))
                    if count <= 100:
                        audio.writeframes(samples.tobytes())
                if count == 100:
                    if audio is not None:
                        assert energy > 0, "silent decoded audio"
                    print(f"RX {track.kind} 100", flush=True)
        finally:
            if audio is not None:
                audio.close()

    def receive(ev):
        task = asyncio.create_task(consume(ev.track))
        tasks.append(task)
        def completed(task):
            if not task.cancelled() and task.exception() and not stopped.is_set():
                failures.append(task.exception())
                traceback.print_exception(task.exception())
                stopped.set()
        task.add_done_callback(completed)
    sdk.on("track", receive)
    # Echo only explicit test application data, over the existing pipe API.
    sdk.on("dataReceived", lambda ev: sdk.send_data(ev.data, ev.uuid))
    sdk.on("error", lambda ev: print("ERROR", ev.message, flush=True))
    try:
        await sdk.connect()
        await sdk.publish([player.video, player.audio], env["VDO_PUBLISH"], room=env["VDO_ROOM"])
        print("READY", flush=True)
        try:
            await sdk.view(env["VDO_VIEW"], downloads=False, timeout=3)
        except StreamNotYetAvailable:
            pass
        await stopped.wait()
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await sdk.disconnect()
        for source in (player.video, player.audio):
            source.stop()
    if failures:
        raise failures[0]
    print("STOPPED", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
