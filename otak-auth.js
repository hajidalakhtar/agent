// Shared auth helper for the Otak REST API and MCP endpoint.
// The token is generated once and stored in .env (OTAK_API_KEY).
import crypto from 'node:crypto';

export function otakApiKey() {
  return String(process.env.OTAK_API_KEY || '').trim();
}

export function isOtakAuthorized(req) {
  const expected = otakApiKey();
  if (!expected) return false; // fail closed: no token => no access

  const auth = String(req.headers?.authorization || '');
  const candidates = [
    String(req.headers?.['x-otak-key'] || ''),
    String(req.headers?.['x-api-key'] || ''),
    /^Bearer\s+/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '',
  ];

  const expectedBuf = Buffer.from(expected);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const buf = Buffer.from(candidate);
    if (buf.length === expectedBuf.length && crypto.timingSafeEqual(buf, expectedBuf)) return true;
  }
  return false;
}

export function otakUnauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'WWW-Authenticate': 'Bearer',
  });
  res.end(JSON.stringify({
    error: 'unauthorized',
    message: 'Butuh Bearer token OTAK_API_KEY (atau header X-Otak-Key).',
  }));
}
