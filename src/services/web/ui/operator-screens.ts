/**
 * The operator's view of the platform.
 *
 * Nothing here can show a conversation, because no route it calls can return one:
 * `withOperatorAction` opens the platform scope, and no table holding content has
 * a platform policy. The screen adds only presentation.
 *
 * Which tenant is open stays in memory. Filtering and sorting are asked of the API
 * rather than done here, so the rule for "not connected" or for where an unknown
 * error rate sorts has one definition. Between requests the screen polls the cheap
 * connections route, and only goes back for the heavier health read when a state
 * has actually changed.
 */

import { html, type Html } from './html.ts';
import { accountScreen } from './client-bot-screens.ts';
import { connectionPill, errorSlot, field, pill, rethrowIfSignedOut, text, when, type FormValues, type Screen, type ScreenContext } from './screen.ts';

interface ConnectionView {
  readonly state: string;
  readonly error: { readonly reason: string; readonly description: string } | null;
  readonly lastKnownGoodAt: string | null;
  readonly changedAt: string | null;
}

interface Metrics {
  readonly messagesReceived: number;
  readonly messagesSent: number;
  readonly turnsAnswered: number;
  readonly failedResponses: number;
  readonly failedDeliveries: number;
  readonly expiredDeliveries: number;
  readonly responsesTimed: number;
  readonly noActivity: boolean;
  readonly errorRate: number | null;
  readonly responseFailureRate: number | null;
  readonly deliveryFailureRate: number | null;
  readonly averageResponseMs: number | null;
}

interface TenantHealth {
  readonly tenantId: string;
  readonly businessName: string;
  readonly provisioningState: string;
  readonly onboardedAt: string;
  readonly connection: ConnectionView;
  readonly metrics: Metrics | null;
  readonly health: { readonly elevatedErrorRate: boolean; readonly degradedResponseTime: boolean } | null;
}

interface Range {
  readonly from: string;
  readonly to: string;
  readonly available: boolean;
  readonly retainedSince: string;
}

interface HealthAnswer {
  readonly range: Range;
  readonly tenants: readonly TenantHealth[];
}

interface DetailAnswer {
  readonly range: Range;
  readonly tenant: TenantHealth;
  readonly transitions: readonly { readonly from: string; readonly to: string; readonly errorReason: string | null; readonly occurredAt: string }[];
}

interface ConnectionsAnswer {
  readonly tenants: readonly ({ readonly tenantId: string } & ConnectionView)[];
}

interface BotStatuses {
  readonly tenants: readonly {
    readonly tenantId: string;
    readonly ready: boolean;
    readonly active: boolean;
    readonly unmetConditions: readonly string[];
  }[];
}

interface AiProviderAnswer {
  readonly provider: { readonly provider: string; readonly model: string; readonly transcriptionModel: string; readonly capabilities: readonly string[] };
}

/** How quickly a state change reaches an operator watching the page (`operator-health-monitoring.md` AC2). */
export const OPERATOR_POLL_MS = 15_000;

function selectOf(name: string, label: string, options: readonly (readonly [string, string])[], value: string): Html {
  return html`<label class="field">
    <span class="label">${label}</span>
    <select name="${name}">
      ${options.map(([optionValue, optionLabel]) => html`<option value="${optionValue}" ${optionValue === value && html`selected`}>${optionLabel}</option>`)}
    </select>
  </label>`;
}

