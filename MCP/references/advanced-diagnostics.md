# VDO.Ninja MCP Advanced Diagnostics

This page is optional. Use it when you are debugging reliability or network edge cases.

## Live Test Commands

```bash
LIVE_VDO_TEST=1 npm run test:mcp:live
LIVE_VDO_TEST=1 npm run test:mcp:soak
LIVE_VDO_TEST=1 npm run test:mcp:matrix
LIVE_VDO_TEST=1 npm run test:mcp:preset:matrix
LIVE_VDO_TEST=1 SOAK_MATRIX_SWEEP_RUNS=20 npm run test:mcp:matrix:sweep
```

Secure preset matrix:

```bash
LIVE_VDO_TEST=1 VDON_MCP_JOIN_TOKEN_SECRET=change_me npm run test:mcp:preset:matrix
```

## Preset Matrix Notes

- `PRESET_MATRIX_ADAPTIVE_FALLBACK=1` enables candidate fallback.
- `PRESET_MATRIX_ALLOW_DIRECT_FALLBACK=1` allows direct fallback after TURN candidates.
- `PRESET_MATRIX_STRICT=1` fails process when any profile fails.
- `PRESET_CONNECT_ATTEMPTS`, `PRESET_CONNECT_TIMEOUT_MS`, and `PRESET_CHANNEL_READY_TIMEOUT_MS` control connect behavior.

Artifacts are written to:

- `MCP/tests/artifacts/latest-preset-matrix-report.json`
- `MCP/tests/artifacts/latest-preset-matrix-summary.txt`
- `MCP/tests/artifacts/history/preset-matrix-*.json`
- `MCP/tests/artifacts/history/preset-matrix-*.txt`

## Soak / Matrix Knobs

- Smoke: `LIVE_SMOKE_RETRIES`, `LIVE_SMOKE_TIMEOUT_MS`
- Soak: `SOAK_RETRIES`, `SOAK_TIMEOUT_MS`
- Matrix: `SOAK_MATRIX_PROFILE_RETRIES`, `SOAK_MATRIX_PROFILE_TIMEOUT_MS`
- Sweep: `SOAK_MATRIX_SWEEP_RUNS`, `SOAK_MATRIX_SWEEP_TIMEOUT_MS`, `SOAK_MATRIX_SWEEP_MIN_SUCCESS_RATE`

## Important

- WebRTC data channels are the transport.
- TURN helps reachability but is not a universal bypass for all enterprise firewall policies.
