import pytest

from vdoninja import VDONinja
from signaling_contract import assert_signaling, assert_control
import json
from pathlib import Path


def test_nested_protocol_vectors():
    vectors = json.loads((Path(__file__).parents[2] / "spec/signaling-validation-vectors.json").read_text())
    for entry in vectors["valid"]:
        (assert_control if entry["channel"] == "control" else assert_signaling)(entry["message"])
    for entry in vectors["invalid"]:
        with pytest.raises(AssertionError):
            (assert_control if entry["channel"] == "control" else assert_signaling)(entry["message"])


def test_removed_identity_options_are_rejected():
    for key in ("client_id", "ClientID", "clientId", "from"):
        with pytest.raises(TypeError):
            VDONinja(**{key: "fake-sender"})


@pytest.mark.asyncio
async def test_application_data_cannot_use_signaling():
    sdk = VDONinja(password=False, turn=False, stun_servers=[])
    sdk._connected = True
    sent = []
    sdk._send_ws = lambda message: sent.append(message)
    with pytest.raises(TypeError, match="Unsupported send_data target"):
        sdk.send_data("private", {"uuid": "peer", "allowFallback": True})
    assert not sdk.send_data("private", "peer")
    sdk.subscribe("news")
    sdk.unsubscribe("news")
    assert not sent
    got = []
    sdk.on("dataReceived", got.append)
    await sdk._handle_signaling({"UUID": "peer", "__fallback": True, "pipe": "fake"})
    assert not got


def test_contract_rejects_unknown_fields_but_keeps_application_payload_opaque():
    for key in ("from", "client_id", "__fallback", "audio", "video", "futureFakeOption"):
        with pytest.raises(AssertionError):
            assert_signaling({"request": "play", "streamID": "camera", key: True})
    assert_control({"pipe": {"from": "app author", "client_id": "app field"}})
