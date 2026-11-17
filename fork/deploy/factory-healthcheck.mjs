#!/usr/bin/env node
// The image's HEALTHCHECK (installed as /usr/local/bin/factory-healthcheck): healthy when the server
// answers GET /auth/me with 200, as it does signed in or not ({"authenticated":false,…}). Node's own
// fetch, so the image needs no curl.
const port = process.env.PORT || '5873';
try {
  const response = await fetch(`http://127.0.0.1:${port}/auth/me`, { signal: AbortSignal.timeout(4000) });
  process.exit(response.status === 200 ? 0 : 1);
} catch {
  process.exit(1);
}
