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

## Outbound mail

Carries the email-verification and password-reset links that client-signup-and-tenancy.md and authentication-and-access.md require. Any SMTP server: a container on a laptop, a relay on a VPS, a provider in a managed cloud — one adapter reached through different values, for the same reason object storage has one S3 adapter. MAIL_TLS is stated rather than inferred from the port, because "465 means implicit and 587 means STARTTLS" is environment detection wearing a disguise; and there is deliberately no opportunistic mode, because a silent fallback to cleartext is a downgrade nothing observes until the credentials are already on the wire.

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `MAIL_ALLOW_INSECURE_AUTH` | boolean | no | `false` | Permit authentication over an unencrypted connection. False by default because AUTH PLAIN over cleartext puts the password on the wire in base64, which is encoding rather than encryption. True is correct only when the server is reached over a trusted local network. |
| `MAIL_CA_CERTIFICATE` | string | no | `` | PEM certificate authority bundle, for a server whose certificate is not signed by a public root. Empty means use the system trust store. This, rather than a switch that turns verification off, is how a self-signed relay is trusted. |
| `MAIL_COMMAND_TIMEOUT` | duration | no | `30000` | How long to wait for any single reply from the mail server. Bounds how long one wedged delivery can occupy a caller, including a server that accepts the connection and then stalls. |
| `MAIL_CONNECT_TIMEOUT` | duration | no | `10000` | How long to wait for a TCP connection to the mail server to be established. |
| `MAIL_EHLO_NAME` | string | no | `localhost` | Name this client announces in EHLO. Many providers reject a sender that does not present a resolvable name, so a real deployment should set this to a hostname that resolves to it. Not derived from the host's own name, because that would make behaviour differ between tiers without appearing in this list. |
| `MAIL_FROM_ADDRESS` | string | yes | — | Address every platform message is sent from, used both as the SMTP envelope sender and in the From header. Its domain also forms the right-hand side of each Message-ID. |
| `MAIL_FROM_NAME` | string | no | `` | Display name shown beside the from address. Empty sends the bare address, which is valid and is what a deployment without a chosen brand name should do. |
| `MAIL_HOST` | string | yes | — | Hostname or address of the SMTP server. A container name on a single host, or a provider relay in a managed cloud. |
| `MAIL_MAX_ATTEMPTS` | integer | no | `4` | How many times a transient mail failure is retried before it is surfaced. Only failures classified as retryable are retried, and a failure after the message body has been committed is never retried, because its outcome is unknown and a retry would deliver a second copy. |
| `MAIL_PASSWORD` | string | no | `<secret>` | Password paired with the username. Ignored when MAIL_USERNAME is empty. **(secret)** |
| `MAIL_PORT` | integer | no | `587` | TCP port of the SMTP server. 587 for submission with STARTTLS, 465 for implicit TLS, 25 for a local relay. Setting it does not change how TLS is reached — MAIL_TLS does. |
| `MAIL_TLS` | enum(disable\|starttls\|implicit) | no | `starttls` | How TLS is reached: "starttls" upgrades an established cleartext connection and fails if the server does not offer it, "implicit" speaks TLS from the first byte, "disable" does not encrypt at all and is appropriate only over a trusted local network such as a container network on a single host. There is deliberately no opportunistic mode — a silent fallback to cleartext is a downgrade nothing observes. |
| `MAIL_USERNAME` | string | no | `` | Account to authenticate as. Empty means do not authenticate, which is correct for a local relay that accepts mail from its own host and for nothing else. |

## Secret sealing

The keys that encrypt every stored credential the platform must be able to use, above all each tenant's WhatsApp access token. credential-and-secret-handling.md AC4 requires that reading the stored data alone be insufficient to use a credential, so the keys are supplied here and held nowhere the database is — a dump, a replica, or a backup is then useless on its own. A list rather than one key is what makes rotation a configuration change (AC8, AC9) instead of a flag day: values sealed under a retired id keep unsealing for as long as that id is still listed. A managed cloud KMS would satisfy AC4 too, but it exists on only one of the three tiers environment-portability.md names, and cost-efficient-operation.md rules out an always-on service besides.

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `VAULT_ACTIVE_SEALING_KEY` | string | no | `` | Which of VAULT_SEALING_KEYS seals new and re-sealed values, by key id. Empty means the first entry. Rotation is: append the new key, set this to its id, restart — nothing is re-encrypted eagerly and nothing becomes unreadable. |
| `VAULT_SEALING_KEYS` | string | yes | — | Comma-separated list of the keys that encrypt every stored credential the platform must be able to *use* — a tenant's WhatsApp access token above all. Each entry is "<key id>:<32 bytes, base64>". Generate one with `node -e "import('@zeddev/secrets').then(m => console.log(m.generateSealingKey('k1')))"`. More than one entry is how a key is rotated: values sealed under an older id keep unsealing for as long as that id is still listed. Without this the database alone would be enough to use every tenant's number (credential-and-secret-handling.md AC4). **(secret)** |

