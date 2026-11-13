# Graph Report - zeddev  (2026-11-13)

## Corpus Check
- 327 files · ~398,937 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3219 nodes · 8709 edges · 154 communities (137 shown, 17 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 66 edges (avg confidence: 0.74)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `783234d8`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- db/connection.ts
- onboarding.test.ts
- db/testing.ts
- Implementation Plan
- errors/index.ts
- client-bot-screens.ts
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
- web/app.test.ts
- api/app.ts
- WhatsApp Inbound Message Recording
- ConfigurationError
- health.ts
- ai/memory.ts
- gemini.ts
- AI Config & Media Type Normalization
- knowledge.test.ts
- secrets/index.ts
- s3.test.ts
- inbound.ts
- whatsapp-gateway/app.test.ts
- screen.ts
- message.ts
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
- disclosure.test.ts
- conversation/package.json
- dependencies
- verification.ts
- persona.ts
- compilerOptions
- handoff.ts
- smtp.ts
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
- ValidationError
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
- time/index.ts
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
- whatsapp/index.ts
- attempts.ts
- codec.ts
- identity/package.json
- TenantObjectStore
- dependencies
- errors.ts
- Writer
- web/package.json
- mail/index.ts
- @zeddev/conversation
- @zeddev/errors
- @zeddev/tenancy
- @zeddev/vault
- conversations-screen.ts
- InMemoryMailer
- ai/config.test.ts

## God Nodes (most connected - your core abstractions)
1. `unitTest()` - 70 edges
2. `specTest()` - 64 edges
3. `ValidationError` - 62 edges
4. `Logger` - 60 edges
5. `Connection` - 57 edges
6. `Secret` - 54 edges
7. `Clock` - 52 edges
8. `Pool` - 51 edges
9. `withIdentityScope()` - 49 edges
10. `withTenant()` - 43 edges

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

## Communities (154 total, 17 thin omitted)

### Community 0 - "db/connection.ts"
Cohesion: 0.15
Nodes (26): NotificationHandler, PendingOperation, QueryResult, SslMode, BackendNotification, bindMessage(), describeMessage(), executeMessage() (+18 more)

### Community 1 - "onboarding.test.ts"
Cohesion: 0.12
Nodes (44): withTenant(), WHATSAPP_ADDRESS, ConnectionStatus, fromRow(), readConnection(), move(), transitionConnection(), assignPhoneNumber() (+36 more)

### Community 2 - "db/testing.ts"
Cohesion: 0.18
Nodes (17): adminOptions(), createTestDatabase(), envValue(), maintenanceDatabase(), onAdmin(), SKIP_REASON, TestDatabase, testDatabaseConfigured() (+9 more)

### Community 3 - "Implementation Plan"
Cohesion: 0.13
Nodes (37): compose.yaml (Docker Compose Stack), postgres Compose service, Decision: Readiness defined once in SQL with triggers, Decision: Round-robin tenant-fair queue dispatch, Decision: Hand-written PostgreSQL client, Decision: Hand-written SigV4 signer and HTTP client, Decision: Log redaction as an allowlist, Decision: Migrations are forward-only (+29 more)

### Community 4 - "errors/index.ts"
Cohesion: 0.10
Nodes (18): AiGenerationError, AiRequestRejectedError, AuthorizationError, ConnectionRevokedError, DuplicateError, ERROR_KINDS, ErrorContext, ErrorKind (+10 more)

### Community 5 - "client-bot-screens.ts"
Cohesion: 0.11
Nodes (46): accountScreen(), capitalize(), checkboxes(), Disclosure, DISCLOSURE_LABELS, disclosureScreen(), Fallback, FALLBACK_TRIGGERS (+38 more)

### Community 6 - "storage/memory.ts"
Cohesion: 0.18
Nodes (19): InMemoryTenantObjectStore, StoredEntry, parseDate(), S3TenantObjectStore, sha256Hex(), assertContentType(), assertObjectId(), assertObjectKind() (+11 more)

### Community 7 - "db/index.ts"
Cohesion: 0.15
Nodes (22): ConnectionOptions, DatabaseConfig, AppliedMigration, appliedMigrations(), checksum(), loadMigrations(), migrate(), MigrateResult (+14 more)

### Community 8 - "reply.ts"
Cohesion: 0.08
Nodes (35): resolveFallbackMessage(), handoffDirectives(), resolveHandoffSignal(), personaDirectives(), describeReplyDecision(), FALLBACK_CAUSES, FallbackCause, fallbackDecision() (+27 more)

### Community 9 - "mail/fixtures.ts"
Cohesion: 0.11
Nodes (18): MailFixture, api(), DecodedMail, decodeEncodedWords(), decodeMail(), envValue(), MailpitSummary, mailTestConfigured() (+10 more)

### Community 10 - "logging/index.ts"
Cohesion: 0.09
Nodes (18): Diagnostic, JsonLinesSink, LEVEL_RANK, LOG_LEVELS, LogFields, LoggerOptions, LogLevel, LogRecord (+10 more)

### Community 11 - "testing/index.ts"
Cohesion: 0.10
Nodes (25): bySpec, coverageFile, entries, specs, uncovered, workDir, REFERENCE_PATH, runMailConformance() (+17 more)

### Community 12 - "Diagnostics, Preflight Checks & Logging"
Cohesion: 0.05
Nodes (36): dependencies, @zeddev/ai, @zeddev/config, @zeddev/conversation, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue (+28 more)

### Community 13 - "graph.ts"
Cohesion: 0.11
Nodes (26): assertCloudCredentials(), assertSendableText(), BusinessAccountProfile, CloudCredentials, CloudDescriptor, MediaRequest, mediaTooLarge(), NumberProfile (+18 more)

### Community 14 - "ai/index.ts"
Cohesion: 0.13
Nodes (31): AI_CANDIDATE_CONFIG_SCHEMA, AI_CONFIG_SCHEMA, AiCandidateConfig, AiConfig, loadAiCandidateSettings(), loadAiConfig(), loadAiSettings(), settingsFrom() (+23 more)

### Community 15 - "bot/index.ts"
Cohesion: 0.17
Nodes (25): ACTIVATION_CAUSES, ActivationCause, ActivationEvent, BotStatus, describeBotStatus(), fromRow(), listBotStatuses(), mayAutoRespond() (+17 more)

### Community 16 - "web/app.test.ts"
Cohesion: 0.12
Nodes (23): RFC-9110, createWeb(), endToEnd(), HOP_BY_HOP, PAGE_CSP, PAGE_HEADERS, Seen, Web (+15 more)

### Community 17 - "api/app.ts"
Cohesion: 0.08
Nodes (36): verifyAiProvider(), AuthenticationError, HttpError, readBody(), SECURITY_HEADERS, ACCEPTED, Api, ApiDependencies (+28 more)

### Community 18 - "WhatsApp Inbound Message Recording"
Cohesion: 0.13
Nodes (31): Configuration-Driven Behavior (No Environment Branching), Environment Portability, Fallback Message Precedence Order, Fallback Response Behavior, Fixed, Non-Generated Fallback Text, Per-Conversation Handoff Pause Scope, Handoff Trigger Conditions, Human Handoff (+23 more)

### Community 19 - "ConfigurationError"
Cohesion: 0.14
Nodes (22): loadAll(), loadConfig(), createPool(), loadDatabaseConfig(), ConfigurationError, IDENTITY_CONFIG_SCHEMA, IdentityConfig, loadIdentityPolicy() (+14 more)

### Community 20 - "health.ts"
Cohesion: 0.07
Nodes (61): compareValues(), CONNECTION_SEVERITY, ConnectionFilter, connectionStatus(), describeCurrent(), describeRange(), describeTenant(), listConnectionHealth() (+53 more)

### Community 21 - "ai/memory.ts"
Cohesion: 0.11
Nodes (20): AiFixture, AiFixtureOptions, AiHarness, ALL, JPEG, OGG, PNG, rejection() (+12 more)

### Community 22 - "gemini.ts"
Cohesion: 0.17
Nodes (25): base64(), asRecord(), contentFiltered(), emptyResponse(), malformedResponse(), safeProviderCode(), tokenCount(), decode() (+17 more)

### Community 23 - "AI Config & Media Type Normalization"
Cohesion: 0.07
Nodes (27): devDependencies, @types/node, typescript, engines, node, name, private, scripts (+19 more)

### Community 24 - "knowledge.test.ts"
Cohesion: 0.08
Nodes (40): createKnowledgeEntry(), deleteKnowledgeEntry(), describeKnowledge(), describeKnowledgeEntry(), describeKnowledgeStatus(), entryContent(), entryId(), entryNotFound() (+32 more)

### Community 25 - "secrets/index.ts"
Cohesion: 0.11
Nodes (33): generateSealingKey(), parseSealingKey(), SCRYPT_DEFAULTS, SealingKey, SECRET_CLASSES, SecretAccessRecord, SecretClass, secretRef() (+25 more)

### Community 26 - "s3.test.ts"
Cohesion: 0.11
Nodes (15): HarnessOptions, StorageHarness, createTestBucket(), envValue(), SKIP_REASON, storageTestConfigured(), TestBucket, TransportResponse (+7 more)

### Community 27 - "inbound.ts"
Cohesion: 0.10
Nodes (27): withInboundScope(), arrayOf(), attributeInboundNumber(), fromRow(), INBOUND_MESSAGE_TYPES, INBOUND_QUEUE, INBOUND_REJECTION_REASONS, InboundContent (+19 more)

### Community 28 - "whatsapp-gateway/app.test.ts"
Cohesion: 0.12
Nodes (17): WhatsAppConfig, INBOUND_JOB_KIND, InboundBatch, InboundRejection, createGateway(), digest(), Gateway, GatewayDependencies (+9 more)

### Community 29 - "screen.ts"
Cohesion: 0.09
Nodes (20): ActivationHistory, Attempt, BotStatus, CONDITION_LINKS, Connection, VERIFICATION_FAILURES, Child, ESCAPES (+12 more)

### Community 30 - "message.ts"
Cohesion: 0.13
Nodes (24): BASE, memoryHarness, MINIMAL_ENV, ADDRESS_FORBIDDEN, assertEnvelopeAddress(), assertHeaderText(), base64Body(), buildMessage() (+16 more)

### Community 31 - "transcript.ts"
Cohesion: 0.06
Nodes (52): BotEntry, CONVERSATION_LIST_FIELDS, ConversationListPage, ConversationListQuery, ConversationSummary, cursorOf(), CustomerEntry, CustomerEntryBase (+44 more)

### Community 32 - "whatsapp/memory.ts"
Cohesion: 0.10
Nodes (31): Decision: cloudFailureDeterminacy for retry-without-duplication, businessVerificationBlocked(), cloudFailureDeterminacy(), cloudFailureReason(), isMediaTooLarge(), CloudFixture, CloudHarness, runWhatsAppCloudConformance() (+23 more)

### Community 33 - "recovery.test.ts"
Cohesion: 0.10
Nodes (23): ConflictError, DefectError, CONNECTION_ERROR_REASONS, CONNECTION_STATES, CONNECTION_TRANSITIONS, connectionHistory(), ConnectionRow, ConnectionState (+15 more)

### Community 34 - "turns.test.ts"
Cohesion: 0.07
Nodes (17): CONVERSATION_LIMITS, at(), BoardFailure, BoardJob, cloudBackend, deliveryOf(), handoffTenant(), instructionsFor() (+9 more)

### Community 35 - "dependencies"
Cohesion: 0.06
Nodes (34): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/monitoring, @zeddev/queue, @zeddev/schema (+26 more)

### Community 36 - "scheduler/start.test.ts"
Cohesion: 0.17
Nodes (13): loadSchedulerSettings(), SCHEDULER_CONFIG_SCHEMA, SchedulerConfig, SchedulerSettings, logger, runSchedule(), ScheduledTask, RunningScheduler (+5 more)

### Community 37 - "config/index.ts"
Cohesion: 0.10
Nodes (28): target, BaseSpec, BooleanSpec, ConfigSpec, ConfigValueType, DURATION_UNITS, DurationSpec, EnumSpec (+20 more)

### Community 38 - "shell.ts"
Cohesion: 0.19
Nodes (25): isPagePath(), AREA_SESSIONS, failedToLoadView(), frame(), notFoundView(), failureMessages(), failureView(), api (+17 more)

### Community 39 - "delivery.ts"
Cohesion: 0.14
Nodes (20): claimDelivery(), DELIVERY_FAILURES, DELIVERY_LIMITS, DELIVERY_PRINCIPAL, DELIVERY_STATES, DeliveryClaim, DeliveryFailure, deliveryJob() (+12 more)

### Community 40 - "behavior.ts"
Cohesion: 0.10
Nodes (41): ACTION_DIRECTIVES, BEHAVIOR_LIMITS, BehaviorConfiguration, behaviorDirectives(), BehaviorRule, clearBehaviorInstructions(), CONDITION_BY_KIND, createBehaviorRule() (+33 more)

### Community 41 - "disclosure.test.ts"
Cohesion: 0.17
Nodes (20): describeDisclosureSetting(), DISCLOSURE_FIELDS, DISCLOSURE_MODES, disclosureDirectives(), DisclosureMode, disclosureModeFor(), DisclosureRow, DisclosureSetting (+12 more)

### Community 42 - "conversation/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, @zeddev/schema, @zeddev/testing, exports, @zeddev/schema, @zeddev/testing, name, private (+2 more)

### Community 43 - "dependencies"
Cohesion: 0.11
Nodes (19): dependencies, @zeddev/ai, @zeddev/bot, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue, @zeddev/secrets (+11 more)

### Community 44 - "verification.ts"
Cohesion: 0.10
Nodes (23): CHECK_CAPABILITY, describeDecision(), EPOCH, EXPECTED, mediaCheck(), parseVerificationInput(), pngChunk(), ProviderVerification (+15 more)

### Community 45 - "persona.ts"
Cohesion: 0.15
Nodes (23): phrase(), clearFreeformInstructions(), describePersona(), Formality, FORMALITY_DIRECTIVES, FORMALITY_LEVELS, fromRow(), parsePersonaInput() (+15 more)

### Community 46 - "compilerOptions"
Cohesion: 0.06
Nodes (29): dom, dom.iterable, es2023, node, shell.ts, compilerOptions, lib, types (+21 more)

### Community 47 - "handoff.ts"
Cohesion: 0.11
Nodes (32): conditionList(), describeHandoffSettings(), enabledFlag(), fromRow(), HANDOFF_FIELDS, HANDOFF_LIMITS, HANDOFF_TRIGGER_DESCRIPTIONS, HANDOFF_TRIGGERS (+24 more)

### Community 48 - "smtp.ts"
Cohesion: 0.10
Nodes (16): RFC-821, BuiltMessage, dataTerminator(), dotStuff(), asConfigurationError(), assertCommandSafe(), AttemptState, Phase (+8 more)

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
Cohesion: 0.05
Nodes (37): dependencies, @zeddev/ai, @zeddev/api, @zeddev/config, @zeddev/conversation-worker, @zeddev/db, @zeddev/identity, @zeddev/logging (+29 more)

### Community 53 - "s3.ts"
Cohesion: 0.16
Nodes (17): AgentOptions, createTransport(), RequestFn, send(), Transport, TransportRequest, ADDRESSING_STYLES, AddressingStyle (+9 more)

### Community 54 - "s3wire.ts"
Cohesion: 0.23
Nodes (13): CREDENTIAL_CODES, decodeEntities(), elementBlocks(), elementText(), ENTITIES, FailureContext, ListedKey, ListPage (+5 more)

### Community 55 - "ai/stubs.ts"
Cohesion: 0.21
Nodes (16): SCRIPTED_FAILURE_STATUS, BASE_PATHS, decodeOpenAiContent(), firstText(), geminiError(), handleGemini(), handleOpenAi(), misbehave() (+8 more)

### Community 56 - "conversation-worker/start.ts"
Cohesion: 0.12
Nodes (16): Config, ConfigSchema, RawEnv, create(), newTenants(), loadGraphCloudSettings(), WHATSAPP_CONFIG_SCHEMA, loadWorkerSettings() (+8 more)

### Community 57 - "identity/index.ts"
Cohesion: 0.05
Nodes (76): withIdentityScope(), withPlatformScope(), ACCESS_PRINCIPAL_TYPES, AccessPrincipalType, AccessRecordInput, DENIAL_REASONS, DenialReason, recordAccess() (+68 more)

### Community 58 - "api/app.test.ts"
Cohesion: 0.12
Nodes (13): Answer, apiWith(), call(), cookieValue(), FAST_SCRYPT, onboard(), POLICY, SEALER (+5 more)

### Community 59 - "S3 Wire Protocol Error Parsing"
Cohesion: 0.07
Nodes (28): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/http, @zeddev/logging, @zeddev/queue, @zeddev/schema (+20 more)

### Community 60 - "dependencies"
Cohesion: 0.08
Nodes (25): dependencies, @zeddev/ai, @zeddev/bot, @zeddev/config, @zeddev/db, @zeddev/identity, @zeddev/logging, @zeddev/mail (+17 more)

### Community 61 - "Backoff & Clock Abstractions"
Cohesion: 0.22
Nodes (8): devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type, version

### Community 62 - "Persona Formality & Text Parsing"
Cohesion: 0.14
Nodes (13): dependencies, @zeddev/db, @zeddev/logging, devDependencies, @zeddev/testing, exports, @zeddev/db, @zeddev/logging (+5 more)

### Community 64 - "queue/index.ts"
Cohesion: 0.24
Nodes (16): DEFAULT_BACKOFF, InMemoryQueueOptions, StoredJob, ClaimRow, PostgresQueueOptions, assertQueueName(), ClaimOptions, digestKey() (+8 more)

### Community 65 - "monitoring/package.json"
Cohesion: 0.10
Nodes (19): dependencies, @zeddev/db, @zeddev/errors, @zeddev/tenancy, @zeddev/whatsapp, devDependencies, @zeddev/schema, @zeddev/testing (+11 more)

### Community 66 - "ValidationError"
Cohesion: 0.18
Nodes (11): ValidationError, STORAGE_CONFIG_SCHEMA, memoryHarness, TENANTS, formatObjectRef(), parseObjectKey(), parseObjectRef(), tenantPrefix() (+3 more)

### Community 67 - "InMemoryObjectStore"
Cohesion: 0.11
Nodes (3): StorageFixture, InMemoryObjectStore, ObjectStore

### Community 68 - "dependencies"
Cohesion: 0.13
Nodes (15): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time (+7 more)

### Community 69 - "fallback.test.ts"
Cohesion: 0.16
Nodes (23): describeFallbackMessages(), FALLBACK_FIELDS, FALLBACK_LIMITS, FALLBACK_TRIGGERS, FallbackInput, fallbackMessageFor(), FallbackMessages, FallbackRow (+15 more)

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
Cohesion: 0.13
Nodes (13): MailHarness, createTestMailbox(), SmtpMailerOptions, create(), HAPPY, instantClock, MESSAGE, ScriptedServer (+5 more)

### Community 78 - "Clock"
Cohesion: 0.12
Nodes (8): InMemoryAiProviderOptions, ConsumerOptions, JobHandler, runConsumer(), sleepQuietly(), waitForSomething(), Queue, Clock

### Community 79 - "worker.ts"
Cohesion: 0.22
Nodes (14): DELIVERY_JOB_KIND, DeliveryAttemptOutcome, AggregationPolicy, PreparedTurn, TURN_JOB_KIND, TurnScheduler, conversationHandlers(), ConversationWorkerDependencies (+6 more)

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
Cohesion: 0.27
Nodes (3): bindTenantContext(), withDispatchScope(), PostgresQueue

### Community 87 - "web/tsconfig.json"
Cohesion: 0.15
Nodes (11): **/*.ts, ../../../tsconfig.base.json, ui/shell.ts, extends, include, extends, include, exclude (+3 more)

### Community 88 - "contract.test.ts"
Cohesion: 0.14
Nodes (15): browser(), FAST_SCRYPT, gatewayMoves(), linkFor(), makeReady(), nextEmail(), onboard(), operator() (+7 more)

### Community 89 - "time/index.ts"
Cohesion: 0.12
Nodes (6): exponentialBackoff(), ExponentialBackoffOptions, FakeClock, Millis, ScheduledTask, SystemClock

### Community 91 - "Tenancy Package Dependencies"
Cohesion: 0.05
Nodes (37): dependencies, @zeddev/config, @zeddev/errors, @zeddev/secrets, @zeddev/time, devDependencies, @zeddev/testing, exports (+29 more)

### Community 93 - "scram.ts"
Cohesion: 0.16
Nodes (13): RFC-5802, RFC-7677, hmac(), md5Password(), parseServerFinal(), parseServerFirst(), pbkdf2, SCRAM_SHA_256 (+5 more)

### Community 94 - "ScriptedCloudBackend"
Cohesion: 0.19
Nodes (4): SentMessage, ScriptedCloudBackend, asRecord(), route()

### Community 95 - "Identity Session Principals"
Cohesion: 0.20
Nodes (9): dependencies, devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type (+1 more)

### Community 96 - "queue/index.test.ts"
Cohesion: 0.21
Nodes (9): HarnessQueueOptions, PAYLOAD, QueueFixture, QueueHarness, runQueueConformance(), drain(), memoryHarness, TENANTS (+1 more)

### Community 97 - "api/package.json"
Cohesion: 0.20
Nodes (9): devDependencies, @zeddev/testing, exports, ./config, @zeddev/testing, name, private, type (+1 more)

### Community 98 - "tsconfig.json"
Cohesion: 0.22
Nodes (8): **/node_modules/**, scripts/**/*.ts, src/services/web/ui/shell.ts, src/**/*.ts, exclude, extends, include, ./tsconfig.base.json

### Community 99 - "HTTP Package Dependencies"
Cohesion: 0.29
Nodes (6): dependencies, exports, name, private, type, version

### Community 100 - "Connection"
Cohesion: 0.15
Nodes (3): Connection, toPostgresFailure(), splitMessages()

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
Cohesion: 0.21
Nodes (7): AdapterDependencies, createAiProvider(), ProviderEntry, AiCapability, AiProviderName, AiSettings, hello

### Community 132 - "conversation/index.ts"
Cohesion: 0.12
Nodes (31): ContextTurn, renderConversation(), RenderedConversation, renderMessage(), text(), TurnMessage, unsupportedNote(), cleanTranscript() (+23 more)

### Community 133 - "Logger"
Cohesion: 0.15
Nodes (10): issuesOf(), issuesOf(), issuesOf(), issuesOf(), issuesOf(), Logger, sanitizeEvent(), keysOf() (+2 more)

### Community 134 - "devDependencies"
Cohesion: 0.11
Nodes (19): devDependencies, @zeddev/ai, @zeddev/api, @zeddev/db, @zeddev/identity, @zeddev/mail, @zeddev/schema, @zeddev/secrets (+11 more)

### Community 135 - "operator-screens.ts"
Cohesion: 0.10
Nodes (33): statusScreen(), conversationsScreen(), entryView(), AiProviderAnswer, aiProviderCard(), BotStatuses, CHECK_NAMES, ConnectionsAnswer (+25 more)

### Community 136 - "api.ts"
Cohesion: 0.17
Nodes (6): Api, ApiError, ApiIssue, ErrorBody, FetchLike, ResponseLike

### Community 137 - "whatsapp/index.ts"
Cohesion: 0.09
Nodes (38): assertMediaRequest(), classifyCloudFailure(), CLOUD_ERROR_CODES, CLOUD_RECOVERABLE_REASONS, cloudFailure(), CloudLinkProbe, describeCloudFailure(), META_ID (+30 more)

### Community 138 - "attempts.ts"
Cohesion: 0.13
Nodes (15): AdapterCore, DEFAULT_AI_BACKOFF, AttemptOutcome, AttemptPolicy, AttemptTimedOut, Failure, MAX_ERROR_BODY_BYTES, MAX_RETRY_WAIT_MS (+7 more)

### Community 139 - "codec.ts"
Cohesion: 0.40
Nodes (9): ARRAY_ELEMENT, arrayLiteral(), decodeValue(), encodeParam(), normalizeTimestampText(), OID, parseArrayText(), rowCountFromTag() (+1 more)

### Community 140 - "identity/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, @zeddev/schema, @zeddev/testing, exports, @zeddev/schema, @zeddev/testing, name, private (+2 more)

### Community 142 - "dependencies"
Cohesion: 0.20
Nodes (10): @zeddev/http, dependencies, @zeddev/config, @zeddev/errors, @zeddev/http, @zeddev/logging, @zeddev/config, @zeddev/logging (+2 more)

### Community 143 - "errors.ts"
Cohesion: 0.39
Nodes (7): CONFIGURATION_CLASSES, FailureContext, mapPostgresFailure(), PostgresFailure, RETRYABLE_CLASSES, RETRYABLE_CODES, VALIDATION_CODES

### Community 145 - "web/package.json"
Cohesion: 0.29
Nodes (6): exports, ./config, name, private, type, version

### Community 146 - "mail/index.ts"
Cohesion: 0.25
Nodes (12): loadMailConfig(), loadSmtpSettings(), MAIL_CONFIG_SCHEMA, MailConfig, RFC-5322, mintMessageId(), MAIL_TLS_MODES, MailMessage (+4 more)

### Community 151 - "conversations-screen.ts"
Cohesion: 0.15
Nodes (15): handoffReason(), HandoffSignal, BotEntry, ConversationList, ConversationSummary, customerBody(), CustomerEntry, DELIVERY (+7 more)

## Knowledge Gaps
- **716 isolated node(s):** `GEMINI_ENV`, `OPENAI_ENV`, `SlotValues`, `PHOTO`, `NOTE` (+711 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **17 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Implementation Plan` connect `Implementation Plan` to `whatsapp/memory.ts`?**
  _High betweenness centrality (0.076) - this node is a cross-community bridge._
- **Why does `cloudFailureDeterminacy()` connect `whatsapp/memory.ts` to `whatsapp/index.ts`, `delivery.ts`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **Why does `Decision: cloudFailureDeterminacy for retry-without-duplication` connect `whatsapp/memory.ts` to `Implementation Plan`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **What connects `GEMINI_ENV`, `OPENAI_ENV`, `SlotValues` to the rest of the system?**
  _716 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `onboarding.test.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11613475177304965 - nodes in this community are weakly interconnected._
- **Should `Implementation Plan` be split into smaller, more focused modules?**
  _Cohesion score 0.13363363363363365 - nodes in this community are weakly interconnected._
- **Should `errors/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.10420168067226891 - nodes in this community are weakly interconnected._