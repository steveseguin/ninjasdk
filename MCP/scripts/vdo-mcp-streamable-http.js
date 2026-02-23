#!/usr/bin/env node
'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { VdoMcpServer } = require('./vdo-mcp-server');
const {
  intFromEnv,
  intFromValue,
  nowISO
} = require('./lib/bridge-utils');

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function jsonResponse(res, statusCode, body, headers) {
  const payload = JSON.stringify(body);
  const baseHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload, 'utf8'))
  };
  res.writeHead(statusCode, Object.assign(baseHeaders, headers || {}));
  res.end(payload);
}

function withCorsHeaders(baseHeaders, origin) {
  if (!origin) return baseHeaders || {};
  return Object.assign({}, baseHeaders || {}, {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '600'
  });
}

function parseBearerToken(req) {
  const auth = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? match[1] : null;
}

function readJsonBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBodyBytes) {
        reject(new Error(`request body exceeds ${maxBodyBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        if (!raw) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', (error) => reject(error));
  });
}

function createQueueRunner() {
  let chain = Promise.resolve();
  return function run(task) {
    const result = chain.then(task, task);
    chain = result.catch(() => {});
    return result;
  };
}

async function startStreamableHttpServer(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const rawPort = options.port;
  const parsedPort = Number.parseInt(String(rawPort), 10);
  const port = Number.isFinite(parsedPort) && parsedPort >= 0 ? parsedPort : DEFAULT_PORT;
  const endpointPath = options.endpointPath || '/mcp';
  const bearerToken = options.bearerToken || null;
  const allowOrigin = options.allowOrigin || null;
  const maxBodyBytes = intFromValue(options.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
  const logger = options.logger || ((message) => process.stderr.write(`${JSON.stringify(message)}\n`));
  const sdkFactory = options.sdkFactory || null;

  const server = options.mcpServer || new VdoMcpServer({
    sdkFactory,
    send: () => {},
    logger
  });
  const runInQueue = createQueueRunner();

  const httpServer = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    const corsHeaders = withCorsHeaders({}, allowOrigin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (reqUrl.pathname === '/health' && req.method === 'GET') {
      jsonResponse(res, 200, {
        ok: true,
        ts: nowISO(),
        mode: 'streamable_http',
        endpoint: endpointPath
      }, corsHeaders);
      return;
    }

    if (reqUrl.pathname !== endpointPath) {
      jsonResponse(res, 404, {
        ok: false,
        error: 'not_found',
        endpoint: endpointPath
      }, corsHeaders);
      return;
    }

    if (req.method !== 'POST') {
      jsonResponse(res, 405, {
        ok: false,
        error: 'method_not_allowed'
      }, corsHeaders);
      return;
    }

    if (bearerToken) {
      const token = parseBearerToken(req);
      if (!token || token !== bearerToken) {
        jsonResponse(res, 401, {
          ok: false,
          error: 'unauthorized'
        }, corsHeaders);
        return;
      }
    }

    let body;
    try {
      body = await readJsonBody(req, maxBodyBytes);
    } catch (error) {
      jsonResponse(res, 400, {
        ok: false,
        error: 'invalid_json',
        message: error.message
      }, corsHeaders);
      return;
    }

    let responses;
    try {
      responses = await runInQueue(async () => {
        const collected = [];
        const originalSend = server.send;
        server.send = (message) => collected.push(message);
        try {
          await server.dispatchMessage(body);
        } finally {
          server.send = originalSend;
        }
        return collected;
      });
    } catch (error) {
      jsonResponse(res, 500, {
        ok: false,
        error: 'dispatch_failed',
        message: error.message
      }, corsHeaders);
      return;
    }

    if (!responses || responses.length === 0) {
      jsonResponse(res, 202, { ok: true, notification: true }, corsHeaders);
      return;
    }

    const payload = responses.length === 1 ? responses[0] : responses;
    jsonResponse(res, 200, payload, corsHeaders);
  });

  await new Promise((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, host, resolve);
  });

  const address = httpServer.address();
  const resolvedPort = address && typeof address === 'object' ? address.port : port;
  const resolvedHost = address && typeof address === 'object' ? address.address : host;
  const baseUrl = `http://${resolvedHost}:${resolvedPort}`;

  logger({
    type: 'http_server_started',
    ts: nowISO(),
    host: resolvedHost,
    port: resolvedPort,
    endpoint: endpointPath
  });

  return {
    server: httpServer,
    mcpServer: server,
    baseUrl,
    endpointUrl: `${baseUrl}${endpointPath}`,
    close: async () => {
      await server.shutdownAll();
      await new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING' && error.code !== 'EPERM') {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

async function main() {
  let sdkFactory;
  if (process.env.VDON_MCP_FAKE === '1') {
    const { createFakeSDKFactory } = require('./lib/fake-network-sdk');
    sdkFactory = createFakeSDKFactory();
  }

  const host = process.env.VDON_MCP_HTTP_HOST || DEFAULT_HOST;
  const port = intFromEnv(process.env.VDON_MCP_HTTP_PORT, DEFAULT_PORT);
  const endpointPath = process.env.VDON_MCP_HTTP_PATH || '/mcp';
  const allowOrigin = process.env.VDON_MCP_HTTP_ALLOW_ORIGIN || null;
  const bearerToken = process.env.VDON_MCP_HTTP_BEARER_TOKEN || null;
  const maxBodyBytes = intFromEnv(process.env.VDON_MCP_HTTP_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES);

  await startStreamableHttpServer({
    host,
    port,
    endpointPath,
    allowOrigin,
    bearerToken,
    maxBodyBytes,
    sdkFactory
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      type: 'fatal',
      ts: nowISO(),
      message: error.message
    })}\n`);
    process.exit(1);
  });
}

module.exports = {
  startStreamableHttpServer
};
