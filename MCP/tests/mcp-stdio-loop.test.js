'use strict';

const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { runMcpStdioLoop } = require('../scripts/vdo-mcp-server');
const { McpStdioParser, writeMcpMessage } = require('../scripts/lib/mcp-stdio-parser');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

async function waitFor(condition, timeoutMs, stepMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

async function run() {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  const outputChunks = [];
  const errorChunks = [];

  output.on('data', (chunk) => outputChunks.push(chunk));
  errorOutput.on('data', (chunk) => errorChunks.push(chunk));

  await runMcpStdioLoop({
    input,
    output,
    errorOutput,
    sdkFactory: createFakeSDKFactory(),
    onExit: async () => {},
    exitOnClose: false
  });

  input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}\n');

  const gotFirst = await waitFor(() => outputChunks.length > 0, 2000, 20);
  assert.equal(gotFirst, true, 'expected initialize response');

  const firstText = Buffer.concat(outputChunks).toString('utf8');
  assert.ok(firstText.includes('"id":1'));
  assert.ok(firstText.includes('"protocolVersion":"2025-06-18"'));

  outputChunks.length = 0;

  const framed = new PassThrough();
  const framedChunks = [];
  framed.on('data', (chunk) => framedChunks.push(chunk));
  writeMcpMessage(framed, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  }, 'framed');

  input.write(Buffer.concat(framedChunks));

  const gotFramedResponse = await waitFor(() => {
    if (outputChunks.length === 0) return false;
    const text = Buffer.concat(outputChunks).toString('utf8');
    return text.includes('Content-Length:');
  }, 2000, 20);
  assert.equal(gotFramedResponse, true, 'expected framed response after framed request');

  const responseParser = new McpStdioParser();
  const responses = [];
  responseParser.on('message', ({ message }) => responses.push(message));
  responseParser.push(Buffer.concat(outputChunks));
  assert.ok(responses.some((message) => message.id === 2), 'expected tools/list response id=2');

  input.write('not-json\n');
  const gotParseError = await waitFor(() => {
    if (outputChunks.length === 0) return false;
    const text = Buffer.concat(outputChunks).toString('utf8');
    return text.includes('"code":-32700');
  }, 2000, 20);
  assert.equal(gotParseError, true, 'expected parse error response');

  input.end();
  output.end();
  errorOutput.end();

  const stderrText = Buffer.concat(errorChunks).toString('utf8');
  assert.ok(typeof stderrText === 'string');

  console.log('mcp-stdio-loop.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
