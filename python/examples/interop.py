#!/usr/bin/env python3
# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MIT
"""The Python peer of the cross-language interoperability test (spec/interop/run_interop.py).

    python examples/interop.py --role publish --stream s1 --host ws://127.0.0.1:8080
    python examples/interop.py --role view --stream s1 --host ws://127.0.0.1:8080
"""
import argparse
import asyncio
import random
import sys

from vdoninja import VDONinja


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", default="view")
    parser.add_argument("--stream", default="interop")
    parser.add_argument("--host", default="wss://wss.vdo.ninja")
    parser.add_argument("--password", default=None)
    args = parser.parse_args()

    sdk = VDONinja(args.host, password=args.password, label="python")
    await sdk.connect()
    if args.role == "publish":
        def on_data(ev):
            if isinstance(ev.data, dict) and "probe" in ev.data:
                sdk.send_data({"echo": ev.data["probe"], "lang": "python"}, ev.uuid)

        sdk.on("dataReceived", on_data)
        sdk.on_request("whoami", lambda data, uuid: {"lang": "python", "got": data})
        await sdk.announce(args.stream)
        print("READY", flush=True)
        await asyncio.Event().wait()
        return 0

    loop = asyncio.get_running_loop()
    echo: asyncio.Future = loop.create_future()
    opened: asyncio.Future = loop.create_future()

    def on_data(ev):
        if isinstance(ev.data, dict) and "echo" in ev.data and not echo.done():
            echo.set_result(ev.data)

    def on_open(ev):
        if not opened.done():
            opened.set_result(ev.uuid)

    sdk.on("dataReceived", on_data)
    sdk.on("dataChannelOpen", on_open)
    await sdk.view(args.stream, timeout=30.0)
    uuid = await asyncio.wait_for(opened, 20.0)
    probe = f"python-{random.randint(0, 99999)}"
    sdk.send_data({"probe": probe}, uuid)
    got = await asyncio.wait_for(echo, 15.0)
    if got.get("echo") != probe:
        print(f"FAIL echo mismatch {got}")
        return 1
    print(f"OK echo {probe} from {got.get('lang')}")
    res = await sdk.request("whoami", {"q": 1}, uuid, timeout=10.0)
    print(f"OK rpc {res}")
    await sdk.disconnect()
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL {exc}")
        sys.exit(1)
