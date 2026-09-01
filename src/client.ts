// REST client, shared types, and agent-friendly error mapping.
// No business logic lives here — each function is a thin wrapper over one
// REST endpoint so that tools.ts stays readable and tests can stub fetch.

export interface BriefGateConfig {
  apiKey: string;
  baseUrl: string;
}

// ─── Domain types ─────────────────────────────────────────────────────────────

export type ItemType =
  | 'text'
  | 'longtext'
  | 'file'
  | 'file_list'
  | 'image'
  | 'color_list'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'url'
  | 'secret'
  | 'structured';

export type ItemStatus = 'pending' | 'submitted' | 'needs_revision' | 'approved';
export type IntakeStatus = 'draft' | 'sent' | 'in_progress' | 'completed' | 'archived';
export type ChaseSchedule = 'default' | 'gentle' | 'aggressive' | 'custom' | 'off';

export interface ItemOption {
  value: string;
  label: string;
}

export interface ItemConstraints {
  formats?: string[];
  min_width?: number;
  min_height?: number;
  max_width?: number;
  max_height?: number;
  max_bytes?: number;
  min_chars?: number;
  max_chars?: number;
  min_count?: number;
  max_count?: number;
  transparent_background?: boolean;
}

export interface ItemDefinition {
  key: string;
  type: ItemType;
  label: string;
  help?: string;
  required?: boolean;
  constraints?: ItemConstraints;
  schema?: Record<string, unknown>;
  options?: ItemOption[];
  pattern?: string;
  assignee?: 'client' | 'owner';
  /** The answer an agent is proceeding on for an owner decision it cannot make. */
  proposed?: { value: string | string[]; rationale?: string };
}

export interface FollowUpAdvice {
  recommended: 'webhook' | 'schedule';
  reason: string;
  webhook: { active_endpoints: number; events: string[]; register_with: string };
  schedule: { check_with: string; every_hours: number; until: string };
}

export interface IntakeCreated {
  intake_id: string;
  portal_url: string;
  status: IntakeStatus;
  items: Array<{ key: string; status: ItemStatus }>;
  follow_up?: FollowUpAdvice;
}

export interface IntakeStatusResult {
  intake_id: string;
  status: IntakeStatus;
  progress: { submitted: number; total: number };
  items: Array<{
    key: string;
    status: ItemStatus;
    submitted_at?: string;
    label: string;
  }>;
  chases: Array<{
    channel: string;
    sent_at: string;
    status: string;
    attempt_no: number;
  }>;
  client_last_seen?: string;
  due_date?: string;
}

export interface IntakeResults {
  intake_id: string;
  status: IntakeStatus;
  results: Record<string, unknown>;
  meta: Record<
    string,
    {
      type: ItemType;
      status: ItemStatus;
      submitted_at?: string;
    }
  >;
}

export interface IntakeListItem {
  intake_id: string;
  project_name: string;
  client_email: string;
  status: IntakeStatus;
  created_at: string;
  due_date?: string;
  portal_url: string;
}

export interface IntakeList {
  intakes: IntakeListItem[];
  total: number;
}

export interface UsageResult {
  plan: string;
  active_intakes: { used: number; limit: number | null };
  storage_bytes: { used: number; limit: number | null };
  requests_this_hour: { used: number; limit: number };
}

// Abort fetch after this many ms so an unresponsive server never stalls the agent.
const FETCH_TIMEOUT_MS = 30_000;

// ─── Core fetch wrapper ───────────────────────────────────────────────────────

