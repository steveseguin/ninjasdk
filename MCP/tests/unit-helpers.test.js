'use strict';

const assert = require('node:assert/strict');
const {
  boolFromEnv,
  intFromEnv,
  intFromValue,
  sanitizeId,
  parsePassword,
  createJoinToken,
  verifyJoinToken,
  ensureStringArray
} = require('../scripts/lib/bridge-utils');

function run() {
  assert.equal(boolFromEnv('true', false), true);
  assert.equal(boolFromEnv('false', true), false);
  assert.equal(boolFromEnv(undefined, true), true);
  assert.equal(boolFromEnv('garbage', false), false);

  assert.equal(intFromEnv('15000', 1), 15000);
  assert.equal(intFromEnv('0', 7), 7);
  assert.equal(intFromEnv(undefined, 5), 5);

  assert.equal(intFromValue(42, 5), 42);
  assert.equal(intFromValue('abc', 9), 9);

  assert.equal(sanitizeId('my-room', null), 'my_room');
  assert.equal(sanitizeId('  weird!!!id  ', null), 'weird_id');
  assert.equal(sanitizeId('', 'fallback_id'), 'fallback_id');

  assert.equal(parsePassword(false), false);
  assert.equal(parsePassword('false'), false);
  assert.equal(parsePassword('true'), undefined);
  assert.equal(parsePassword(''), undefined);
  assert.equal(parsePassword('secret'), 'secret');

  const token = createJoinToken({ room: 'r1', stream_id: 'a1', exp: Date.now() + 1000 }, 'secret');
  const verifyOk = verifyJoinToken(token, 'secret');
  assert.equal(verifyOk.ok, true);
  assert.equal(verifyOk.payload.room, 'r1');
  const verifyBad = verifyJoinToken(token, 'wrong');
  assert.equal(verifyBad.ok, false);

  assert.deepEqual(ensureStringArray('a,b, c'), ['a', 'b', 'c']);
  assert.deepEqual(ensureStringArray(['x', ' y ', '', null]), ['x', 'y']);

  console.log('unit-helpers.test.js passed');
}

run();