## AI provider

The model that writes every bot reply, reads images, and transcribes voice notes. ai-provider-portability.md requires swapping it — and reverting the swap — be a configuration change, so these keys are the whole mechanism: one platform-wide selection, applied to every tenant at once, with no per-provider tenant state to migrate. The base URL is always stated rather than defaulted, so a deployment can point the same adapter at a vendor, a gateway, or a local model server without a code change. AI_CAPABILITIES records what the chosen model can do; a message needing anything else is answered with the fallback message the client wrote rather than sent to a model that cannot handle it.

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `AI_API_KEY` | string | no | `<secret>` | Credential for the provider. Empty sends none, which is correct for a local model server and for nothing reachable over the internet. **(secret)** |
| `AI_BASE_URL` | url | yes | — | API root the adapter appends its paths to — the Gemini "v1beta" root, or the "/v1" root of an OpenAI-compatible server. Always stated, never defaulted, so the deployment names its upstream in configuration rather than in code. |
| `AI_CAPABILITIES` | string | no | `text,vision,audio` | Comma-separated list of what the configured model can do: text, vision (understand images), audio (transcribe voice notes). "text" is required. A message needing a capability not listed here is answered with the client's fallback message instead of being sent to a model that cannot handle it. |
| `AI_MAX_ATTEMPTS` | integer | no | `3` | Attempts per reply before the failure is surfaced and fallback applies. Only transient failures (rate limits, timeouts, 5xx) are retried; a rejected credential, a missing model, or a withheld reply is not, because a second attempt would only spend quota. |
| `AI_MODEL` | string | yes | — | Model that generates replies, exactly as the provider names it. |
| `AI_PROVIDER` | enum(gemini\|openai_compatible) | no | `gemini` | Which adapter speaks to the model: "gemini" for the Gemini generateContent API, "openai_compatible" for any server exposing /chat/completions (OpenAI, Groq, OpenRouter, or a local Ollama or llama.cpp server). Applies to every tenant at once. Changing it back reverts the swap; no tenant configuration is stored per provider, so nothing needs re-entering. |
| `AI_REQUEST_TIMEOUT` | duration | no | `60000` | How long one request to the provider may take, including reading the response. A request that exceeds it counts as a transient failure and is retried within AI_MAX_ATTEMPTS. |
| `AI_TRANSCRIPTION_MODEL` | string | no | `` | Model that transcribes voice notes, when it is not AI_MODEL. Required for "openai_compatible" when AI_CAPABILITIES includes audio, because those servers transcribe with a dedicated speech model (e.g. whisper-large-v3) rather than the chat model. Empty means AI_MODEL. |

## WhatsApp

The platform's one Meta app, which every client's number is authorized to. Platform-wide rather than per tenant: a client's own access token is a tenant secret and never an environment value. The app secret is what proves an inbound notification came from Meta (message-delivery-reliability.md AC2), and without it anyone who found the webhook URL could inject messages into any tenant's conversations. The app id is needed as well as the secret because connecting a number subscribes the client's WhatsApp Business Account to this app by id, and the connection flow checks that subscription. WHATSAPP_API_BASE_URL is stated rather than defaulted for the reason AI_BASE_URL is: an embedded vendor URL pins the deployment to one upstream and to one API version, so a version bump would stop being a configuration change.

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `WHATSAPP_API_BASE_URL` | url | yes | — | Versioned Graph API root the adapter appends its paths to, including the version segment. Always stated, never defaulted: an embedded vendor URL pins the deployment to one upstream and to one API version, so it could be pointed at neither a sandbox nor a recorded stub without a code change, and a version bump would stop being a configuration change. |
| `WHATSAPP_APP_ID` | string | yes | — | The Meta app's numeric id. A client's WhatsApp Business Account has to be subscribed to this app before Meta will deliver its messages here, and the connection flow both performs that subscription and checks it — which is why the id has to be known, not just the secret. |
| `WHATSAPP_APP_SECRET` | string | yes | — | The Meta app's secret. Every inbound webhook notification carries an HMAC-SHA256 of its body keyed with it (X-Hub-Signature-256), and a notification whose signature does not verify is refused and recorded rather than processed — message-delivery-reliability.md AC2. Without it anyone who finds the webhook URL could inject messages into any tenant's conversations. **(secret)** |
| `WHATSAPP_REQUEST_TIMEOUT` | duration | no | `15000` | How long one Graph API call may take, including reading the response. Exceeding it counts as a transient failure: a timeout is no evidence about the credentials, so it must never move a working connection to error. |
| `WHATSAPP_VERIFICATION_TTL` | duration | no | `900000` | How long a client has to reply with the connection code before the attempt is abandoned and the connection reports verification_failed. Long enough to find the phone, short enough that a code seen over someone’s shoulder is not useful later. |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | string | yes | — | A value you choose and enter in the Meta app dashboard when subscribing the webhook. Meta echoes it once in a GET handshake to prove the subscription request came from the dashboard you control; the gateway answers the handshake only when it matches. **(secret)** |

