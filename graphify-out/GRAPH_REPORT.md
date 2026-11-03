# Graph Report - zeddev  (2026-11-03)

## Corpus Check
- 282 files · ~347,539 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2690 nodes · 7447 edges · 140 communities (125 shown, 15 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 46 edges (avg confidence: 0.73)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `cf2de347`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- db/connection.ts
- onboarding.test.ts
- db/testing.ts
- Specs Index
- errors/index.ts
- persona.ts
- s3.ts
- db/index.ts
- reply.ts
- mail/fixtures.ts
- logging/index.ts
- testing/index.ts
- Diagnostics, Preflight Checks & Logging
- cloud.ts
- ai/index.ts
- bot/index.ts
- mail/index.ts
- api/app.ts
- WhatsApp Inbound Message Recording
- api/start.ts
- attempts.ts
- ai/memory.ts
- gemini.ts
- AI Config & Media Type Normalization
- knowledge.test.ts
- secrets/index.ts
- s3.test.ts
- whatsapp/index.ts
- whatsapp-gateway/app.test.ts
- IdentityService
- message.ts
- transcript.ts
- whatsapp/memory.ts
- Connection
- turns.test.ts
- codec.ts
- ConfigurationError
- config/index.ts
- scram.ts
- conversation/index.ts
- behavior.ts
- ValidationError
- whatsapp/package.json
- dependencies
- smtp.test.ts
- transcript.test.ts
- Conversation Turn & Handoff Status
- handoff.ts
- SmtpMailer
- objectKey
- DB Package Dependencies
- Identity Access Principals & Authorization
- Storage Package Dependencies
- sigv4.ts
- s3wire.ts
- ai/stubs.ts
- MemorySink
- identity/index.ts
- Clock
- S3 Wire Protocol Error Parsing
- AGENTS.md Package Index & Manifests
- Backoff & Clock Abstractions
- Persona Formality & Text Parsing
- Bot Package Dependencies
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
- .resolveClientSession
- worker.ts
- Conversation Turn Admission & Locking
- Postgres Value Codec
- Identity Package Dependencies
- Tenant Test Fixtures
- Config Package Dependencies
- context.ts
- service.ts
- WhatsApp Package Dependencies
- Mailer
- time/index.ts
- Tenant-Scoped Object Store Wrapper
- Tenancy Package Dependencies
- Identity Package Manifest
- Implementation Plan
- ScriptedCloudBackend
- Identity Session Principals
- ObjectStore
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
- ai/config.ts
- media.ts
- withIdentityScope
- credentials.ts
- graph.test.ts
- WhatsAppCloud
- AiProvider
- identity/package.json
- TenantObjectStore
- tokens.ts

## God Nodes (most connected - your core abstractions)
1. `Connection` - 62 edges
2. `unitTest()` - 62 edges
3. `ValidationError` - 57 edges
4. `specTest()` - 56 edges
5. `Pool` - 55 edges
6. `withIdentityScope()` - 53 edges
7. `Secret` - 52 edges
8. `Logger` - 49 edges
9. `Clock` - 49 edges
10. `withTenant()` - 47 edges

## Surprising Connections (you probably didn't know these)
- `Decision: cloudFailureDeterminacy for retry-without-duplication` --rationale_for--> `cloudFailureDeterminacy()`  [EXTRACTED]
  IMPLEMENTATION_PLAN.md → src/lib/whatsapp/cloud.ts
- `PROMPT_build.md Step 0a (consult graph first)` --semantically_similar_to--> `PROMPT_plan.md Step 0a (consult graph first)`  [INFERRED] [semantically similar]
  PROMPT_build.md → PROMPT_plan.md
- `PROMPT_build.md Step 1 (graph-narrowed implementation search)` --semantically_similar_to--> `PROMPT_plan.md Step 1 (graph-based gap analysis)`  [INFERRED] [semantically similar]
  PROMPT_build.md → PROMPT_plan.md
- `Decision: Readiness defined once in SQL with triggers` --rationale_for--> `Bot Activation Control Spec`  [EXTRACTED]
  IMPLEMENTATION_PLAN.md → specs/bot-activation-control.md
- `Decision: Four-step WhatsApp connection verification state machine` --rationale_for--> `Bot Activation Control Spec`  [EXTRACTED]
  IMPLEMENTATION_PLAN.md → specs/bot-activation-control.md

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

## Communities (140 total, 15 thin omitted)

### Community 0 - "db/connection.ts"
Cohesion: 0.15
Nodes (23): NotificationHandler, PendingOperation, QueryResult, SslMode, BackendNotification, bindMessage(), describeMessage(), executeMessage() (+15 more)

### Community 1 - "onboarding.test.ts"
Cohesion: 0.07
Nodes (58): ConflictError, CONNECTION_ERROR_REASONS, CONNECTION_STATES, CONNECTION_TRANSITIONS, connectionHistory(), ConnectionRow, ConnectionState, ConnectionStatus (+50 more)

### Community 2 - "db/testing.ts"
Cohesion: 0.18
Nodes (17): withPlatformScope(), adminOptions(), createTestDatabase(), envValue(), maintenanceDatabase(), onAdmin(), SKIP_REASON, TestDatabase (+9 more)

### Community 3 - "Specs Index"
Cohesion: 0.30
Nodes (16): Decision: Log redaction as an allowlist, Decision: Tagged first-line reply output protocol, Decision: Tenant isolation enforced in the database via row-level security, Decision: Configured list of sealing keys for tenant secrets, AI Provider Portability Spec, Authentication and Access Spec, Behavior Rules Configuration Spec, Bot Activation Control Spec (+8 more)

### Community 4 - "errors/index.ts"
Cohesion: 0.12
Nodes (16): AiGenerationError, AiRequestRejectedError, AuthorizationError, ConnectionRevokedError, DuplicateError, ERROR_KINDS, ErrorContext, ErrorKind (+8 more)

### Community 5 - "persona.ts"
Cohesion: 0.14
Nodes (23): phrase(), clearFreeformInstructions(), describePersona(), Formality, FORMALITY_DIRECTIVES, FORMALITY_LEVELS, fromRow(), parsePersonaInput() (+15 more)

### Community 6 - "s3.ts"
Cohesion: 0.15
Nodes (28): STORAGE_CONFIG_SCHEMA, memoryHarness, TENANTS, StoredEntry, ADDRESSING_STYLES, AddressingStyle, S3Request, sha256Hex() (+20 more)

### Community 7 - "db/index.ts"
Cohesion: 0.12
Nodes (26): DATABASE_CONFIG_SCHEMA, ConnectionOptions, SSL_MODES, DatabaseConfig, AppliedMigration, appliedMigrations(), checksum(), loadMigrations() (+18 more)

### Community 8 - "reply.ts"
Cohesion: 0.08
Nodes (36): FallbackSource, handoffDirectives(), personaDirectives(), describeReplyDecision(), FALLBACK_CAUSES, FallbackCause, fallbackDecision(), generateReply() (+28 more)

### Community 9 - "mail/fixtures.ts"
Cohesion: 0.10
Nodes (23): MailFixture, MailHarness, runMailConformance(), RFC-3834, api(), createTestMailbox(), DecodedMail, decodeEncodedWords() (+15 more)

### Community 10 - "logging/index.ts"
Cohesion: 0.08
Nodes (23): issuesOf(), issuesOf(), issuesOf(), issuesOf(), issuesOf(), issuesOf(), Diagnostic, LEVEL_RANK (+15 more)

### Community 11 - "testing/index.ts"
Cohesion: 0.09
Nodes (25): bySpec, coverageFile, entries, specs, uncovered, workDir, COMPLETE_ENV, REFERENCE_PATH (+17 more)

### Community 12 - "Diagnostics, Preflight Checks & Logging"
Cohesion: 0.05
Nodes (36): dependencies, @zeddev/ai, @zeddev/config, @zeddev/conversation, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue (+28 more)

### Community 13 - "cloud.ts"
Cohesion: 0.10
Nodes (38): assertCloudCredentials(), assertMediaRequest(), assertSendableText(), BusinessAccountProfile, classifyCloudFailure(), CLOUD_ERROR_CODES, CLOUD_RECOVERABLE_REASONS, CloudCredentials (+30 more)

### Community 14 - "ai/index.ts"
Cohesion: 0.17
Nodes (25): appendPart(), audioMediaType(), baseMediaType(), capabilityRejected(), imageMediaType(), mediaTooLarge(), NormalizedGeneration, NormalizedTranscription (+17 more)

### Community 15 - "bot/index.ts"
Cohesion: 0.17
Nodes (24): ACTIVATION_CAUSES, ActivationCause, ActivationEvent, BotStatus, describeBotStatus(), fromRow(), listBotStatuses(), mayAutoRespond() (+16 more)

### Community 16 - "mail/index.ts"
Cohesion: 0.18
Nodes (17): loadMailConfig(), loadSmtpSettings(), MAIL_CONFIG_SCHEMA, MailConfig, BASE, memoryHarness, MINIMAL_ENV, RFC-5322 (+9 more)

### Community 17 - "api/app.ts"
Cohesion: 0.05
Nodes (51): AuthenticationError, TransientTransportError, HttpError, readBody(), SECURITY_HEADERS, ACCEPTED, Api, ApiDependencies (+43 more)

### Community 18 - "WhatsApp Inbound Message Recording"
Cohesion: 0.13
Nodes (31): Configuration-Driven Behavior (No Environment Branching), Environment Portability, Fallback Message Precedence Order, Fallback Response Behavior, Fixed, Non-Generated Fallback Text, Per-Conversation Handoff Pause Scope, Handoff Trigger Conditions, Human Handoff (+23 more)

### Community 19 - "api/start.ts"
Cohesion: 0.23
Nodes (21): loadAiConfig(), loadAiSettings(), loadAll(), loadConfig(), RawEnv, createPool(), loadDatabaseConfig(), assertTenantIsolationEnforceable() (+13 more)

### Community 20 - "attempts.ts"
Cohesion: 0.13
Nodes (18): AdapterCore, AdapterDependencies, DEFAULT_AI_BACKOFF, AttemptOutcome, AttemptPolicy, AttemptTimedOut, Failure, MAX_ERROR_BODY_BYTES (+10 more)

### Community 21 - "ai/memory.ts"
Cohesion: 0.10
Nodes (23): AiFixture, AiFixtureOptions, AiHarness, ALL, JPEG, OGG, PNG, rejection() (+15 more)

### Community 22 - "gemini.ts"
Cohesion: 0.16
Nodes (24): base64(), asRecord(), contentFiltered(), emptyResponse(), malformedResponse(), safeProviderCode(), tokenCount(), decode() (+16 more)

### Community 23 - "AI Config & Media Type Normalization"
Cohesion: 0.07
Nodes (27): devDependencies, @types/node, typescript, engines, node, name, private, scripts (+19 more)

### Community 24 - "knowledge.test.ts"
Cohesion: 0.14
Nodes (29): createKnowledgeEntry(), deleteKnowledgeEntry(), describeKnowledge(), describeKnowledgeEntry(), describeKnowledgeStatus(), entryContent(), entryId(), entryNotFound() (+21 more)

### Community 25 - "secrets/index.ts"
Cohesion: 0.12
Nodes (30): generateSealingKey(), parseSealingKey(), SCRYPT_DEFAULTS, SealingKey, SECRET_CLASSES, SecretAccessRecord, SecretClass, secretRef() (+22 more)

### Community 26 - "s3.test.ts"
Cohesion: 0.10
Nodes (23): HarnessOptions, runStorageConformance(), StorageFixture, StorageHarness, createTestBucket(), envValue(), SKIP_REASON, storageTestConfigured() (+15 more)

### Community 27 - "whatsapp/index.ts"
Cohesion: 0.12
Nodes (32): withInboundScope(), arrayOf(), assignPhoneNumber(), attributeInboundNumber(), fromRow(), INBOUND_MESSAGE_TYPES, INBOUND_REJECTION_REASONS, InboundBatch (+24 more)

### Community 28 - "whatsapp-gateway/app.test.ts"
Cohesion: 0.12
Nodes (20): endCustomerRef(), INBOUND_JOB_KIND, INBOUND_QUEUE, createGateway(), digest(), Gateway, GatewayDependencies, InboundScheduler (+12 more)

### Community 29 - "IdentityService"
Cohesion: 0.27
Nodes (8): recordAccess(), recordAccessOutOfBand(), assertEmail(), assertPasswordStrength(), IdentityService, secs(), mintToken(), verifyCredential()

### Community 30 - "message.ts"
Cohesion: 0.14
Nodes (21): ADDRESS_FORBIDDEN, assertEnvelopeAddress(), assertHeaderText(), base64Body(), buildMessage(), BuildMessageInput, DAYS, encodeHeaderText() (+13 more)

### Community 31 - "transcript.ts"
Cohesion: 0.09
Nodes (41): BotEntry, CONVERSATION_LIST_FIELDS, ConversationListPage, ConversationSummary, cursorOf(), CustomerEntry, CustomerEntryBase, describeConversationSummary() (+33 more)

### Community 32 - "whatsapp/memory.ts"
Cohesion: 0.13
Nodes (23): AccountState, ANSWER_LOST, CLOUD_OPERATIONS, CloudOperation, DescribedMedia, InMemoryWhatsAppCloudOptions, isAnswerLost(), isScriptedFailure() (+15 more)

### Community 33 - "Connection"
Cohesion: 0.16
Nodes (5): Connection, toPostgresFailure(), parseNotification(), queryMessage(), splitMessages()

### Community 34 - "turns.test.ts"
Cohesion: 0.08
Nodes (14): INBOUND_DISPOSITIONS, BoardFailure, BoardJob, cloudBackend, deliveryOf(), handoffTenant(), liveTenant(), OutcomeRow (+6 more)

### Community 35 - "codec.ts"
Cohesion: 0.40
Nodes (9): ARRAY_ELEMENT, arrayLiteral(), decodeValue(), encodeParam(), normalizeTimestampText(), OID, parseArrayText(), rowCountFromTag() (+1 more)

### Community 36 - "ConfigurationError"
Cohesion: 0.39
Nodes (4): ConfigurationError, loadSealer(), loadVaultConfig(), VAULT_CONFIG_SCHEMA

### Community 37 - "config/index.ts"
Cohesion: 0.10
Nodes (30): target, BaseSpec, BooleanSpec, Config, ConfigSchema, ConfigSpec, ConfigValueType, DURATION_UNITS (+22 more)

### Community 38 - "scram.ts"
Cohesion: 0.15
Nodes (14): RFC-5802, RFC-7677, hmac(), md5Password(), parseServerFinal(), parseServerFirst(), pbkdf2, SCRAM_SHA_256 (+6 more)

### Community 39 - "conversation/index.ts"
Cohesion: 0.21
Nodes (18): claimDelivery(), DELIVERY_FAILURES, DELIVERY_JOB_KIND, DELIVERY_LIMITS, DELIVERY_PRINCIPAL, DELIVERY_STATES, DeliveryAttemptOutcome, DeliveryClaim (+10 more)

### Community 40 - "behavior.ts"
Cohesion: 0.11
Nodes (41): ACTION_DIRECTIVES, BEHAVIOR_LIMITS, BehaviorConfiguration, behaviorDirectives(), BehaviorRule, clearBehaviorInstructions(), CONDITION_BY_KIND, createBehaviorRule() (+33 more)

### Community 41 - "ValidationError"
Cohesion: 0.16
Nodes (23): describeFallbackMessages(), FALLBACK_FIELDS, FALLBACK_LIMITS, FALLBACK_TRIGGERS, FallbackInput, fallbackMessageFor(), FallbackMessages, FallbackRow (+15 more)

### Community 42 - "whatsapp/package.json"
Cohesion: 0.17
Nodes (11): devDependencies, @zeddev/schema, @zeddev/testing, exports, ./testing, @zeddev/schema, @zeddev/testing, name (+3 more)

### Community 43 - "dependencies"
Cohesion: 0.07
Nodes (29): dependencies, @zeddev/ai, @zeddev/bot, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue, @zeddev/secrets (+21 more)

### Community 44 - "smtp.test.ts"
Cohesion: 0.09
Nodes (21): RFC-821, BuiltMessage, asConfigurationError(), assertCommandSafe(), AttemptState, Phase, PHASE_CONFIG_KEYS, replyFailure() (+13 more)

### Community 45 - "transcript.test.ts"
Cohesion: 0.13
Nodes (13): ConversationListQuery, Answer, at(), closeTogether(), conversationOf(), hold(), HUMAN_REQUEST, listAll (+5 more)

### Community 46 - "Conversation Turn & Handoff Status"
Cohesion: 0.10
Nodes (20): es2023, node, compilerOptions, allowImportingTsExtensions, erasableSyntaxOnly, exactOptionalPropertyTypes, isolatedModules, lib (+12 more)

### Community 47 - "handoff.ts"
Cohesion: 0.11
Nodes (32): conditionList(), describeHandoffSettings(), enabledFlag(), fromRow(), HANDOFF_FIELDS, HANDOFF_LIMITS, HANDOFF_TRIGGER_DESCRIPTIONS, HANDOFF_TRIGGERS (+24 more)

### Community 48 - "SmtpMailer"
Cohesion: 0.20
Nodes (3): Session, SmtpMailer, SmtpConnection

### Community 49 - "objectKey"
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

### Community 53 - "sigv4.ts"
Cohesion: 0.25
Nodes (18): amzDate(), canonicalHeaders, canonicalQuery(), canonicalRequest(), canonicalUri(), credentialScope(), EMPTY_PAYLOAD_SHA256, hmac() (+10 more)

### Community 54 - "s3wire.ts"
Cohesion: 0.23
Nodes (13): CREDENTIAL_CODES, decodeEntities(), elementBlocks(), elementText(), ENTITIES, FailureContext, ListedKey, ListPage (+5 more)

### Community 55 - "ai/stubs.ts"
Cohesion: 0.35
Nodes (11): BASE_PATHS, decodeOpenAiContent(), firstText(), geminiError(), handleGemini(), handleOpenAi(), misbehave(), openAiError() (+3 more)

### Community 56 - "MemorySink"
Cohesion: 0.15
Nodes (6): JsonLinesSink, LogSink, MemorySink, NullSink, StartOptions, StartWorkerOptions

### Community 57 - "identity/index.ts"
Cohesion: 0.21
Nodes (18): ACCESS_PRINCIPAL_TYPES, AccessPrincipalType, AccessRecordInput, DENIAL_REASONS, DenialReason, ACTION_PRINCIPALS, actionPrincipalType(), ACTIONS (+10 more)

### Community 58 - "Clock"
Cohesion: 0.12
Nodes (8): ConsumerOptions, JobHandler, runConsumer(), sleepQuietly(), waitForSomething(), InMemoryQueueOptions, Queue, Clock

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
Cohesion: 0.24
Nodes (15): DeliveryScheduler, DEFAULT_BACKOFF, StoredJob, ClaimRow, PostgresQueueOptions, assertQueueName(), ClaimOptions, digestKey() (+7 more)

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
Nodes (3): withDispatchScope(), toDiagnostic(), PostgresQueue

### Community 74 - "mail/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, @zeddev/testing, exports, ./testing, @zeddev/testing, name, private, type (+2 more)

### Community 75 - "Conversation Worker Job Handlers"
Cohesion: 0.09
Nodes (22): dependencies, @zeddev/config, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time, devDependencies (+14 more)

### Community 76 - "Schema Migrations Runner"
Cohesion: 0.10
Nodes (19): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/secrets, devDependencies, @zeddev/schema, @zeddev/testing (+11 more)

### Community 77 - "disclosure.test.ts"
Cohesion: 0.17
Nodes (20): describeDisclosureSetting(), DISCLOSURE_FIELDS, DISCLOSURE_MODES, disclosureDirectives(), DisclosureMode, disclosureModeFor(), DisclosureRow, DisclosureSetting (+12 more)

### Community 78 - ".resolveClientSession"
Cohesion: 0.31
Nodes (3): Action, ClientPrincipal, OperatorPrincipal

### Community 79 - "worker.ts"
Cohesion: 0.18
Nodes (14): recordMediaUnderstanding(), understandTurnMedia(), AggregationPolicy, PreparedTurn, JobBoard, TURN_JOB_KIND, TurnScheduler, conversationHandlers() (+6 more)

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

### Community 85 - "context.ts"
Cohesion: 0.33
Nodes (9): ContextTurn, renderConversation(), RenderedConversation, renderMessage(), text(), TurnMessage, unsupportedNote(), MediaUnderstandingFailure (+1 more)

### Community 86 - "service.ts"
Cohesion: 0.11
Nodes (14): ClientSessionIssued, decoyHash(), OperatorSessionIssued, Outcome, SignUpInput, SignUpResult, TenantProvisioning, TOKEN_REJECTIONS (+6 more)

### Community 87 - "WhatsApp Package Dependencies"
Cohesion: 0.39
Nodes (7): CONFIGURATION_CLASSES, FailureContext, mapPostgresFailure(), PostgresFailure, RETRYABLE_CLASSES, RETRYABLE_CODES, VALIDATION_CODES

### Community 88 - "Mailer"
Cohesion: 0.12
Nodes (3): InMemoryMailer, Mailer, MailOutbox

### Community 89 - "time/index.ts"
Cohesion: 0.12
Nodes (6): exponentialBackoff(), ExponentialBackoffOptions, FakeClock, Millis, ScheduledTask, SystemClock

### Community 91 - "Tenancy Package Dependencies"
Cohesion: 0.05
Nodes (37): dependencies, @zeddev/config, @zeddev/errors, @zeddev/secrets, @zeddev/time, devDependencies, @zeddev/testing, exports (+29 more)

### Community 93 - "Implementation Plan"
Cohesion: 0.15
Nodes (20): compose.yaml (Docker Compose Stack), postgres Compose service, Decision: Readiness defined once in SQL with triggers, Decision: Round-robin tenant-fair queue dispatch, Decision: Hand-written PostgreSQL client, Decision: Hand-written SigV4 signer and HTTP client, Decision: Migrations are forward-only, Decision: Node 24 native TypeScript type stripping, no build step (+12 more)

### Community 94 - "ScriptedCloudBackend"
Cohesion: 0.21
Nodes (3): ScriptedCloudBackend, route(), liveTenant()

### Community 95 - "Identity Session Principals"
Cohesion: 0.20
Nodes (9): dependencies, devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type (+1 more)

### Community 97 - "conversation-worker/start.test.ts"
Cohesion: 0.20
Nodes (6): loadWorkerSettings(), WORKER_CONFIG_SCHEMA, WorkerConfig, WorkerSettings, RunningWorker, SEALING_KEY

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

### Community 131 - "ai/config.ts"
Cohesion: 0.17
Nodes (13): AI_CONFIG_SCHEMA, AiConfig, GEMINI_ENV, OPENAI_ENV, AI_PROVIDERS, createAiProvider(), AiStub, readBody() (+5 more)

### Community 132 - "media.ts"
Cohesion: 0.12
Nodes (20): cleanTranscript(), CONTROL_CHARACTERS, IMAGE_UNDERSTANDING_INSTRUCTIONS, MEDIA_LIMITS, MEDIA_PRINCIPAL, MEDIA_UNDERSTANDING_FAILURES, MediaJobContext, MediaUnderstandingDependencies (+12 more)

### Community 133 - "withIdentityScope"
Cohesion: 0.12
Nodes (16): newTenant(), newTenant(), newTenant(), newTenant(), newTenant(), newTenant(), withIdentityScope(), IdentityPolicy (+8 more)

### Community 134 - "credentials.ts"
Cohesion: 0.22
Nodes (14): assertBusinessName(), COMMON_PASSWORD_STEMS, emailLocalPart(), isSequentialRun(), isSingleRepeatedCharacter(), MAX_BUSINESS_NAME_LENGTH, MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH (+6 more)

### Community 137 - "WhatsAppCloud"
Cohesion: 0.12
Nodes (15): Decision: cloudFailureDeterminacy for retry-without-duplication, feedConnection(), moveConnection(), settleDelivery(), businessVerificationBlocked(), cloudFailureDeterminacy(), cloudFailureReason(), isMediaTooLarge() (+7 more)

### Community 138 - "AiProvider"
Cohesion: 0.23
Nodes (4): answer(), InMemoryAiProvider, AiProvider, TranscriptionResult

### Community 139 - "identity/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, @zeddev/schema, @zeddev/testing, exports, @zeddev/schema, @zeddev/testing, name, private (+2 more)

### Community 143 - "tokens.ts"
Cohesion: 0.40
Nodes (6): claimedTokenKind(), hashToken(), hasTokenKind(), TOKEN_KINDS, TOKEN_PREFIXES, TokenKind

## Knowledge Gaps
- **563 isolated node(s):** `T0`, `HUMAN_REQUEST`, `listAll`, `Stored`, `Issue` (+558 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **15 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Implementation Plan` connect `Implementation Plan` to `WhatsAppCloud`, `mail/package.json`, `Specs Index`?**
  _High betweenness centrality (0.078) - this node is a cross-community bridge._
- **Why does `cloudFailureDeterminacy()` connect `WhatsAppCloud` to `whatsapp/index.ts`, `cloud.ts`, `conversation/index.ts`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **Why does `Decision: cloudFailureDeterminacy for retry-without-duplication` connect `WhatsAppCloud` to `Implementation Plan`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **What connects `T0`, `HUMAN_REQUEST`, `listAll` to the rest of the system?**
  _563 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `onboarding.test.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07355769230769231 - nodes in this community are weakly interconnected._
- **Should `errors/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11954022988505747 - nodes in this community are weakly interconnected._
- **Should `persona.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.14245014245014245 - nodes in this community are weakly interconnected._