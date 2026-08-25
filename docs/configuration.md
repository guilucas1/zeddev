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

## Identity and sessions

The session, lockout, and recovery-link bounds that authentication-and-access.md requires be defined but deliberately leaves unspecified. They are configuration rather than constants because a laptop, a VPS, and a managed cloud deployment can legitimately want different values — a demo instance with a short absolute session lifetime, a production one with a longer inactivity window — and environment-portability.md requires every such behavioural difference be explainable from this list. Startup additionally rejects an absolute lifetime shorter than the inactivity timeout, which is individually valid on both keys and jointly leaves only one of the two required expiry rules in force.

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `IDENTITY_EMAIL_VERIFICATION_TTL` | duration | no | `86400000` | How long an email-verification link remains redeemable. Required by authentication-and-access.md AC11, which mandates a defined expiry for any recovery link or code but prescribes no value. |
| `IDENTITY_LOGIN_LOCKOUT_DURATION` | duration | no | `900000` | How long authentication is refused for an account that reached the failed-attempt threshold. Expires on its own so that lockout never requires operator intervention to clear, which client-signup-and-tenancy.md requires of every recovery path. |
| `IDENTITY_LOGIN_MAX_FAILED_ATTEMPTS` | integer | no | `10` | Consecutive failed authentication attempts against one account before further attempts are locked out rather than evaluated. Required by authentication-and-access.md AC12. Counted on the account row so the count survives a restart — an in-memory counter would let routine redeploys reset an attacker’s budget. |
| `IDENTITY_MIN_PASSWORD_LENGTH` | integer | no | `12` | Minimum accepted length for a client or operator password. The credential-strength standard client-signup-and-tenancy.md requires but leaves undefined. There are no composition rules by design — see credentials.ts for why length plus a blocklist beats "one uppercase and one digit". |
| `IDENTITY_PASSWORD_RESET_TTL` | duration | no | `3600000` | How long a password-reset link remains redeemable. Deliberately much shorter than the verification link: a reset link grants account takeover in one click and can be requested by anyone who knows the address. |
| `IDENTITY_SESSION_ABSOLUTE_LIFETIME` | duration | no | `604800000` | Maximum total life of a session regardless of activity. Caps how long a stolen token remains usable, which an inactivity timeout alone cannot do because activity refreshes it. Required by authentication-and-access.md AC6. |
| `IDENTITY_SESSION_INACTIVITY_TIMEOUT` | duration | no | `43200000` | How long a client or operator session survives without use. Measured from the last request the session made, and refreshed on each one. Required by authentication-and-access.md AC5, which mandates an inactivity bound but leaves the value to implementation. |

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

# How long an email-verification link remains redeemable. Required by authentication-and-access.md AC11, which mandates a defined expiry for any recovery link or code but prescribes no value.
# default: 86400000
IDENTITY_EMAIL_VERIFICATION_TTL=86400000

# How long authentication is refused for an account that reached the failed-attempt threshold. Expires on its own so that lockout never requires operator intervention to clear, which client-signup-and-tenancy.md requires of every recovery path.
# default: 900000
IDENTITY_LOGIN_LOCKOUT_DURATION=900000

# Consecutive failed authentication attempts against one account before further attempts are locked out rather than evaluated. Required by authentication-and-access.md AC12. Counted on the account row so the count survives a restart — an in-memory counter would let routine redeploys reset an attacker’s budget.
# default: 10
IDENTITY_LOGIN_MAX_FAILED_ATTEMPTS=10

# Minimum accepted length for a client or operator password. The credential-strength standard client-signup-and-tenancy.md requires but leaves undefined. There are no composition rules by design — see credentials.ts for why length plus a blocklist beats "one uppercase and one digit".
# default: 12
IDENTITY_MIN_PASSWORD_LENGTH=12

# How long a password-reset link remains redeemable. Deliberately much shorter than the verification link: a reset link grants account takeover in one click and can be requested by anyone who knows the address.
# default: 3600000
IDENTITY_PASSWORD_RESET_TTL=3600000

# Maximum total life of a session regardless of activity. Caps how long a stolen token remains usable, which an inactivity timeout alone cannot do because activity refreshes it. Required by authentication-and-access.md AC6.
# default: 604800000
IDENTITY_SESSION_ABSOLUTE_LIFETIME=604800000

# How long a client or operator session survives without use. Measured from the last request the session made, and refreshed on each one. Required by authentication-and-access.md AC5, which mandates an inactivity bound but leaves the value to implementation.
# default: 43200000
IDENTITY_SESSION_INACTIVITY_TIMEOUT=43200000

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