## Logging

Read by every service. Verbosity is the only thing that varies; what a record may contain does not, because redaction is an allowlist of field names enforced at the logger boundary and applies at every level.

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `LOG_LEVEL` | enum(debug\|info\|warn\|error) | no | `info` | Least severe log level written. Records are newline-delimited JSON on standard output. Changing it changes how many records are written, never which fields they may carry — redaction is enforced at every level. |

## API service

The client and operator HTTP API. API_PUBLIC_BASE_URL and API_TRUSTED_PROXY_HOPS are the two values most likely to differ between a laptop, a VPS, and a managed cloud, and both are stated rather than inferred from the request: a link built from a caller-supplied Host header lets the caller choose where a password-reset link points, and trusting X-Forwarded-For without knowing how many proxies wrote it lets a caller forge the source address the login throttle counts by.

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `API_ANONYMOUS_RATE_LIMIT` | integer | no | `30` | Unauthenticated requests one source may make to the credential and recovery endpoints (signup, login, verification, password reset) per API_ANONYMOUS_RATE_WINDOW. The per-source half of the login throttle authentication-and-access.md AC12 requires; the per-account half is IDENTITY_LOGIN_MAX_FAILED_ATTEMPTS. Counted per process, so N instances admit up to N times this. |
| `API_ANONYMOUS_RATE_WINDOW` | duration | no | `600000` | Window over which API_ANONYMOUS_RATE_LIMIT is counted. |
| `API_HTTP_HOST` | string | no | `0.0.0.0` | Address the HTTP listener binds to. The default listens on every interface, which is what a container needs; set it to a loopback address to keep a process on a shared host reachable only through a local reverse proxy. |
| `API_HTTP_PORT` | integer | no | `8080` | TCP port the HTTP listener binds to. 0 asks the operating system for any free port, which is only useful to a test harness. |
| `API_MAX_BODY_BYTES` | integer | no | `16384` | Largest request body accepted, in bytes. Every request this service takes is a small JSON document, and the bound is what stops a caller making the password hasher chew on megabytes. |
| `API_PREVIEW_RATE_LIMIT` | integer | no | `20` | Reply previews one client business may run per API_PREVIEW_RATE_WINDOW. Each preview is a real call to the AI provider, and the provider's free-tier quota is shared by every tenant's live conversations, so one client previewing in a loop must not be able to spend the quota other businesses' customers are answered from. Counted per process, so N instances admit up to N times this. |
| `API_PREVIEW_RATE_WINDOW` | duration | no | `600000` | Window over which API_PREVIEW_RATE_LIMIT is counted. |
| `API_PUBLIC_BASE_URL` | url | yes | — | Public URL at which clients reach the platform, with the dashboard and the API served from one origin. Verification and password-reset links are built from it; an https URL marks session cookies Secure; and its origin is the only Origin a state-changing request is accepted from. Never derived from the request, because a link built from a caller-supplied Host header lets the caller choose where a password-reset link points. |
| `API_REQUEST_TIMEOUT` | duration | no | `30000` | How long one request may take to arrive in full and be answered before the connection is dropped. Bounds how long a slow client can hold a connection open. |
| `API_SHUTDOWN_GRACE` | duration | no | `10000` | On a stop signal, how long in-flight requests and queued outbound mail are given to finish before connections are closed. Should be shorter than the orchestrator's own kill timeout, or the process is killed mid-drain. |
| `API_TRUSTED_PROXY_HOPS` | integer | no | `0` | Number of reverse proxies in front of this service whose X-Forwarded-For entries are trusted. 0 means the TCP peer is the client. Too high lets a caller forge their own source address and escape the per-source throttle; too low makes every client share the proxy's address and one noisy client throttles them all. |

