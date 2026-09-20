/**
 * Where the sealing keys come from.
 *
 * `@zeddev/secrets` can seal and unseal, but it deliberately holds no keys: a
 * library that reads its own key out of the environment cannot be handed a
 * different one in a test, and rotation stops being expressible. The keys are
 * configuration, and this schema is the only place the platform names them.
 *
 * Several keys may be supplied at once, which is what makes rotation possible
 * without a flag day: add the new key, make it active, and every value sealed
 * under the retired key still unseals because its id is still held.
 * `credential-and-secret-handling.md` AC8 and AC9 require a credential be
 * replaceable "without a redeployment" and "without any code change"; a
 * single-key design forces one or the other.
 */

import { loadConfig, type Config, type ConfigSchema, type RawEnv } from '@zeddev/config';
import { ConfigurationError, type ConfigIssue } from '@zeddev/errors';
import { parseSealingKey, SecretSealer } from '@zeddev/secrets';

export const VAULT_CONFIG_SCHEMA = {
  VAULT_SEALING_KEYS: {
    type: 'string',
    description:
      'Comma-separated list of the keys that encrypt every stored credential the platform must be able to *use* — a tenant\'s WhatsApp access token above all. Each entry is "<key id>:<32 bytes, base64>". Generate one with `node -e "import(\'@zeddev/secrets\').then(m => console.log(m.generateSealingKey(\'k1\')))"`. More than one entry is how a key is rotated: values sealed under an older id keep unsealing for as long as that id is still listed. Without this the database alone would be enough to use every tenant\'s number (credential-and-secret-handling.md AC4).',
    secret: true,
    minLength: 8,
    example: 'k1:REPLACE_WITH_32_RANDOM_BYTES_BASE64',
  },
  VAULT_ACTIVE_SEALING_KEY: {
    type: 'string',
    description:
      'Which of VAULT_SEALING_KEYS seals new and re-sealed values, by key id. Empty means the first entry. Rotation is: append the new key, set this to its id, restart — nothing is re-encrypted eagerly and nothing becomes unreadable.',
    default: '',
  },
} as const satisfies ConfigSchema;

export type VaultConfig = Config<typeof VAULT_CONFIG_SCHEMA>;

export function loadVaultConfig(env: RawEnv = process.env): VaultConfig {
  return loadConfig(VAULT_CONFIG_SCHEMA, env);
}

/**
 * Build the sealer the platform runs with.
 *
 * Every problem with the list is reported together, as `ConfigurationError` does
 * everywhere else: an operator fixing a mistyped key should not discover a second
 * mistyped key only on the next restart.
 */
export function loadSealer(env: RawEnv = process.env): SecretSealer {
  const config = loadVaultConfig(env);
  const issues: ConfigIssue[] = [];
  const entries = config.VAULT_SEALING_KEYS.expose()
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  if (entries.length === 0) {
    issues.push({ key: 'VAULT_SEALING_KEYS', reason: 'at least one sealing key is required' });
  }

  const keys = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    try {
      const key = parseSealingKey(entry, 'VAULT_SEALING_KEYS');
      if (seen.has(key.id)) {
        issues.push({ key: 'VAULT_SEALING_KEYS', reason: `key id "${key.id}" is listed twice` });
        continue;
      }
      seen.add(key.id);
      keys.push(key);
    } catch (error) {
      if (error instanceof ConfigurationError) issues.push(...error.issues);
      else throw error;
    }
  }

  const active = config.VAULT_ACTIVE_SEALING_KEY === '' ? undefined : config.VAULT_ACTIVE_SEALING_KEY;
  if (active !== undefined && !seen.has(active)) {
    issues.push({
      key: 'VAULT_ACTIVE_SEALING_KEY',
      reason: `names key id "${active}", which VAULT_SEALING_KEYS does not list`,
    });
  }

  if (issues.length > 0) throw new ConfigurationError(issues);
  return new SecretSealer(keys, active);
}
