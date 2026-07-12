'use strict';

const assert = require('node:assert/strict');
const {
  VdoMcpServer,
  parseCliArgs,
  buildStartupBanner,
  maybeWriteStartupBanner
} = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

function run() {
  const parsed = parseCliArgs([
    '--tool-profile', 'core',
    '--max-message-bytes', '2097152',
    '--join-token-secret', 'secret_123',
    '--enforce-join-token', 'true',
    '--allow-peer-stream-ids', 'agent_a,agent_b',
    '--require-session-mac', 'true'
  ]);
  assert.equal(parsed.toolProfile, 'core');
  assert.equal(parsed.maxMessageBytes, 2097152);
  assert.equal(parsed.defaultJoinTokenSecret, 'secret_123');
  assert.equal(parsed.defaultEnforceJoinToken, true);
  assert.deepEqual(parsed.defaultAllowPeerStreamIDs, ['agent_a', 'agent_b']);
  assert.equal(parsed.defaultRequireSessionMac, true);

  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(),
    toolProfile: parsed.toolProfile,
    defaultJoinTokenSecret: parsed.defaultJoinTokenSecret,
    defaultEnforceJoinToken: parsed.defaultEnforceJoinToken,
    defaultAllowPeerStreamIDs: parsed.defaultAllowPeerStreamIDs,
    defaultRequireSessionMac: parsed.defaultRequireSessionMac
  });
  const config = server.parseConnectConfig({
    room: 'cli_flags_room',
    stream_id: 'agent_test'
  });
  assert.equal(server.toolProfile.name, 'core');
  assert.equal(config.enforceJoinToken, true);
  assert.equal(config.joinTokenSecret, 'secret_123');
  assert.deepEqual(config.allowPeerStreamIDs, ['agent_a', 'agent_b']);
  assert.equal(config.requireSessionMac, true);

  const banner = buildStartupBanner(server);
  assert.equal(Array.isArray(banner), true);
  assert.equal(banner.length >= 3, true);
  assert.ok(banner[0].includes('Server running'));

  const writes = [];
  const didWrite = maybeWriteStartupBanner(
    {
      input: { isTTY: true },
      output: { isTTY: true },
      errorOutput: {
        isTTY: true,
        write: (text) => {
          writes.push(String(text));
        }
      }
    },
    server
  );
  assert.equal(didWrite, true);
  assert.ok(writes.join('').includes('vdo_capabilities'));

  const suppressed = maybeWriteStartupBanner(
    {
      env: { VDON_MCP_NO_STARTUP_BANNER: '1' },
      input: { isTTY: true },
      output: { isTTY: true },
      errorOutput: {
        isTTY: true,
        write: () => {
          throw new Error('unexpected write when startup banner disabled');
        }
      }
    },
    server
  );
  assert.equal(suppressed, false);

  const nonInteractive = maybeWriteStartupBanner(
    {
      input: { isTTY: false },
      output: { isTTY: true },
      errorOutput: { isTTY: true, write: () => {} }
    },
    server
  );
  assert.equal(nonInteractive, false);

  assert.equal(parseCliArgs(['--help']).showHelp, true);

  assert.throws(() => parseCliArgs(['--unknown']), /unknown CLI argument/);
  assert.throws(() => parseCliArgs(['--tool-profile']), /requires a value/);
  assert.throws(() => parseCliArgs(['--max-message-bytes', '0']), /positive integer/);
  assert.throws(() => parseCliArgs(['--enforce-join-token', 'maybe']), /must be true or false/);
  assert.throws(() => parseCliArgs(['--require-session-mac', 'maybe']), /must be true or false/);
  assert.throws(() => parseCliArgs(['--allow-peer-stream-ids']), /requires comma-separated ids/);

  console.log('mcp-cli-flags.test.js passed');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