## WhatsApp gateway service

The inbound webhook Meta delivers every message to, deployed apart from the API so that acknowledging a notification never waits on anything else the platform is doing — a slow acknowledgement makes Meta redeliver (message-delivery-reliability.md AC1). Meta only calls public HTTPS URLs, so on a laptop or VPS a TLS-terminating proxy or tunnel forwards to GATEWAY_HTTP_PORT; that forwarding is deployment plumbing, not a code path, so it is the same artifact on every tier.

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `GATEWAY_HTTP_HOST` | string | no | `0.0.0.0` | Address the webhook listener binds to. The default listens on every interface, which is what a container needs. |
| `GATEWAY_HTTP_PORT` | integer | no | `8081` | TCP port the webhook listener binds to. Meta must reach it over public HTTPS, so on a VPS or laptop a TLS-terminating reverse proxy or tunnel forwards to it; the URL Meta is given is that proxy's, followed by /v1/whatsapp/webhook. 0 asks the operating system for any free port, which is only useful to a test harness. |
| `GATEWAY_MAX_BODY_BYTES` | integer | no | `262144` | Largest webhook notification accepted, in bytes. Notifications carry message text and media references, never media itself, so they are small; the bound stops a caller making the gateway hash and buffer megabytes before the signature check refuses them. |
| `GATEWAY_REQUEST_TIMEOUT` | duration | no | `10000` | How long one notification may take to arrive in full and be acknowledged before the connection is dropped. Meta treats a slow acknowledgement as a failure and redelivers, so this bounds a slow client, not the gateway: acknowledging is a signature check and one short transaction. |
| `GATEWAY_SHUTDOWN_GRACE` | duration | no | `10000` | On a stop signal, how long in-flight notifications are given to be stored and acknowledged before connections are closed. One cut short is not lost: it was never acknowledged, so Meta redelivers it, and duplicate suppression makes the redelivery safe. |

## Conversation worker service

Turns stored inbound messages into answers: it groups an end-customer's rapid messages into one turn, puts the turn and the conversation before it to the AI provider, and records exactly one answer per turn. It listens on no port — its only input is the job queue in PostgreSQL — so more capacity is more worker processes, with nothing to route. The aggregation window and maximum turn duration are message-burst-aggregation.md's platform-wide timing, a trade between letting a customer finish a thought and answering quickly; the in-flight cap is what stops one business's surge from delaying every other's (message-delivery-reliability.md AC16).

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `WORKER_AGGREGATION_WINDOW` | duration | no | `5000` | How long the worker waits after an end-customer's latest message for another before answering them. Messages arriving within it of each other are one turn and get one reply (message-burst-aggregation.md). Longer lets a customer finish a thought split across messages; shorter answers sooner. Every reply waits at least this long. |
| `WORKER_CONCURRENCY` | integer | no | `4` | Jobs this process runs at once. Most of a job is waiting on the AI provider, so this can exceed the CPU count; the database pool must have room for it plus one connection held for queue notifications. |
| `WORKER_MAX_IN_FLIGHT_PER_TENANT` | integer | no | `2` | How many of one tenant's jobs may run at once across every worker. Keeps one business's traffic surge, or a provider hang on its requests, from occupying every worker while other businesses' customers wait (message-delivery-reliability.md AC16). Set it below WORKER_CONCURRENCY times the number of worker processes. |
| `WORKER_MAX_TURN_DURATION` | duration | no | `30000` | The longest one turn stays open after its first message, however quickly more keep arriving, so a customer who never pauses is still answered. Must be at least WORKER_AGGREGATION_WINDOW. |
| `WORKER_SHUTDOWN_GRACE` | duration | no | `30000` | On a stop signal, how long in-flight jobs are given to finish before the process exits. One cut short is not lost: its lease expires and it runs again, and a turn is answered at most once however many times its job runs. |
| `WORKER_VISIBILITY_TIMEOUT` | duration | no | `60000` | How long a claimed job is held before another worker may take it over. The worker renews it while a job runs, so this bounds how long the job of a worker that died stays stuck, not how long a slow AI call may take. |

## Scheduler service

