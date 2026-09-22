# Graph Report - zeddev  (2026-09-22)

## Corpus Check
- 275 files · ~324,861 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2586 nodes · 7449 edges · 131 communities (119 shown, 12 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 52 edges (avg confidence: 0.75)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `e8903f4c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- WhatsApp Cloud API Client
- WhatsApp Number Onboarding & Connection Setup
- Domain Error Types & Config Test
- API Service Dependencies
- Bot Reply Generation & Prompt Assembly
- Bot Config Tests & Test Database Utilities
- Config Schema & Duration Parsing
- AI Provider Response Decoding
- Mailer & API Cookie/Session Handling
- Tenant Object Storage (Memory & S3)
- Conversation Worker Dependencies
- Bot Admin API Handlers
- Diagnostics, Preflight Checks & Logging
- PostgreSQL Wire Protocol Messages
- Deployment Package Dependencies
- Architecture Decisions & Specs Index
- AI Provider Conformance Harness
- Conversation/Tenant Scoping & WhatsApp State
- WhatsApp Inbound Message Recording
- Product Specs Overview
- Postgres Connection & Pool Internals
- Mail Test Fixtures & Mailpit Integration
- WhatsApp Cloud Conformance & Test Stubs
- AI Config & Media Type Normalization
- Bot Behavior Rules Engine
- Postgres Config, Errors & Pool Types
- Secrets Sealing & Config Errors
- Docker Compose Stack & Package Manifests
- Spec Coverage Tooling
- Tenant Secret Vault Store
- WhatsApp Gateway Dependencies
- SMTP Mail Delivery & Retry
- Root Package Scripts & Workspace Config
- Bot Handoff Settings
- HTTP Server Primitives & Gateway App
- AI Provider Adapters & Registry
- Bot Knowledge Base Entries
- Service Startup & Config Loading
- Identity Service (Signup/Login/Reset)
- SMTP Session Protocol
- S3 Storage Test Fixtures & Transport
- S3 Object Store & SigV4 Types
- Outbound Delivery Scheduling & Retry
- Retry Attempt Policy & AI Errors
- AI Provider Test Stub Server
- Bot Activation Readiness
- Conversation Turn & Handoff Status
- Bot Fallback Messages Config
- Job Queue Types
- Conversation Turn Test Utilities
- DB Package Dependencies
- Identity Access Principals & Authorization
- Storage Package Dependencies
- Identity Credential Hashing & Sessions
- Mail Config & Loading
- SMTP Message Building (RFC Compliance)
- Base TypeScript Compiler Config
- Mail Package Dependencies
- Queue Package Dependencies
- S3 Wire Protocol Error Parsing
- AGENTS.md Package Index & Manifests
- Backoff & Clock Abstractions
- Persona Formality & Text Parsing
- Bot Package Dependencies
- AWS SigV4 Request Signing
- API App Integration Tests
- SCRAM-SHA-256 Postgres Authentication
- AI Package Dependencies
- Conversation Package Dependencies
- Job Queue Consumer Loop
- In-Memory Object Store Tests
- Logging Package Dependencies
- In-Memory Job Queue
- Postgres-Backed Job Queue
- Scripted WhatsApp Cloud Backend (Test Double)
- Conversation Worker Job Handlers
- Schema Migrations Runner
- Identity Credential Validation Rules
- Queue Conformance Test Harness
- Conversation Context Rendering
- Conversation Turn Admission & Locking
- Postgres Value Codec
- Identity Package Dependencies
- Tenant Test Fixtures
- Config Package Dependencies
- Schema Package Dependencies
- In-Memory Job Board & Fake Clock
- WhatsApp Package Dependencies
- Conversation Worker Config & Startup
- Identity Token Minting
- Tenant-Scoped Object Store Wrapper
- Tenancy Package Dependencies
- Identity Package Manifest
- Log Sinks & CLI Startup Options
- Bot Disclosure Setting Types
- Identity Session Principals
- Mail Socket Connection
- Time Package Dependencies
- Errors Package Dependencies
- HTTP Package Dependencies
- Vault Package Dependencies
- Root TypeScript Project Config
- Postgres Wire Writer
- In-Memory Mailer Test Double
- Storage Test Fixture Interface
- Build Loop Tool-Output Formatter
- Local Service Readiness Check Script
- AI Package tsconfig
- Bot Package tsconfig
- Config Package tsconfig
- Conversation Package tsconfig
- DB Package tsconfig
- Deployment Package tsconfig
- Errors Package tsconfig
- HTTP Package tsconfig
- Identity Package tsconfig
- Logging Package tsconfig
- Mail Package tsconfig
- Queue Package tsconfig
- Schema Package tsconfig
- Storage Package tsconfig
- Tenancy Package tsconfig
- Testing Package tsconfig
- Time Package tsconfig
- Vault Package tsconfig
- WhatsApp Package tsconfig
- API Service tsconfig
- Conversation Worker tsconfig
- WhatsApp Gateway tsconfig
- Local DB Script (db.sh)
- Local Mail Script (mail.sh)

## God Nodes (most connected - your core abstractions)
1. `createApi()` - 74 edges
2. `Connection` - 68 edges
3. `withTenant()` - 66 edges
4. `Pool` - 62 edges
5. `unitTest()` - 60 edges
6. `withIdentityScope()` - 57 edges
7. `ValidationError` - 55 edges
8. `specTest()` - 55 edges
9. `Secret` - 51 edges
10. `Logger` - 50 edges

## Surprising Connections (you probably didn't know these)
- `Decision: cloudFailureDeterminacy for retry-without-duplication` --rationale_for--> `cloudFailureDeterminacy()`  [EXTRACTED]
  IMPLEMENTATION_PLAN.md → src/lib/whatsapp/cloud.ts
- `PROMPT_build.md Step 0a (consult graph first)` --semantically_similar_to--> `PROMPT_plan.md Step 0a (consult graph first)`  [INFERRED] [semantically similar]
  PROMPT_build.md → PROMPT_plan.md
- `PROMPT_build.md Step 1 (graph-narrowed implementation search)` --semantically_similar_to--> `PROMPT_plan.md Step 1 (graph-based gap analysis)`  [INFERRED] [semantically similar]
  PROMPT_build.md → PROMPT_plan.md
- `Implementation Plan` --references--> `Configuration Reference`  [EXTRACTED]
  IMPLEMENTATION_PLAN.md → docs/configuration.md
- `Decision: Log redaction as an allowlist` --rationale_for--> `Credential and Secret Handling Spec`  [INFERRED]
  IMPLEMENTATION_PLAN.md → specs/credential-and-secret-handling.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Graph-First Consult Before Raw-File Read** — agents_md_graph_section, prompt_build_md_step_0a, prompt_plan_md_step_0a [INFERRED 0.85]
- **Automatic Graph Freshness (Hook + Targeted Update)** — agents_md_post_commit_hook, agents_md_graphify_update_workflow, agents_md_ast_only_vs_semantic_update [EXTRACTED 1.00]
- **Graph-Narrowed Candidates Before Subagent Dispatch** — prompt_build_md_step_1, prompt_plan_md_step_1, agents_md_graphify_query [INFERRED 0.80]
- **Bot Reply Prompt Directive Composition** — src_lib_bot_reply_replyinstructions, src_lib_bot_persona_personadirectives, src_lib_bot_behavior_behaviordirectives, src_lib_bot_disclosure_disclosuredirectives, src_lib_bot_handoff_handoffdirectives, src_lib_bot_knowledge_knowledgedirectives [EXTRACTED 0.95]
- **Hand-Written Protocol Adapters (Avoid Dependency Cost)** — src_lib_db_package, src_lib_storage_package, src_lib_mail_package [INFERRED 0.85]
- **Specs That Delegate to Fallback Response Behavior** — specs_fallback_response_behavior_fallback_response_behavior, specs_text_conversation_handling_text_conversation_handling, specs_image_message_understanding_image_message_understanding, specs_voice_message_understanding_voice_message_understanding, specs_human_handoff_human_handoff, specs_message_burst_aggregation_message_burst_aggregation, specs_message_delivery_reliability_message_delivery_reliability, specs_language_configuration_language_configuration [INFERRED 0.85]
- **Specs Consuming the WhatsApp Connection State Vocabulary** — specs_whatsapp_number_connection_state_vocabulary, specs_whatsapp_number_connection_whatsapp_number_connection, specs_operator_health_monitoring_operator_health_monitoring, specs_operator_proactive_alerting_operator_proactive_alerting, specs_message_delivery_reliability_message_delivery_reliability [EXTRACTED 1.00]
- **Specs Applying Tenant Data Isolation As a Cross-Cutting Constraint** — specs_tenant_data_isolation_tenant_data_isolation, specs_message_burst_aggregation_message_burst_aggregation, specs_message_delivery_reliability_message_delivery_reliability, specs_image_message_understanding_image_message_understanding, specs_language_configuration_language_configuration, specs_persona_and_tone_configuration_persona_and_tone_configuration, specs_environment_portability_environment_portability, specs_human_handoff_human_handoff [INFERRED 0.85]

## Communities (131 total, 12 thin omitted)

### Community 0 - "WhatsApp Cloud API Client"
Cohesion: 0.15
Nodes (26): NotificationHandler, PendingOperation, QueryResult, SslMode, BackendNotification, bindMessage(), describeMessage(), executeMessage() (+18 more)

### Community 1 - "WhatsApp Number Onboarding & Connection Setup"
Cohesion: 0.10
Nodes (52): businessVerificationBlocked(), cloudFailureReason(), META_ID, WHATSAPP_ADDRESS, ConnectionErrorReason, ConnectionStatus, readConnection(), readPhoneNumber() (+44 more)

### Community 2 - "Domain Error Types & Config Test"
Cohesion: 0.12
Nodes (35): configure(), connect(), liveTenant(), newTenant(), readyTenant(), create(), nextReplyDirectives(), replyConfiguration() (+27 more)

### Community 3 - "API Service Dependencies"
Cohesion: 0.20
Nodes (26): Decision: Readiness defined once in SQL with triggers, Decision: Round-robin tenant-fair queue dispatch, Decision: Log redaction as an allowlist, Decision: Migrations are forward-only, Decision: Node 24 native TypeScript type stripping, no build step, Decision: Tagged first-line reply output protocol, Decision: Ports-and-adapters for every external dependency, Decision: Tenant isolation enforced in the database via row-level security (+18 more)

### Community 4 - "Bot Reply Generation & Prompt Assembly"
Cohesion: 0.10
Nodes (18): inspectIsolationCapability(), AiGenerationError, AiRequestRejectedError, AuthorizationError, ConfigurationError, ConnectionRevokedError, DuplicateError, ERROR_KINDS (+10 more)

### Community 5 - "Bot Config Tests & Test Database Utilities"
Cohesion: 0.13
Nodes (37): fromRow(), readActivationHistory(), readBotStatus(), setBotActive(), clearBehaviorInstructions(), createBehaviorRule(), deleteBehaviorRule(), describeBehaviorRule() (+29 more)

### Community 6 - "Config Schema & Duration Parsing"
Cohesion: 0.29
Nodes (11): StoredEntry, sha256Hex(), assertContentType(), assertWithinSizeLimit(), kindPrefix(), newObjectId(), ObjectKind, ObjectMetadata (+3 more)

### Community 7 - "AI Provider Response Decoding"
Cohesion: 0.10
Nodes (31): DATABASE_CONFIG_SCHEMA, ConnectionOptions, SSL_MODES, DatabaseConfig, AppliedMigration, appliedMigrations(), checksum(), loadMigrations() (+23 more)

### Community 8 - "Mailer & API Cookie/Session Handling"
Cohesion: 0.07
Nodes (47): BehaviorConfiguration, behaviorDirectives(), BehaviorRule, enabledBehaviorRules(), ruleDirective(), DisclosureMode, handoffDirectives(), HandoffPolicy (+39 more)

### Community 9 - "Tenant Object Storage (Memory & S3)"
Cohesion: 0.11
Nodes (18): MailFixture, api(), DecodedMail, decodeEncodedWords(), decodeMail(), envValue(), MailpitSummary, mailTestConfigured() (+10 more)

### Community 10 - "Conversation Worker Dependencies"
Cohesion: 0.07
Nodes (23): issuesOf(), issuesOf(), issuesOf(), issuesOf(), issuesOf(), issuesOf(), Diagnostic, JsonLinesSink (+15 more)

### Community 11 - "Bot Admin API Handlers"
Cohesion: 0.11
Nodes (21): bySpec, coverageFile, entries, specs, uncovered, workDir, COMPLETE_ENV, REFERENCE_PATH (+13 more)

### Community 12 - "Diagnostics, Preflight Checks & Logging"
Cohesion: 0.05
Nodes (36): dependencies, @zeddev/ai, @zeddev/config, @zeddev/conversation, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue (+28 more)

### Community 13 - "PostgreSQL Wire Protocol Messages"
Cohesion: 0.09
Nodes (30): ErrorContext, assertCloudCredentials(), BusinessAccountProfile, classifyCloudFailure(), CLOUD_ERROR_CODES, CLOUD_RECOVERABLE_REASONS, CloudCredentials, CloudDescriptor (+22 more)

### Community 14 - "Deployment Package Dependencies"
Cohesion: 0.17
Nodes (26): AI_CONFIG_SCHEMA, AiConfig, loadAiConfig(), loadAiSettings(), AI_PROVIDERS, audioMediaType(), baseMediaType(), imageMediaType() (+18 more)

### Community 15 - "Architecture Decisions & Specs Index"
Cohesion: 0.08
Nodes (44): ACTIVATION_CAUSES, ActivationCause, ActivationEvent, BotStatus, describeBotStatus(), listBotStatuses(), mayAutoRespond(), NEVER_EVALUATED (+36 more)

### Community 16 - "AI Provider Conformance Harness"
Cohesion: 0.25
Nodes (12): loadMailConfig(), loadSmtpSettings(), MAIL_CONFIG_SCHEMA, MailConfig, RFC-5322, mintMessageId(), MAIL_TLS_MODES, MailMessage (+4 more)

### Community 17 - "Conversation/Tenant Scoping & WhatsApp State"
Cohesion: 0.07
Nodes (31): AuthenticationError, ConflictError, HttpError, readBody(), SECURITY_HEADERS, Api, ApiDependencies, CLIENT_COOKIE_PATH (+23 more)

### Community 18 - "WhatsApp Inbound Message Recording"
Cohesion: 0.13
Nodes (31): Configuration-Driven Behavior (No Environment Branching), Environment Portability, Fallback Message Precedence Order, Fallback Response Behavior, Fixed, Non-Generated Fallback Text, Per-Conversation Handoff Pause Scope, Handoff Trigger Conditions, Human Handoff (+23 more)

### Community 19 - "Product Specs Overview"
Cohesion: 0.28
Nodes (16): loadAll(), createPool(), loadDatabaseConfig(), assertTenantIsolationEnforceable(), loadIdentityPolicy(), IdentityServiceOptions, migrateToLatest(), loadGraphCloudSettings() (+8 more)

### Community 20 - "Postgres Connection & Pool Internals"
Cohesion: 0.10
Nodes (15): AdapterCore, AdapterDependencies, DEFAULT_AI_BACKOFF, AttemptOutcome, AttemptPolicy, parseRetryAfter(), readErrorBody(), answer() (+7 more)

### Community 21 - "Mail Test Fixtures & Mailpit Integration"
Cohesion: 0.10
Nodes (22): AiFixture, AiFixtureOptions, AiHarness, ALL, JPEG, OGG, PNG, rejection() (+14 more)

### Community 22 - "WhatsApp Cloud Conformance & Test Stubs"
Cohesion: 0.11
Nodes (38): base64(), asRecord(), AttemptTimedOut, contentFiltered(), emptyResponse(), Failure, malformedResponse(), MAX_ERROR_BODY_BYTES (+30 more)

### Community 23 - "AI Config & Media Type Normalization"
Cohesion: 0.07
Nodes (27): devDependencies, @types/node, typescript, engines, node, name, private, scripts (+19 more)

### Community 24 - "Bot Behavior Rules Engine"
Cohesion: 0.17
Nodes (24): createKnowledgeEntry(), deleteKnowledgeEntry(), describeKnowledgeStatus(), entryContent(), entryId(), entryNotFound(), EntryRow, fromRow() (+16 more)

### Community 25 - "Postgres Config, Errors & Pool Types"
Cohesion: 0.19
Nodes (18): secretRef(), SecretSealer, deleteTenantSecret(), describe(), describeTenantSecret(), putTenantSecret(), readTenantSecret(), recordSecretAccess() (+10 more)

### Community 26 - "Secrets Sealing & Config Errors"
Cohesion: 0.15
Nodes (13): HarnessOptions, StorageFixture, StorageHarness, createTestBucket(), envValue(), SKIP_REASON, storageTestConfigured(), TestBucket (+5 more)

### Community 27 - "Docker Compose Stack & Package Manifests"
Cohesion: 0.07
Nodes (35): withInboundScope(), arrayOf(), assignPhoneNumber(), attributeInboundNumber(), fromRow(), INBOUND_JOB_KIND, INBOUND_MESSAGE_TYPES, INBOUND_REJECTION_REASONS (+27 more)

### Community 28 - "Spec Coverage Tooling"
Cohesion: 0.16
Nodes (20): Config, loadConfig(), loadWhatsAppConfig(), WHATSAPP_CONFIG_SCHEMA, WhatsAppConfig, createGateway(), digest(), Gateway (+12 more)

### Community 29 - "Tenant Secret Vault Store"
Cohesion: 0.05
Nodes (77): newTenant(), newTenant(), newTenant(), newTenant(), newTenant(), newTenant(), newTenant(), withIdentityScope() (+69 more)

### Community 30 - "WhatsApp Gateway Dependencies"
Cohesion: 0.13
Nodes (24): BASE, memoryHarness, MINIMAL_ENV, ADDRESS_FORBIDDEN, assertEnvelopeAddress(), assertHeaderText(), base64Body(), buildMessage() (+16 more)

### Community 31 - "SMTP Mail Delivery & Retry"
Cohesion: 0.16
Nodes (13): STORAGE_CONFIG_SCHEMA, AgentOptions, createTransport(), RequestFn, send(), Transport, TransportRequest, ADDRESSING_STYLES (+5 more)

### Community 32 - "Root Package Scripts & Workspace Config"
Cohesion: 0.08
Nodes (29): Decision: cloudFailureDeterminacy for retry-without-duplication, cloudFailureDeterminacy(), CloudFixture, CloudHarness, runWhatsAppCloudConformance(), scriptedToken(), AccountState, ANSWER_LOST (+21 more)

### Community 33 - "Bot Handoff Settings"
Cohesion: 0.15
Nodes (4): rowCountFromTag(), Connection, toPostgresFailure(), splitMessages()

### Community 34 - "HTTP Server Primitives & Gateway App"
Cohesion: 0.09
Nodes (19): readDelivery(), CONVERSATION_LIMITS, INBOUND_DISPOSITIONS, at(), BoardFailure, cloudBackend, connectionOf(), deliveryOf() (+11 more)

### Community 35 - "AI Provider Adapters & Registry"
Cohesion: 0.36
Nodes (9): ARRAY_ELEMENT, arrayLiteral(), decodeValue(), encodeParam(), normalizeTimestampText(), OID, parseArrayText(), scalarText() (+1 more)

### Community 36 - "Bot Knowledge Base Entries"
Cohesion: 0.11
Nodes (17): generateSealingKey(), hashCredential(), parseSealingKey(), scrypt, SCRYPT_DEFAULTS, SealingKey, Secret, SECRET_CLASSES (+9 more)

### Community 37 - "Service Startup & Config Loading"
Cohesion: 0.21
Nodes (13): target, ConfigSchema, renderEnvTemplate(), renderReference(), combinedSchema(), configKeys(), ConfigSection, PLATFORM_CONFIG_SCHEMAS (+5 more)

### Community 38 - "Identity Service (Signup/Login/Reset)"
Cohesion: 0.16
Nodes (13): RFC-5802, RFC-7677, hmac(), md5Password(), parseServerFinal(), parseServerFirst(), pbkdf2, SCRAM_SHA_256 (+5 more)

### Community 39 - "SMTP Session Protocol"
Cohesion: 0.11
Nodes (30): claimDelivery(), DELIVERY_FAILURES, DELIVERY_JOB_KIND, DELIVERY_LIMITS, DELIVERY_PRINCIPAL, DELIVERY_STATES, DeliveryAttemptOutcome, DeliveryClaim (+22 more)

### Community 40 - "S3 Storage Test Fixtures & Transport"
Cohesion: 0.15
Nodes (22): ACTION_DIRECTIVES, BEHAVIOR_LIMITS, CONDITION_BY_KIND, definition(), enabledFlag(), parseBehaviorInstructionsInput(), parseIdInput(), parseRuleCreateInput() (+14 more)

### Community 41 - "S3 Object Store & SigV4 Types"
Cohesion: 0.18
Nodes (18): liveTenant(), CONNECTION_ERROR_REASONS, CONNECTION_STATES, CONNECTION_TRANSITIONS, connectionHistory(), ConnectionRow, ConnectionState, ConnectionTransition (+10 more)

### Community 42 - "Outbound Delivery Scheduling & Retry"
Cohesion: 0.12
Nodes (16): compose.yaml (Docker Compose Stack), postgres Compose service, Configuration Reference, devDependencies, @zeddev/schema, @zeddev/testing, exports, ./testing (+8 more)

### Community 43 - "Retry Attempt Policy & AI Errors"
Cohesion: 0.11
Nodes (19): dependencies, @zeddev/ai, @zeddev/bot, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue, @zeddev/secrets (+11 more)

### Community 44 - "AI Provider Test Stub Server"
Cohesion: 0.13
Nodes (13): MailHarness, createTestMailbox(), SmtpMailerOptions, create(), HAPPY, instantClock, MESSAGE, ScriptedServer (+5 more)

### Community 45 - "Bot Activation Readiness"
Cohesion: 0.11
Nodes (18): CLIENT_SESSION_COOKIE, OPERATOR_SESSION_COOKIE, Answer, apiWith(), call(), cookieValue(), FAST_SCRYPT, gatewayMoves() (+10 more)

### Community 46 - "Conversation Turn & Handoff Status"
Cohesion: 0.10
Nodes (20): es2023, node, compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, exactOptionalPropertyTypes, isolatedModules, lib (+12 more)

### Community 47 - "Bot Fallback Messages Config"
Cohesion: 0.12
Nodes (22): conditionList(), enabledFlag(), fromRow(), HANDOFF_FIELDS, HANDOFF_LIMITS, HANDOFF_TRIGGER_DESCRIPTIONS, HANDOFF_TRIGGERS, HandoffDecision (+14 more)

### Community 48 - "Job Queue Types"
Cohesion: 0.10
Nodes (16): RFC-821, BuiltMessage, dataTerminator(), dotStuff(), asConfigurationError(), assertCommandSafe(), AttemptState, Phase (+8 more)

### Community 49 - "Conversation Turn Test Utilities"
Cohesion: 0.25
Nodes (9): InMemoryTenantObjectStore, parseDate(), S3TenantObjectStore, assertObjectId(), assertObjectKind(), assertOwnedBy(), objectKey(), ObjectRef (+1 more)

### Community 50 - "DB Package Dependencies"
Cohesion: 0.10
Nodes (20): dependencies, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/time, devDependencies, @zeddev/schema, @zeddev/testing (+12 more)

### Community 51 - "Identity Access Principals & Authorization"
Cohesion: 0.09
Nodes (22): dependencies, @zeddev/config, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time, devDependencies (+14 more)

### Community 52 - "Storage Package Dependencies"
Cohesion: 0.06
Nodes (33): dependencies, @zeddev/ai, @zeddev/api, @zeddev/config, @zeddev/conversation-worker, @zeddev/db, @zeddev/identity, @zeddev/logging (+25 more)

### Community 53 - "Identity Credential Hashing & Sessions"
Cohesion: 0.18
Nodes (23): amzDate(), canonicalHeaders, canonicalQuery(), canonicalRequest(), canonicalUri(), credentialScope(), EMPTY_PAYLOAD_SHA256, hmac() (+15 more)

### Community 54 - "Mail Config & Loading"
Cohesion: 0.19
Nodes (14): NotFoundError, CREDENTIAL_CODES, decodeEntities(), elementBlocks(), elementText(), ENTITIES, FailureContext, ListedKey (+6 more)

### Community 55 - "SMTP Message Building (RFC Compliance)"
Cohesion: 0.17
Nodes (18): SCRIPTED_FAILURE_STATUS, AiStub, BASE_PATHS, decodeOpenAiContent(), firstText(), geminiError(), handleGemini(), handleOpenAi() (+10 more)

### Community 56 - "Base TypeScript Compiler Config"
Cohesion: 0.20
Nodes (15): BaseSpec, BooleanSpec, ConfigSpec, ConfigValueType, DURATION_UNITS, DurationSpec, EnumSpec, FALSE_VALUES (+7 more)

### Community 57 - "Mail Package Dependencies"
Cohesion: 0.22
Nodes (4): MemorySink, envFor(), FAST_SCRYPT, REQUIRED_KEYS

### Community 58 - "Queue Package Dependencies"
Cohesion: 0.12
Nodes (8): ConsumerOptions, JobHandler, runConsumer(), sleepQuietly(), waitForSomething(), drain(), waitUntil(), Queue

### Community 59 - "S3 Wire Protocol Error Parsing"
Cohesion: 0.07
Nodes (28): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/http, @zeddev/logging, @zeddev/queue, @zeddev/schema (+20 more)

### Community 60 - "AGENTS.md Package Index & Manifests"
Cohesion: 0.05
Nodes (42): dependencies, @zeddev/ai, @zeddev/bot, @zeddev/config, @zeddev/conversation, @zeddev/db, @zeddev/errors, @zeddev/http (+34 more)

### Community 61 - "Backoff & Clock Abstractions"
Cohesion: 0.22
Nodes (8): devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type, version

### Community 62 - "Persona Formality & Text Parsing"
Cohesion: 0.14
Nodes (13): dependencies, @zeddev/db, @zeddev/logging, devDependencies, @zeddev/testing, exports, @zeddev/db, @zeddev/logging (+5 more)

### Community 64 - "AWS SigV4 Request Signing"
Cohesion: 0.28
Nodes (12): DEFAULT_BACKOFF, StoredJob, ClaimRow, PostgresQueueOptions, assertQueueName(), ClaimOptions, digestKey(), FailOptions (+4 more)

### Community 66 - "SCRAM-SHA-256 Postgres Authentication"
Cohesion: 0.20
Nodes (5): TransportResponse, S3ObjectStore, parseObjectKey(), tenantPrefix(), normalizeTenantId()

### Community 67 - "AI Package Dependencies"
Cohesion: 0.08
Nodes (3): InMemoryObjectStore, ObjectStore, TenantObjectStore

### Community 68 - "Conversation Package Dependencies"
Cohesion: 0.08
Nodes (25): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time (+17 more)

### Community 69 - "Job Queue Consumer Loop"
Cohesion: 0.23
Nodes (9): HarnessQueueOptions, PAYLOAD, QueueFixture, QueueHarness, runQueueConformance(), memoryHarness, TENANTS, create() (+1 more)

### Community 70 - "In-Memory Object Store Tests"
Cohesion: 0.21
Nodes (15): AST-only code updates vs. semantic doc updates, GRAPH_REPORT.md, Graph Section (AGENTS.md), graphify explain, graphify-out/graph.json, graphify query, /graphify --update (targeted semantic refresh), graphify hook install (post-commit hook) (+7 more)

### Community 71 - "Logging Package Dependencies"
Cohesion: 0.14
Nodes (13): dependencies, @zeddev/errors, @zeddev/secrets, devDependencies, @zeddev/testing, exports, @zeddev/errors, @zeddev/secrets (+5 more)

### Community 72 - "In-Memory Job Queue"
Cohesion: 0.22
Nodes (21): admitLocked(), admitPendingMessages(), assertPolicy(), closeTurn(), ConversationRow, handoffStatus(), insertOutcome(), lockConversation() (+13 more)

### Community 73 - "Postgres-Backed Job Queue"
Cohesion: 0.22
Nodes (3): withDispatchScope(), toDiagnostic(), PostgresQueue

### Community 74 - "Scripted WhatsApp Cloud Backend (Test Double)"
Cohesion: 0.20
Nodes (9): devDependencies, @zeddev/testing, exports, ./testing, @zeddev/testing, name, private, type (+1 more)

### Community 75 - "Conversation Worker Job Handlers"
Cohesion: 0.09
Nodes (22): dependencies, @zeddev/config, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time, devDependencies (+14 more)

### Community 76 - "Schema Migrations Runner"
Cohesion: 0.10
Nodes (19): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/secrets, devDependencies, @zeddev/schema, @zeddev/testing (+11 more)

### Community 77 - "Identity Credential Validation Rules"
Cohesion: 0.20
Nodes (13): DISCLOSURE_FIELDS, DISCLOSURE_MODES, disclosureModeFor(), DisclosureRow, DisclosureSetting, DisclosureSource, fromRow(), NEVER_CHOSEN (+5 more)

### Community 78 - "Queue Conformance Test Harness"
Cohesion: 0.17
Nodes (11): devDependencies, @zeddev/schema, @zeddev/testing, exports, @zeddev/schema, @zeddev/testing, name, private (+3 more)

### Community 79 - "Conversation Context Rendering"
Cohesion: 0.23
Nodes (13): AggregationPolicy, JobBoard, TURN_JOB_KIND, TurnScheduler, conversationHandlers(), ConversationWorkerDependencies, handleDelivery(), handleInbound() (+5 more)

### Community 80 - "Conversation Turn Admission & Locking"
Cohesion: 0.15
Nodes (13): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/secrets, @zeddev/time, @zeddev/vault, @zeddev/config (+5 more)

### Community 81 - "Postgres Value Codec"
Cohesion: 0.17
Nodes (11): dependencies, @zeddev/errors, devDependencies, @zeddev/testing, exports, @zeddev/errors, @zeddev/testing, name (+3 more)

### Community 82 - "Identity Package Dependencies"
Cohesion: 0.18
Nodes (11): dependencies, @zeddev/config, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/time, @zeddev/config, @zeddev/errors (+3 more)

### Community 83 - "Tenant Test Fixtures"
Cohesion: 0.11
Nodes (17): dependencies, @zeddev/config, @zeddev/errors, @zeddev/secrets, @zeddev/time, devDependencies, @zeddev/testing, exports (+9 more)

### Community 84 - "Config Package Dependencies"
Cohesion: 0.22
Nodes (8): devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type, version

### Community 85 - "Schema Package Dependencies"
Cohesion: 0.24
Nodes (12): ContextTurn, renderConversation(), RenderedConversation, renderMessage(), text(), TurnMessage, unsupportedNote(), ContextRow (+4 more)

### Community 87 - "WhatsApp Package Dependencies"
Cohesion: 0.39
Nodes (7): CONFIGURATION_CLASSES, FailureContext, mapPostgresFailure(), PostgresFailure, RETRYABLE_CLASSES, RETRYABLE_CODES, VALIDATION_CODES

### Community 89 - "Identity Token Minting"
Cohesion: 0.14
Nodes (11): InMemoryAiProviderOptions, LoggerOptions, InMemoryQueueOptions, InMemoryObjectStoreOptions, Backoff, exponentialBackoff(), ExponentialBackoffOptions, Clock (+3 more)

### Community 91 - "Tenancy Package Dependencies"
Cohesion: 0.05
Nodes (37): dependencies, @zeddev/config, @zeddev/errors, @zeddev/secrets, @zeddev/time, devDependencies, @zeddev/testing, exports (+29 more)

### Community 93 - "Log Sinks & CLI Startup Options"
Cohesion: 0.60
Nodes (5): Decision: Hand-written PostgreSQL client, Decision: Hand-written SigV4 signer and HTTP client, Decision: PostgreSQL as the single persistent store, Decision: node:test and npm workspaces, zero test/build dependencies, Cost-Efficient Operation Spec

### Community 94 - "Bot Disclosure Setting Types"
Cohesion: 0.43
Nodes (3): BoardJob, EnqueueRequest, EnqueueResult

### Community 95 - "Identity Session Principals"
Cohesion: 0.20
Nodes (9): dependencies, devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type (+1 more)

### Community 96 - "Mail Socket Connection"
Cohesion: 0.40
Nodes (4): memoryHarness, TENANTS, formatObjectRef(), parseObjectRef()

### Community 97 - "Time Package Dependencies"
Cohesion: 0.27
Nodes (9): RawEnv, LogSink, INBOUND_QUEUE, loadWorkerSettings(), WORKER_CONFIG_SCHEMA, WorkerConfig, WorkerSettings, RunningWorker (+1 more)

### Community 98 - "Errors Package Dependencies"
Cohesion: 0.25
Nodes (7): **/node_modules/**, scripts/**/*.ts, src/**/*.ts, exclude, extends, include, ./tsconfig.base.json

### Community 99 - "HTTP Package Dependencies"
Cohesion: 0.29
Nodes (6): dependencies, exports, name, private, type, version

### Community 100 - "Vault Package Dependencies"
Cohesion: 0.38
Nodes (5): scan(), sourceFiles(), SRC_DIR, stripComment(), Violation

### Community 101 - "Root TypeScript Project Config"
Cohesion: 0.33
Nodes (3): colors, readline, rl

### Community 102 - "Postgres Wire Writer"
Cohesion: 0.40
Nodes (4): ENV_FILE, missing, Service, SERVICES

### Community 103 - "In-Memory Mailer Test Double"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 104 - "Storage Test Fixture Interface"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 105 - "Build Loop Tool-Output Formatter"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 106 - "Local Service Readiness Check Script"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 107 - "AI Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 108 - "Bot Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 109 - "Config Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 110 - "Conversation Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 111 - "DB Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 112 - "Deployment Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 113 - "Errors Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 114 - "HTTP Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 115 - "Identity Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 116 - "Logging Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 117 - "Mail Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 118 - "Queue Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 119 - "Schema Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 120 - "Storage Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 121 - "Tenancy Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 122 - "Testing Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 123 - "Time Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

### Community 124 - "Vault Package tsconfig"
Cohesion: 0.40
Nodes (4): extends, include, **/*.ts, ../../../tsconfig.base.json

## Knowledge Gaps
- **542 isolated node(s):** `10-application-role.sh script`, `loop.sh script`, `name`, `private`, `type` (+537 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Implementation Plan` connect `API Service Dependencies` to `Root Package Scripts & Workspace Config`, `Outbound Delivery Scheduling & Retry`, `Log Sinks & CLI Startup Options`, `Queue Conformance Test Harness`?**
  _High betweenness centrality (0.110) - this node is a cross-community bridge._
- **Why does `cloudFailureDeterminacy()` connect `Root Package Scripts & Workspace Config` to `WhatsApp Number Onboarding & Connection Setup`, `Bot Reply Generation & Prompt Assembly`, `PostgreSQL Wire Protocol Messages`, `SMTP Session Protocol`?**
  _High betweenness centrality (0.108) - this node is a cross-community bridge._
- **Why does `Decision: cloudFailureDeterminacy for retry-without-duplication` connect `Root Package Scripts & Workspace Config` to `API Service Dependencies`?**
  _High betweenness centrality (0.107) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `createApi()` (e.g. with `.error()` and `route()`) actually correct?**
  _`createApi()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `10-application-role.sh script`, `loop.sh script`, `name` to the rest of the system?**
  _542 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `WhatsApp Number Onboarding & Connection Setup` be split into smaller, more focused modules?**
  _Cohesion score 0.10324675324675325 - nodes in this community are weakly interconnected._
- **Should `Domain Error Types & Config Test` be split into smaller, more focused modules?**
  _Cohesion score 0.11616161616161616 - nodes in this community are weakly interconnected._