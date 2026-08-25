<!--
  GENERATED FILE — do not edit by hand.

  Regenerate with `npm run config-reference`. A test fails the build when this
  file no longer matches the schemas, because `environment-portability.md`
  requires the documented configuration list be complete enough to explain every
  behavioural difference between deployment tiers, and a hand-maintained list
  stops being that on the second key anyone adds.
-->

# Configuration reference

Every value the platform reads from its environment. There is nothing else: no
configuration file, no flag, and no branch on which tier is running. That last
part is a requirement rather than a style choice — `environment-portability.md`
requires that the same artifact run on a personal computer, a low-cost VPS, and a
managed cloud provider "given only environment-appropriate configuration values",
and separately that no logic branch on detecting which of those it is. So this
list is the complete answer to "what differs between our deployments".

Startup collects **every** missing or invalid key and fails with all of them at
once, rather than one per restart.

Values marked **(secret)** arrive wrapped so they cannot be logged or serialised
by accident. Never place one in a URL, a command line, or a container image.

## Database

PostgreSQL carries relational data, the job queue, and — later — vector embeddings, so it is the one backing service every tier must supply. Discrete keys rather than a connection URL, so that exactly one of them is a secret and cannot be serialised by accident. The role named here must not be a superuser and must not carry BYPASSRLS: both are exempt from every row-level security policy in the schema, which would silently remove all tenant isolation while appearing to work.

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `DATABASE_ACQUIRE_TIMEOUT` | duration | no | `10000` | How long a request waits for a free connection before failing. |
| `DATABASE_CA_CERTIFICATE` | string | no | `` | PEM certificate authority bundle, for a server whose certificate is not signed by a public root. Empty means use the system trust store. |
| `DATABASE_CONNECT_TIMEOUT` | duration | no | `10000` | How long to wait for a TCP connection to the database to be established. |
| `DATABASE_HOST` | string | yes | — | Hostname or address of the PostgreSQL server. |
| `DATABASE_IDLE_TIMEOUT` | duration | no | `30000` | How long an unused connection is kept open before being closed. |
| `DATABASE_NAME` | string | yes | — | Database to connect to. |
| `DATABASE_PASSWORD` | string | yes | — | Password for the database role. **(secret)** |
| `DATABASE_POOL_MAX` | integer | no | `10` | Maximum simultaneous database connections held by this process. Each one costs memory on the server, so this is the main lever for fitting the platform onto a small host. |
| `DATABASE_PORT` | integer | no | `5432` | TCP port of the PostgreSQL server. |
| `DATABASE_SSL_MODE` | enum(disable\|prefer\|require\|verify-ca\|verify-full) | no | `prefer` | TLS negotiation mode, using libpq vocabulary. "disable" is appropriate only when the database is reached over a trusted local network, such as a container network on a single host. |
| `DATABASE_STATEMENT_TIMEOUT` | duration | no | `30000` | Server-side limit on how long any single statement may run. Enforced by the server so that an abandoned query cannot keep holding locks that block other tenants. |
| `DATABASE_USER` | string | yes | — | Role to authenticate as. |

## Object storage

Holds uploaded knowledge documents and fetched inbound media. Any S3-compatible endpoint: a container on a laptop or VPS, or a managed bucket in the cloud. The only protocol difference between those is STORAGE_ADDRESSING_STYLE, which is configured rather than detected — detecting it would be environment-tier branching, which environment-portability.md forbids outright.

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `STORAGE_ACCESS_KEY_ID` | string | yes | — | Access key identifying the platform to the object storage endpoint. |
| `STORAGE_ADDRESSING_STYLE` | enum(path\|virtual-host) | no | `path` | Whether the bucket appears in the request path or in the hostname. Self-hosted endpoints generally require "path"; managed providers generally prefer "virtual-host". This is configuration rather than something the platform detects, because detecting it would be environment-tier branching by another name. |
| `STORAGE_BUCKET` | string | yes | — | Bucket holding uploaded knowledge documents and fetched inbound media. |
| `STORAGE_ENDPOINT_HOST` | string | yes | — | Hostname or address of the S3-compatible object storage endpoint. A container name on a single host, or a provider endpoint in a managed cloud. |
| `STORAGE_ENDPOINT_PORT` | integer | no | `443` | TCP port of the object storage endpoint. Leave at the protocol default unless the endpoint is published elsewhere. |
| `STORAGE_KEY_PREFIX` | string | no | `` | Prepended to every object key, so one bucket can carry more than one deployment. Empty means the bucket holds this deployment alone. Must end with a slash if set. |
| `STORAGE_MAX_ATTEMPTS` | integer | no | `4` | How many times a transient object storage failure is retried before it is surfaced. Only failures classified as retryable are retried; a rejected credential fails on the first attempt. |
| `STORAGE_MAX_OBJECT_BYTES` | integer | no | `33554432` | Ceiling on a single stored object. Bodies are buffered in memory, so this is the main lever for fitting the platform onto a small host; it also bounds what a client can upload as business knowledge. |
| `STORAGE_MAX_SOCKETS` | integer | no | `16` | Maximum simultaneous connections to the object storage endpoint held by this process. |
| `STORAGE_REGION` | string | no | `us-east-1` | Region name used when signing requests. Self-hosted endpoints generally ignore the value but still require the signature to name one. |
| `STORAGE_REQUEST_TIMEOUT` | duration | no | `30000` | How long any single object storage request may take, including reading the response body. Bounds how long one wedged upload can occupy a worker. |
| `STORAGE_SECRET_ACCESS_KEY` | string | yes | — | Secret key paired with the access key. **(secret)** |
| `STORAGE_TLS` | boolean | no | `true` | Whether to speak TLS to the endpoint. False is appropriate only when the endpoint is reached over a trusted local network, such as a container network on a single host. |

