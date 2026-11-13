# Graph Report - zeddev  (2026-11-13)

## Corpus Check
- 330 files · ~405,364 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3256 nodes · 8765 edges · 160 communities (144 shown, 16 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 65 edges (avg confidence: 0.74)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3080da26`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- db/connection.ts
- whatsapp/index.ts
- behavior.test.ts
- Implementation Plan
- errors/index.ts
- client-bot-screens.ts
- s3.ts
- db/index.ts
- reply.ts
- mail/fixtures.ts
- logging/index.ts
- testing/index.ts
- dependencies
- cloud.ts
- ai/index.ts
- bot/index.ts
- web/app.test.ts
- api/app.ts
- WhatsApp Inbound Message Recording
- migrateToLatest
- monitoring/index.ts
- ai/memory.ts
- gemini.ts
- AI Config & Media Type Normalization
- knowledge.test.ts
- secrets/index.ts
- s3.test.ts
- inbound.ts
- whatsapp-gateway/app.ts
- screen.ts
- mail/index.ts
- transcript.ts
- whatsapp/memory.ts
- recovery.test.ts
- turns.test.ts
- dependencies
- scheduler/start.test.ts
- config/index.ts
- shell.ts
- delivery.ts
- behavior.ts
- withTenant
- conversation/package.json
- dependencies
- verification.ts
- persona.ts
- compilerOptions
- handoff.ts
- SmtpMailer
- InMemoryAiProvider
- DB Package Dependencies
- Identity Access Principals & Authorization
- dependencies
- identity/index.ts
- s3wire.ts
- ai/stubs.ts
- conversation-worker/start.test.ts
- withIdentityScope
- api/app.test.ts
- dependencies
- dependencies
- Backoff & Clock Abstractions
- Persona Formality & Text Parsing
- Pool
- queue/index.ts
- monitoring/package.json
- S3ObjectStore
- InMemoryObjectStore
- dependencies
- fallback.test.ts
- In-Memory Object Store Tests
- Logging Package Dependencies
- turns.ts
- whatsapp/package.json
- mail/package.json
- Conversation Worker Job Handlers
- Schema Migrations Runner
- smtp.test.ts
- Clock
- worker.ts
- dependencies
- Postgres Value Codec
- Identity Package Dependencies
- Tenant Test Fixtures
- Config Package Dependencies
- sigv4.ts
- PostgresQueue
- web/tsconfig.json
- contract.test.ts
- FakeClock
- InMemoryQueue
- Tenancy Package Dependencies
- Identity Package Manifest
- scram.ts
- ScriptedCloudBackend
- Identity Session Principals
- queue/index.test.ts
- api/package.json
- tsconfig.json
- HTTP Package Dependencies
- Connection
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
- registry.ts
- conversation/index.ts
- Logger
- devDependencies
- operator-screens.ts
- api.ts
- whatsapp/conformance.ts
- attempts.ts
- codec.ts
- identity/package.json
- ValidationError
- dependencies
- service.ts
- Writer
- web/package.json
- smtp.ts
- @zeddev/conversation
- credentials.ts
- conversation-worker/package.json
- deployment/index.ts
- conversations-screen.ts
- Mailer
- ai/config.test.ts
- whatsapp-gateway/package.json
- deployment/package.json
- service.test.ts
- tokens.ts
- portability.test.ts
- withPlatformScope

## God Nodes (most connected - your core abstractions)
1. `unitTest()` - 71 edges
2. `specTest()` - 65 edges
3. `ValidationError` - 62 edges
4. `Logger` - 62 edges
5. `Connection` - 57 edges
6. `withTenant()` - 54 edges
7. `Secret` - 54 edges
8. `withIdentityScope()` - 51 edges
9. `Clock` - 51 edges
10. `Pool` - 45 edges

## Surprising Connections (you probably didn't know these)
- `Decision: cloudFailureDeterminacy for retry-without-duplication` --rationale_for--> `cloudFailureDeterminacy()`  [EXTRACTED]
  IMPLEMENTATION_PLAN.md → src/lib/whatsapp/cloud.ts
- `PROMPT_build.md Step 0a (consult graph first)` --semantically_similar_to--> `PROMPT_plan.md Step 0a (consult graph first)`  [INFERRED] [semantically similar]
  PROMPT_build.md → PROMPT_plan.md
- `PROMPT_build.md Step 1 (graph-narrowed implementation search)` --semantically_similar_to--> `PROMPT_plan.md Step 1 (graph-based gap analysis)`  [INFERRED] [semantically similar]
  PROMPT_build.md → PROMPT_plan.md
- `Decision: Log redaction as an allowlist` --rationale_for--> `Credential and Secret Handling Spec`  [INFERRED]
  IMPLEMENTATION_PLAN.md → specs/credential-and-secret-handling.md
- `Decision: Tenant isolation enforced in the database via row-level security` --rationale_for--> `Credential and Secret Handling Spec`  [INFERRED]
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

## Communities (160 total, 16 thin omitted)

### Community 0 - "db/connection.ts"
Cohesion: 0.17
Nodes (23): NotificationHandler, BackendNotification, bindMessage(), describeMessage(), executeMessage(), frame(), parseDataRow(), parseErrorFields() (+15 more)

### Community 1 - "whatsapp/index.ts"
Cohesion: 0.07
Nodes (78): CLOUD_RECOVERABLE_REASONS, CloudLinkProbe, CONNECTION_ERROR_REASONS, CONNECTION_STATES, CONNECTION_TRANSITIONS, ConnectionErrorReason, connectionHistory(), ConnectionRow (+70 more)

### Community 2 - "behavior.test.ts"
Cohesion: 0.12
Nodes (23): readBehaviorRules(), nextReplyDirectives(), replyConfiguration(), adminOptions(), createTestDatabase(), envValue(), maintenanceDatabase(), onAdmin() (+15 more)

### Community 3 - "Implementation Plan"
Cohesion: 0.13
Nodes (37): compose.yaml (Docker Compose Stack), postgres Compose service, Decision: Readiness defined once in SQL with triggers, Decision: Round-robin tenant-fair queue dispatch, Decision: Hand-written PostgreSQL client, Decision: Hand-written SigV4 signer and HTTP client, Decision: Log redaction as an allowlist, Decision: Migrations are forward-only (+29 more)

### Community 4 - "errors/index.ts"
Cohesion: 0.10
Nodes (19): AiGenerationError, AiRequestRejectedError, AuthenticationError, AuthorizationError, ConnectionRevokedError, DuplicateError, ERROR_KINDS, ErrorContext (+11 more)

### Community 5 - "client-bot-screens.ts"
Cohesion: 0.11
Nodes (46): accountScreen(), capitalize(), checkboxes(), Disclosure, DISCLOSURE_LABELS, disclosureScreen(), Fallback, FALLBACK_TRIGGERS (+38 more)

### Community 6 - "s3.ts"
Cohesion: 0.12
Nodes (35): STORAGE_CONFIG_SCHEMA, memoryHarness, TENANTS, InMemoryTenantObjectStore, StoredEntry, ADDRESSING_STYLES, AddressingStyle, parseDate() (+27 more)

### Community 7 - "db/index.ts"
Cohesion: 0.10
Nodes (34): ConnectionOptions, PendingOperation, QueryResult, SslMode, CONFIGURATION_CLASSES, FailureContext, mapPostgresFailure(), PostgresFailure (+26 more)

### Community 8 - "reply.ts"
Cohesion: 0.07
Nodes (38): BehaviorConfiguration, behaviorDirectives(), enabledBehaviorRules(), ruleDirective(), FallbackSource, handoffDirectives(), KnowledgeConfiguration, describeReplyDecision() (+30 more)

### Community 9 - "mail/fixtures.ts"
Cohesion: 0.10
Nodes (20): MailFixture, api(), createTestMailbox(), DecodedMail, decodeEncodedWords(), decodeMail(), envValue(), MailpitSummary (+12 more)

### Community 10 - "logging/index.ts"
Cohesion: 0.10
Nodes (16): Diagnostic, endCustomerRef(), JsonLinesSink, LEVEL_RANK, LOG_LEVELS, LogFields, LogLevel, LogRecord (+8 more)

### Community 11 - "testing/index.ts"
Cohesion: 0.12
Nodes (20): bySpec, coverageFile, entries, specs, uncovered, workDir, REFERENCE_PATH, runMailConformance() (+12 more)

### Community 12 - "dependencies"
Cohesion: 0.07
Nodes (27): @zeddev/vault, @zeddev/ai, dependencies, @zeddev/ai, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging (+19 more)

### Community 13 - "cloud.ts"
Cohesion: 0.09
Nodes (37): assertCloudCredentials(), assertMediaRequest(), assertSendableText(), BusinessAccountProfile, classifyCloudFailure(), CLOUD_ERROR_CODES, CloudCredentials, CloudDescriptor (+29 more)

### Community 14 - "ai/index.ts"
Cohesion: 0.14
Nodes (31): AI_CANDIDATE_CONFIG_SCHEMA, AI_CONFIG_SCHEMA, AiCandidateConfig, AiConfig, loadAiCandidateSettings(), loadAiConfig(), loadAiSettings(), settingsFrom() (+23 more)

### Community 15 - "bot/index.ts"
Cohesion: 0.18
Nodes (23): ACTIVATION_CAUSES, ActivationCause, ActivationEvent, BotStatus, describeBotStatus(), fromRow(), listBotStatuses(), mayAutoRespond() (+15 more)

### Community 16 - "web/app.test.ts"
Cohesion: 0.12
Nodes (23): RFC-9110, createWeb(), endToEnd(), HOP_BY_HOP, PAGE_CSP, PAGE_HEADERS, Seen, Web (+15 more)

### Community 17 - "api/app.ts"
Cohesion: 0.08
Nodes (42): TransientTransportError, HttpError, readBody(), SECURITY_HEADERS, ACCEPTED, Api, ApiDependencies, CLIENT_COOKIE_PATH (+34 more)

### Community 18 - "WhatsApp Inbound Message Recording"
Cohesion: 0.13
Nodes (31): Configuration-Driven Behavior (No Environment Branching), Environment Portability, Fallback Message Precedence Order, Fallback Response Behavior, Fixed, Non-Generated Fallback Text, Per-Conversation Handoff Pause Scope, Handoff Trigger Conditions, Human Handoff (+23 more)

### Community 19 - "migrateToLatest"
Cohesion: 0.29
Nodes (11): loadAll(), createPool(), loadDatabaseConfig(), loadIdentityPolicy(), migrateToLatest(), option(), readFirstLine(), runCli() (+3 more)

### Community 20 - "monitoring/index.ts"
Cohesion: 0.05
Nodes (78): withHeartbeatScope(), Component, ComponentReason, ComponentReport, COMPONENTS, ComponentState, ComponentStatus, Heartbeat (+70 more)

### Community 21 - "ai/memory.ts"
Cohesion: 0.11
Nodes (21): AiFixture, AiFixtureOptions, AiHarness, ALL, JPEG, OGG, PNG, rejection() (+13 more)

### Community 22 - "gemini.ts"
Cohesion: 0.15
Nodes (27): base64(), asRecord(), contentFiltered(), emptyResponse(), malformedResponse(), safeProviderCode(), tokenCount(), decode() (+19 more)

### Community 23 - "AI Config & Media Type Normalization"
Cohesion: 0.07
Nodes (27): devDependencies, @types/node, typescript, engines, node, name, private, scripts (+19 more)

### Community 24 - "knowledge.test.ts"
Cohesion: 0.09
Nodes (38): createKnowledgeEntry(), deleteKnowledgeEntry(), describeKnowledge(), describeKnowledgeEntry(), describeKnowledgeStatus(), entryContent(), entryId(), entryNotFound() (+30 more)

### Community 25 - "secrets/index.ts"
Cohesion: 0.11
Nodes (33): generateSealingKey(), isSecret(), parseSealingKey(), SCRYPT_DEFAULTS, SealingKey, SECRET_CLASSES, SecretAccessRecord, SecretClass (+25 more)

### Community 26 - "s3.test.ts"
Cohesion: 0.12
Nodes (20): HarnessOptions, StorageHarness, createTestBucket(), envValue(), SKIP_REASON, storageTestConfigured(), TestBucket, AgentOptions (+12 more)

### Community 27 - "inbound.ts"
Cohesion: 0.09
Nodes (29): withInboundScope(), ConflictError, arrayOf(), attributeInboundNumber(), fromRow(), INBOUND_MESSAGE_TYPES, INBOUND_QUEUE, INBOUND_REJECTION_REASONS (+21 more)

### Community 28 - "whatsapp-gateway/app.ts"
Cohesion: 0.12
Nodes (20): WhatsAppConfig, INBOUND_JOB_KIND, InboundBatch, InboundRejection, createGateway(), digest(), Gateway, GatewayDependencies (+12 more)

### Community 29 - "screen.ts"
Cohesion: 0.15
Nodes (13): Child, ESCAPES, escapeText(), render(), CODE_MESSAGES, CONNECTION_TONES, FieldOptions, humanize() (+5 more)

### Community 30 - "mail/index.ts"
Cohesion: 0.10
Nodes (38): loadMailConfig(), loadSmtpSettings(), MAIL_CONFIG_SCHEMA, MailConfig, BASE, memoryHarness, MINIMAL_ENV, RFC-5322 (+30 more)

### Community 31 - "transcript.ts"
Cohesion: 0.06
Nodes (52): BotEntry, CONVERSATION_LIST_FIELDS, ConversationListPage, ConversationListQuery, ConversationSummary, cursorOf(), CustomerEntry, CustomerEntryBase (+44 more)

### Community 32 - "whatsapp/memory.ts"
Cohesion: 0.14
Nodes (23): AccountState, ANSWER_LOST, CLOUD_OPERATIONS, CloudOperation, DescribedMedia, InMemoryWhatsAppCloudOptions, isAnswerLost(), isScriptedFailure() (+15 more)

### Community 33 - "recovery.test.ts"
Cohesion: 0.15
Nodes (10): describeConnection(), AN_HOUR, IMMEDIATE, interrupted(), META_OUTAGE, newTenant(), PROFILE, sweep() (+2 more)

### Community 34 - "turns.test.ts"
Cohesion: 0.07
Nodes (17): CONVERSATION_LIMITS, at(), BoardFailure, BoardJob, cloudBackend, deliveryOf(), handoffTenant(), instructionsFor() (+9 more)

### Community 35 - "dependencies"
Cohesion: 0.06
Nodes (34): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/monitoring, @zeddev/queue, @zeddev/schema (+26 more)

### Community 36 - "scheduler/start.test.ts"
Cohesion: 0.11
Nodes (18): RawEnv, Millis, ScheduledTask, SystemClock, CliIo, loadSchedulerSettings(), SCHEDULER_CONFIG_SCHEMA, SchedulerConfig (+10 more)

### Community 37 - "config/index.ts"
Cohesion: 0.10
Nodes (27): BaseSpec, BooleanSpec, Config, ConfigSchema, ConfigSpec, ConfigValueType, DURATION_UNITS, DurationSpec (+19 more)

### Community 38 - "shell.ts"
Cohesion: 0.19
Nodes (25): isPagePath(), AREA_SESSIONS, failedToLoadView(), frame(), notFoundView(), failureMessages(), failureView(), api (+17 more)

### Community 39 - "delivery.ts"
Cohesion: 0.14
Nodes (20): claimDelivery(), DELIVERY_FAILURES, DELIVERY_LIMITS, DELIVERY_PRINCIPAL, DELIVERY_STATES, DeliveryClaim, DeliveryFailure, deliveryJob() (+12 more)

### Community 40 - "behavior.ts"
Cohesion: 0.11
Nodes (33): ACTION_DIRECTIVES, BEHAVIOR_LIMITS, BehaviorRule, clearBehaviorInstructions(), CONDITION_BY_KIND, createBehaviorRule(), definition(), deleteBehaviorRule() (+25 more)

### Community 41 - "withTenant"
Cohesion: 0.18
Nodes (20): describeDisclosureSetting(), DISCLOSURE_FIELDS, DISCLOSURE_MODES, disclosureDirectives(), DisclosureMode, disclosureModeFor(), DisclosureRow, DisclosureSetting (+12 more)

### Community 42 - "conversation/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, @zeddev/schema, @zeddev/testing, exports, @zeddev/schema, @zeddev/testing, name, private (+2 more)

### Community 43 - "dependencies"
Cohesion: 0.11
Nodes (19): dependencies, @zeddev/ai, @zeddev/bot, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue, @zeddev/secrets (+11 more)

### Community 44 - "verification.ts"
Cohesion: 0.10
Nodes (24): CHECK_CAPABILITY, describeDecision(), EPOCH, EXPECTED, mediaCheck(), parseVerificationInput(), pngChunk(), ProviderVerification (+16 more)

### Community 45 - "persona.ts"
Cohesion: 0.14
Nodes (27): phrase(), conditionList(), clearFreeformInstructions(), describePersona(), Formality, FORMALITY_DIRECTIVES, FORMALITY_LEVELS, fromRow() (+19 more)

### Community 46 - "compilerOptions"
Cohesion: 0.06
Nodes (29): dom, dom.iterable, es2023, node, shell.ts, compilerOptions, lib, types (+21 more)

### Community 47 - "handoff.ts"
Cohesion: 0.12
Nodes (31): describeHandoffSettings(), enabledFlag(), fromRow(), HANDOFF_FIELDS, HANDOFF_LIMITS, HANDOFF_TRIGGER_DESCRIPTIONS, HANDOFF_TRIGGERS, HandoffDecision (+23 more)

### Community 48 - "SmtpMailer"
Cohesion: 0.20
Nodes (3): Session, SmtpMailer, SmtpConnection

### Community 49 - "InMemoryAiProvider"
Cohesion: 0.29
Nodes (6): InMemoryAiProvider, appendPart(), capabilityRejected(), mediaTooLarge(), normalizeGeneration(), normalizeTranscription()

### Community 50 - "DB Package Dependencies"
Cohesion: 0.10
Nodes (20): dependencies, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/time, devDependencies, @zeddev/schema, @zeddev/testing (+12 more)

### Community 51 - "Identity Access Principals & Authorization"
Cohesion: 0.09
Nodes (22): dependencies, @zeddev/config, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time, devDependencies (+14 more)

### Community 52 - "dependencies"
Cohesion: 0.07
Nodes (27): dependencies, @zeddev/ai, @zeddev/api, @zeddev/config, @zeddev/conversation-worker, @zeddev/db, @zeddev/identity, @zeddev/logging (+19 more)

### Community 53 - "identity/index.ts"
Cohesion: 0.18
Nodes (20): ACCESS_PRINCIPAL_TYPES, AccessPrincipalType, AccessRecordInput, DENIAL_REASONS, DenialReason, PasswordContext, Action, ACTION_PRINCIPALS (+12 more)

### Community 54 - "s3wire.ts"
Cohesion: 0.23
Nodes (13): CREDENTIAL_CODES, decodeEntities(), elementBlocks(), elementText(), ENTITIES, FailureContext, ListedKey, ListPage (+5 more)

### Community 55 - "ai/stubs.ts"
Cohesion: 0.21
Nodes (16): SCRIPTED_FAILURE_STATUS, BASE_PATHS, decodeOpenAiContent(), firstText(), geminiError(), handleGemini(), handleOpenAi(), misbehave() (+8 more)

### Community 56 - "conversation-worker/start.test.ts"
Cohesion: 0.17
Nodes (13): loadConfig(), loadWorkerSettings(), WORKER_CONFIG_SCHEMA, WorkerConfig, WorkerSettings, logger, RunningWorker, startWorker() (+5 more)

### Community 57 - "withIdentityScope"
Cohesion: 0.18
Nodes (14): newTenant(), newTenant(), newTenant(), newTenant(), withIdentityScope(), recordAccess(), recordAccessOutOfBand(), assertEmail() (+6 more)

### Community 58 - "api/app.test.ts"
Cohesion: 0.11
Nodes (17): CLIENT_SESSION_COOKIE, Answer, apiWith(), call(), cookieValue(), FAST_SCRYPT, gatewayMoves(), onboard() (+9 more)

### Community 59 - "dependencies"
Cohesion: 0.11
Nodes (19): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/monitoring, @zeddev/queue, @zeddev/schema (+11 more)

### Community 60 - "dependencies"
Cohesion: 0.07
Nodes (29): dependencies, @zeddev/bot, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/identity, @zeddev/logging, @zeddev/mail (+21 more)

### Community 61 - "Backoff & Clock Abstractions"
Cohesion: 0.22
Nodes (8): devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type, version

### Community 62 - "Persona Formality & Text Parsing"
Cohesion: 0.14
Nodes (13): dependencies, @zeddev/db, @zeddev/logging, devDependencies, @zeddev/testing, exports, @zeddev/db, @zeddev/logging (+5 more)

### Community 64 - "queue/index.ts"
Cohesion: 0.27
Nodes (14): DEFAULT_BACKOFF, StoredJob, ClaimRow, PostgresQueueOptions, assertQueueName(), ClaimOptions, digestKey(), EnqueueRequest (+6 more)

### Community 65 - "monitoring/package.json"
Cohesion: 0.09
Nodes (21): dependencies, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/tenancy, @zeddev/whatsapp, devDependencies, @zeddev/schema (+13 more)

### Community 66 - "S3ObjectStore"
Cohesion: 0.21
Nodes (3): TransportResponse, S3ObjectStore, parseObjectKey()

### Community 67 - "InMemoryObjectStore"
Cohesion: 0.11
Nodes (3): StorageFixture, InMemoryObjectStore, ObjectStore

### Community 68 - "dependencies"
Cohesion: 0.13
Nodes (15): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time (+7 more)

### Community 69 - "fallback.test.ts"
Cohesion: 0.18
Nodes (22): describeFallbackMessages(), FALLBACK_FIELDS, FALLBACK_LIMITS, FALLBACK_TRIGGERS, FallbackInput, fallbackMessageFor(), FallbackMessages, FallbackRow (+14 more)

### Community 70 - "In-Memory Object Store Tests"
Cohesion: 0.21
Nodes (15): AST-only code updates vs. semantic doc updates, GRAPH_REPORT.md, Graph Section (AGENTS.md), graphify explain, graphify-out/graph.json, graphify query, /graphify --update (targeted semantic refresh), graphify hook install (post-commit hook) (+7 more)

### Community 71 - "Logging Package Dependencies"
Cohesion: 0.14
Nodes (13): dependencies, @zeddev/errors, @zeddev/secrets, devDependencies, @zeddev/testing, exports, @zeddev/errors, @zeddev/secrets (+5 more)

### Community 72 - "turns.ts"
Cohesion: 0.13
Nodes (27): AdmissionResult, admitLocked(), admitPendingMessages(), assertPolicy(), closeTurn(), ContextRow, ConversationRow, INBOUND_DISPOSITIONS (+19 more)

### Community 73 - "whatsapp/package.json"
Cohesion: 0.17
Nodes (11): devDependencies, @zeddev/schema, @zeddev/testing, exports, ./testing, @zeddev/schema, @zeddev/testing, name (+3 more)

### Community 74 - "mail/package.json"
Cohesion: 0.20
Nodes (9): devDependencies, @zeddev/testing, exports, ./testing, @zeddev/testing, name, private, type (+1 more)

### Community 75 - "Conversation Worker Job Handlers"
Cohesion: 0.09
Nodes (22): dependencies, @zeddev/config, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time, devDependencies (+14 more)

### Community 76 - "Schema Migrations Runner"
Cohesion: 0.10
Nodes (19): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/secrets, devDependencies, @zeddev/schema, @zeddev/testing (+11 more)

### Community 77 - "smtp.test.ts"
Cohesion: 0.14
Nodes (11): MailHarness, SmtpMailerOptions, HAPPY, instantClock, MESSAGE, ScriptedServer, ScriptStep, SETTINGS (+3 more)

### Community 78 - "Clock"
Cohesion: 0.11
Nodes (9): LoggerOptions, ConsumerOptions, JobHandler, runConsumer(), sleepQuietly(), waitForSomething(), Queue, InMemoryObjectStoreOptions (+1 more)

### Community 79 - "worker.ts"
Cohesion: 0.24
Nodes (13): DELIVERY_JOB_KIND, DeliveryAttemptOutcome, AggregationPolicy, PreparedTurn, TURN_JOB_KIND, TurnScheduler, conversationHandlers(), ConversationWorkerDependencies (+5 more)

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

### Community 85 - "sigv4.ts"
Cohesion: 0.25
Nodes (18): amzDate(), canonicalHeaders, canonicalQuery(), canonicalRequest(), canonicalUri(), credentialScope(), EMPTY_PAYLOAD_SHA256, hmac() (+10 more)

### Community 86 - "PostgresQueue"
Cohesion: 0.23
Nodes (3): bindTenantContext(), withDispatchScope(), PostgresQueue

### Community 87 - "web/tsconfig.json"
Cohesion: 0.15
Nodes (11): **/*.ts, ../../../tsconfig.base.json, ui/shell.ts, extends, include, extends, include, exclude (+3 more)

### Community 88 - "contract.test.ts"
Cohesion: 0.14
Nodes (16): browser(), FAST_SCRYPT, gatewayMoves(), linkFor(), makeReady(), nextEmail(), onboard(), operator() (+8 more)

### Community 91 - "Tenancy Package Dependencies"
Cohesion: 0.05
Nodes (37): dependencies, @zeddev/config, @zeddev/errors, @zeddev/secrets, @zeddev/time, devDependencies, @zeddev/testing, exports (+29 more)

### Community 93 - "scram.ts"
Cohesion: 0.16
Nodes (13): RFC-5802, RFC-7677, hmac(), md5Password(), parseServerFinal(), parseServerFirst(), pbkdf2, SCRAM_SHA_256 (+5 more)

### Community 95 - "Identity Session Principals"
Cohesion: 0.20
Nodes (9): dependencies, devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type (+1 more)

### Community 96 - "queue/index.test.ts"
Cohesion: 0.19
Nodes (10): HarnessQueueOptions, PAYLOAD, QueueFixture, QueueHarness, runQueueConformance(), drain(), memoryHarness, TENANTS (+2 more)

### Community 97 - "api/package.json"
Cohesion: 0.20
Nodes (9): devDependencies, @zeddev/testing, exports, ./config, @zeddev/testing, name, private, type (+1 more)

### Community 98 - "tsconfig.json"
Cohesion: 0.22
Nodes (8): **/node_modules/**, scripts/**/*.ts, src/services/web/ui/shell.ts, src/**/*.ts, exclude, extends, include, ./tsconfig.base.json

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

### Community 131 - "registry.ts"
Cohesion: 0.20
Nodes (6): AdapterDependencies, createAiProvider(), ProviderEntry, AiCapability, AiSettings, hello

### Community 132 - "conversation/index.ts"
Cohesion: 0.12
Nodes (31): ContextTurn, renderConversation(), RenderedConversation, renderMessage(), text(), TurnMessage, unsupportedNote(), cleanTranscript() (+23 more)

### Community 133 - "Logger"
Cohesion: 0.12
Nodes (12): issuesOf(), issuesOf(), issuesOf(), issuesOf(), issuesOf(), ConfigurationError, Logger, sanitizeEvent() (+4 more)

### Community 134 - "devDependencies"
Cohesion: 0.11
Nodes (19): devDependencies, @zeddev/ai, @zeddev/api, @zeddev/db, @zeddev/identity, @zeddev/mail, @zeddev/schema, @zeddev/secrets (+11 more)

### Community 135 - "operator-screens.ts"
Cohesion: 0.07
Nodes (47): ActivationHistory, Attempt, BotStatus, CONDITION_LINKS, Connection, connectionScreen(), statusScreen(), VERIFICATION_FAILURES (+39 more)

### Community 136 - "api.ts"
Cohesion: 0.17
Nodes (6): Api, ApiError, ApiIssue, ErrorBody, FetchLike, ResponseLike

### Community 137 - "whatsapp/conformance.ts"
Cohesion: 0.14
Nodes (13): Decision: cloudFailureDeterminacy for retry-without-duplication, businessVerificationBlocked(), cloudFailureDeterminacy(), cloudFailureReason(), isMediaTooLarge(), probeCloudLink(), WhatsAppCloud, CloudFixture (+5 more)

### Community 138 - "attempts.ts"
Cohesion: 0.15
Nodes (15): AdapterCore, DEFAULT_AI_BACKOFF, AttemptOutcome, AttemptPolicy, AttemptTimedOut, Failure, MAX_ERROR_BODY_BYTES, MAX_RETRY_WAIT_MS (+7 more)

### Community 139 - "codec.ts"
Cohesion: 0.40
Nodes (9): ARRAY_ELEMENT, arrayLiteral(), decodeValue(), encodeParam(), normalizeTimestampText(), OID, parseArrayText(), rowCountFromTag() (+1 more)

### Community 140 - "identity/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, @zeddev/schema, @zeddev/testing, exports, @zeddev/schema, @zeddev/testing, name, private (+2 more)

### Community 141 - "ValidationError"
Cohesion: 0.20
Nodes (5): ValidationError, TenantObjectStore, assertTenantId(), isTenantId(), normalizeTenantId()

### Community 142 - "dependencies"
Cohesion: 0.18
Nodes (11): @zeddev/http, dependencies, @zeddev/config, @zeddev/errors, @zeddev/http, @zeddev/logging, @zeddev/config, @zeddev/logging (+3 more)

### Community 143 - "service.ts"
Cohesion: 0.10
Nodes (16): IdentityPolicy, ClientSessionIssued, decoyHash(), IdentityServiceOptions, OperatorSessionIssued, Outcome, SignUpInput, SignUpResult (+8 more)

### Community 145 - "web/package.json"
Cohesion: 0.29
Nodes (6): exports, ./config, name, private, type, version

### Community 146 - "smtp.ts"
Cohesion: 0.14
Nodes (13): RFC-821, BuiltMessage, asConfigurationError(), assertCommandSafe(), AttemptState, Phase, PHASE_CONFIG_KEYS, replyFailure() (+5 more)

### Community 147 - "@zeddev/conversation"
Cohesion: 0.67
Nodes (3): @zeddev/conversation, @zeddev/conversation, @zeddev/conversation

### Community 148 - "credentials.ts"
Cohesion: 0.23
Nodes (14): assertBusinessName(), assertPasswordStrength(), COMMON_PASSWORD_STEMS, emailLocalPart(), isSequentialRun(), isSingleRepeatedCharacter(), MAX_BUSINESS_NAME_LENGTH, MAX_EMAIL_LENGTH (+6 more)

### Community 149 - "conversation-worker/package.json"
Cohesion: 0.17
Nodes (11): devDependencies, @zeddev/bot, @zeddev/testing, exports, ./config, @zeddev/testing, name, private (+3 more)

### Community 150 - "deployment/index.ts"
Cohesion: 0.31
Nodes (8): target, combinedSchema(), configKeys(), ConfigSection, PLATFORM_CONFIG_SCHEMAS, renderPlatformReference(), tableOnly(), LOGGING_CONFIG_SCHEMA

### Community 151 - "conversations-screen.ts"
Cohesion: 0.11
Nodes (16): HandoffSignal, BotEntry, ConversationList, ConversationSummary, customerBody(), CustomerEntry, DELIVERY, Entry (+8 more)

### Community 154 - "whatsapp-gateway/package.json"
Cohesion: 0.20
Nodes (9): devDependencies, @zeddev/testing, exports, ./config, @zeddev/testing, name, private, type (+1 more)

### Community 155 - "deployment/package.json"
Cohesion: 0.22
Nodes (8): devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type, version

### Community 156 - "service.test.ts"
Cohesion: 0.25
Nodes (6): BASE_POLICY, countTenants(), FAST_SCRYPT, nextIdentity(), onboard(), tenantRow()

### Community 157 - "tokens.ts"
Cohesion: 0.57
Nodes (5): claimedTokenKind(), hasTokenKind(), TOKEN_KINDS, TOKEN_PREFIXES, TokenKind

### Community 158 - "portability.test.ts"
Cohesion: 0.38
Nodes (5): scan(), sourceFiles(), SRC_DIR, stripComment(), Violation

## Knowledge Gaps
- **718 isolated node(s):** `DatabaseConfig`, `name`, `version`, `private`, `type` (+713 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `cloudFailureDeterminacy()` connect `whatsapp/conformance.ts` to `whatsapp/index.ts`, `cloud.ts`, `delivery.ts`?**
  _High betweenness centrality (0.051) - this node is a cross-community bridge._
- **Why does `Decision: cloudFailureDeterminacy for retry-without-duplication` connect `whatsapp/conformance.ts` to `Implementation Plan`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **Why does `Implementation Plan` connect `Implementation Plan` to `whatsapp/conformance.ts`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **What connects `DatabaseConfig`, `name`, `version` to the rest of the system?**
  _718 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `whatsapp/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.06894664842681258 - nodes in this community are weakly interconnected._
- **Should `behavior.test.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11746031746031746 - nodes in this community are weakly interconnected._
- **Should `Implementation Plan` be split into smaller, more focused modules?**
  _Cohesion score 0.13363363363363365 - nodes in this community are weakly interconnected._