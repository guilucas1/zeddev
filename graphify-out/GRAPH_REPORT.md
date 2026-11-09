# Graph Report - zeddev  (2026-11-03)

## Corpus Check
- 293 files · ~357,071 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2788 nodes · 7695 edges · 136 communities (123 shown, 13 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 45 edges (avg confidence: 0.73)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `4f4f7a14`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Connection
- onboarding.test.ts
- db/testing.ts
- Implementation Plan
- errors/index.ts
- persona.ts
- s3.ts
- db/index.ts
- reply.ts
- mail/fixtures.ts
- logging/index.ts
- testing/index.ts
- Diagnostics, Preflight Checks & Logging
- graph.ts
- ai/index.ts
- bot/index.ts
- mail/types.ts
- ValidationError
- WhatsApp Inbound Message Recording
- api/start.ts
- adapter.ts
- ai/memory.ts
- gemini.ts
- AI Config & Media Type Normalization
- knowledge.test.ts
- secrets/index.ts
- s3.test.ts
- whatsapp/index.ts
- whatsapp-gateway/app.ts
- withIdentityScope
- mail/index.ts
- transcript.ts
- whatsapp/memory.ts
- recovery.test.ts
- turns.test.ts
- dependencies
- scheduler/start.test.ts
- config/index.ts
- activation.test.ts
- delivery.ts
- behavior.ts
- withTenant
- conversation/package.json
- dependencies
- smtp.test.ts
- transcript.test.ts
- Conversation Turn & Handoff Status
- handoff.ts
- SmtpConnection
- objectKey
- DB Package Dependencies
- Identity Access Principals & Authorization
- dependencies
- sigv4.ts
- s3wire.ts
- ai/stubs.ts
- conversation-worker/start.ts
- identity/index.ts
- Clock
- S3 Wire Protocol Error Parsing
- AGENTS.md Package Index & Manifests
- Backoff & Clock Abstractions
- Persona Formality & Text Parsing
- Pool
- queue/index.ts
- InMemoryQueue
- S3ObjectStore
- InMemoryObjectStore
- dependencies
- queue/index.test.ts
- In-Memory Object Store Tests
- Logging Package Dependencies
- turns.ts
- PostgresQueue
- mail/package.json
- Conversation Worker Job Handlers
- Schema Migrations Runner
- disclosure.test.ts
- IdentityService
- worker.ts
- whatsapp/package.json
- Postgres Value Codec
- Identity Package Dependencies
- Tenant Test Fixtures
- Config Package Dependencies
- inbound.test.ts
- service.ts
- scheduler/tsconfig.json
- Mailer
- time/index.ts
- Tenancy Package Dependencies
- Identity Package Manifest
- Cost-Efficient Operation Spec
- ScriptedCloudBackend
- Identity Session Principals
- conversation-worker/start.test.ts
- Errors Package Dependencies
- HTTP Package Dependencies
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
- credentials.ts
- cloud.ts
- runAttempts
- identity/package.json
- TenantObjectStore
- tokens.ts

## God Nodes (most connected - your core abstractions)
1. `unitTest()` - 64 edges
2. `Connection` - 60 edges
3. `specTest()` - 58 edges
4. `ValidationError` - 57 edges
5. `Pool` - 55 edges
6. `Logger` - 55 edges
7. `withIdentityScope()` - 53 edges
8. `Secret` - 53 edges
9. `Clock` - 51 edges
10. `withTenant()` - 47 edges

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

## Communities (136 total, 13 thin omitted)

### Community 0 - "Connection"
Cohesion: 0.05
Nodes (53): RFC-5802, RFC-7677, ARRAY_ELEMENT, arrayLiteral(), decodeValue(), encodeParam(), normalizeTimestampText(), OID (+45 more)

### Community 1 - "onboarding.test.ts"
Cohesion: 0.09
Nodes (48): META_ID, disconnectWhatsApp(), fromRow(), readConnection(), requireTenant(), transitionConnection(), assignPhoneNumber(), connectedTenant() (+40 more)

### Community 2 - "db/testing.ts"
Cohesion: 0.18
Nodes (14): adminOptions(), createTestDatabase(), envValue(), maintenanceDatabase(), onAdmin(), SKIP_REASON, TestDatabase, testDatabaseConfigured() (+6 more)

### Community 3 - "Implementation Plan"
Cohesion: 0.20
Nodes (26): Decision: Readiness defined once in SQL with triggers, Decision: Round-robin tenant-fair queue dispatch, Decision: Log redaction as an allowlist, Decision: Migrations are forward-only, Decision: Node 24 native TypeScript type stripping, no build step, Decision: Tagged first-line reply output protocol, Decision: Ports-and-adapters for every external dependency, Decision: Tenant isolation enforced in the database via row-level security (+18 more)

### Community 4 - "errors/index.ts"
Cohesion: 0.08
Nodes (26): COMPLETE_ENV, CONFIGURATION_CLASSES, FailureContext, mapPostgresFailure(), PostgresFailure, RETRYABLE_CLASSES, RETRYABLE_CODES, VALIDATION_CODES (+18 more)

### Community 5 - "persona.ts"
Cohesion: 0.13
Nodes (25): phrase(), conditionList(), clearFreeformInstructions(), describePersona(), Formality, FORMALITY_DIRECTIVES, FORMALITY_LEVELS, fromRow() (+17 more)

### Community 6 - "s3.ts"
Cohesion: 0.17
Nodes (24): STORAGE_CONFIG_SCHEMA, memoryHarness, TENANTS, StoredEntry, ADDRESSING_STYLES, AddressingStyle, S3Request, sha256Hex() (+16 more)

### Community 7 - "db/index.ts"
Cohesion: 0.14
Nodes (22): DATABASE_CONFIG_SCHEMA, ConnectionOptions, SSL_MODES, DatabaseConfig, AppliedMigration, appliedMigrations(), checksum(), loadMigrations() (+14 more)

### Community 8 - "reply.ts"
Cohesion: 0.09
Nodes (35): disclosureDirectives(), handoffDirectives(), personaDirectives(), describeReplyDecision(), FALLBACK_CAUSES, FallbackCause, fallbackDecision(), generateReply() (+27 more)

### Community 9 - "mail/fixtures.ts"
Cohesion: 0.10
Nodes (20): MailHarness, api(), createTestMailbox(), DecodedMail, decodeEncodedWords(), decodeMail(), envValue(), MailpitSummary (+12 more)

### Community 10 - "logging/index.ts"
Cohesion: 0.08
Nodes (21): issuesOf(), issuesOf(), issuesOf(), issuesOf(), issuesOf(), issuesOf(), Diagnostic, LEVEL_RANK (+13 more)

### Community 11 - "testing/index.ts"
Cohesion: 0.10
Nodes (24): bySpec, coverageFile, entries, specs, uncovered, workDir, REFERENCE_PATH, runMailConformance() (+16 more)

### Community 12 - "Diagnostics, Preflight Checks & Logging"
Cohesion: 0.05
Nodes (36): dependencies, @zeddev/ai, @zeddev/config, @zeddev/conversation, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue (+28 more)

### Community 13 - "graph.ts"
Cohesion: 0.12
Nodes (25): assertCloudCredentials(), assertMediaRequest(), BusinessAccountProfile, CloudCredentials, CloudDescriptor, MediaRequest, mediaTooLarge(), NumberProfile (+17 more)

### Community 14 - "ai/index.ts"
Cohesion: 0.14
Nodes (31): AI_CONFIG_SCHEMA, AiConfig, loadAiConfig(), loadAiSettings(), AI_PROVIDERS, appendPart(), audioMediaType(), baseMediaType() (+23 more)

### Community 15 - "bot/index.ts"
Cohesion: 0.08
Nodes (46): ACTIVATION_CAUSES, ActivationCause, ActivationEvent, BotStatus, describeBotStatus(), fromRow(), listBotStatuses(), mayAutoRespond() (+38 more)

### Community 16 - "mail/types.ts"
Cohesion: 0.31
Nodes (6): mintMessageId(), MAIL_TLS_MODES, MailMessage, MailTlsMode, SentMail, RFC-2047

### Community 17 - "ValidationError"
Cohesion: 0.08
Nodes (33): AuthenticationError, TransientTransportError, ValidationError, ACCEPTED, Api, CLIENT_COOKIE_PATH, OPERATOR_COOKIE_PATH, RequestContext (+25 more)

### Community 18 - "WhatsApp Inbound Message Recording"
Cohesion: 0.13
Nodes (31): Configuration-Driven Behavior (No Environment Branching), Environment Portability, Fallback Message Precedence Order, Fallback Response Behavior, Fixed, Non-Generated Fallback Text, Per-Conversation Handoff Pause Scope, Handoff Trigger Conditions, Human Handoff (+23 more)

### Community 19 - "api/start.ts"
Cohesion: 0.12
Nodes (33): Config, ConfigSchema, loadAll(), loadConfig(), RawEnv, createPool(), loadDatabaseConfig(), assertTenantIsolationEnforceable() (+25 more)

### Community 20 - "adapter.ts"
Cohesion: 0.17
Nodes (7): AdapterCore, DEFAULT_AI_BACKOFF, AttemptOutcome, AttemptPolicy, parseRetryAfter(), readErrorBody(), AiProviderDescriptor

### Community 21 - "ai/memory.ts"
Cohesion: 0.11
Nodes (23): AiFixture, AiFixtureOptions, AiHarness, ALL, JPEG, OGG, PNG, rejection() (+15 more)

### Community 22 - "gemini.ts"
Cohesion: 0.15
Nodes (29): base64(), asRecord(), AttemptTimedOut, contentFiltered(), emptyResponse(), Failure, malformedResponse(), MAX_ERROR_BODY_BYTES (+21 more)

### Community 23 - "AI Config & Media Type Normalization"
Cohesion: 0.07
Nodes (27): devDependencies, @types/node, typescript, engines, node, name, private, scripts (+19 more)

### Community 24 - "knowledge.test.ts"
Cohesion: 0.13
Nodes (30): createKnowledgeEntry(), deleteKnowledgeEntry(), describeKnowledge(), describeKnowledgeEntry(), describeKnowledgeStatus(), entryContent(), entryId(), entryNotFound() (+22 more)

### Community 25 - "secrets/index.ts"
Cohesion: 0.06
Nodes (45): generateSealingKey(), parseSealingKey(), SCRYPT_DEFAULTS, SealingKey, SECRET_CLASSES, SecretAccessRecord, SecretClass, secretRef() (+37 more)

### Community 26 - "s3.test.ts"
Cohesion: 0.10
Nodes (23): HarnessOptions, runStorageConformance(), StorageFixture, StorageHarness, createTestBucket(), envValue(), SKIP_REASON, storageTestConfigured() (+15 more)

### Community 27 - "whatsapp/index.ts"
Cohesion: 0.10
Nodes (36): CONNECTION_ERROR_REASONS, CONNECTION_STATES, CONNECTION_TRANSITIONS, ConnectionRow, ConnectionState, ConnectionStatus, ConnectionTransition, describeConnection() (+28 more)

### Community 28 - "whatsapp-gateway/app.ts"
Cohesion: 0.16
Nodes (16): HttpError, readBody(), SECURITY_HEADERS, WhatsAppConfig, createGateway(), digest(), Gateway, GatewayDependencies (+8 more)

### Community 29 - "withIdentityScope"
Cohesion: 0.13
Nodes (21): newTenant(), newTenant(), newTenant(), newTenant(), newTenant(), newTenant(), withIdentityScope(), recordAccess() (+13 more)

### Community 30 - "mail/index.ts"
Cohesion: 0.12
Nodes (30): MAIL_CONFIG_SCHEMA, MailConfig, BASE, memoryHarness, MINIMAL_ENV, RFC-5322, ADDRESS_FORBIDDEN, assertEnvelopeAddress() (+22 more)

### Community 31 - "transcript.ts"
Cohesion: 0.10
Nodes (33): BotEntry, CONVERSATION_LIST_FIELDS, ConversationListPage, ConversationSummary, cursorOf(), CustomerEntry, CustomerEntryBase, describeConversationSummary() (+25 more)

### Community 32 - "whatsapp/memory.ts"
Cohesion: 0.14
Nodes (23): AccountState, ANSWER_LOST, CLOUD_OPERATIONS, CloudOperation, DescribedMedia, InMemoryWhatsAppCloudOptions, isAnswerLost(), isScriptedFailure() (+15 more)

### Community 33 - "recovery.test.ts"
Cohesion: 0.08
Nodes (29): CloudLinkProbe, probeCloudLink(), WhatsAppCloud, ConnectionErrorReason, connectionHistory(), claimRecoveryProbe(), listConnectionsDueForRecovery(), recoverOne() (+21 more)

### Community 34 - "turns.test.ts"
Cohesion: 0.08
Nodes (14): BoardFailure, BoardJob, cloudBackend, deliveryOf(), handoffTenant(), liveTenant(), OutcomeRow, outcomesOf() (+6 more)

### Community 35 - "dependencies"
Cohesion: 0.06
Nodes (32): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue, @zeddev/schema, @zeddev/time (+24 more)

### Community 36 - "scheduler/start.test.ts"
Cohesion: 0.17
Nodes (14): loadSchedulerSettings(), SCHEDULER_CONFIG_SCHEMA, SchedulerConfig, SchedulerSettings, logger, runSchedule(), ScheduledTask, RunningScheduler (+6 more)

### Community 37 - "config/index.ts"
Cohesion: 0.11
Nodes (25): target, BaseSpec, BooleanSpec, ConfigSpec, ConfigValueType, DURATION_UNITS, DurationSpec, EnumSpec (+17 more)

### Community 38 - "activation.test.ts"
Cohesion: 0.21
Nodes (13): configure(), connect(), liveTenant(), newTenant(), readyTenant(), ConflictError, DISPATCH_READABLE_TABLES, INBOUND_SCOPE_TABLES (+5 more)

### Community 39 - "delivery.ts"
Cohesion: 0.14
Nodes (20): claimDelivery(), DELIVERY_FAILURES, DELIVERY_LIMITS, DELIVERY_PRINCIPAL, DELIVERY_STATES, DeliveryClaim, DeliveryFailure, deliveryJob() (+12 more)

### Community 40 - "behavior.ts"
Cohesion: 0.11
Nodes (40): ACTION_DIRECTIVES, BEHAVIOR_LIMITS, BehaviorConfiguration, behaviorDirectives(), BehaviorRule, clearBehaviorInstructions(), CONDITION_BY_KIND, createBehaviorRule() (+32 more)

### Community 41 - "withTenant"
Cohesion: 0.17
Nodes (9): save(), sent(), sentForEveryTrigger(), replyPersona(), withPlatformScope(), withTenant(), move(), jobsOf() (+1 more)

### Community 42 - "conversation/package.json"
Cohesion: 0.17
Nodes (11): devDependencies, @zeddev/schema, @zeddev/testing, exports, @zeddev/schema, @zeddev/testing, name, private (+3 more)

### Community 43 - "dependencies"
Cohesion: 0.11
Nodes (19): dependencies, @zeddev/ai, @zeddev/bot, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue, @zeddev/secrets (+11 more)

### Community 44 - "smtp.test.ts"
Cohesion: 0.10
Nodes (22): RFC-821, asConfigurationError(), assertCommandSafe(), AttemptState, Phase, PHASE_CONFIG_KEYS, replyFailure(), SmtpMailer (+14 more)

### Community 45 - "transcript.test.ts"
Cohesion: 0.10
Nodes (19): ConversationListQuery, parseConversationListInput(), parseTranscriptInput(), readLimit(), refuseUnknown(), Answer, at(), closeTogether() (+11 more)

### Community 46 - "Conversation Turn & Handoff Status"
Cohesion: 0.10
Nodes (20): es2023, node, compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, exactOptionalPropertyTypes, isolatedModules, lib (+12 more)

### Community 47 - "handoff.ts"
Cohesion: 0.12
Nodes (31): describeHandoffSettings(), enabledFlag(), fromRow(), HANDOFF_FIELDS, HANDOFF_LIMITS, HANDOFF_TRIGGER_DESCRIPTIONS, HANDOFF_TRIGGERS, HandoffDecision (+23 more)

### Community 49 - "objectKey"
Cohesion: 0.27
Nodes (9): InMemoryTenantObjectStore, parseDate(), S3TenantObjectStore, assertObjectId(), assertObjectKind(), assertOwnedBy(), objectKey(), ObjectRef (+1 more)

### Community 50 - "DB Package Dependencies"
Cohesion: 0.10
Nodes (20): dependencies, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/time, devDependencies, @zeddev/schema, @zeddev/testing (+12 more)

### Community 51 - "Identity Access Principals & Authorization"
Cohesion: 0.09
Nodes (22): dependencies, @zeddev/config, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time, devDependencies (+14 more)

### Community 52 - "dependencies"
Cohesion: 0.06
Nodes (35): dependencies, @zeddev/ai, @zeddev/api, @zeddev/config, @zeddev/conversation-worker, @zeddev/db, @zeddev/identity, @zeddev/logging (+27 more)

### Community 53 - "sigv4.ts"
Cohesion: 0.23
Nodes (19): amzDate(), canonicalHeaders, canonicalQuery(), canonicalRequest(), canonicalUri(), credentialScope(), EMPTY_PAYLOAD_SHA256, hmac() (+11 more)

### Community 54 - "s3wire.ts"
Cohesion: 0.23
Nodes (13): CREDENTIAL_CODES, decodeEntities(), elementBlocks(), elementText(), ENTITIES, FailureContext, ListedKey, ListPage (+5 more)

### Community 55 - "ai/stubs.ts"
Cohesion: 0.28
Nodes (13): SCRIPTED_FAILURE_STATUS, BASE_PATHS, decodeOpenAiContent(), firstText(), geminiError(), handleGemini(), handleOpenAi(), misbehave() (+5 more)

### Community 56 - "conversation-worker/start.ts"
Cohesion: 0.17
Nodes (11): JsonLinesSink, LogSink, NullSink, INBOUND_QUEUE, loadWorkerSettings(), WORKER_CONFIG_SCHEMA, WorkerConfig, WorkerSettings (+3 more)

### Community 57 - "identity/index.ts"
Cohesion: 0.21
Nodes (17): ACCESS_PRINCIPAL_TYPES, AccessPrincipalType, AccessRecordInput, DENIAL_REASONS, DenialReason, IdentityConfig, ACTION_PRINCIPALS, actionPrincipalType() (+9 more)

### Community 58 - "Clock"
Cohesion: 0.12
Nodes (9): LoggerOptions, ConsumerOptions, JobHandler, runConsumer(), sleepQuietly(), waitForSomething(), InMemoryQueueOptions, Queue (+1 more)

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

### Community 64 - "queue/index.ts"
Cohesion: 0.27
Nodes (14): DEFAULT_BACKOFF, StoredJob, ClaimRow, PostgresQueueOptions, assertQueueName(), ClaimOptions, digestKey(), EnqueueRequest (+6 more)

### Community 66 - "S3ObjectStore"
Cohesion: 0.22
Nodes (4): TransportResponse, S3ObjectStore, parseObjectKey(), tenantPrefix()

### Community 68 - "dependencies"
Cohesion: 0.13
Nodes (15): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time (+7 more)

### Community 69 - "queue/index.test.ts"
Cohesion: 0.21
Nodes (9): HarnessQueueOptions, PAYLOAD, QueueFixture, QueueHarness, runQueueConformance(), drain(), memoryHarness, TENANTS (+1 more)

### Community 70 - "In-Memory Object Store Tests"
Cohesion: 0.21
Nodes (15): AST-only code updates vs. semantic doc updates, GRAPH_REPORT.md, Graph Section (AGENTS.md), graphify explain, graphify-out/graph.json, graphify query, /graphify --update (targeted semantic refresh), graphify hook install (post-commit hook) (+7 more)

### Community 71 - "Logging Package Dependencies"
Cohesion: 0.14
Nodes (13): dependencies, @zeddev/errors, @zeddev/secrets, devDependencies, @zeddev/testing, exports, @zeddev/errors, @zeddev/secrets (+5 more)

### Community 72 - "turns.ts"
Cohesion: 0.13
Nodes (27): AdmissionResult, admitLocked(), admitPendingMessages(), assertPolicy(), closeTurn(), ContextRow, CONVERSATION_LIMITS, ConversationRow (+19 more)

### Community 73 - "PostgresQueue"
Cohesion: 0.18
Nodes (4): bindTenantContext(), withDispatchScope(), toDiagnostic(), PostgresQueue

### Community 74 - "mail/package.json"
Cohesion: 0.13
Nodes (14): compose.yaml (Docker Compose Stack), postgres Compose service, Configuration Reference, devDependencies, @zeddev/testing, exports, ./testing, @zeddev/testing (+6 more)

### Community 75 - "Conversation Worker Job Handlers"
Cohesion: 0.09
Nodes (22): dependencies, @zeddev/config, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time, devDependencies (+14 more)

### Community 76 - "Schema Migrations Runner"
Cohesion: 0.10
Nodes (19): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/secrets, devDependencies, @zeddev/schema, @zeddev/testing (+11 more)

### Community 77 - "disclosure.test.ts"
Cohesion: 0.36
Nodes (9): DISCLOSURE_MODES, disclosureModeFor(), fromRow(), parseDisclosureInput(), readDisclosureSetting(), saveDisclosureSetting(), choose(), directives() (+1 more)

### Community 78 - "IdentityService"
Cohesion: 0.21
Nodes (8): IdentityPolicy, Action, ClientPrincipal, OperatorPrincipal, Principal, principalId(), IdentityService, ScryptParams

### Community 79 - "worker.ts"
Cohesion: 0.16
Nodes (15): DELIVERY_JOB_KIND, DeliveryAttemptOutcome, AggregationPolicy, PreparedTurn, JobBoard, TURN_JOB_KIND, TurnScheduler, conversationHandlers() (+7 more)

### Community 80 - "whatsapp/package.json"
Cohesion: 0.07
Nodes (26): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/time, @zeddev/vault (+18 more)

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
Cohesion: 0.28
Nodes (4): withInboundScope(), attributeInboundNumber(), recordInboundRejection(), APP_SECRET

### Community 86 - "service.ts"
Cohesion: 0.12
Nodes (13): ClientSessionIssued, decoyHash(), OperatorSessionIssued, Outcome, SignUpInput, SignUpResult, TenantProvisioning, TOKEN_REJECTIONS (+5 more)

### Community 87 - "scheduler/tsconfig.json"
Cohesion: 0.40
Nodes (4): **/*.ts, ../../../tsconfig.base.json, extends, include

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

### Community 98 - "Errors Package Dependencies"
Cohesion: 0.25
Nodes (7): **/node_modules/**, scripts/**/*.ts, src/**/*.ts, exclude, extends, include, ./tsconfig.base.json

### Community 99 - "HTTP Package Dependencies"
Cohesion: 0.29
Nodes (6): dependencies, exports, name, private, type, version

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
Cohesion: 0.14
Nodes (12): AdapterDependencies, answer(), GEMINI_ENV, OPENAI_ENV, createAiProvider(), readBody(), startAiStub(), AiProvider (+4 more)

### Community 132 - "conversation/index.ts"
Cohesion: 0.12
Nodes (31): ContextTurn, renderConversation(), RenderedConversation, renderMessage(), text(), TurnMessage, unsupportedNote(), cleanTranscript() (+23 more)

### Community 134 - "credentials.ts"
Cohesion: 0.22
Nodes (14): assertBusinessName(), COMMON_PASSWORD_STEMS, emailLocalPart(), isSequentialRun(), isSingleRepeatedCharacter(), MAX_BUSINESS_NAME_LENGTH, MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH (+6 more)

### Community 137 - "cloud.ts"
Cohesion: 0.10
Nodes (24): Decision: cloudFailureDeterminacy for retry-without-duplication, assertSendableText(), businessVerificationBlocked(), classifyCloudFailure(), CLOUD_ERROR_CODES, CLOUD_RECOVERABLE_REASONS, cloudFailure(), cloudFailureDeterminacy() (+16 more)

### Community 138 - "runAttempts"
Cohesion: 0.33
Nodes (5): once(), rejectionCode(), runAttempts(), TRANSIENT_STATUSES, InMemoryAiProvider

### Community 139 - "identity/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, @zeddev/schema, @zeddev/testing, exports, @zeddev/schema, @zeddev/testing, name, private (+2 more)

### Community 141 - "TenantObjectStore"
Cohesion: 0.23
Nodes (4): TenantObjectStore, assertTenantId(), isTenantId(), normalizeTenantId()

### Community 143 - "tokens.ts"
Cohesion: 0.40
Nodes (6): claimedTokenKind(), hashToken(), hasTokenKind(), TOKEN_KINDS, TOKEN_PREFIXES, TokenKind

## Knowledge Gaps
- **593 isolated node(s):** `OutcomeRow`, `ConfigSection`, `name`, `version`, `private` (+588 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Implementation Plan` connect `Implementation Plan` to `cloud.ts`, `mail/package.json`, `conversation/package.json`, `Cost-Efficient Operation Spec`?**
  _High betweenness centrality (0.137) - this node is a cross-community bridge._
- **Why does `cloudFailureDeterminacy()` connect `cloud.ts` to `whatsapp/index.ts`, `delivery.ts`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._
- **Why does `Decision: cloudFailureDeterminacy for retry-without-duplication` connect `cloud.ts` to `Implementation Plan`?**
  _High betweenness centrality (0.134) - this node is a cross-community bridge._
- **What connects `OutcomeRow`, `ConfigSection`, `name` to the rest of the system?**
  _593 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Connection` be split into smaller, more focused modules?**
  _Cohesion score 0.05039193729003359 - nodes in this community are weakly interconnected._
- **Should `onboarding.test.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08974358974358974 - nodes in this community are weakly interconnected._
- **Should `errors/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.0797979797979798 - nodes in this community are weakly interconnected._