'use strict';

const crypto = require('node:crypto');

function nowISO() {
  return new Date().toISOString();
}

function boolFromEnv(value, fallback) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function intFromEnv(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function intFromValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeIntFromValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function clampInt(value, fallback, minValue, maxValue) {
  const parsed = Number.parseInt(String(value), 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  const floor = Number.isFinite(minValue) ? minValue : safe;
  const ceil = Number.isFinite(maxValue) ? maxValue : safe;
  return Math.min(Math.max(safe, floor), ceil);
}

function sanitizeId(value, fallback) {
  const source = String(value || fallback || '').trim();
  const safe = source.replace(/\W+/g, '_').replace(/^_+|_+$/g, '');
  return safe || fallback || null;
}

function parsePassword(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (raw === false) return false;
  if (raw === true) return undefined;
  const text = String(raw).trim().toLowerCase();
  if (text === 'false') return false;
  if (text === 'true' || text === '') return undefined;
  return raw;
}

function generateShortId(prefix) {
  const rand = crypto.randomBytes(4).toString('hex');
  return prefix ? `${prefix}_${rand}` : rand;
}

function randomUUID() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return [
    crypto.randomBytes(4).toString('hex'),
    crypto.randomBytes(2).toString('hex'),
    '4' + crypto.randomBytes(2).toString('hex').slice(1),
    ((8 + Math.floor(Math.random() * 4)).toString(16) + crypto.randomBytes(2).toString('hex').slice(1)),
    crypto.randomBytes(6).toString('hex')
  ].join('-');
}

function sha256Hex(data) {
  const hash = crypto.createHash('sha256');
  hash.update(data);
  return hash.digest('hex');
}

function hmacSha256Hex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function base64UrlEncode(bufferOrText) {
  const buf = Buffer.isBuffer(bufferOrText) ? bufferOrText : Buffer.from(String(bufferOrText), 'utf8');
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('base64url input must be a non-empty string');
  }
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLen), 'base64');
}

function createJoinToken(payload, secret) {
  if (!secret) throw new Error('secret is required');
  if (!payload || typeof payload !== 'object') throw new Error('payload must be an object');
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = base64UrlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

function verifyJoinToken(token, secret) {
  if (!secret) throw new Error('secret is required');
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'token must be a non-empty string' };
  }
  const parts = token.split('.');
  if (parts.length !== 2) {
    return { ok: false, error: 'invalid token format' };
  }

  const [body, sig] = parts;
  const expectedSig = base64UrlEncode(crypto.createHmac('sha256', secret).update(body).digest());
  if (sig !== expectedSig) {
    return { ok: false, error: 'invalid token signature' };
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(body).toString('utf8'));
  } catch (error) {
    return { ok: false, error: `invalid token payload: ${error.message}` };
  }

  return {
    ok: true,
    payload
  };
}

function ensureStringArray(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

module.exports = {
  boolFromEnv,
  intFromEnv,
  intFromValue,
  nonNegativeIntFromValue,
  clampInt,
  sanitizeId,
  parsePassword,
  nowISO,
  generateShortId,
  randomUUID,
  sha256Hex,
  hmacSha256Hex,
  base64UrlEncode,
  base64UrlDecode,
  createJoinToken,
  verifyJoinToken,
  ensureStringArray,
  safeJsonParse
};
