import { createHash, createHmac } from 'node:crypto';

import { MastraAuthProvider, getRequestHeader } from '@mastra/core/server';
import type { MastraAuthRequest } from '@mastra/core/server';
import { SignJWT, createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { JWTPayload } from 'jose';

export interface OidcAuthOptions {
  /** The provider's issuer, e.g. `https://id.tail99d67.ts.net`. Discovery is read from it. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /**
   * Signs Factory's session cookie and derives each login's PKCE verifier and nonce. At least 32
   * characters; keep it stable, or everyone is signed out.
   */
  sessionSecret: string;
  /** Everyone the provider lets in belongs to this one Factory organization. */
  organizationId?: string;
  /** Text on the sign-in button. */
  displayName?: string;
  scopes?: string[];
  cookieName?: string;
  /** Session lifetime in seconds. Default: 7 days. */
  sessionMaxAge?: number;
  /** Override discovery fetches (tests). */
  fetch?: typeof fetch;
}

export interface OidcUser {
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  groups?: string[];
  organizationId: string;
  memberOrgIds: string[];
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

const DEFAULT_SCOPES = ['openid', 'profile', 'email', 'groups'];
const base64url = (buffer: Buffer) => buffer.toString('base64url');

/**
 * Factory sign-in through any OpenID Connect provider. It plugs into Factory's single-sign-on
 * routes (`/auth/login` → provider → `/auth/callback`), sets an HttpOnly session cookie Factory
 * signs itself, and authenticates every request from that cookie. Who may sign in is the
 * provider's decision (e.g. Pocket ID's allowed groups on the client); everyone it admits joins one
 * Factory organization.
 *
 * The PKCE verifier and the nonce are HMACs of the login's random `state` under the session secret,
 * so the flow needs no server-side store and no extra cookie.
 */
export class OidcAuth extends MastraAuthProvider<OidcUser> {
  readonly #options: Required<Omit<OidcAuthOptions, 'fetch' | 'displayName'>> & { displayName?: string };
  readonly #fetch: typeof fetch;
  readonly #key: Uint8Array;
  #discovery: Promise<Discovery> | undefined;
  #jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

  constructor(options: OidcAuthOptions) {
    super({ name: 'oidc' });
    if (!options.issuer || !options.clientId || !options.clientSecret) {
      throw new Error('OidcAuth needs an issuer, a client id and a client secret');
    }
    if (!options.sessionSecret || options.sessionSecret.length < 32) {
      throw new Error('OidcAuth needs a session secret of at least 32 characters');
    }
    this.#options = {
      issuer: options.issuer.replace(/\/+$/, ''),
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      sessionSecret: options.sessionSecret,
      organizationId: options.organizationId ?? 'homelab',
      displayName: options.displayName,
      scopes: options.scopes ?? DEFAULT_SCOPES,
      cookieName: options.cookieName ?? 'factory_oidc_session',
      sessionMaxAge: options.sessionMaxAge ?? 7 * 24 * 60 * 60,
    };
    this.#fetch = options.fetch ?? fetch;
    this.#key = new TextEncoder().encode(options.sessionSecret);
  }

  // ── Single sign-on ───────────────────────────────────────────────────────

  async getLoginUrl(redirectUri: string, state: string): Promise<string> {
    const discovery = await this.#discover();
    // PKCE S256: the challenge is the SHA-256 of the verifier derived from this login's state.
    const challenge = base64url(createHash('sha256').update(this.#derive('pkce', state)).digest());
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.#options.clientId,
      redirect_uri: redirectUri,
      scope: this.#options.scopes.join(' '),
      state,
      nonce: this.#derive('nonce', state),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${discovery.authorization_endpoint}?${params.toString()}`;
  }

  async handleCallback(
    code: string,
    state: string,
    redirectUri?: string,
  ): Promise<{ user: OidcUser; tokens: { accessToken: string; idToken?: string }; cookies: string[] }> {
    const discovery = await this.#discover();
    const response = await this.#fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(
          `${encodeURIComponent(this.#options.clientId)}:${encodeURIComponent(this.#options.clientSecret)}`,
        ).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: this.#derive('pkce', state),
        ...(redirectUri ? { redirect_uri: redirectUri } : {}),
      }),
    });
    if (!response.ok) throw new Error(`Sign-in failed: the identity provider refused the code (${response.status})`);
    const tokens = (await response.json()) as { access_token: string; id_token?: string };
    if (!tokens.id_token) throw new Error('Sign-in failed: the identity provider returned no ID token');

    const { payload } = await jwtVerify(tokens.id_token, this.#keys(discovery), {
      issuer: discovery.issuer,
      audience: this.#options.clientId,
    });
    if (payload.nonce !== this.#derive('nonce', state))
      throw new Error('Sign-in failed: the ID token nonce does not match');

    const user = this.#userFrom(payload);
    const session = await new SignJWT({
      email: user.email,
      name: user.name,
      picture: user.avatarUrl,
      groups: user.groups,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(`${this.#options.sessionMaxAge}s`)
      .sign(this.#key);
    return {
      user,
      tokens: { accessToken: tokens.access_token, ...(tokens.id_token ? { idToken: tokens.id_token } : {}) },
      cookies: [this.#cookie(session, this.#options.sessionMaxAge)],
    };
  }

  async getLogoutUrl(redirectUri: string): Promise<string | null> {
    const discovery = await this.#discover().catch(() => undefined);
    if (!discovery?.end_session_endpoint) return null;
    const params = new URLSearchParams({ client_id: this.#options.clientId, post_logout_redirect_uri: redirectUri });
    return `${discovery.end_session_endpoint}?${params.toString()}`;
  }

  getLoginButtonConfig() {
    return { provider: 'oidc', text: `Sign in with ${this.#options.displayName ?? 'single sign-on'}` };
  }

  /** Factory clears the session cookie on logout through these headers. */
  getClearSessionHeaders(): Record<string, string> {
    return { 'Set-Cookie': this.#cookie('', 0) };
  }

  // ── Request authentication ───────────────────────────────────────────────

  async authenticateToken(token: string, request: MastraAuthRequest): Promise<OidcUser | null> {
    const session = this.#cookieFrom(getRequestHeader(request, 'cookie')) ?? (token || undefined);
    if (!session) return null;
    try {
      const { payload } = await jwtVerify(session, this.#key, { algorithms: ['HS256'] });
      return this.#userFrom(payload);
    } catch {
      return null;
    }
  }

  authorizeUser(user: OidcUser): boolean {
    return Boolean(user.id);
  }

  // ── One organization ─────────────────────────────────────────────────────

  async ensureOrganization(_userId: string): Promise<string | undefined> {
    return this.#options.organizationId;
  }

  /** The provider already limits who signs in, so everyone admitted administers the organization. */
  async isOrganizationAdmin(organizationId: string, _userId: string): Promise<boolean> {
    return organizationId === this.#options.organizationId;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  #discover(): Promise<Discovery> {
    this.#discovery ??= (async () => {
      const response = await this.#fetch(`${this.#options.issuer}/.well-known/openid-configuration`);
      if (!response.ok) throw new Error(`OIDC discovery failed for ${this.#options.issuer} (${response.status})`);
      return (await response.json()) as Discovery;
    })().catch(error => {
      this.#discovery = undefined; // retry on the next request
      throw error;
    });
    return this.#discovery;
  }

  #keys(discovery: Discovery) {
    this.#jwks ??= createRemoteJWKSet(new URL(discovery.jwks_uri), {
      [customFetch]: (url: string, init: RequestInit) => this.#fetch(url, init),
    });
    return this.#jwks;
  }

  /** A per-login secret derived from `state`: the PKCE verifier or the nonce. */
  #derive(purpose: 'pkce' | 'nonce', state: string): string {
    return base64url(createHmac('sha256', this.#options.sessionSecret).update(`${purpose}:${state}`).digest());
  }

  #userFrom(payload: JWTPayload): OidcUser {
    const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
    const email = str(payload.email);
    const name = str(payload.name) ?? str(payload.preferred_username) ?? email;
    const avatarUrl = str(payload.picture);
    const groups = Array.isArray(payload.groups)
      ? payload.groups.filter((g): g is string => typeof g === 'string')
      : undefined;
    return {
      id: payload.sub ?? '',
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(groups ? { groups } : {}),
      organizationId: this.#options.organizationId,
      memberOrgIds: [this.#options.organizationId],
    };
  }

  #cookie(value: string, maxAge: number): string {
    return `${this.#options.cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  }

  #cookieFrom(header: string | undefined | null): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === this.#options.cookieName) return rest.join('=') || undefined;
    }
    return undefined;
  }
}
