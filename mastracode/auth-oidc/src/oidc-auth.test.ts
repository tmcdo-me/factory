import { createHash } from 'node:crypto';

import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import { OidcAuth } from './oidc-auth';

const ISSUER = 'https://id.example.ts.net';
const SECRET = 'x'.repeat(40);
const REDIRECT = 'https://factory.example.ts.net/auth/callback';

/** A minimal OIDC provider: discovery, JWKS, and a token endpoint that enforces PKCE. */
async function fakeProvider(overrides: { audience?: string; nonce?: string; tokenStatus?: number } = {}) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const logins = new Map<string, { challenge: string; nonce: string }>();
  const requests: string[] = [];

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.pathname);
    if (url.pathname === '/.well-known/openid-configuration') {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/api/oidc/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
        end_session_endpoint: `${ISSUER}/api/oidc/end-session`,
      });
    }
    if (url.pathname === '/.well-known/jwks.json') return Response.json({ keys: [jwk] });
    if (url.pathname === '/api/oidc/token') {
      if (overrides.tokenStatus) return new Response('nope', { status: overrides.tokenStatus });
      const body = new URLSearchParams(String(init?.body));
      const login = logins.get(body.get('code')!);
      const verifier = body.get('code_verifier')!;
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!login || login.challenge !== challenge) return new Response('PKCE mismatch', { status: 400 });
      const idToken = await new SignJWT({
        email: 'tim@example.com',
        name: 'Tim',
        groups: ['admins'],
        nonce: overrides.nonce ?? login.nonce,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(overrides.audience ?? 'factory-client')
        .setSubject('user-123')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return Response.json({ access_token: 'at', id_token: idToken, token_type: 'Bearer' });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;

  /** What the browser does: follow the login URL, and the provider issues a code for it. */
  const authorize = (loginUrl: string) => {
    const params = new URL(loginUrl).searchParams;
    const code = `code-${logins.size + 1}`;
    logins.set(code, { challenge: params.get('code_challenge')!, nonce: params.get('nonce')! });
    return { code, state: params.get('state')! };
  };
  return { fetch, authorize, requests };
}

const makeAuth = (fetch: typeof globalThis.fetch, extra: Partial<ConstructorParameters<typeof OidcAuth>[0]> = {}) =>
  new OidcAuth({
    issuer: `${ISSUER}/`,
    clientId: 'factory-client',
    clientSecret: 'shh',
    sessionSecret: SECRET,
    displayName: 'Pocket ID',
    fetch,
    ...extra,
  });

const cookieRequest = (cookie: string) => new Request('https://factory.example.ts.net/web/x', { headers: { cookie } });
const sessionCookie = (setCookie: string) => setCookie.split(';')[0]!;

describe('OidcAuth', () => {
  it('builds a PKCE login URL from discovery', async () => {
    const provider = await fakeProvider();
    const url = new URL(await makeAuth(provider.fetch).getLoginUrl(REDIRECT, 'state-1'));
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'factory-client',
      redirect_uri: REDIRECT,
      scope: 'openid profile email groups',
      state: 'state-1',
      code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get('nonce')).toBeTruthy();
  });

  it('signs a user in and authenticates later requests from the session cookie', async () => {
    const provider = await fakeProvider();
    const auth = makeAuth(provider.fetch);
    const { code, state } = provider.authorize(await auth.getLoginUrl(REDIRECT, 'state-2'));

    const result = await auth.handleCallback(code, state);
    expect(result.user).toEqual({
      id: 'user-123',
      email: 'tim@example.com',
      name: 'Tim',
      groups: ['admins'],
      organizationId: 'homelab',
      memberOrgIds: ['homelab'],
    });
    expect(result.cookies[0]).toMatch(
      /^factory_oidc_session=.+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/,
    );

    const user = await auth.authenticateToken(
      '',
      cookieRequest(`other=1; ${sessionCookie(result.cookies[0]!)}`) as never,
    );
    expect(user).toMatchObject({ id: 'user-123', email: 'tim@example.com', organizationId: 'homelab' });
    expect(auth.authorizeUser(user!)).toBe(true);
  });

  it('rejects missing, tampered, foreign and expired sessions', async () => {
    const provider = await fakeProvider();
    const auth = makeAuth(provider.fetch);
    expect(await auth.authenticateToken('', cookieRequest('a=b') as never)).toBeNull();

    const { code, state } = provider.authorize(await auth.getLoginUrl(REDIRECT, 's'));
    const cookie = sessionCookie((await auth.handleCallback(code, state)).cookies[0]!);
    expect(await auth.authenticateToken('', cookieRequest(`${cookie}x`) as never)).toBeNull();

    const otherServer = makeAuth(provider.fetch, { sessionSecret: 'y'.repeat(40) });
    expect(await otherServer.authenticateToken('', cookieRequest(cookie) as never)).toBeNull();

    const expired = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-123')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SECRET));
    expect(await auth.authenticateToken('', cookieRequest(`factory_oidc_session=${expired}`) as never)).toBeNull();
  });

  it('refuses an ID token with the wrong nonce or audience, and a refused code', async () => {
    for (const overrides of [{ nonce: 'replayed' }, { audience: 'someone-else' }, { tokenStatus: 400 }]) {
      const provider = await fakeProvider(overrides);
      const auth = makeAuth(provider.fetch);
      const { code, state } = provider.authorize(await auth.getLoginUrl(REDIRECT, 'state-x'));
      await expect(auth.handleCallback(code, state)).rejects.toThrow();
    }
  });

  it('cannot complete a login whose state it did not issue (PKCE ties code to state)', async () => {
    const provider = await fakeProvider();
    const auth = makeAuth(provider.fetch);
    const { code } = provider.authorize(await auth.getLoginUrl(REDIRECT, 'real-state'));
    await expect(auth.handleCallback(code, 'forged-state')).rejects.toThrow(/refused the code/);
  });

  it('logs out through the end-session endpoint and clears the cookie', async () => {
    const provider = await fakeProvider();
    const auth = makeAuth(provider.fetch);
    const url = new URL((await auth.getLogoutUrl('https://factory.example.ts.net/'))!);
    expect(url.pathname).toBe('/api/oidc/end-session');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://factory.example.ts.net/');
    expect(auth.getClearSessionHeaders()['Set-Cookie']).toMatch(/^factory_oidc_session=; .*Max-Age=0$/);
    expect(auth.getLoginButtonConfig()).toEqual({ provider: 'oidc', text: 'Sign in with Pocket ID' });
  });

  it('puts everyone in one organization they administer', async () => {
    const auth = makeAuth((await fakeProvider()).fetch, { organizationId: 'tmcdo' });
    expect(await auth.ensureOrganization('u')).toBe('tmcdo');
    expect(await auth.isOrganizationAdmin('tmcdo', 'u')).toBe(true);
    expect(await auth.isOrganizationAdmin('other', 'u')).toBe(false);
  });

  it('insists on a real session secret and client', () => {
    expect(() => new OidcAuth({ issuer: ISSUER, clientId: 'c', clientSecret: 's', sessionSecret: 'short' })).toThrow(
      /32/,
    );
    expect(() => new OidcAuth({ issuer: '', clientId: 'c', clientSecret: 's', sessionSecret: SECRET })).toThrow(
      /issuer/,
    );
  });
});
