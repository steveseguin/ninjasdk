#!/usr/bin/env python3
# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MIT
"""Terminal P2P chat over VDO.Ninja data channels.

    python examples/chat.py --room my_unique_room --name alice
"""
import argparse
import asyncio
import sys

from vdoninja import VDONinja


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--room", required=True)
    parser.add_argument("--name", default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--host", default="wss://wss.vdo.ninja")
    args = parser.parse_args()

    sdk = VDONinja(args.host, password=args.password, label=args.name or "")
    sdk.on("dataChannelOpen", lambda ev: print(f"* {ev.uuid[:8]} connected"))
    sdk.on("peerDisconnected", lambda ev: print(f"* {ev.uuid[:8]} left"))

    def on_data(ev):
        if isinstance(ev.data, dict) and "message" in ev.data:
            print(f"<{ev.data.get('from') or ev.uuid[:8]}> {ev.data['message']}")
        else:
            print(f"<{ev.uuid[:8]}> {ev.data!r}")

    sdk.on("dataReceived", on_data)
    ctl = await sdk.auto_connect(args.room, stream_id=args.name, label=args.name or "")
    print(f"Joined {args.room!r} as {ctl['streamID']!r}. Type and press enter; Ctrl-C to quit.")
    loop = asyncio.get_running_loop()
    try:
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break
            line = line.strip()
            if line and not sdk.send_data({"message": line, "from": ctl["streamID"]}):
                print("(no peers connected yet)")
    except KeyboardInterrupt:
        pass
    finally:
        ctl["stop"]()
        await sdk.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
