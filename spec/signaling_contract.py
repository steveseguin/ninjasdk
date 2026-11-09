"""Test-only allowlist of the supported, source-reviewed VDO.Ninja messages."""
import json
import re
from pathlib import Path

CONTRACT = json.loads(Path(__file__).with_name("signaling-contract.json").read_text())


def _keys(value, allowed):
    assert isinstance(value, dict)
    assert not (set(value) - set(allowed)), value


def _peer_payloads(message):
    def candidate(value):
        _keys(value, ("candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"))
        assert isinstance(value.get("candidate"), str)
        for field in ("sdpMid", "usernameFragment"):
            assert value.get(field) is None or isinstance(value[field], str)
        index = value.get("sdpMLineIndex")
        assert index is None or (type(index) is int and index >= 0)

    for field in ("UUID", "session", "streamID"):
        if field in message:
            assert isinstance(message[field], str)
    for field in ("bye", "iceRestartRequest"):
        if field in message:
            assert type(message[field]) is bool
    if "type" in message:
        assert message["type"] in CONTRACT["candidateTypes"]
    encrypted = False
    for field in ("description", "candidate", "candidates"):
        if field not in message:
            continue
        value = message[field]
        if isinstance(value, str):
            assert re.fullmatch(r"(?:[0-9a-fA-F]{32})+", value)
            encrypted = True
        elif field == "description":
            _keys(value, ("type", "sdp"))
            assert value.get("type") in ("offer", "answer")
            assert isinstance(value.get("sdp"), str)
        elif field == "candidates":
            assert isinstance(value, list)
            for item in value:
                candidate(item)
        else:
            candidate(value)
    assert ("vector" in message) == encrypted
    if encrypted:
        assert isinstance(message["vector"], str)
        assert re.fullmatch(r"[0-9a-fA-F]{32}", message["vector"])


def assert_signaling(message):
    assert isinstance(message, dict), "Signaling must be an object"
    if "request" in message:
        assert isinstance(message["request"], str), "Request must be a string"
        assert message["request"] in CONTRACT["requests"], f"Unsupported request: {message}"
        allowed = CONTRACT["requests"][message["request"]]
        key = "roomid" if message["request"] == "joinroom" else "streamID"
        assert isinstance(message.get(key), str) and message[key]
    elif "leave" in message:
        allowed = CONTRACT["leave"]
        assert message["leave"] is True
    else:
        allowed = CONTRACT["peer"]
        assert isinstance(message.get("UUID"), str) and message["UUID"], "Missing destination UUID"
        assert any(key in message for key in CONTRACT["peerPayloads"]), "Missing peer payload"
        if "type" in message:
            assert message["type"] in CONTRACT["candidateTypes"]
        _peer_payloads(message)
    unknown = set(message) - set(allowed)
    assert not unknown, f"Unsupported protocol fields: {sorted(unknown)}"


def assert_control(message):
    assert isinstance(message, dict)
    assert not (set(message) - set(CONTRACT["control"])), message
    _peer_payloads(message)
    for field in ("audio", "video", "allowresources"):
        if field in message:
            assert type(message[field]) is bool
