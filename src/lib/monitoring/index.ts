/**
 * `@zeddev/monitoring` — the operator's numbers and health view across tenants, per
 * `operator-health-monitoring.md`. The counting itself is in migration 0020.
 */

export {
  assessHealth,
  HEALTH_THRESHOLDS,
  METRIC_BASELINE_MS,
  METRIC_RETENTION_DAYS,
  METRIC_WINDOWS,
  NO_METRICS,
  parseMetricSelection,
  purgeExpiredMetrics,
  resolveMetricRange,
  summarizeMetrics,
  type HealthFlags,
  type MetricRange,
  type MetricSelection,
  type MetricTotals,
  type MetricWindow,
  type TenantMetrics,
} from './metrics.ts';
export {
  listConnectionHealth,
  listTenantHealth,
  parseTenantDetailInput,
  parseTenantHealthInput,
  readTenantHealth,
  SORT_DIRECTIONS,
  sortTenantHealth,
  TENANT_HEALTH_SORTS,
  TRANSITION_HISTORY_LIMIT,
  type ConnectionFilter,
  type RangeDescription,
  type SortDirection,
  type TenantHealth,
  type TenantHealthQuery,
  type TenantHealthSort,
} from './health.ts';