The platform's timer-driven work: recovering interrupted WhatsApp connections, and deleting finished jobs so the queue table does not grow forever. whatsapp-number-connection.md requires recovery be attempted automatically and be bounded, and leaves the bound to implementation, so the bound is here. It needs a tenant's WhatsApp token to try the connection, which is why it requires the sealing keys and the WhatsApp keys. It listens on no port and nothing waits on it: while it is down that work simply waits, and running two is safe, so it is the same artifact and the same values on every tier.

| Variable | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `SCHEDULER_JOB_PURGE_INTERVAL` | duration | no | `3600000` | How often finished jobs past SCHEDULER_JOB_RETENTION are deleted from the job queue. |
| `SCHEDULER_JOB_RETENTION` | duration | no | `604800000` | How long a job that succeeded is kept before deletion. Its enqueue deduplication ends with it, so this must comfortably exceed how long Meta may keep redelivering a webhook. Longer costs database space and shorter gains little: a job holds routing metadata only, its payload having gone when it finished. Jobs that exhausted their retries are never deleted by this; they are the record of a failure. |
| `SCHEDULER_RECONNECT_BASE_DELAY` | duration | no | `60000` | The wait after the first failed recovery attempt, doubling after each failure up to SCHEDULER_RECONNECT_MAX_DELAY. Half of each wait is randomised, so tenants interrupted together do not retry together. Keep it longer than an attempt can take (a few WHATSAPP_REQUEST_TIMEOUTs), or a second scheduler instance may start one while the last is still out. |
| `SCHEDULER_RECONNECT_INTERVAL` | duration | no | `60000` | How often the scheduler looks for interrupted WhatsApp connections that are due another recovery attempt. This is one indexed query, and it is the longest an interrupted connection waits for its first attempt. |
| `SCHEDULER_RECONNECT_MAX_ATTEMPTS` | integer | no | `12` | How many recovery attempts may fail for a recoverable reason before the connection falls to error, which switches the client's bot off until they reconnect the number (whatsapp-number-connection.md AC6). With the default delays, twelve attempts span roughly three hours, enough to ride out an ordinary Meta incident. A failure Meta says retrying cannot fix, such as a revoked token, goes to error immediately regardless. |
| `SCHEDULER_RECONNECT_MAX_DELAY` | duration | no | `1800000` | The longest wait between recovery attempts. Must be at least SCHEDULER_RECONNECT_BASE_DELAY. |
| `SCHEDULER_SHUTDOWN_GRACE` | duration | no | `30000` | On a stop signal, how long in-flight work is given to finish before the process exits. Nothing cut short is lost: a recovery attempt that never reported back has spent none of the allowance and simply runs again. |

## Template

