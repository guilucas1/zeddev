# Graph Report - zeddev  (2026-11-14)

## Corpus Check
- 337 files · ~424,574 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3356 nodes · 8825 edges · 160 communities (149 shown, 11 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 59 edges (avg confidence: 0.73)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5d51f2f5`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- db/connection.ts
- whatsapp/index.ts
- disclosure.test.ts
- Implementation Plan
- errors/index.ts
- client-bot-screens.ts
- recovery.test.ts
- db/index.ts
- reply.ts
- mail/tls.test.ts
- logging/index.ts
- testing/index.ts
- dependencies
- graph.ts
- ai/index.ts
- bot/index.ts
- web/app.test.ts
- api/app.ts
- WhatsApp Inbound Message Recording
- ValidationError
- metrics.ts
- ai/memory.ts
- gemini.ts
- AI Config & Media Type Normalization
- knowledge.ts
- secrets/index.ts
- s3.test.ts
- inbound.ts
- whatsapp-gateway/app.ts
- screen.ts
- mail/index.ts
- transcript.ts
- whatsapp/memory.ts
- connection.test.ts
- turns.test.ts
- dependencies
- scheduler/start.test.ts
- config/index.ts
- shell.ts
- delivery.ts
- behavior.ts
- ConfigurationError
- monitoring/index.ts
- dependencies
- verification.ts
- ai/config.test.ts
- compilerOptions
- handoff.ts
- smtp.ts
- InMemoryAiProvider
- DB Package Dependencies
- Identity Access Principals & Authorization
- dependencies
- identity/index.ts
- health.ts
- conversation-worker/start.ts
- knowledge-selection.test.ts
- withIdentityScope
- api/app.test.ts
- dependencies
- dependencies
- Backoff & Clock Abstractions
- Persona Formality & Text Parsing
- db/testing.ts
- queue/index.ts
- monitoring/package.json
- storage/index.test.ts
- InMemoryObjectStore
- dependencies
- fallback.test.ts
- In-Memory Object Store Tests
- Logging Package Dependencies
- turns.ts
- health.test.ts
- mail/package.json
- Conversation Worker Job Handlers
- Schema Migrations Runner
- Mailer
- deployment/index.ts
- errors.ts
- dependencies
- Postgres Value Codec
- Identity Package Dependencies
- Tenant Test Fixtures
- Config Package Dependencies
- sigv4.ts
- InMemoryQueue
- web/tsconfig.json
- contract.test.ts
- Clock
- scheduler/package.json
- Tenancy Package Dependencies
- socket.ts
- scram.ts
- ScriptedCloudBackend
- Identity Session Principals
- MemorySink
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
- db.sh
- mail.sh
- Conversation Worker tsconfig
- WhatsApp Gateway tsconfig
- Local DB Script (db.sh)
- Local Mail Script (mail.sh)
- storage/memory.ts
- conversation/index.ts
- test-tls.sh
- devDependencies
- operator-screens.ts
- api.ts
- cloud.ts
- Cost-Efficient Operation Spec
- codec.ts
- identity/package.json
- TenantObjectStore
- dependencies
- service.ts
- Writer
- whatsapp-gateway/package.json
- smtp.test.ts
- s3.ts
- credentials.ts
- conversation-worker/package.json
- tiers.test.ts
- api/start.test.ts
- html.ts
- web/package.json
- deployment/package.json
- service.test.ts
- tokens.ts
- worker.ts
- @zeddev/ai
- whatsapp/package.json

## God Nodes (most connected - your core abstractions)
1. `unitTest()` - 73 edges
2. `specTest()` - 68 edges
3. `ValidationError` - 62 edges
4. `Logger` - 60 edges
5. `Secret` - 53 edges
6. `Connection` - 51 edges
7. `withIdentityScope()` - 47 edges
8. `Clock` - 46 edges
9. `ConfigurationError` - 43 edges
10. `withTenant()` - 39 edges

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

## Communities (160 total, 11 thin omitted)

### Community 0 - "db/connection.ts"
Cohesion: 0.16
Nodes (25): NotificationHandler, RFC-6066, BackendNotification, bindMessage(), describeMessage(), executeMessage(), FieldDescription, frame() (+17 more)

### Community 1 - "whatsapp/index.ts"
Cohesion: 0.10
Nodes (50): assertSendableText(), META_ID, WHATSAPP_ADDRESS, ConnectionErrorReason, ConnectionStatus, assignPhoneNumber(), readPhoneNumber(), abandonVerification() (+42 more)

### Community 2 - "disclosure.test.ts"
Cohesion: 0.18
Nodes (19): describeDisclosureSetting(), DISCLOSURE_FIELDS, DISCLOSURE_MODES, disclosureDirectives(), DisclosureMode, disclosureModeFor(), DisclosureRow, DisclosureSetting (+11 more)

### Community 3 - "Implementation Plan"
Cohesion: 0.19
Nodes (27): Decision: Readiness defined once in SQL with triggers, Decision: Round-robin tenant-fair queue dispatch, Decision: Log redaction as an allowlist, Decision: Migrations are forward-only, Decision: Node 24 native TypeScript type stripping, no build step, Decision: cloudFailureDeterminacy for retry-without-duplication, Decision: Tagged first-line reply output protocol, Decision: Ports-and-adapters for every external dependency (+19 more)

### Community 4 - "errors/index.ts"
Cohesion: 0.09
Nodes (23): PendingOperation, tlsFailureIssue(), AiGenerationError, AiRequestRejectedError, AuthenticationError, classifyTlsVerificationFailure(), ConnectionRevokedError, DuplicateError (+15 more)

### Community 5 - "client-bot-screens.ts"
Cohesion: 0.11
Nodes (45): accountScreen(), capitalize(), checkboxes(), Disclosure, DISCLOSURE_LABELS, disclosureScreen(), Fallback, FALLBACK_TRIGGERS (+37 more)

### Community 6 - "recovery.test.ts"
Cohesion: 0.09
Nodes (26): CloudLinkProbe, probeCloudLink(), WhatsAppCloud, claimRecoveryProbe(), listConnectionsDueForRecovery(), recoverOne(), RECOVERY_LIMITS, RECOVERY_PRINCIPAL (+18 more)

### Community 7 - "db/index.ts"
Cohesion: 0.13
Nodes (24): SslMode, DatabaseConfig, AppliedMigration, appliedMigrations(), checksum(), loadMigrations(), MigrateResult, Migration (+16 more)

### Community 8 - "reply.ts"
Cohesion: 0.07
Nodes (39): BehaviorConfiguration, BehaviorRule, handoffDirectives(), resolveHandoffSignal(), KnowledgeConfiguration, knowledgeDirectives(), readKnowledge(), personaDirectives() (+31 more)

### Community 9 - "mail/tls.test.ts"
Cohesion: 0.12
Nodes (24): RFC-2047, RFC-5321, RFC-5322, api(), apiBase(), createTestMailbox(), createTestTlsMailbox(), DecodedMail (+16 more)

### Community 10 - "logging/index.ts"
Cohesion: 0.07
Nodes (24): issuesOf(), issuesOf(), issuesOf(), issuesOf(), issuesOf(), Diagnostic, JsonLinesSink, LEVEL_RANK (+16 more)

### Community 11 - "testing/index.ts"
Cohesion: 0.09
Nodes (25): bySpec, coverageFile, entries, specs, uncovered, workDir, REFERENCE_PATH, MailFixture (+17 more)

### Community 12 - "dependencies"
Cohesion: 0.07
Nodes (27): @zeddev/vault, @zeddev/conversation, dependencies, @zeddev/config, @zeddev/conversation, @zeddev/db, @zeddev/errors, @zeddev/logging (+19 more)

### Community 13 - "graph.ts"
Cohesion: 0.13
Nodes (23): assertCloudCredentials(), assertMediaRequest(), CloudCredentials, CloudDescriptor, MediaRequest, mediaTooLarge(), NumberProfile, RetrievedMedia (+15 more)

### Community 14 - "ai/index.ts"
Cohesion: 0.13
Nodes (33): AI_CANDIDATE_CONFIG_SCHEMA, AI_CONFIG_SCHEMA, AiCandidateConfig, AiConfig, loadAiCandidateSettings(), loadAiConfig(), loadAiSettings(), settingsFrom() (+25 more)

### Community 15 - "bot/index.ts"
Cohesion: 0.18
Nodes (23): ACTIVATION_CAUSES, ActivationCause, ActivationEvent, BotStatus, describeBotStatus(), fromRow(), listBotStatuses(), mayAutoRespond() (+15 more)

### Community 16 - "web/app.test.ts"
Cohesion: 0.12
Nodes (23): RFC-9110, createWeb(), endToEnd(), HOP_BY_HOP, PAGE_CSP, PAGE_HEADERS, Seen, Web (+15 more)

### Community 17 - "api/app.ts"
Cohesion: 0.08
Nodes (37): HttpError, ACCEPTED, ApiDependencies, CLIENT_COOKIE_PATH, CLIENT_SESSION_COOKIE, createApi(), errorName(), OPERATOR_COOKIE_PATH (+29 more)

### Community 18 - "WhatsApp Inbound Message Recording"
Cohesion: 0.13
Nodes (31): Configuration-Driven Behavior (No Environment Branching), Environment Portability, Fallback Message Precedence Order, Fallback Response Behavior, Fixed, Non-Generated Fallback Text, Per-Conversation Handoff Pause Scope, Handoff Trigger Conditions, Human Handoff (+23 more)

### Community 19 - "ValidationError"
Cohesion: 0.15
Nodes (23): clearFreeformInstructions(), describePersona(), Formality, FORMALITY_DIRECTIVES, FORMALITY_LEVELS, fromRow(), parsePersonaInput(), Persona (+15 more)

### Community 20 - "metrics.ts"
Cohesion: 0.12
Nodes (25): parseTenantDetailInput(), PeriodTotals, assessHealth(), attempts(), ceilHour(), floorHour(), HEALTH_THRESHOLDS, isMetricWindow() (+17 more)

### Community 21 - "ai/memory.ts"
Cohesion: 0.08
Nodes (37): AiFixture, AiFixtureOptions, AiHarness, ALL, JPEG, OGG, PNG, rejection() (+29 more)

### Community 22 - "gemini.ts"
Cohesion: 0.15
Nodes (29): base64(), asRecord(), contentFiltered(), emptyResponse(), malformedResponse(), safeProviderCode(), tokenCount(), decode() (+21 more)

### Community 23 - "AI Config & Media Type Normalization"
Cohesion: 0.07
Nodes (27): devDependencies, @types/node, typescript, engines, node, name, private, scripts (+19 more)

### Community 24 - "knowledge.ts"
Cohesion: 0.18
Nodes (20): createKnowledgeEntry(), deleteKnowledgeEntry(), describeKnowledge(), describeKnowledgeEntry(), describeKnowledgeStatus(), entryContent(), entryId(), entryNotFound() (+12 more)

### Community 25 - "secrets/index.ts"
Cohesion: 0.05
Nodes (47): APP_SECRET, call(), Client, env(), eventually(), FAST_SCRYPT, HoldableProvider, onboardClient() (+39 more)

### Community 26 - "s3.test.ts"
Cohesion: 0.14
Nodes (15): HarnessOptions, runStorageConformance(), StorageFixture, StorageHarness, createTestBucket(), envValue(), SKIP_REASON, storageTestConfigured() (+7 more)

### Community 27 - "inbound.ts"
Cohesion: 0.10
Nodes (28): withInboundScope(), arrayOf(), attributeInboundNumber(), fromRow(), INBOUND_MESSAGE_TYPES, INBOUND_QUEUE, INBOUND_REJECTION_REASONS, InboundContent (+20 more)

### Community 28 - "whatsapp-gateway/app.ts"
Cohesion: 0.14
Nodes (20): readBody(), SECURITY_HEADERS, WhatsAppConfig, INBOUND_JOB_KIND, InboundBatch, InboundRejection, createGateway(), digest() (+12 more)

### Community 29 - "screen.ts"
Cohesion: 0.07
Nodes (40): handoffReason(), HandoffSignal, ActivationHistory, Attempt, BotStatus, CONDITION_LINKS, connectionScreen(), statusScreen() (+32 more)

### Community 30 - "mail/index.ts"
Cohesion: 0.09
Nodes (41): loadMailConfig(), loadSmtpSettings(), MAIL_CONFIG_SCHEMA, MailConfig, BASE, memoryHarness, MINIMAL_ENV, RFC-5322 (+33 more)

### Community 31 - "transcript.ts"
Cohesion: 0.06
Nodes (53): DeliveryFailure, DeliveryState, BotEntry, CONVERSATION_LIST_FIELDS, ConversationListPage, ConversationListQuery, ConversationSummary, cursorOf() (+45 more)

### Community 32 - "whatsapp/memory.ts"
Cohesion: 0.14
Nodes (23): AccountState, ANSWER_LOST, CLOUD_OPERATIONS, CloudOperation, DescribedMedia, InMemoryWhatsAppCloudOptions, isAnswerLost(), isScriptedFailure() (+15 more)

### Community 33 - "connection.test.ts"
Cohesion: 0.21
Nodes (17): ConflictError, CONNECTION_ERROR_REASONS, CONNECTION_STATES, CONNECTION_TRANSITIONS, connectionHistory(), ConnectionRow, ConnectionState, ConnectionTransition (+9 more)

### Community 34 - "turns.test.ts"
Cohesion: 0.07
Nodes (17): at(), BoardFailure, BoardJob, cloudBackend, deliveryOf(), handoffTenant(), instructionsFor(), JobBoard (+9 more)

### Community 35 - "dependencies"
Cohesion: 0.11
Nodes (19): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/monitoring, @zeddev/schema, @zeddev/time (+11 more)

### Community 36 - "scheduler/start.test.ts"
Cohesion: 0.17
Nodes (14): loadSchedulerSettings(), SCHEDULER_CONFIG_SCHEMA, SchedulerConfig, SchedulerSettings, runSchedule(), ScheduledTask, RunningScheduler, startScheduler() (+6 more)

### Community 37 - "config/index.ts"
Cohesion: 0.13
Nodes (21): BaseSpec, BooleanSpec, ConfigSchema, ConfigSpec, ConfigValueType, DURATION_UNITS, DurationSpec, EnumSpec (+13 more)

### Community 38 - "shell.ts"
Cohesion: 0.19
Nodes (25): isPagePath(), AREA_SESSIONS, failedToLoadView(), frame(), notFoundView(), failureMessages(), failureView(), api (+17 more)

### Community 39 - "delivery.ts"
Cohesion: 0.16
Nodes (18): claimDelivery(), DELIVERY_FAILURES, DELIVERY_LIMITS, DELIVERY_PRINCIPAL, DELIVERY_STATES, DeliveryClaim, deliveryJob(), DeliveryScheduler (+10 more)

### Community 40 - "behavior.ts"
Cohesion: 0.09
Nodes (39): ACTION_DIRECTIVES, BEHAVIOR_LIMITS, behaviorDirectives(), clearBehaviorInstructions(), CONDITION_BY_KIND, createBehaviorRule(), definition(), deleteBehaviorRule() (+31 more)

### Community 41 - "ConfigurationError"
Cohesion: 0.15
Nodes (17): loadAll(), RawEnv, createPool(), loadDatabaseConfig(), ConfigurationError, IDENTITY_CONFIG_SCHEMA, IdentityConfig, loadIdentityPolicy() (+9 more)

### Community 42 - "monitoring/index.ts"
Cohesion: 0.12
Nodes (25): BACKLOG, BacklogRow, Component, ComponentReason, ComponentReport, COMPONENTS, ComponentState, ComponentStatus (+17 more)

### Community 43 - "dependencies"
Cohesion: 0.07
Nodes (29): dependencies, @zeddev/ai, @zeddev/bot, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue, @zeddev/secrets (+21 more)

### Community 44 - "verification.ts"
Cohesion: 0.10
Nodes (24): CHECK_CAPABILITY, describeDecision(), EPOCH, EXPECTED, mediaCheck(), parseVerificationInput(), pngChunk(), ProviderVerification (+16 more)

### Community 45 - "ai/config.test.ts"
Cohesion: 0.14
Nodes (7): AdapterDependencies, GEMINI_ENV, OPENAI_ENV, createAiProvider(), ProviderEntry, AiProvider, AiSettings

### Community 46 - "compilerOptions"
Cohesion: 0.06
Nodes (29): dom, dom.iterable, es2023, node, shell.ts, compilerOptions, lib, types (+21 more)

### Community 47 - "handoff.ts"
Cohesion: 0.12
Nodes (32): conditionList(), describeHandoffSettings(), enabledFlag(), fromRow(), HANDOFF_FIELDS, HANDOFF_LIMITS, HANDOFF_TRIGGER_DESCRIPTIONS, HANDOFF_TRIGGERS (+24 more)

### Community 48 - "smtp.ts"
Cohesion: 0.11
Nodes (13): RFC-821, BuiltMessage, asConfigurationError(), assertCommandSafe(), AttemptState, Phase, PHASE_CONFIG_KEYS, replyFailure() (+5 more)

### Community 50 - "DB Package Dependencies"
Cohesion: 0.10
Nodes (20): dependencies, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/time, devDependencies, @zeddev/schema, @zeddev/testing (+12 more)

### Community 51 - "Identity Access Principals & Authorization"
Cohesion: 0.09
Nodes (22): dependencies, @zeddev/config, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time, devDependencies (+14 more)

### Community 52 - "dependencies"
Cohesion: 0.07
Nodes (27): dependencies, @zeddev/api, @zeddev/config, @zeddev/conversation-worker, @zeddev/db, @zeddev/identity, @zeddev/logging, @zeddev/mail (+19 more)

### Community 53 - "identity/index.ts"
Cohesion: 0.16
Nodes (20): AuthorizationError, ACCESS_PRINCIPAL_TYPES, AccessPrincipalType, AccessRecordInput, DENIAL_REASONS, DenialReason, Action, ACTION_PRINCIPALS (+12 more)

### Community 54 - "health.ts"
Cohesion: 0.15
Nodes (24): compareValues(), CONNECTION_SEVERITY, ConnectionFilter, connectionStatus(), describeCurrent(), describeRange(), describeTenant(), listConnectionHealth() (+16 more)

### Community 55 - "conversation-worker/start.ts"
Cohesion: 0.20
Nodes (13): Config, loadConfig(), loadGraphCloudSettings(), loadWhatsAppConfig(), WHATSAPP_CONFIG_SCHEMA, loadWorkerSettings(), WORKER_CONFIG_SCHEMA, WorkerConfig (+5 more)

### Community 56 - "knowledge-selection.test.ts"
Cohesion: 0.16
Nodes (13): KNOWLEDGE_LIMITS, KnowledgeEntry, KNOWLEDGE_SELECTION, queryWeights(), saidIn(), scoreEntries(), selectKnowledge(), entry() (+5 more)

### Community 57 - "withIdentityScope"
Cohesion: 0.16
Nodes (17): newTenant(), newTenant(), newTenant(), newTenant(), newTenant(), withIdentityScope(), recordAccess(), recordAccessOutOfBand() (+9 more)

### Community 58 - "api/app.test.ts"
Cohesion: 0.12
Nodes (13): Answer, apiWith(), call(), cookieValue(), FAST_SCRYPT, onboard(), POLICY, SEALER (+5 more)

### Community 59 - "dependencies"
Cohesion: 0.11
Nodes (19): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/monitoring, @zeddev/queue, @zeddev/schema (+11 more)

### Community 60 - "dependencies"
Cohesion: 0.08
Nodes (25): dependencies, @zeddev/bot, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/monitoring, @zeddev/schema (+17 more)

### Community 61 - "Backoff & Clock Abstractions"
Cohesion: 0.22
Nodes (8): devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type, version

### Community 62 - "Persona Formality & Text Parsing"
Cohesion: 0.14
Nodes (13): dependencies, @zeddev/db, @zeddev/logging, devDependencies, @zeddev/testing, exports, @zeddev/db, @zeddev/logging (+5 more)

### Community 63 - "db/testing.ts"
Cohesion: 0.09
Nodes (32): as(), nextReplyDirectives(), replyConfiguration(), ConnectionOptions, withPlatformScope(), withTenant(), adminOptions(), createTestDatabase() (+24 more)

### Community 64 - "queue/index.ts"
Cohesion: 0.07
Nodes (25): DEFAULT_BACKOFF, ConsumerOptions, JobHandler, runConsumer(), sleepQuietly(), waitForSomething(), InMemoryQueueOptions, StoredJob (+17 more)

### Community 65 - "monitoring/package.json"
Cohesion: 0.09
Nodes (21): dependencies, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/tenancy, @zeddev/whatsapp, devDependencies, @zeddev/schema (+13 more)

### Community 66 - "storage/index.test.ts"
Cohesion: 0.16
Nodes (8): STORAGE_CONFIG_SCHEMA, memoryHarness, TENANTS, S3ObjectStore, formatObjectRef(), parseObjectKey(), parseObjectRef(), tenantPrefix()

### Community 68 - "dependencies"
Cohesion: 0.13
Nodes (15): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time (+7 more)

### Community 69 - "fallback.test.ts"
Cohesion: 0.17
Nodes (23): describeFallbackMessages(), FALLBACK_FIELDS, FALLBACK_LIMITS, FALLBACK_TRIGGERS, FallbackInput, fallbackMessageFor(), FallbackMessages, FallbackRow (+15 more)

### Community 70 - "In-Memory Object Store Tests"
Cohesion: 0.21
Nodes (15): AST-only code updates vs. semantic doc updates, GRAPH_REPORT.md, Graph Section (AGENTS.md), graphify explain, graphify-out/graph.json, graphify query, /graphify --update (targeted semantic refresh), graphify hook install (post-commit hook) (+7 more)

### Community 71 - "Logging Package Dependencies"
Cohesion: 0.14
Nodes (13): dependencies, @zeddev/errors, @zeddev/secrets, devDependencies, @zeddev/testing, exports, @zeddev/errors, @zeddev/secrets (+5 more)

### Community 72 - "turns.ts"
Cohesion: 0.12
Nodes (29): AdmissionResult, admitLocked(), admitPendingMessages(), assertPolicy(), closeTurn(), ContextRow, CONVERSATION_LIMITS, ConversationRow (+21 more)

### Community 73 - "health.test.ts"
Cohesion: 0.12
Nodes (10): TenantHealth, TenantHealthQuery, Answer, LAST_DAY, NOW, WEEK_AGO, WITHIN_DAY, HealthFlags (+2 more)

### Community 74 - "mail/package.json"
Cohesion: 0.20
Nodes (9): devDependencies, @zeddev/testing, exports, ./testing, @zeddev/testing, name, private, type (+1 more)

### Community 75 - "Conversation Worker Job Handlers"
Cohesion: 0.09
Nodes (22): dependencies, @zeddev/config, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time, devDependencies (+14 more)

### Community 76 - "Schema Migrations Runner"
Cohesion: 0.10
Nodes (19): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/secrets, devDependencies, @zeddev/schema, @zeddev/testing (+11 more)

### Community 78 - "deployment/index.ts"
Cohesion: 0.22
Nodes (13): target, combinedSchema(), configKeys(), ConfigSection, PLATFORM_CONFIG_SCHEMAS, renderPlatformReference(), tableOnly(), DEPLOYMENT_TIERS (+5 more)

### Community 79 - "errors.ts"
Cohesion: 0.33
Nodes (8): CONFIGURATION_CLASSES, FailureContext, mapPostgresFailure(), PostgresFailure, RETRYABLE_CLASSES, RETRYABLE_CODES, toPostgresFailure(), VALIDATION_CODES

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
Cohesion: 0.21
Nodes (19): amzDate(), canonicalHeaders, canonicalQuery(), canonicalRequest(), canonicalUri(), credentialScope(), EMPTY_PAYLOAD_SHA256, hmac() (+11 more)

### Community 87 - "web/tsconfig.json"
Cohesion: 0.15
Nodes (11): **/*.ts, ../../../tsconfig.base.json, ui/shell.ts, extends, include, extends, include, exclude (+3 more)

### Community 88 - "contract.test.ts"
Cohesion: 0.14
Nodes (15): browser(), FAST_SCRYPT, gatewayMoves(), linkFor(), makeReady(), nextEmail(), onboard(), operator() (+7 more)

### Community 89 - "Clock"
Cohesion: 0.07
Nodes (23): AdapterCore, DEFAULT_AI_BACKOFF, AttemptOutcome, AttemptPolicy, AttemptTimedOut, Failure, MAX_ERROR_BODY_BYTES, MAX_RETRY_WAIT_MS (+15 more)

### Community 90 - "scheduler/package.json"
Cohesion: 0.14
Nodes (13): devDependencies, @zeddev/bot, @zeddev/secrets, @zeddev/testing, exports, ./config, @zeddev/bot, @zeddev/secrets (+5 more)

### Community 91 - "Tenancy Package Dependencies"
Cohesion: 0.05
Nodes (37): dependencies, @zeddev/config, @zeddev/errors, @zeddev/secrets, @zeddev/time, devDependencies, @zeddev/testing, exports (+29 more)

### Community 92 - "socket.ts"
Cohesion: 0.18
Nodes (7): certificateRefusal(), createConnector(), SmtpConnectOptions, SocketConnection, tlsOptions(), RFC-6066, recordingConnector()

### Community 93 - "scram.ts"
Cohesion: 0.15
Nodes (13): RFC-5802, RFC-7677, hmac(), md5Password(), parseServerFinal(), parseServerFirst(), pbkdf2, SCRAM_SHA_256 (+5 more)

### Community 94 - "ScriptedCloudBackend"
Cohesion: 0.21
Nodes (3): BusinessAccountProfile, ScriptedCloudBackend, route()

### Community 95 - "Identity Session Principals"
Cohesion: 0.20
Nodes (9): dependencies, devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type (+1 more)

### Community 96 - "MemorySink"
Cohesion: 0.15
Nodes (11): MemorySink, asleep(), HarnessQueueOptions, PAYLOAD, QueueFixture, QueueHarness, runQueueConformance(), drain() (+3 more)

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
Cohesion: 0.09
Nodes (8): Connection, QueryResult, migrate(), IdleEntry, Pool, Waiter, encrypted(), refusal()

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

### Community 125 - "db.sh"
Cohesion: 0.83
Nodes (3): enable_tls(), db.sh script, upsert_env()

### Community 126 - "mail.sh"
Cohesion: 0.83
Nodes (3): mail.sh script, start_mailpit(), upsert_env()

### Community 131 - "storage/memory.ts"
Cohesion: 0.17
Nodes (20): InMemoryTenantObjectStore, StoredEntry, parseDate(), S3TenantObjectStore, assertContentType(), assertObjectId(), assertObjectKind(), assertOwnedBy() (+12 more)

### Community 132 - "conversation/index.ts"
Cohesion: 0.12
Nodes (31): ContextTurn, renderConversation(), RenderedConversation, renderMessage(), text(), TurnMessage, unsupportedNote(), cleanTranscript() (+23 more)

### Community 134 - "devDependencies"
Cohesion: 0.12
Nodes (17): devDependencies, @zeddev/ai, @zeddev/api, @zeddev/db, @zeddev/identity, @zeddev/mail, @zeddev/schema, @zeddev/testing (+9 more)

### Community 135 - "operator-screens.ts"
Cohesion: 0.07
Nodes (36): AiProviderAnswer, aiProviderCard(), BotStatuses, CHECK_NAMES, COMPONENT_NAMES, COMPONENT_PILLS, COMPONENT_REASONS, ComponentsAnswer (+28 more)

### Community 136 - "api.ts"
Cohesion: 0.17
Nodes (6): Api, ApiError, ApiIssue, ErrorBody, FetchLike, ResponseLike

### Community 137 - "cloud.ts"
Cohesion: 0.11
Nodes (19): businessVerificationBlocked(), classifyCloudFailure(), CLOUD_ERROR_CODES, CLOUD_RECOVERABLE_REASONS, cloudFailure(), cloudFailureDeterminacy(), cloudFailureReason(), describeCloudFailure() (+11 more)

### Community 138 - "Cost-Efficient Operation Spec"
Cohesion: 0.60
Nodes (5): Decision: Hand-written PostgreSQL client, Decision: Hand-written SigV4 signer and HTTP client, Decision: PostgreSQL as the single persistent store, Decision: node:test and npm workspaces, zero test/build dependencies, Cost-Efficient Operation Spec

### Community 139 - "codec.ts"
Cohesion: 0.40
Nodes (9): ARRAY_ELEMENT, arrayLiteral(), decodeValue(), encodeParam(), normalizeTimestampText(), OID, parseArrayText(), rowCountFromTag() (+1 more)

### Community 140 - "identity/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, @zeddev/schema, @zeddev/testing, exports, @zeddev/schema, @zeddev/testing, name, private (+2 more)

### Community 141 - "TenantObjectStore"
Cohesion: 0.23
Nodes (4): TenantObjectStore, assertTenantId(), isTenantId(), normalizeTenantId()

### Community 142 - "dependencies"
Cohesion: 0.18
Nodes (11): @zeddev/http, dependencies, @zeddev/config, @zeddev/errors, @zeddev/http, @zeddev/logging, @zeddev/config, @zeddev/logging (+3 more)

### Community 143 - "service.ts"
Cohesion: 0.12
Nodes (13): IdentityPolicy, ClientSessionIssued, IdentityServiceOptions, OperatorSessionIssued, Outcome, SignUpInput, SignUpResult, TenantProvisioning (+5 more)

### Community 145 - "whatsapp-gateway/package.json"
Cohesion: 0.20
Nodes (9): devDependencies, @zeddev/testing, exports, ./config, @zeddev/testing, name, private, type (+1 more)

### Community 146 - "smtp.test.ts"
Cohesion: 0.13
Nodes (11): MailHarness, SmtpMailerOptions, create(), HAPPY, instantClock, MESSAGE, ScriptedServer, ScriptStep (+3 more)

### Community 147 - "s3.ts"
Cohesion: 0.11
Nodes (30): AgentOptions, createTransport(), RequestFn, send(), Transport, TransportRequest, TransportResponse, ADDRESSING_STYLES (+22 more)

### Community 148 - "credentials.ts"
Cohesion: 0.22
Nodes (14): assertBusinessName(), COMMON_PASSWORD_STEMS, emailLocalPart(), isSequentialRun(), isSingleRepeatedCharacter(), MAX_BUSINESS_NAME_LENGTH, MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH (+6 more)

### Community 149 - "conversation-worker/package.json"
Cohesion: 0.15
Nodes (12): @zeddev/bot, devDependencies, @zeddev/bot, @zeddev/testing, exports, ./config, @zeddev/testing, name (+4 more)

### Community 150 - "tiers.test.ts"
Cohesion: 0.13
Nodes (16): APP_SECRET, browser(), BUSINESSES, Client, converse(), customerWrites(), deploymentValues(), eventually() (+8 more)

### Community 152 - "html.ts"
Cohesion: 0.50
Nodes (4): Child, ESCAPES, escapeText(), render()

### Community 154 - "web/package.json"
Cohesion: 0.29
Nodes (6): exports, ./config, name, private, type, version

### Community 155 - "deployment/package.json"
Cohesion: 0.13
Nodes (14): devDependencies, @zeddev/queue, @zeddev/secrets, @zeddev/testing, exports, name, private, type (+6 more)

### Community 156 - "service.test.ts"
Cohesion: 0.25
Nodes (6): BASE_POLICY, countTenants(), FAST_SCRYPT, nextIdentity(), onboard(), tenantRow()

### Community 157 - "tokens.ts"
Cohesion: 0.40
Nodes (6): claimedTokenKind(), hashToken(), hasTokenKind(), TOKEN_KINDS, TOKEN_PREFIXES, TokenKind

### Community 158 - "worker.ts"
Cohesion: 0.22
Nodes (14): DELIVERY_JOB_KIND, DeliveryAttemptOutcome, AggregationPolicy, PreparedTurn, TURN_JOB_KIND, TurnScheduler, conversationHandlers(), ConversationWorkerDependencies (+6 more)

### Community 159 - "@zeddev/ai"
Cohesion: 0.50
Nodes (4): @zeddev/ai, @zeddev/ai, @zeddev/ai, @zeddev/ai

### Community 161 - "whatsapp/package.json"
Cohesion: 0.11
Nodes (17): compose.yaml (Docker Compose Stack), postgres Compose service, Configuration Reference, devDependencies, @zeddev/schema, @zeddev/testing, exports, ./testing (+9 more)

## Knowledge Gaps
- **730 isolated node(s):** `JobShape`, `FAST_SCRYPT`, `POLICY`, `Answer`, `SEALER` (+725 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `cloudFailureDeterminacy()` connect `cloud.ts` to `whatsapp/index.ts`, `Implementation Plan`, `delivery.ts`?**
  _High betweenness centrality (0.079) - this node is a cross-community bridge._
- **Why does `Implementation Plan` connect `Implementation Plan` to `whatsapp/package.json`, `Cost-Efficient Operation Spec`?**
  _High betweenness centrality (0.073) - this node is a cross-community bridge._
- **Why does `Decision: cloudFailureDeterminacy for retry-without-duplication` connect `Implementation Plan` to `cloud.ts`?**
  _High betweenness centrality (0.072) - this node is a cross-community bridge._
- **What connects `JobShape`, `FAST_SCRYPT`, `POLICY` to the rest of the system?**
  _730 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `whatsapp/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09610389610389611 - nodes in this community are weakly interconnected._
- **Should `errors/index.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09176788124156546 - nodes in this community are weakly interconnected._
- **Should `client-bot-screens.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.11058823529411765 - nodes in this community are weakly interconnected._