## Template

```sh
# How long a request waits for a free connection before failing.
# default: 10000
DATABASE_ACQUIRE_TIMEOUT=10000

# PEM certificate authority bundle, for a server whose certificate is not signed by a public root. Empty means use the system trust store.
# default: 
DATABASE_CA_CERTIFICATE=

# How long to wait for a TCP connection to the database to be established.
# default: 10000
DATABASE_CONNECT_TIMEOUT=10000

# Hostname or address of the PostgreSQL server.
DATABASE_HOST=postgres

# How long an unused connection is kept open before being closed.
# default: 30000
DATABASE_IDLE_TIMEOUT=30000

# Database to connect to.
DATABASE_NAME=zeddev

# Password for the database role.
DATABASE_PASSWORD=

# Maximum simultaneous database connections held by this process. Each one costs memory on the server, so this is the main lever for fitting the platform onto a small host.
# default: 10
DATABASE_POOL_MAX=10

# TCP port of the PostgreSQL server.
# default: 5432
DATABASE_PORT=5432

# TLS negotiation mode, using libpq vocabulary. "disable" is appropriate only when the database is reached over a trusted local network, such as a container network on a single host.
# one of: disable, prefer, require, verify-ca, verify-full
# default: prefer
DATABASE_SSL_MODE=prefer

# Server-side limit on how long any single statement may run. Enforced by the server so that an abandoned query cannot keep holding locks that block other tenants.
# default: 30000
DATABASE_STATEMENT_TIMEOUT=30000

# Role to authenticate as.
DATABASE_USER=zeddev

# Access key identifying the platform to the object storage endpoint.
STORAGE_ACCESS_KEY_ID=

# Whether the bucket appears in the request path or in the hostname. Self-hosted endpoints generally require "path"; managed providers generally prefer "virtual-host". This is configuration rather than something the platform detects, because detecting it would be environment-tier branching by another name.
# one of: path, virtual-host
# default: path
STORAGE_ADDRESSING_STYLE=path

# Bucket holding uploaded knowledge documents and fetched inbound media.
STORAGE_BUCKET=zeddev

# Hostname or address of the S3-compatible object storage endpoint. A container name on a single host, or a provider endpoint in a managed cloud.
STORAGE_ENDPOINT_HOST=object-storage

# TCP port of the object storage endpoint. Leave at the protocol default unless the endpoint is published elsewhere.
# default: 443
STORAGE_ENDPOINT_PORT=443

# Prepended to every object key, so one bucket can carry more than one deployment. Empty means the bucket holds this deployment alone. Must end with a slash if set.
# default: 
STORAGE_KEY_PREFIX=

# How many times a transient object storage failure is retried before it is surfaced. Only failures classified as retryable are retried; a rejected credential fails on the first attempt.
# default: 4
STORAGE_MAX_ATTEMPTS=4

# Ceiling on a single stored object. Bodies are buffered in memory, so this is the main lever for fitting the platform onto a small host; it also bounds what a client can upload as business knowledge.
# default: 33554432
STORAGE_MAX_OBJECT_BYTES=33554432

# Maximum simultaneous connections to the object storage endpoint held by this process.
# default: 16
STORAGE_MAX_SOCKETS=16

# Region name used when signing requests. Self-hosted endpoints generally ignore the value but still require the signature to name one.
# default: us-east-1
STORAGE_REGION=us-east-1

# How long any single object storage request may take, including reading the response body. Bounds how long one wedged upload can occupy a worker.
# default: 30000
STORAGE_REQUEST_TIMEOUT=30000

# Secret key paired with the access key.
STORAGE_SECRET_ACCESS_KEY=

# Whether to speak TLS to the endpoint. False is appropriate only when the endpoint is reached over a trusted local network, such as a container network on a single host.
# default: true
STORAGE_TLS=true
```