```sh
# Credential for the provider. Empty sends none, which is correct for a local model server and for nothing reachable over the internet.
AI_API_KEY=

# API root the adapter appends its paths to — the Gemini "v1beta" root, or the "/v1" root of an OpenAI-compatible server. Always stated, never defaulted, so the deployment names its upstream in configuration rather than in code.
AI_BASE_URL=https://example.com/v1

# Comma-separated list of what the configured model can do: text, vision (understand images), audio (transcribe voice notes). "text" is required. A message needing a capability not listed here is answered with the client's fallback message instead of being sent to a model that cannot handle it.
# default: text,vision,audio
AI_CAPABILITIES=text,vision,audio

# Attempts per reply before the failure is surfaced and fallback applies. Only transient failures (rate limits, timeouts, 5xx) are retried; a rejected credential, a missing model, or a withheld reply is not, because a second attempt would only spend quota.
# default: 3
AI_MAX_ATTEMPTS=3

# Model that generates replies, exactly as the provider names it.
AI_MODEL=gemini-2.5-flash

# Which adapter speaks to the model: "gemini" for the Gemini generateContent API, "openai_compatible" for any server exposing /chat/completions (OpenAI, Groq, OpenRouter, or a local Ollama or llama.cpp server). Applies to every tenant at once. Changing it back reverts the swap; no tenant configuration is stored per provider, so nothing needs re-entering.
# one of: gemini, openai_compatible
# default: gemini
AI_PROVIDER=gemini

# How long one request to the provider may take, including reading the response. A request that exceeds it counts as a transient failure and is retried within AI_MAX_ATTEMPTS.
# default: 60000
AI_REQUEST_TIMEOUT=60000

# Model that transcribes voice notes, when it is not AI_MODEL. Required for "openai_compatible" when AI_CAPABILITIES includes audio, because those servers transcribe with a dedicated speech model (e.g. whisper-large-v3) rather than the chat model. Empty means AI_MODEL.
# default: 
AI_TRANSCRIPTION_MODEL=

# Unauthenticated requests one source may make to the credential and recovery endpoints (signup, login, verification, password reset) per API_ANONYMOUS_RATE_WINDOW. The per-source half of the login throttle authentication-and-access.md AC12 requires; the per-account half is IDENTITY_LOGIN_MAX_FAILED_ATTEMPTS. Counted per process, so N instances admit up to N times this.
# default: 30
API_ANONYMOUS_RATE_LIMIT=30

# Window over which API_ANONYMOUS_RATE_LIMIT is counted.
# default: 600000
API_ANONYMOUS_RATE_WINDOW=600000

# Address the HTTP listener binds to. The default listens on every interface, which is what a container needs; set it to a loopback address to keep a process on a shared host reachable only through a local reverse proxy.
# default: 0.0.0.0
API_HTTP_HOST=0.0.0.0

# TCP port the HTTP listener binds to. 0 asks the operating system for any free port, which is only useful to a test harness.
# default: 8080
API_HTTP_PORT=8080

# Largest request body accepted, in bytes. Every request this service takes is a small JSON document, and the bound is what stops a caller making the password hasher chew on megabytes.
# default: 16384
API_MAX_BODY_BYTES=16384

# Reply previews one client business may run per API_PREVIEW_RATE_WINDOW. Each preview is a real call to the AI provider, and the provider's free-tier quota is shared by every tenant's live conversations, so one client previewing in a loop must not be able to spend the quota other businesses' customers are answered from. Counted per process, so N instances admit up to N times this.
# default: 20
API_PREVIEW_RATE_LIMIT=20

# Window over which API_PREVIEW_RATE_LIMIT is counted.
# default: 600000
API_PREVIEW_RATE_WINDOW=600000

# Public URL at which clients reach the platform, with the dashboard and the API served from one origin. Verification and password-reset links are built from it; an https URL marks session cookies Secure; and its origin is the only Origin a state-changing request is accepted from. Never derived from the request, because a link built from a caller-supplied Host header lets the caller choose where a password-reset link points.
API_PUBLIC_BASE_URL=https://example.com

# How long one request may take to arrive in full and be answered before the connection is dropped. Bounds how long a slow client can hold a connection open.
# default: 30000
API_REQUEST_TIMEOUT=30000

# On a stop signal, how long in-flight requests and queued outbound mail are given to finish before connections are closed. Should be shorter than the orchestrator's own kill timeout, or the process is killed mid-drain.
# default: 10000
API_SHUTDOWN_GRACE=10000

# Number of reverse proxies in front of this service whose X-Forwarded-For entries are trusted. 0 means the TCP peer is the client. Too high lets a caller forge their own source address and escape the per-source throttle; too low makes every client share the proxy's address and one noisy client throttles them all.
# default: 0
API_TRUSTED_PROXY_HOPS=0

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

# Address the webhook listener binds to. The default listens on every interface, which is what a container needs.
# default: 0.0.0.0
GATEWAY_HTTP_HOST=0.0.0.0

# TCP port the webhook listener binds to. Meta must reach it over public HTTPS, so on a VPS or laptop a TLS-terminating reverse proxy or tunnel forwards to it; the URL Meta is given is that proxy's, followed by /v1/whatsapp/webhook. 0 asks the operating system for any free port, which is only useful to a test harness.
# default: 8081
GATEWAY_HTTP_PORT=8081

# Largest webhook notification accepted, in bytes. Notifications carry message text and media references, never media itself, so they are small; the bound stops a caller making the gateway hash and buffer megabytes before the signature check refuses them.
# default: 262144
GATEWAY_MAX_BODY_BYTES=262144

# How long one notification may take to arrive in full and be acknowledged before the connection is dropped. Meta treats a slow acknowledgement as a failure and redelivers, so this bounds a slow client, not the gateway: acknowledging is a signature check and one short transaction.
# default: 10000
GATEWAY_REQUEST_TIMEOUT=10000

# On a stop signal, how long in-flight notifications are given to be stored and acknowledged before connections are closed. One cut short is not lost: it was never acknowledged, so Meta redelivers it, and duplicate suppression makes the redelivery safe.
# default: 10000
GATEWAY_SHUTDOWN_GRACE=10000

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

# Least severe log level written. Records are newline-delimited JSON on standard output. Changing it changes how many records are written, never which fields they may carry — redaction is enforced at every level.
# one of: debug, info, warn, error
# default: info
LOG_LEVEL=info

# Permit authentication over an unencrypted connection. False by default because AUTH PLAIN over cleartext puts the password on the wire in base64, which is encoding rather than encryption. True is correct only when the server is reached over a trusted local network.
# default: false
MAIL_ALLOW_INSECURE_AUTH=false

# PEM certificate authority bundle, for a server whose certificate is not signed by a public root. Empty means use the system trust store. This, rather than a switch that turns verification off, is how a self-signed relay is trusted.
# default: 
MAIL_CA_CERTIFICATE=

# How long to wait for any single reply from the mail server. Bounds how long one wedged delivery can occupy a caller, including a server that accepts the connection and then stalls.
# default: 30000
MAIL_COMMAND_TIMEOUT=30000

# How long to wait for a TCP connection to the mail server to be established.
# default: 10000
MAIL_CONNECT_TIMEOUT=10000

# Name this client announces in EHLO. Many providers reject a sender that does not present a resolvable name, so a real deployment should set this to a hostname that resolves to it. Not derived from the host's own name, because that would make behaviour differ between tiers without appearing in this list.
# default: localhost
MAIL_EHLO_NAME=localhost

# Address every platform message is sent from, used both as the SMTP envelope sender and in the From header. Its domain also forms the right-hand side of each Message-ID.
MAIL_FROM_ADDRESS=no-reply@example.com

# Display name shown beside the from address. Empty sends the bare address, which is valid and is what a deployment without a chosen brand name should do.
# default: 
MAIL_FROM_NAME=

# Hostname or address of the SMTP server. A container name on a single host, or a provider relay in a managed cloud.
MAIL_HOST=mail

# How many times a transient mail failure is retried before it is surfaced. Only failures classified as retryable are retried, and a failure after the message body has been committed is never retried, because its outcome is unknown and a retry would deliver a second copy.
# default: 4
MAIL_MAX_ATTEMPTS=4

# Password paired with the username. Ignored when MAIL_USERNAME is empty.
MAIL_PASSWORD=

# TCP port of the SMTP server. 587 for submission with STARTTLS, 465 for implicit TLS, 25 for a local relay. Setting it does not change how TLS is reached — MAIL_TLS does.
# default: 587
MAIL_PORT=587

# How TLS is reached: "starttls" upgrades an established cleartext connection and fails if the server does not offer it, "implicit" speaks TLS from the first byte, "disable" does not encrypt at all and is appropriate only over a trusted local network such as a container network on a single host. There is deliberately no opportunistic mode — a silent fallback to cleartext is a downgrade nothing observes.
# one of: disable, starttls, implicit
# default: starttls
MAIL_TLS=starttls

# Account to authenticate as. Empty means do not authenticate, which is correct for a local relay that accepts mail from its own host and for nothing else.
# default: 
MAIL_USERNAME=

# How often finished jobs past SCHEDULER_JOB_RETENTION are deleted from the job queue.
# default: 3600000
SCHEDULER_JOB_PURGE_INTERVAL=3600000

# How long a job that succeeded is kept before deletion. Its enqueue deduplication ends with it, so this must comfortably exceed how long Meta may keep redelivering a webhook. Longer costs database space and shorter gains little: a job holds routing metadata only, its payload having gone when it finished. Jobs that exhausted their retries are never deleted by this; they are the record of a failure.
# default: 604800000
SCHEDULER_JOB_RETENTION=604800000

# The wait after the first failed recovery attempt, doubling after each failure up to SCHEDULER_RECONNECT_MAX_DELAY. Half of each wait is randomised, so tenants interrupted together do not retry together. Keep it longer than an attempt can take (a few WHATSAPP_REQUEST_TIMEOUTs), or a second scheduler instance may start one while the last is still out.
# default: 60000
SCHEDULER_RECONNECT_BASE_DELAY=60000

# How often the scheduler looks for interrupted WhatsApp connections that are due another recovery attempt. This is one indexed query, and it is the longest an interrupted connection waits for its first attempt.
# default: 60000
SCHEDULER_RECONNECT_INTERVAL=60000

# How many recovery attempts may fail for a recoverable reason before the connection falls to error, which switches the client's bot off until they reconnect the number (whatsapp-number-connection.md AC6). With the default delays, twelve attempts span roughly three hours, enough to ride out an ordinary Meta incident. A failure Meta says retrying cannot fix, such as a revoked token, goes to error immediately regardless.
# default: 12
SCHEDULER_RECONNECT_MAX_ATTEMPTS=12

# The longest wait between recovery attempts. Must be at least SCHEDULER_RECONNECT_BASE_DELAY.
# default: 1800000
SCHEDULER_RECONNECT_MAX_DELAY=1800000

# On a stop signal, how long in-flight work is given to finish before the process exits. Nothing cut short is lost: a recovery attempt that never reported back has spent none of the allowance and simply runs again.
# default: 30000
SCHEDULER_SHUTDOWN_GRACE=30000

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

# Which of VAULT_SEALING_KEYS seals new and re-sealed values, by key id. Empty means the first entry. Rotation is: append the new key, set this to its id, restart — nothing is re-encrypted eagerly and nothing becomes unreadable.
# default: 
VAULT_ACTIVE_SEALING_KEY=

# Comma-separated list of the keys that encrypt every stored credential the platform must be able to *use* — a tenant's WhatsApp access token above all. Each entry is "<key id>:<32 bytes, base64>". Generate one with `node -e "import('@zeddev/secrets').then(m => console.log(m.generateSealingKey('k1')))"`. More than one entry is how a key is rotated: values sealed under an older id keep unsealing for as long as that id is still listed. Without this the database alone would be enough to use every tenant's number (credential-and-secret-handling.md AC4).
VAULT_SEALING_KEYS=k1:REPLACE_WITH_32_RANDOM_BYTES_BASE64

# Versioned Graph API root the adapter appends its paths to, including the version segment. Always stated, never defaulted: an embedded vendor URL pins the deployment to one upstream and to one API version, so it could be pointed at neither a sandbox nor a recorded stub without a code change, and a version bump would stop being a configuration change.
WHATSAPP_API_BASE_URL=https://example.com/v21.0

# The Meta app's numeric id. A client's WhatsApp Business Account has to be subscribed to this app before Meta will deliver its messages here, and the connection flow both performs that subscription and checks it — which is why the id has to be known, not just the secret.
WHATSAPP_APP_ID=3090001111

# The Meta app's secret. Every inbound webhook notification carries an HMAC-SHA256 of its body keyed with it (X-Hub-Signature-256), and a notification whose signature does not verify is refused and recorded rather than processed — message-delivery-reliability.md AC2. Without it anyone who finds the webhook URL could inject messages into any tenant's conversations.
WHATSAPP_APP_SECRET=

# How long one Graph API call may take, including reading the response. Exceeding it counts as a transient failure: a timeout is no evidence about the credentials, so it must never move a working connection to error.
# default: 15000
WHATSAPP_REQUEST_TIMEOUT=15000

# How long a client has to reply with the connection code before the attempt is abandoned and the connection reports verification_failed. Long enough to find the phone, short enough that a code seen over someone’s shoulder is not useful later.
# default: 900000
WHATSAPP_VERIFICATION_TTL=900000

# A value you choose and enter in the Meta app dashboard when subscribing the webhook. Meta echoes it once in a GET handshake to prove the subscription request came from the dashboard you control; the gateway answers the handshake only when it matches.
WHATSAPP_WEBHOOK_VERIFY_TOKEN=

# How long the worker waits after an end-customer's latest message for another before answering them. Messages arriving within it of each other are one turn and get one reply (message-burst-aggregation.md). Longer lets a customer finish a thought split across messages; shorter answers sooner. Every reply waits at least this long.
# default: 5000
WORKER_AGGREGATION_WINDOW=5000

# Jobs this process runs at once. Most of a job is waiting on the AI provider, so this can exceed the CPU count; the database pool must have room for it plus one connection held for queue notifications.
# default: 4
WORKER_CONCURRENCY=4

# How many of one tenant's jobs may run at once across every worker. Keeps one business's traffic surge, or a provider hang on its requests, from occupying every worker while other businesses' customers wait (message-delivery-reliability.md AC16). Set it below WORKER_CONCURRENCY times the number of worker processes.
# default: 2
WORKER_MAX_IN_FLIGHT_PER_TENANT=2

# The longest one turn stays open after its first message, however quickly more keep arriving, so a customer who never pauses is still answered. Must be at least WORKER_AGGREGATION_WINDOW.
# default: 30000
WORKER_MAX_TURN_DURATION=30000

# On a stop signal, how long in-flight jobs are given to finish before the process exits. One cut short is not lost: its lease expires and it runs again, and a turn is answered at most once however many times its job runs.
# default: 30000
WORKER_SHUTDOWN_GRACE=30000

# How long a claimed job is held before another worker may take it over. The worker renews it while a job runs, so this bounds how long the job of a worker that died stays stuck, not how long a slow AI call may take.
# default: 60000
WORKER_VISIBILITY_TIMEOUT=60000
```