export async function apiRequest<T>(
  config: BriefGateConfig,
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const url = `${config.baseUrl}/v1${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  const init: RequestInit = {
    method,
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...extraHeaders,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `BriefGate API request timed out after ${FETCH_TIMEOUT_MS / 1000}s — the service may be temporarily unreachable. Try again shortly.`,
      );
    }
    // Network errors (ECONNREFUSED, DNS failure, etc.) — expose cause without leaking config.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`BriefGate API unreachable: ${detail}. Check your network connection or BRIEFGATE_BASE_URL.`);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    return throwApiError(res);
  }

  if (res.status === 204) {
    return {} as T;
  }

  // Guard against a proxy/CDN returning HTML (e.g. on a 502 that was re-wrapped as 200).
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(
      `BriefGate API returned an unexpected non-JSON response (status ${res.status}). This may indicate a proxy or network issue — try again shortly.`,
    );
  }
}

async function throwApiError(res: Response): Promise<never> {
  let message = '';
  let retryAfter = '';
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    message = body.message ?? body.error ?? '';
  } catch {
    message = res.statusText;
  }
  retryAfter = res.headers.get('Retry-After') ?? '';

  switch (res.status) {
    case 401:
      throw new Error(
        'Authentication failed — verify your BRIEFGATE_API_KEY is correct and has not been revoked.',
      );
    case 402:
      throw new Error(
        `Plan limit reached: ${message || 'quota exceeded'} — upgrade your plan or reduce scope.`,
      );
    case 403:
      throw new Error(
        'Access denied — this API key does not have the required scope for this operation.',
      );
    case 404:
      throw new Error(
        'Resource not found — verify the intake_id is correct and belongs to this API key.',
      );
    case 409:
      throw new Error(
        'Conflict — an intake with this idempotency key already exists; check list_intakes to find it.',
      );
    case 410:
      throw new Error(
        'Gone — this intake has been deleted and all its files purged.',
      );
    case 413:
      throw new Error(
        'Payload too large — reduce the number of items or check file size limits.',
      );
    case 422:
      throw new Error(
        `Invalid request: ${message || 'check the parameters and try again.'}`,
      );
    case 429: {
      const after = retryAfter ? `${retryAfter}s` : 'a moment';
      throw new Error(
        `Rate limited — retry after ${after}. Use webhooks instead of polling to stay within limits.`,
      );
    }
    case 500:
    case 502:
    case 503:
      throw new Error(
        `BriefGate API error ${res.status}: ${message || 'internal server error — try again shortly.'}`,
      );
    default:
      throw new Error(`BriefGate API error ${res.status}: ${message || res.statusText}`);
  }
}

// ─── Typed endpoint wrappers ──────────────────────────────────────────────────

export async function createIntake(
  config: BriefGateConfig,
  payload: unknown,
  idempotencyKey: string,
): Promise<IntakeCreated> {
  return apiRequest<IntakeCreated>(config, 'POST', '/intakes', payload, {
    'Idempotency-Key': idempotencyKey,
  });
}

export async function listIntakes(
  config: BriefGateConfig,
  params: { status?: string; client_email?: string; limit?: number; offset?: number },
): Promise<IntakeList> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.client_email) qs.set('client_email', params.client_email);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString() ? `?${qs.toString()}` : '';
  return apiRequest<IntakeList>(config, 'GET', `/intakes${query}`);
}

export async function getIntakeStatus(
  config: BriefGateConfig,
  intakeId: string,
): Promise<IntakeStatusResult> {
  return apiRequest<IntakeStatusResult>(config, 'GET', `/intakes/${intakeId}/status`);
}

export async function getIntakeResults(
  config: BriefGateConfig,
  intakeId: string,
  params: { only_new?: boolean; include_pending?: boolean },
): Promise<IntakeResults> {
  const qs = new URLSearchParams();
  if (params.only_new) qs.set('only_new', 'true');
  if (params.include_pending) qs.set('include_pending', 'true');
  const query = qs.toString() ? `?${qs.toString()}` : '';
  return apiRequest<IntakeResults>(config, 'GET', `/intakes/${intakeId}/results${query}`);
}

export async function addItems(
  config: BriefGateConfig,
  intakeId: string,
  items: ItemDefinition[],
): Promise<IntakeCreated> {
  return apiRequest<IntakeCreated>(config, 'POST', `/intakes/${intakeId}/items`, { items });
}

export async function updateItem(
  config: BriefGateConfig,
  intakeId: string,
  itemKey: string,
  changes: Record<string, unknown>,
): Promise<{ item: Record<string, unknown>; discarded_submitted_value?: boolean }> {
  return apiRequest(config, 'PATCH', `/intakes/${intakeId}/items/${encodeURIComponent(itemKey)}`, changes);
}

export async function requestRevision(
  config: BriefGateConfig,
  intakeId: string,
  itemKey: string,
  note: string,
): Promise<{ status: string; item_key: string }> {
  return apiRequest<{ status: string; item_key: string }>(
    config,
    'POST',
    `/intakes/${intakeId}/revision`,
    { item_key: itemKey, note },
  );
}

export async function sendChase(
  config: BriefGateConfig,
  intakeId: string,
  channel?: 'email' | 'sms',
): Promise<{ sent: true }> {
  return apiRequest<{ sent: true }>(config, 'POST', `/intakes/${intakeId}/chase`, {
    ...(channel !== undefined && { channel }),
  });
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────
//
// The REST routes have always accepted an API key ("an agent must be able to
// register its own webhook over MCP/REST rather than the developer having to
// click through the dashboard"), but no MCP tool ever reached them, so the
// only way to set one up was the dashboard. These close that gap.

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  format: string;
  active: boolean;
  created_at: string;
}

export async function listWebhooks(
  config: BriefGateConfig,
): Promise<{ webhooks: WebhookEndpoint[] }> {
  return apiRequest<{ webhooks: WebhookEndpoint[] }>(config, 'GET', '/webhooks');
}

export async function createWebhook(
  config: BriefGateConfig,
  payload: { url: string; events: string[]; format?: string },
): Promise<WebhookEndpoint & { secret: string }> {
  return apiRequest<WebhookEndpoint & { secret: string }>(config, 'POST', '/webhooks', payload);
}

export async function deleteWebhook(
  config: BriefGateConfig,
  id: string,
): Promise<{ deleted: true }> {
  return apiRequest<{ deleted: true }>(config, 'DELETE', `/webhooks/${id}`);
}

export async function getUsage(config: BriefGateConfig): Promise<UsageResult> {
  return apiRequest<UsageResult>(config, 'GET', '/usage');
}
