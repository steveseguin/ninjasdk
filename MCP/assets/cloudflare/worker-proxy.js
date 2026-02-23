/**
 * Cloudflare Worker proxy template for a remote MCP HTTP endpoint.
 *
 * This Worker does not run WebRTC itself.
 * It forwards MCP JSON-RPC requests to an upstream vdo-mcp-streamable-http server.
 *
 * Required secrets/config:
 * - MCP_UPSTREAM_URL: e.g. https://your-origin.example.com/mcp
 * - MCP_UPSTREAM_TOKEN: bearer token expected by upstream server
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(env)
      });
    }

    if (url.pathname === '/health') {
      return json({
        ok: true,
        mode: 'cloudflare_proxy',
        ts: new Date().toISOString()
      }, 200, env);
    }

    if (url.pathname !== '/mcp') {
      return json({ ok: false, error: 'not_found' }, 404, env);
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'method_not_allowed' }, 405, env);
    }

    const upstreamUrl = env.MCP_UPSTREAM_URL;
    if (!upstreamUrl) {
      return json({ ok: false, error: 'missing_upstream_url' }, 500, env);
    }

    const upstreamToken = env.MCP_UPSTREAM_TOKEN || '';
    const body = await request.text();

    const headers = {
      'content-type': 'application/json'
    };
    if (upstreamToken) {
      headers.authorization = `Bearer ${upstreamToken}`;
    }

    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body
    });

    const upstreamBody = await upstreamRes.text();
    return new Response(upstreamBody, {
      status: upstreamRes.status,
      headers: {
        ...corsHeaders(env),
        'content-type': upstreamRes.headers.get('content-type') || 'application/json; charset=utf-8'
      }
    });
  }
};

function json(payload, status, env) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(env),
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

function corsHeaders(env) {
  const allowOrigin = env.MCP_ALLOW_ORIGIN || '*';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '600'
  };
}
