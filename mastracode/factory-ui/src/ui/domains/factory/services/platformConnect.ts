/**
 * Browser-side helpers for the Mastra Connect tools a Factory's sessions get: the server's
 * `/web/integrations/platform/connect-tools` route lists the Platform project's connections.
 */

export const MASTRA_PLATFORM_URL = 'https://projects.mastra.ai';

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
      ...init,
    });
  } catch (cause) {
    const err = new Error('Network request failed');
    (err as { transient?: boolean }).transient = true;
    (err as { cause?: unknown }).cause = cause;
    throw err;
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      code = body.error;
      if (body.message) message = body.message;
      else if (body.error) message = body.error;
    } catch {
      /* ignore non-JSON */
    }
    const err = new Error(message);
    (err as { code?: string }).code = code;
    (err as { status?: number }).status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}

export interface ConnectToolConnection {
  id: string;
  integrationId: string;
  providerName: string;
  logoUrl: string | null;
  accountLabel: string | null;
  status: string;
}

export function isConnectToolsOffError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'connect_tools_off';
}

export interface ConnectTools {
  /** The Platform project whose connections sessions get as tools. */
  projectId: string;
  connections: ConnectToolConnection[];
}

export async function listConnectTools(baseUrl: string): Promise<ConnectTools> {
  return requestJson<ConnectTools>(baseUrl, '/web/integrations/platform/connect-tools');
}

/**
 * The Connect settings page of the Platform project. Without the organization id, Platform's `/org/*` route fills in
 * the user's current organization.
 */
export function platformProjectConnectUrl(projectId: string, organizationId?: string): string {
  const org = organizationId ? `orgs/${encodeURIComponent(organizationId)}` : 'org';
  return `${MASTRA_PLATFORM_URL}/${org}/projects/${encodeURIComponent(projectId)}/settings/connect`;
}
