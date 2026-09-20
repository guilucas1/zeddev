/**
 * `@zeddev/vault` — where a tenant's *usable* secrets are kept.
 *
 * Not an external service: the name describes the role, not a vendor. The store
 * is `tenant_secrets` in the platform's own PostgreSQL, protected by AES-256-GCM
 * under keys that live only in configuration, which is what makes a copy of the
 * database insufficient to use anything in it (`credential-and-secret-handling.md`
 * AC4). `cost-efficient-operation.md` rules out an always-on secret-management
 * service, and `environment-portability.md` rules out a mechanism available on
 * only one of the three tiers — a managed KMS is both.
 *
 * The split from `@zeddev/secrets` is deliberate and load-bearing: that package
 * is the cryptography and holds no keys and no storage, so it can be depended on
 * by `@zeddev/db` itself. This package is the *policy* — where a sealed value
 * lives, who may read it, and the audit record that accompanies every touch — and
 * therefore depends on the database. Merging them would make `@zeddev/db` depend
 * on a package that depends on `@zeddev/db`.
 */

export { loadSealer, loadVaultConfig, VAULT_CONFIG_SCHEMA, type VaultConfig } from './config.ts';
export {
  deleteTenantSecret,
  describeTenantSecret,
  putTenantSecret,
  readTenantSecret,
  recordSecretAccess,
  requireTenantSecret,
  resealTenantSecrets,
  secretsAwaitingReseal,
  TENANT_SECRET_CLASSES,
  tenantSecretAccessHistory,
  type StoredSecretDescription,
  type TenantSecretClass,
} from './store.ts';
