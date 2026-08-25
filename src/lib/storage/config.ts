/**
 * The object storage environment schema.
 *
 * Discrete keys rather than an endpoint URL, following the same reasoning
 * IMPLEMENTATION_PLAN.md §1 records for the database: a URL is one string that
 * tends to accumulate a credential, and once it does, every accidental
 * disclosure of it — a log line, a crash dump, a process listing — is a
 * credential disclosure. Discrete keys let exactly one of them be marked
 * `secret`, so it arrives wrapped in `Secret` and cannot be serialised by
 * accident.
 *
 * These keys are also the complete answer to `environment-portability.md`'s
 * requirement that the configuration list be "sufficient by itself to explain
 * every observed behavioral difference between two deployments". Between a
 * laptop container, a VPS container, and a managed cloud bucket, everything that
 * differs is here: the address, whether TLS is spoken, how the bucket is
 * addressed, and the credentials. Nothing about which tier is running is
 * discoverable from inside the process, which is what AC5 requires.
 */

import type { ConfigSchema } from '@zeddev/config';
import { ADDRESSING_STYLES } from './s3.ts';
import { DEFAULT_MAX_OBJECT_BYTES } from './types.ts';

export const STORAGE_CONFIG_SCHEMA = {
  STORAGE_ENDPOINT_HOST: {
    type: 'string',
    description:
      'Hostname or address of the S3-compatible object storage endpoint. A container name on a single host, or a provider endpoint in a managed cloud.',
    example: 'object-storage',
  },
  STORAGE_ENDPOINT_PORT: {
    type: 'integer',
    description:
      'TCP port of the object storage endpoint. Leave at the protocol default unless the endpoint is published elsewhere.',
    default: 443,
    min: 1,
    max: 65535,
  },
  STORAGE_TLS: {
    type: 'boolean',
    description:
      'Whether to speak TLS to the endpoint. False is appropriate only when the endpoint is reached over a trusted local network, such as a container network on a single host.',
    default: true,
  },
  STORAGE_BUCKET: {
    type: 'string',
    description: 'Bucket holding uploaded knowledge documents and fetched inbound media.',
    example: 'zeddev',
  },
  STORAGE_REGION: {
    type: 'string',
    description:
      'Region name used when signing requests. Self-hosted endpoints generally ignore the value but still require the signature to name one.',
    default: 'us-east-1',
  },
  STORAGE_ACCESS_KEY_ID: {
    type: 'string',
    description: 'Access key identifying the platform to the object storage endpoint.',
  },
  STORAGE_SECRET_ACCESS_KEY: {
    type: 'string',
    description: 'Secret key paired with the access key.',
    secret: true,
  },
  STORAGE_ADDRESSING_STYLE: {
    type: 'enum',
    values: ADDRESSING_STYLES,
    description:
      'Whether the bucket appears in the request path or in the hostname. Self-hosted endpoints generally require "path"; managed providers generally prefer "virtual-host". This is configuration rather than something the platform detects, because detecting it would be environment-tier branching by another name.',
    default: 'path',
  },
  STORAGE_KEY_PREFIX: {
    type: 'string',
    description:
      'Prepended to every object key, so one bucket can carry more than one deployment. Empty means the bucket holds this deployment alone. Must end with a slash if set.',
    default: '',
  },
  STORAGE_MAX_OBJECT_BYTES: {
    type: 'integer',
    description:
      'Ceiling on a single stored object. Bodies are buffered in memory, so this is the main lever for fitting the platform onto a small host; it also bounds what a client can upload as business knowledge.',
    default: DEFAULT_MAX_OBJECT_BYTES,
    min: 1024,
  },
  STORAGE_REQUEST_TIMEOUT: {
    type: 'duration',
    description:
      'How long any single object storage request may take, including reading the response body. Bounds how long one wedged upload can occupy a worker.',
    default: 30_000,
    min: 100,
  },
  STORAGE_MAX_ATTEMPTS: {
    type: 'integer',
    description:
      'How many times a transient object storage failure is retried before it is surfaced. Only failures classified as retryable are retried; a rejected credential fails on the first attempt.',
    default: 4,
    min: 1,
    max: 10,
  },
  STORAGE_MAX_SOCKETS: {
    type: 'integer',
    description:
      'Maximum simultaneous connections to the object storage endpoint held by this process.',
    default: 16,
    min: 1,
    max: 256,
  },
} as const satisfies ConfigSchema;
