'use strict';

const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { McpStdioParser, writeMcpMessage } = require('../scripts/lib/mcp-stdio-parser');

function run() {
  const parser = new McpStdioParser({ maxMessageBytes: 4096 });
  const seen = [];
  const errors = [];

  parser.on('message', (event) => {
    seen.push(event);
  });
  parser.on('error', (error) => {
    errors.push(error);
  });

  parser.push(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mode, 'line');
  assert.equal(seen[0].message.method, 'ping');

  const framed = new PassThrough();
  const chunks = [];
  framed.on('data', (chunk) => chunks.push(chunk));
  writeMcpMessage(framed, { jsonrpc: '2.0', id: 2, method: 'initialize' }, 'framed');
  const framedBuffer = Buffer.concat(chunks);
  const splitAt = Math.floor(framedBuffer.length / 2);

  parser.push(framedBuffer.slice(0, splitAt));
  parser.push(framedBuffer.slice(splitAt));

  assert.equal(seen.length, 2);
  assert.equal(seen[1].mode, 'framed');
  assert.equal(seen[1].message.id, 2);

  parser.push(Buffer.from('not-json\n'));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'parse_error');

  const tooLargeParser = new McpStdioParser({ maxMessageBytes: 4 });
  const largeErrors = [];
  tooLargeParser.on('error', (error) => {
    largeErrors.push(error);
  });
  tooLargeParser.push(Buffer.from('{"id":1}\n'));
  assert.equal(largeErrors.length, 1);
  assert.equal(largeErrors[0].code, 'message_too_large');

  console.log('mcp-stdio-parser.test.js passed');
}

run();