function percent(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function milliseconds(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
}

/** Zero or more, or nothing to say. Unavailable (`null`) is never shown as zero. */
function count(metrics: Metrics | null, value: (present: Metrics) => number): string {
  return metrics === null ? 'Unavailable' : String(value(metrics));
}

function flags(health: TenantHealth['health']): Html | false {
  if (health === null) return false;
  return html`${health.elevatedErrorRate && pill('High error rate', 'bad')} ${health.degradedResponseTime && pill('Slow responses', 'warn')}`;
}

const signature = (answer: ConnectionsAnswer): string =>
  answer.tenants
    .map((tenant) => `${tenant.tenantId}:${tenant.state}:${tenant.error?.reason ?? ''}:${tenant.changedAt ?? ''}`)
    .sort()
    .join('|');

interface Controls {
  readonly window: string;
  readonly from: string;
  readonly to: string;
  readonly connection: string;
  readonly sortBy: string;
  readonly sortDirection: string;
}

export function operatorDashboardScreen(context: ScreenContext): Screen {
  let controls: Controls = { window: '24h', from: '', to: '', connection: '', sortBy: 'businessName', sortDirection: 'asc' };
  let health: HealthAnswer;
  let lastSignature = '';
  let stale = false;
  let statuses = new Map<string, BotStatuses['tenants'][number]>();
  let provider: AiProviderAnswer['provider'] | undefined;
  let detail: DetailAnswer | undefined;

  const rangeBody = (): Record<string, unknown> =>
    controls.window === 'custom' ? { from: controls.from, to: controls.to } : { window: controls.window };

  const loadHealth = async (): Promise<void> => {
    health = await context.api.post<HealthAnswer>('/v1/operator/tenants/health', {
      ...rangeBody(),
      ...(controls.connection === '' ? {} : { connection: controls.connection }),
      sortBy: controls.sortBy,
      sortDirection: controls.sortDirection,
    });
  };

  const loadDetail = async (tenantId: string): Promise<void> => {
    detail = await context.api.post<DetailAnswer>('/v1/operator/tenants/detail', { tenantId, ...rangeBody() });
  };

  const unavailable = (range: Range): Html | false =>
    !range.available &&
    html`<p class="warning">Metrics for this period are unavailable. They are kept since ${when(range.retainedSince)}; pick a period after that.</p>`;

  const controlsForm = (): Html => html`<form data-form="controls" data-autosubmit class="filters">
    ${selectOf('window', 'Period', [['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['custom', 'Custom']], controls.window)}
    ${controls.window === 'custom' &&
    html`${field({ name: 'from', label: 'From', type: 'date', value: controls.from })} ${field({ name: 'to', label: 'To', type: 'date', value: controls.to })}`}
    ${selectOf(
      'connection',
      'Connection',
      [['', 'All'], ['not_connected', 'Not connected'], ['connecting', 'Connecting'], ['connected', 'Connected'], ['reconnecting', 'Reconnecting'], ['error', 'Error'], ['disconnected', 'Disconnected']],
      controls.connection,
    )}
    ${selectOf(
      'sortBy',
      'Sort by',
      [['businessName', 'Business'], ['connectionState', 'Connection'], ['errorRate', 'Error rate'], ['messagesReceived', 'Messages received'], ['messagesSent', 'Messages sent'], ['averageResponseMs', 'Response time']],
      controls.sortBy,
    )}
    ${selectOf('sortDirection', 'Order', [['asc', 'Ascending'], ['desc', 'Descending']], controls.sortDirection)}
    ${errorSlot}
  </form>`;

  const tenantRow = (tenant: TenantHealth): Html => {
    const { metrics } = tenant;
    return html`<tr>
      <td><button class="link" data-action="open" data-tenant="${tenant.tenantId}">${tenant.businessName}</button></td>
      <td>${connectionPill(tenant.connection.state)}${tenant.connection.error !== null && html`<div class="hint">${tenant.connection.error.reason}</div>`}</td>
      <td class="number">${metrics?.noActivity === true ? 'No activity' : count(metrics, (m) => m.messagesReceived)}</td>
      <td class="number">${count(metrics, (m) => m.messagesSent)}</td>
      <td class="number">${percent(metrics?.errorRate)}</td>
      <td class="number">${milliseconds(metrics?.averageResponseMs)}</td>
      <td>${flags(tenant.health)}</td>
    </tr>`;
  };

  const listView = (): Html => html`<h1>Platform health</h1>
    ${stale && html`<p class="warning">Couldn't refresh just now. This may be out of date.</p>`}
    ${provider !== undefined &&
    html`<p class="hint">AI provider: ${provider.provider}, model ${provider.model}. Handles ${provider.capabilities.join(', ')}.</p>`}
    <section class="card">${controlsForm()}</section>
    ${unavailable(health.range)}
    <section class="card table">
      ${health.tenants.length === 0
        ? html`<p class="empty">No tenants match.</p>`
        : html`<table>
            <thead><tr><th>Business</th><th>Connection</th><th class="number">Received</th><th class="number">Sent</th><th class="number">Error rate</th><th class="number">Avg response</th><th>Flags</th></tr></thead>
            <tbody>${health.tenants.map(tenantRow)}</tbody>
          </table>`}
    </section>`;

  const detailView = ({ tenant, transitions, range }: DetailAnswer): Html => {
    const { metrics, connection } = tenant;
    const status = statuses.get(tenant.tenantId);
    return html`<p><button class="link" data-action="close">← All tenants</button></p>
      <h1>${tenant.businessName}</h1>
      <section class="card">
        <div class="stats">
          <div><span class="label">Connection</span> ${connectionPill(connection.state)}</div>
          <div><span class="label">Last working</span> ${when(connection.lastKnownGoodAt)}</div>
          <div><span class="label">Changed</span> ${when(connection.changedAt)}</div>
          ${status !== undefined && html`<div><span class="label">Readiness</span> ${status.ready ? pill('Ready', 'good') : pill('Not ready', 'warn')}</div>`}
          ${status !== undefined && html`<div><span class="label">Bot</span> ${status.active ? pill('On', 'good') : pill('Off', 'muted')}</div>`}
        </div>
        ${connection.error !== null && html`<p class="warning"><strong>${connection.error.reason}.</strong> ${connection.error.description}</p>`}
        ${status !== undefined && status.unmetConditions.length > 0 && html`<p class="hint">Not met: ${status.unmetConditions.join(', ')}</p>`}
        <p class="hint">Onboarded ${when(tenant.onboardedAt)}</p>
      </section>
      ${unavailable(range)}
      <section class="card">
        <h2>Activity, ${when(range.from)} to ${when(range.to)}</h2>
        ${metrics?.noActivity === true && html`<p class="empty">No activity in this period.</p>`}
        <dl class="facts">
          <dt>Messages received</dt><dd>${count(metrics, (m) => m.messagesReceived)}</dd>
          <dt>Messages sent</dt><dd>${count(metrics, (m) => m.messagesSent)}</dd>
          <dt>Turns answered</dt><dd>${count(metrics, (m) => m.turnsAnswered)}</dd>
          <dt>Failed responses</dt><dd>${count(metrics, (m) => m.failedResponses)}</dd>
          <dt>Failed deliveries</dt><dd>${count(metrics, (m) => m.failedDeliveries)}</dd>
          <dt>Expired deliveries</dt><dd>${count(metrics, (m) => m.expiredDeliveries)}</dd>
          <dt>Error rate</dt><dd>${percent(metrics?.errorRate)}</dd>
          <dt>Average response</dt><dd>${milliseconds(metrics?.averageResponseMs)}</dd>
        </dl>
        ${flags(tenant.health)}
      </section>
      <section class="card">
        <h2>Connection history</h2>
        ${transitions.length === 0
          ? html`<p class="empty">No changes recorded.</p>`
          : html`<ul class="timeline">
              ${transitions.map(
                (entry) => html`<li>
                  ${entry.from} → <strong>${entry.to}</strong>
                  ${entry.errorReason !== null && html` (${entry.errorReason})`}
                  <span class="hint">${when(entry.occurredAt)}</span>
                </li>`,
              )}
            </ul>`}
      </section>`;
  };

  return {
    title: 'Platform health',
    load: async () => {
      const [, connections, botStatuses, ai] = await Promise.all([
        loadHealth(),
        context.api.get<ConnectionsAnswer>('/v1/operator/connections'),
        context.api.get<BotStatuses>('/v1/operator/bot-statuses'),
        context.api.get<AiProviderAnswer>('/v1/operator/ai-provider'),
      ]);
      lastSignature = signature(connections);
      statuses = new Map(botStatuses.tenants.map((tenant) => [tenant.tenantId, tenant]));
      provider = ai.provider;
    },
    pollAfterMs: () => OPERATOR_POLL_MS,
    poll: async () => {
      try {
        const connections = await context.api.get<ConnectionsAnswer>('/v1/operator/connections');
        const next = signature(connections);
        if (next !== lastSignature) {
          await loadHealth();
          if (detail !== undefined) await loadDetail(detail.tenant.tenantId);
          lastSignature = next;
        }
        stale = false;
      } catch (error) {
        rethrowIfSignedOut(error);
        stale = true;
      }
    },
    view: () => (detail === undefined ? listView() : detailView(detail)),
    forms: {
      controls: async (values: FormValues) => {
        const next: Controls = {
          window: text(values, 'window'),
          from: text(values, 'from'),
          to: text(values, 'to'),
          connection: text(values, 'connection'),
          sortBy: text(values, 'sortBy'),
          sortDirection: text(values, 'sortDirection'),
        };
        controls = next;
        // A custom period needs both ends before there is anything to ask for.
        if (next.window === 'custom' && (next.from === '' || next.to === '')) return;
        await loadHealth();
      },
    },
    actions: {
      open: async ({ tenant }) => {
        await loadDetail(tenant ?? '');
      },
      close: () => {
        detail = undefined;
      },
    },
  };
}

export function operatorAccountScreen(context: ScreenContext): Screen {
  return accountScreen(context, '/v1/operator/account/password', '/operator/login', false);
}
