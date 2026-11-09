# Graph Report - zeddev  (2026-11-09)

## Corpus Check
- 303 files · ~371,447 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2900 nodes · 7955 edges · 147 communities (131 shown, 16 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 47 edges (avg confidence: 0.72)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `7f507838`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Connection
- onboarding.test.ts
- db/testing.ts
- Implementation Plan
- errors/index.ts
- persona.ts
- storage/memory.ts
- db/index.ts
- reply.ts
- mail/fixtures.ts
- logging/index.ts
- testing/index.ts
- Diagnostics, Preflight Checks & Logging
- graph.ts
- ai/index.ts
- bot/index.ts
- mail/index.ts
- api/app.ts
- WhatsApp Inbound Message Recording
- api/start.ts
- health.ts
- ai/memory.ts
- gemini.ts
- AI Config & Media Type Normalization
- knowledge.test.ts
- secrets/index.ts
- s3.test.ts
- whatsapp/index.ts
- whatsapp-gateway/app.ts
- metrics.ts
- message.ts
- transcript.ts
- whatsapp/memory.ts
- recovery.test.ts
- turns.test.ts
- dependencies
- scheduler/start.ts
- config/index.ts
- health.test.ts
- delivery.ts
- behavior.ts
- withIdentityScope
- conversation/package.json
- dependencies
- smtp.ts
- transcript.test.ts
- Conversation Turn & Handoff Status
- handoff.ts
- SmtpMailer
- InMemoryAiProvider
- DB Package Dependencies
- Identity Access Principals & Authorization
- dependencies
- s3.ts
- s3wire.ts
- ai/stubs.ts
- conversation-worker/start.ts
- identity/index.ts
- api/app.test.ts
- S3 Wire Protocol Error Parsing
- dependencies
- Backoff & Clock Abstractions
- Persona Formality & Text Parsing
- Pool
- queue/index.ts
- monitoring/package.json
- storage/index.test.ts
- InMemoryObjectStore
- identity/package.json
- ValidationError
- In-Memory Object Store Tests
- Logging Package Dependencies
- turns.ts
- whatsapp/package.json
- mail/package.json
- Conversation Worker Job Handlers
- Schema Migrations Runner
- smtp.test.ts
- Queue
- worker.ts
- dependencies
- Postgres Value Codec
- Identity Package Dependencies
- Tenant Test Fixtures
- Config Package Dependencies
- inbound.test.ts
- PostgresQueue
- monitoring/tsconfig.json
- Mailer
- time/index.ts
- InMemoryQueue
- Tenancy Package Dependencies
- Identity Package Manifest
- Cost-Efficient Operation Spec
- ScriptedCloudBackend
- Identity Session Principals
- queue/index.test.ts
- api/package.json
- Errors Package Dependencies
- HTTP Package Dependencies
- deployment/package.json
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
- ai/config.test.ts
- conversation/index.ts
- deployment/index.ts
- scheduler/start.test.ts
- LogSink
- @zeddev/ai
- cloud.ts
- Clock
- @zeddev/identity
- @zeddev/mail
- TenantObjectStore
- @zeddev/logging
- activation.test.ts
- @zeddev/monitoring
- MailOutbox
- FixedWindowRateLimiter

## God Nodes (most connected - your core abstractions)
1. `unitTest()` - 67 edges
2. `specTest()` - 61 edges
3. `ValidationError` - 60 edges
4. `Connection` - 57 edges
5. `Logger` - 55 edges
6. `Pool` - 53 edges
7. `Secret` - 53 edges
8. `Clock` - 51 edges
9. `withIdentityScope()` - 49 edges
10. `withTenant()` - 43 edges

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

## Communities (147 total, 16 thin omitted)

### Community 0 - "Connection"
Cohesion: 0.05
Nodes (53): RFC-5802, RFC-7677, ARRAY_ELEMENT, arrayLiteral(), decodeValue(), encodeParam(), normalizeTimestampText(), OID (+45 more)

### Community 1 - "onboarding.test.ts"
Cohesion: 0.09
Nodes (46): deleteTenantSecret(), readTenantSecret(), recordSecretAccess(), requireTenantSecret(), readConnection(), assignPhoneNumber(), abandonVerification(), beginVerification() (+38 more)

### Community 2 - "db/testing.ts"
Cohesion: 0.13
Nodes (15): newTenant(), replyPersona(), adminOptions(), createTestDatabase(), envValue(), maintenanceDatabase(), onAdmin(), SKIP_REASON (+7 more)

### Community 3 - "Implementation Plan"
Cohesion: 0.20
Nodes (26): Decision: Readiness defined once in SQL with triggers, Decision: Round-robin tenant-fair queue dispatch, Decision: Log redaction as an allowlist, Decision: Migrations are forward-only, Decision: Node 24 native TypeScript type stripping, no build step, Decision: Tagged first-line reply output protocol, Decision: Ports-and-adapters for every external dependency, Decision: Tenant isolation enforced in the database via row-level security (+18 more)

### Community 4 - "errors/index.ts"
Cohesion: 0.08
Nodes (27): CONFIGURATION_CLASSES, FailureContext, mapPostgresFailure(), PostgresFailure, RETRYABLE_CLASSES, RETRYABLE_CODES, VALIDATION_CODES, AiGenerationError (+19 more)

### Community 5 - "persona.ts"
Cohesion: 0.15
Nodes (21): clearFreeformInstructions(), describePersona(), Formality, FORMALITY_DIRECTIVES, FORMALITY_LEVELS, fromRow(), parsePersonaInput(), Persona (+13 more)

### Community 6 - "storage/memory.ts"
Cohesion: 0.17
Nodes (22): InMemoryTenantObjectStore, StoredEntry, parseDate(), S3TenantObjectStore, sha256Hex(), assertContentType(), assertObjectId(), assertObjectKind() (+14 more)

### Community 7 - "db/index.ts"
Cohesion: 0.14
Nodes (23): DATABASE_CONFIG_SCHEMA, ConnectionOptions, QueryResult, SSL_MODES, DatabaseConfig, AppliedMigration, appliedMigrations(), checksum() (+15 more)

### Community 8 - "reply.ts"
Cohesion: 0.07
Nodes (39): BehaviorConfiguration, behaviorDirectives(), enabledBehaviorRules(), ruleDirective(), disclosureDirectives(), FallbackSource, HandoffTrigger, personaDirectives() (+31 more)

### Community 9 - "mail/fixtures.ts"
Cohesion: 0.11
Nodes (19): api(), createTestMailbox(), DecodedMail, decodeEncodedWords(), decodeMail(), envValue(), MailpitSummary, mailTestConfigured() (+11 more)

### Community 10 - "logging/index.ts"
Cohesion: 0.08
Nodes (23): issuesOf(), issuesOf(), issuesOf(), issuesOf(), issuesOf(), Diagnostic, endCustomerRef(), LEVEL_RANK (+15 more)

### Community 11 - "testing/index.ts"
Cohesion: 0.11
Nodes (23): bySpec, coverageFile, entries, specs, uncovered, workDir, runMailConformance(), RFC-3834 (+15 more)

### Community 12 - "Diagnostics, Preflight Checks & Logging"
Cohesion: 0.05
Nodes (36): dependencies, @zeddev/ai, @zeddev/config, @zeddev/conversation, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue (+28 more)

### Community 13 - "graph.ts"
Cohesion: 0.13
Nodes (24): assertCloudCredentials(), assertMediaRequest(), BusinessAccountProfile, CloudCredentials, CloudDescriptor, cloudFailure(), MediaRequest, mediaTooLarge() (+16 more)

### Community 14 - "ai/index.ts"
Cohesion: 0.13
Nodes (33): AI_CONFIG_SCHEMA, AiConfig, loadAiConfig(), loadAiSettings(), AI_PROVIDERS, appendPart(), audioMediaType(), baseMediaType() (+25 more)

### Community 15 - "bot/index.ts"
Cohesion: 0.11
Nodes (33): ACTIVATION_CAUSES, ActivationCause, ActivationEvent, BotStatus, describeBotStatus(), fromRow(), listBotStatuses(), mayAutoRespond() (+25 more)

### Community 16 - "mail/index.ts"
Cohesion: 0.23
Nodes (13): isRetryable(), loadMailConfig(), loadSmtpSettings(), MAIL_CONFIG_SCHEMA, MailConfig, RFC-5322, mintMessageId(), MAIL_TLS_MODES (+5 more)

### Community 17 - "api/app.ts"
Cohesion: 0.11
Nodes (32): HttpError, readBody(), SECURITY_HEADERS, ACCEPTED, Api, ApiDependencies, CLIENT_COOKIE_PATH, CLIENT_SESSION_COOKIE (+24 more)

### Community 18 - "WhatsApp Inbound Message Recording"
Cohesion: 0.13
Nodes (31): Configuration-Driven Behavior (No Environment Branching), Environment Portability, Fallback Message Precedence Order, Fallback Response Behavior, Fixed, Non-Generated Fallback Text, Per-Conversation Handoff Pause Scope, Handoff Trigger Conditions, Human Handoff (+23 more)

### Community 19 - "api/start.ts"
Cohesion: 0.31
Nodes (16): loadAll(), loadConfig(), createPool(), loadDatabaseConfig(), assertTenantIsolationEnforceable(), loadIdentityPolicy(), loadGraphCloudSettings(), loadWhatsAppConfig() (+8 more)

### Community 20 - "health.ts"
Cohesion: 0.14
Nodes (32): compareValues(), CONNECTION_SEVERITY, ConnectionFilter, connectionStatus(), describeCurrent(), describeRange(), describeTenant(), listConnectionHealth() (+24 more)

### Community 21 - "ai/memory.ts"
Cohesion: 0.13
Nodes (21): AiFixture, AiFixtureOptions, AiHarness, ALL, JPEG, OGG, PNG, rejection() (+13 more)

### Community 22 - "gemini.ts"
Cohesion: 0.26
Nodes (17): base64(), asRecord(), contentFiltered(), emptyResponse(), safeProviderCode(), tokenCount(), decode(), encodeTurn() (+9 more)

### Community 23 - "AI Config & Media Type Normalization"
Cohesion: 0.07
Nodes (27): devDependencies, @types/node, typescript, engines, node, name, private, scripts (+19 more)

### Community 24 - "knowledge.test.ts"
Cohesion: 0.09
Nodes (39): createKnowledgeEntry(), deleteKnowledgeEntry(), describeKnowledge(), describeKnowledgeEntry(), describeKnowledgeStatus(), entryContent(), entryId(), entryNotFound() (+31 more)

### Community 25 - "secrets/index.ts"
Cohesion: 0.10
Nodes (31): generateSealingKey(), hashCredential(), isSecret(), parseSealingKey(), scrypt, SCRYPT_DEFAULTS, SealingKey, SECRET_CLASSES (+23 more)

### Community 26 - "s3.test.ts"
Cohesion: 0.12
Nodes (16): NotFoundError, HarnessOptions, runStorageConformance(), StorageFixture, StorageHarness, createTestBucket(), envValue(), SKIP_REASON (+8 more)

### Community 27 - "whatsapp/index.ts"
Cohesion: 0.09
Nodes (46): CLOUD_RECOVERABLE_REASONS, CloudLinkProbe, ConnectionErrorReason, GraphCloudDependencies, GraphCloudSettings, arrayOf(), fromRow(), INBOUND_JOB_KIND (+38 more)

### Community 28 - "whatsapp-gateway/app.ts"
Cohesion: 0.23
Nodes (14): WhatsAppConfig, createGateway(), digest(), Gateway, GatewayDependencies, InboundScheduler, Reply, WEBHOOK_PATH (+6 more)

### Community 29 - "metrics.ts"
Cohesion: 0.13
Nodes (24): PeriodTotals, assessHealth(), attempts(), ceilHour(), floorHour(), HEALTH_THRESHOLDS, isMetricWindow(), METRIC_BASELINE_MS (+16 more)

### Community 30 - "message.ts"
Cohesion: 0.11
Nodes (27): BASE, memoryHarness, MINIMAL_ENV, ADDRESS_FORBIDDEN, assertEnvelopeAddress(), assertHeaderText(), base64Body(), buildMessage() (+19 more)

### Community 31 - "transcript.ts"
Cohesion: 0.10
Nodes (33): BotEntry, CONVERSATION_LIST_FIELDS, ConversationListPage, ConversationSummary, cursorOf(), CustomerEntry, CustomerEntryBase, describeConversationSummary() (+25 more)

### Community 32 - "whatsapp/memory.ts"
Cohesion: 0.14
Nodes (23): AccountState, ANSWER_LOST, CLOUD_OPERATIONS, CloudOperation, DescribedMedia, InMemoryWhatsAppCloudOptions, isAnswerLost(), isScriptedFailure() (+15 more)

### Community 33 - "recovery.test.ts"
Cohesion: 0.09
Nodes (24): CONNECTION_ERROR_REASONS, CONNECTION_STATES, CONNECTION_TRANSITIONS, connectionHistory(), ConnectionRow, ConnectionState, ConnectionStatus, ConnectionTransition (+16 more)

### Community 34 - "turns.test.ts"
Cohesion: 0.07
Nodes (17): at(), BoardFailure, BoardJob, cloudBackend, deliveryOf(), handoffTenant(), instructionsFor(), JobBoard (+9 more)

### Community 35 - "dependencies"
Cohesion: 0.06
Nodes (34): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/monitoring, @zeddev/queue, @zeddev/schema (+26 more)

### Community 36 - "scheduler/start.ts"
Cohesion: 0.25
Nodes (11): loadSchedulerSettings(), SCHEDULER_CONFIG_SCHEMA, SchedulerConfig, SchedulerSettings, runSchedule(), ScheduledTask, RunningScheduler, startScheduler() (+3 more)

### Community 37 - "config/index.ts"
Cohesion: 0.13
Nodes (22): BaseSpec, BooleanSpec, Config, ConfigSchema, ConfigSpec, ConfigValueType, DURATION_UNITS, DurationSpec (+14 more)

### Community 38 - "health.test.ts"
Cohesion: 0.15
Nodes (12): Answer, LAST_DAY, NOW, WEEK_AGO, WITHIN_DAY, DISPATCH_READABLE_TABLES, INBOUND_SCOPE_TABLES, loadSchemaMigrations() (+4 more)

### Community 39 - "delivery.ts"
Cohesion: 0.13
Nodes (22): claimDelivery(), DELIVERY_FAILURES, DELIVERY_JOB_KIND, DELIVERY_LIMITS, DELIVERY_PRINCIPAL, DELIVERY_STATES, DeliveryAttemptOutcome, DeliveryClaim (+14 more)

### Community 40 - "behavior.ts"
Cohesion: 0.11
Nodes (34): ACTION_DIRECTIVES, BEHAVIOR_LIMITS, BehaviorRule, clearBehaviorInstructions(), CONDITION_BY_KIND, createBehaviorRule(), definition(), deleteBehaviorRule() (+26 more)

### Community 41 - "withIdentityScope"
Cohesion: 0.10
Nodes (22): create(), newTenant(), nextReplyDirectives(), replyConfiguration(), choose(), directives(), followed(), newTenant() (+14 more)

### Community 42 - "conversation/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, @zeddev/schema, @zeddev/testing, exports, @zeddev/schema, @zeddev/testing, name, private (+2 more)

### Community 43 - "dependencies"
Cohesion: 0.11
Nodes (19): dependencies, @zeddev/ai, @zeddev/bot, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue, @zeddev/secrets (+11 more)

### Community 44 - "smtp.ts"
Cohesion: 0.17
Nodes (11): RFC-821, asConfigurationError(), assertCommandSafe(), AttemptState, Phase, PHASE_CONFIG_KEYS, replyFailure(), SmtpMailerOptions (+3 more)

### Community 45 - "transcript.test.ts"
Cohesion: 0.10
Nodes (19): ConversationListQuery, parseConversationListInput(), parseTranscriptInput(), readLimit(), refuseUnknown(), Answer, at(), closeTogether() (+11 more)

### Community 46 - "Conversation Turn & Handoff Status"
Cohesion: 0.10
Nodes (20): es2023, node, compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, exactOptionalPropertyTypes, isolatedModules, lib (+12 more)

### Community 47 - "handoff.ts"
Cohesion: 0.11
Nodes (34): conditionList(), describeHandoffSettings(), enabledFlag(), fromRow(), HANDOFF_FIELDS, HANDOFF_LIMITS, HANDOFF_TRIGGER_DESCRIPTIONS, HANDOFF_TRIGGERS (+26 more)

### Community 49 - "InMemoryAiProvider"
Cohesion: 0.15
Nodes (8): GeminiProvider, geminiTranscriptionPrompt(), InMemoryAiProvider, OpenAiCompatibleProvider, AiCallOptions, AiProviderDescriptor, GenerationResult, TranscriptionResult

### Community 50 - "DB Package Dependencies"
Cohesion: 0.10
Nodes (20): dependencies, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/time, devDependencies, @zeddev/schema, @zeddev/testing (+12 more)

### Community 51 - "Identity Access Principals & Authorization"
Cohesion: 0.09
Nodes (22): dependencies, @zeddev/config, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time, devDependencies (+14 more)

### Community 52 - "dependencies"
Cohesion: 0.10
Nodes (21): dependencies, @zeddev/api, @zeddev/config, @zeddev/conversation-worker, @zeddev/db, @zeddev/logging, @zeddev/scheduler, @zeddev/storage (+13 more)

### Community 53 - "s3.ts"
Cohesion: 0.11
Nodes (35): STORAGE_CONFIG_SCHEMA, AgentOptions, createTransport(), RequestFn, send(), Transport, TransportRequest, ADDRESSING_STYLES (+27 more)

### Community 54 - "s3wire.ts"
Cohesion: 0.23
Nodes (13): CREDENTIAL_CODES, decodeEntities(), elementBlocks(), elementText(), ENTITIES, FailureContext, ListedKey, ListPage (+5 more)

### Community 55 - "ai/stubs.ts"
Cohesion: 0.21
Nodes (16): SCRIPTED_FAILURE_STATUS, BASE_PATHS, decodeOpenAiContent(), firstText(), geminiError(), handleGemini(), handleOpenAi(), misbehave() (+8 more)

### Community 56 - "conversation-worker/start.ts"
Cohesion: 0.29
Nodes (9): RawEnv, INBOUND_QUEUE, CliIo, loadWorkerSettings(), WORKER_CONFIG_SCHEMA, WorkerConfig, WorkerSettings, RunningWorker (+1 more)

### Community 57 - "identity/index.ts"
Cohesion: 0.05
Nodes (67): ACCESS_PRINCIPAL_TYPES, AccessPrincipalType, AccessRecordInput, DENIAL_REASONS, DenialReason, recordAccess(), recordAccessOutOfBand(), IDENTITY_CONFIG_SCHEMA (+59 more)

### Community 58 - "api/app.test.ts"
Cohesion: 0.12
Nodes (13): Answer, apiWith(), call(), cookieValue(), FAST_SCRYPT, onboard(), POLICY, SEALER (+5 more)

### Community 59 - "S3 Wire Protocol Error Parsing"
Cohesion: 0.07
Nodes (28): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/http, @zeddev/logging, @zeddev/queue, @zeddev/schema (+20 more)

### Community 60 - "dependencies"
Cohesion: 0.08
Nodes (25): dependencies, @zeddev/bot, @zeddev/config, @zeddev/conversation, @zeddev/db, @zeddev/errors, @zeddev/http, @zeddev/schema (+17 more)

### Community 61 - "Backoff & Clock Abstractions"
Cohesion: 0.22
Nodes (8): devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type, version

### Community 62 - "Persona Formality & Text Parsing"
Cohesion: 0.14
Nodes (13): dependencies, @zeddev/db, @zeddev/logging, devDependencies, @zeddev/testing, exports, @zeddev/db, @zeddev/logging (+5 more)

### Community 64 - "queue/index.ts"
Cohesion: 0.26
Nodes (14): DEFAULT_BACKOFF, StoredJob, ClaimRow, PostgresQueueOptions, assertQueueName(), ClaimOptions, digestKey(), EnqueueRequest (+6 more)

### Community 65 - "monitoring/package.json"
Cohesion: 0.10
Nodes (19): dependencies, @zeddev/db, @zeddev/errors, @zeddev/tenancy, @zeddev/whatsapp, devDependencies, @zeddev/schema, @zeddev/testing (+11 more)

### Community 66 - "storage/index.test.ts"
Cohesion: 0.18
Nodes (7): TransportResponse, memoryHarness, TENANTS, S3ObjectStore, parseObjectKey(), parseObjectRef(), tenantPrefix()

### Community 68 - "identity/package.json"
Cohesion: 0.08
Nodes (25): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time (+17 more)

### Community 69 - "ValidationError"
Cohesion: 0.15
Nodes (24): describeFallbackMessages(), FALLBACK_FIELDS, FALLBACK_LIMITS, FALLBACK_TRIGGERS, FallbackInput, fallbackMessageFor(), FallbackMessages, FallbackRow (+16 more)

### Community 70 - "In-Memory Object Store Tests"
Cohesion: 0.21
Nodes (15): AST-only code updates vs. semantic doc updates, GRAPH_REPORT.md, Graph Section (AGENTS.md), graphify explain, graphify-out/graph.json, graphify query, /graphify --update (targeted semantic refresh), graphify hook install (post-commit hook) (+7 more)

### Community 71 - "Logging Package Dependencies"
Cohesion: 0.14
Nodes (13): dependencies, @zeddev/errors, @zeddev/secrets, devDependencies, @zeddev/testing, exports, @zeddev/errors, @zeddev/secrets (+5 more)

### Community 72 - "turns.ts"
Cohesion: 0.13
Nodes (27): AdmissionResult, admitLocked(), admitPendingMessages(), assertPolicy(), closeTurn(), ContextRow, CONVERSATION_LIMITS, ConversationRow (+19 more)

### Community 73 - "whatsapp/package.json"
Cohesion: 0.12
Nodes (16): compose.yaml (Docker Compose Stack), postgres Compose service, Configuration Reference, devDependencies, @zeddev/schema, @zeddev/testing, exports, ./testing (+8 more)

### Community 74 - "mail/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, @zeddev/testing, exports, ./testing, @zeddev/testing, name, private, type (+2 more)

### Community 75 - "Conversation Worker Job Handlers"
Cohesion: 0.09
Nodes (22): dependencies, @zeddev/config, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time, devDependencies (+14 more)

### Community 76 - "Schema Migrations Runner"
Cohesion: 0.10
Nodes (19): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/secrets, devDependencies, @zeddev/schema, @zeddev/testing (+11 more)

### Community 77 - "smtp.test.ts"
Cohesion: 0.11
Nodes (11): MailHarness, HAPPY, instantClock, MESSAGE, ScriptedServer, ScriptStep, SETTINGS, RFC-2047 (+3 more)

### Community 78 - "Queue"
Cohesion: 0.14
Nodes (6): ConsumerOptions, JobHandler, runConsumer(), sleepQuietly(), waitForSomething(), Queue

### Community 79 - "worker.ts"
Cohesion: 0.30
Nodes (11): AggregationPolicy, PreparedTurn, TURN_JOB_KIND, TurnScheduler, conversationHandlers(), ConversationWorkerDependencies, handleDelivery(), handleInbound() (+3 more)

### Community 80 - "dependencies"
Cohesion: 0.13
Nodes (15): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/time, @zeddev/vault (+7 more)

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

### Community 85 - "inbound.test.ts"
Cohesion: 0.24
Nodes (6): withInboundScope(), attributeInboundNumber(), recordInboundRejection(), APP_SECRET, connectedTenant(), newTenant()

### Community 86 - "PostgresQueue"
Cohesion: 0.18
Nodes (4): bindTenantContext(), withDispatchScope(), toDiagnostic(), PostgresQueue

### Community 87 - "monitoring/tsconfig.json"
Cohesion: 0.29
Nodes (6): **/*.ts, ../../../tsconfig.base.json, extends, include, extends, include

### Community 88 - "Mailer"
Cohesion: 0.13
Nodes (3): MailFixture, InMemoryMailer, Mailer

### Community 89 - "time/index.ts"
Cohesion: 0.12
Nodes (6): exponentialBackoff(), ExponentialBackoffOptions, FakeClock, Millis, ScheduledTask, SystemClock

### Community 91 - "Tenancy Package Dependencies"
Cohesion: 0.05
Nodes (37): dependencies, @zeddev/config, @zeddev/errors, @zeddev/secrets, @zeddev/time, devDependencies, @zeddev/testing, exports (+29 more)

### Community 93 - "Cost-Efficient Operation Spec"
Cohesion: 0.60
Nodes (5): Decision: Hand-written PostgreSQL client, Decision: Hand-written SigV4 signer and HTTP client, Decision: PostgreSQL as the single persistent store, Decision: node:test and npm workspaces, zero test/build dependencies, Cost-Efficient Operation Spec

### Community 95 - "Identity Session Principals"
Cohesion: 0.20
Nodes (9): dependencies, devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type (+1 more)

### Community 96 - "queue/index.test.ts"
Cohesion: 0.21
Nodes (9): HarnessQueueOptions, PAYLOAD, QueueFixture, QueueHarness, runQueueConformance(), drain(), memoryHarness, TENANTS (+1 more)

### Community 97 - "api/package.json"
Cohesion: 0.20
Nodes (9): devDependencies, @zeddev/testing, exports, ./config, @zeddev/testing, name, private, type (+1 more)

### Community 98 - "Errors Package Dependencies"
Cohesion: 0.25
Nodes (7): **/node_modules/**, scripts/**/*.ts, src/**/*.ts, exclude, extends, include, ./tsconfig.base.json

### Community 99 - "HTTP Package Dependencies"
Cohesion: 0.29
Nodes (6): dependencies, exports, name, private, type, version

### Community 100 - "deployment/package.json"
Cohesion: 0.22
Nodes (8): devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type, version

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

### Community 131 - "ai/config.test.ts"
Cohesion: 0.16
Nodes (9): AdapterDependencies, answer(), GEMINI_ENV, OPENAI_ENV, createAiProvider(), ProviderEntry, AiProvider, AiSettings (+1 more)

### Community 132 - "conversation/index.ts"
Cohesion: 0.12
Nodes (30): ContextTurn, renderConversation(), RenderedConversation, renderMessage(), text(), TurnMessage, unsupportedNote(), cleanTranscript() (+22 more)

### Community 133 - "deployment/index.ts"
Cohesion: 0.29
Nodes (9): target, combinedSchema(), configKeys(), ConfigSection, PLATFORM_CONFIG_SCHEMAS, renderPlatformReference(), tableOnly(), REFERENCE_PATH (+1 more)

### Community 134 - "scheduler/start.test.ts"
Cohesion: 0.17
Nodes (4): MemorySink, tenant(), finish(), SEALING_KEY

### Community 135 - "LogSink"
Cohesion: 0.25
Nodes (4): JsonLinesSink, LogSink, NullSink, StartOptions

### Community 136 - "@zeddev/ai"
Cohesion: 0.67
Nodes (3): @zeddev/ai, @zeddev/ai, @zeddev/ai

### Community 137 - "cloud.ts"
Cohesion: 0.08
Nodes (25): Decision: cloudFailureDeterminacy for retry-without-duplication, MediaUnderstandingDependencies, assertSendableText(), businessVerificationBlocked(), classifyCloudFailure(), CLOUD_ERROR_CODES, cloudFailureDeterminacy(), cloudFailureReason() (+17 more)

### Community 138 - "Clock"
Cohesion: 0.13
Nodes (18): AdapterCore, DEFAULT_AI_BACKOFF, AttemptOutcome, AttemptPolicy, AttemptTimedOut, Failure, malformedResponse(), MAX_ERROR_BODY_BYTES (+10 more)

### Community 139 - "@zeddev/identity"
Cohesion: 0.67
Nodes (3): @zeddev/identity, @zeddev/identity, @zeddev/identity

### Community 140 - "@zeddev/mail"
Cohesion: 0.67
Nodes (3): @zeddev/mail, @zeddev/mail, @zeddev/mail

### Community 141 - "TenantObjectStore"
Cohesion: 0.23
Nodes (4): TenantObjectStore, assertTenantId(), isTenantId(), normalizeTenantId()

### Community 143 - "activation.test.ts"
Cohesion: 0.60
Nodes (5): configure(), connect(), liveTenant(), newTenant(), readyTenant()

## Knowledge Gaps
- **611 isolated node(s):** `NOW`, `LOJA`, `SHOP`, `EntryRow`, `NOW` (+606 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Implementation Plan` connect `Implementation Plan` to `whatsapp/package.json`, `cloud.ts`, `mail/package.json`, `Cost-Efficient Operation Spec`?**
  _High betweenness centrality (0.089) - this node is a cross-community bridge._
- **Why does `cloudFailureDeterminacy()` connect `cloud.ts` to `whatsapp/index.ts`, `delivery.ts`?**
  _High betweenness centrality (0.088) - this node is a cross-community bridge._
- **Why does `Decision: cloudFailureDeterminacy for retry-without-duplication` connect `cloud.ts` to `Implementation Plan`?**
  _High betweenness centrality (0.087) - this node is a cross-community bridge._
- **What connects `NOW`, `LOJA`, `SHOP` to the rest of the system?**
  _611 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Connection` be split into smaller, more focused modules?**
  _Cohesion score 0.05039193729003359 - nodes in this community are weakly interconnected._
- **Should `onboarding.test.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08734693877551021 - nodes in this community are weakly interconnected._
- **Should `db/testing.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1310344827586207 - nodes in this community are weakly interconnected._