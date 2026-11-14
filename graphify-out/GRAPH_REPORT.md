# Graph Report - zeddev  (2026-11-13)

## Corpus Check
- 331 files · ~410,170 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 3282 nodes · 8744 edges · 159 communities (145 shown, 14 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 63 edges (avg confidence: 0.73)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `dff309b9`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- db/connection.ts
- onboarding.test.ts
- ValidationError
- Implementation Plan
- errors/index.ts
- client-bot-screens.ts
- s3.ts
- db/index.ts
- reply.ts
- smtp.test.ts
- logging/index.ts
- testing/index.ts
- dependencies
- graph.ts
- ai/index.ts
- bot/index.ts
- contract.test.ts
- api/app.ts
- WhatsApp Inbound Message Recording
- whatsapp/index.ts
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
- text
- conversation/package.json
- dependencies
- verification.ts
- scheduler/package.json
- compilerOptions
- handoff.ts
- SmtpMailer
- InMemoryAiProvider
- DB Package Dependencies
- Identity Access Principals & Authorization
- dependencies
- identity/index.ts
- Specs Index
- ai/stubs.ts
- api/start.ts
- IdentityService
- api/app.test.ts
- dependencies
- dependencies
- Backoff & Clock Abstractions
- Persona Formality & Text Parsing
- Pool
- queue/index.ts
- monitoring/package.json
- storage/index.test.ts
- Clock
- dependencies
- fallback.test.ts
- In-Memory Object Store Tests
- Logging Package Dependencies
- turns.ts
- queue/index.test.ts
- mail/package.json
- Conversation Worker Job Handlers
- Schema Migrations Runner
- mail/types.ts
- Queue
- storage/http.ts
- whatsapp/package.json
- Postgres Value Codec
- Identity Package Dependencies
- Tenant Test Fixtures
- Config Package Dependencies
- sigv4.ts
- PostgresQueue
- web/tsconfig.json
- routes.ts
- time/index.ts
- InMemoryQueue
- Tenancy Package Dependencies
- Identity Package Manifest
- scram.ts
- ScriptedCloudBackend
- Identity Session Principals
- queue/conformance.ts
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
- @zeddev/ai
- devDependencies
- operator-screens.ts
- api.ts
- whatsapp/conformance.ts
- attempts.ts
- codec.ts
- identity/package.json
- TenantObjectStore
- dependencies
- service.ts
- Writer
- web/package.json
- smtp.ts
- credentials.ts
- conversation-worker/package.json
- deployment/index.ts
- conversations-screen.ts
- Mailer
- ai/config.test.ts
- whatsapp-gateway/package.json
- deployment/package.json
- withIdentityScope
- tokens.ts
- portability.test.ts
- .resolveClientSession

## God Nodes (most connected - your core abstractions)
1. `unitTest()` - 70 edges
2. `specTest()` - 65 edges
3. `ValidationError` - 62 edges
4. `Logger` - 59 edges
5. `Connection` - 54 edges
6. `Secret` - 54 edges
7. `withTenant()` - 52 edges
8. `withIdentityScope()` - 51 edges
9. `Clock` - 46 edges
10. `Pool` - 42 edges

## Surprising Connections (you probably didn't know these)
- `Decision: cloudFailureDeterminacy for retry-without-duplication` --rationale_for--> `cloudFailureDeterminacy()`  [EXTRACTED]
  IMPLEMENTATION_PLAN.md → src/lib/whatsapp/cloud.ts
- `PROMPT_build.md Step 0a (consult graph first)` --semantically_similar_to--> `PROMPT_plan.md Step 0a (consult graph first)`  [INFERRED] [semantically similar]
  PROMPT_build.md → PROMPT_plan.md
- `PROMPT_build.md Step 1 (graph-narrowed implementation search)` --semantically_similar_to--> `PROMPT_plan.md Step 1 (graph-based gap analysis)`  [INFERRED] [semantically similar]
  PROMPT_build.md → PROMPT_plan.md
- `Decision: Tagged first-line reply output protocol` --rationale_for--> `Behavior Rules Configuration Spec`  [EXTRACTED]
  IMPLEMENTATION_PLAN.md → specs/behavior-rules-configuration.md
- `Decision: Readiness defined once in SQL with triggers` --rationale_for--> `Bot Activation Control Spec`  [EXTRACTED]
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

## Communities (159 total, 14 thin omitted)

### Community 0 - "db/connection.ts"
Cohesion: 0.15
Nodes (26): NotificationHandler, PendingOperation, QueryResult, SslMode, BackendNotification, bindMessage(), describeMessage(), executeMessage() (+18 more)

### Community 1 - "onboarding.test.ts"
Cohesion: 0.09
Nodes (45): META_ID, ConnectionStatus, assignPhoneNumber(), readPhoneNumber(), abandonVerification(), beginVerification(), ConnectedNumber, CONNECTION_LIMITS (+37 more)

### Community 2 - "ValidationError"
Cohesion: 0.08
Nodes (44): nextReplyDirectives(), replyConfiguration(), describeDisclosureSetting(), DISCLOSURE_FIELDS, DISCLOSURE_MODES, disclosureDirectives(), DisclosureMode, disclosureModeFor() (+36 more)

### Community 3 - "Implementation Plan"
Cohesion: 0.13
Nodes (24): compose.yaml (Docker Compose Stack), postgres Compose service, Decision: Readiness defined once in SQL with triggers, Decision: Round-robin tenant-fair queue dispatch, Decision: Hand-written PostgreSQL client, Decision: Hand-written SigV4 signer and HTTP client, Decision: Log redaction as an allowlist, Decision: Migrations are forward-only (+16 more)

### Community 4 - "errors/index.ts"
Cohesion: 0.07
Nodes (33): CONFIGURATION_CLASSES, mapPostgresFailure(), RETRYABLE_CLASSES, RETRYABLE_CODES, VALIDATION_CODES, AiGenerationError, AiRequestRejectedError, AuthorizationError (+25 more)

### Community 5 - "client-bot-screens.ts"
Cohesion: 0.12
Nodes (29): capitalize(), checkboxes(), Disclosure, DISCLOSURE_LABELS, Fallback, FALLBACK_TRIGGERS, FallbackPreview, fallbackScreen() (+21 more)

### Community 6 - "s3.ts"
Cohesion: 0.15
Nodes (28): InMemoryTenantObjectStore, StoredEntry, ADDRESSING_STYLES, AddressingStyle, parseDate(), S3Request, S3TenantObjectStore, ListedKey (+20 more)

### Community 7 - "db/index.ts"
Cohesion: 0.13
Nodes (27): ConnectionOptions, FailureContext, PostgresFailure, DatabaseConfig, AppliedMigration, appliedMigrations(), checksum(), loadMigrations() (+19 more)

### Community 8 - "reply.ts"
Cohesion: 0.07
Nodes (38): behaviorDirectives(), enabledBehaviorRules(), ruleDirective(), FallbackSource, handoffDirectives(), KnowledgeConfiguration, personaDirectives(), describeReplyDecision() (+30 more)

### Community 9 - "smtp.test.ts"
Cohesion: 0.09
Nodes (24): MailHarness, api(), createTestMailbox(), decodeEncodedWords(), decodeMail(), envValue(), MailpitSummary, mailTestConfigured() (+16 more)

### Community 10 - "logging/index.ts"
Cohesion: 0.06
Nodes (27): issuesOf(), issuesOf(), issuesOf(), issuesOf(), issuesOf(), Diagnostic, endCustomerRef(), JsonLinesSink (+19 more)

### Community 11 - "testing/index.ts"
Cohesion: 0.11
Nodes (20): bySpec, coverageFile, entries, specs, uncovered, workDir, MailFixture, runMailConformance() (+12 more)

### Community 12 - "dependencies"
Cohesion: 0.07
Nodes (27): @zeddev/vault, @zeddev/conversation, dependencies, @zeddev/config, @zeddev/conversation, @zeddev/db, @zeddev/errors, @zeddev/logging (+19 more)

### Community 13 - "graph.ts"
Cohesion: 0.14
Nodes (22): assertCloudCredentials(), assertMediaRequest(), BusinessAccountProfile, CloudCredentials, CloudDescriptor, MediaRequest, mediaTooLarge(), NumberProfile (+14 more)

### Community 14 - "ai/index.ts"
Cohesion: 0.14
Nodes (31): AI_CANDIDATE_CONFIG_SCHEMA, AI_CONFIG_SCHEMA, AiCandidateConfig, AiConfig, loadAiCandidateSettings(), loadAiConfig(), loadAiSettings(), settingsFrom() (+23 more)

### Community 15 - "bot/index.ts"
Cohesion: 0.10
Nodes (42): ACTIVATION_CAUSES, ActivationCause, ActivationEvent, BotStatus, describeBotStatus(), fromRow(), listBotStatuses(), mayAutoRespond() (+34 more)

### Community 16 - "contract.test.ts"
Cohesion: 0.08
Nodes (35): RFC-9110, createWeb(), endToEnd(), HOP_BY_HOP, PAGE_CSP, PAGE_HEADERS, Seen, Web (+27 more)

### Community 17 - "api/app.ts"
Cohesion: 0.08
Nodes (40): AuthenticationError, ConflictError, TransientTransportError, HttpError, ACCEPTED, ApiDependencies, CLIENT_COOKIE_PATH, CLIENT_SESSION_COOKIE (+32 more)

### Community 18 - "WhatsApp Inbound Message Recording"
Cohesion: 0.13
Nodes (31): Configuration-Driven Behavior (No Environment Branching), Environment Portability, Fallback Message Precedence Order, Fallback Response Behavior, Fixed, Non-Generated Fallback Text, Per-Conversation Handoff Pause Scope, Handoff Trigger Conditions, Human Handoff (+23 more)

### Community 19 - "whatsapp/index.ts"
Cohesion: 0.14
Nodes (30): assertSendableText(), classifyCloudFailure(), CLOUD_ERROR_CODES, CLOUD_RECOVERABLE_REASONS, cloudFailure(), CloudLinkProbe, describeCloudFailure(), REASON_BY_CODE (+22 more)

### Community 20 - "monitoring/index.ts"
Cohesion: 0.05
Nodes (77): withHeartbeatScope(), Component, ComponentReason, ComponentReport, COMPONENTS, ComponentState, ComponentStatus, Heartbeat (+69 more)

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
Cohesion: 0.06
Nodes (45): APP_SECRET, call(), Client, env(), eventually(), FAST_SCRYPT, HoldableProvider, onboardClient() (+37 more)

### Community 26 - "s3.test.ts"
Cohesion: 0.13
Nodes (16): HarnessOptions, runStorageConformance(), StorageFixture, StorageHarness, createTestBucket(), envValue(), SKIP_REASON, storageTestConfigured() (+8 more)

### Community 27 - "inbound.ts"
Cohesion: 0.11
Nodes (28): withInboundScope(), arrayOf(), attributeInboundNumber(), fromRow(), INBOUND_MESSAGE_TYPES, INBOUND_QUEUE, INBOUND_REJECTION_REASONS, InboundContent (+20 more)

### Community 28 - "whatsapp-gateway/app.ts"
Cohesion: 0.10
Nodes (24): readBody(), SECURITY_HEADERS, WhatsAppConfig, INBOUND_JOB_KIND, InboundBatch, InboundRejection, createGateway(), digest() (+16 more)

### Community 29 - "screen.ts"
Cohesion: 0.16
Nodes (12): Child, ESCAPES, escapeText(), render(), CODE_MESSAGES, CONNECTION_TONES, FieldOptions, humanize() (+4 more)

### Community 30 - "mail/index.ts"
Cohesion: 0.10
Nodes (35): loadMailConfig(), loadSmtpSettings(), BASE, memoryHarness, MINIMAL_ENV, RFC-5322, RFC-5322, ADDRESS_FORBIDDEN (+27 more)

### Community 31 - "transcript.ts"
Cohesion: 0.06
Nodes (52): BotEntry, CONVERSATION_LIST_FIELDS, ConversationListPage, ConversationListQuery, ConversationSummary, cursorOf(), CustomerEntry, CustomerEntryBase (+44 more)

### Community 32 - "whatsapp/memory.ts"
Cohesion: 0.14
Nodes (23): AccountState, ANSWER_LOST, CLOUD_OPERATIONS, CloudOperation, DescribedMedia, InMemoryWhatsAppCloudOptions, isAnswerLost(), isScriptedFailure() (+15 more)

### Community 33 - "recovery.test.ts"
Cohesion: 0.11
Nodes (27): CONNECTION_ERROR_REASONS, CONNECTION_STATES, CONNECTION_TRANSITIONS, connectionHistory(), ConnectionRow, ConnectionState, ConnectionTransition, describeConnection() (+19 more)

### Community 34 - "turns.test.ts"
Cohesion: 0.07
Nodes (17): CONVERSATION_LIMITS, at(), BoardFailure, BoardJob, cloudBackend, deliveryOf(), handoffTenant(), instructionsFor() (+9 more)

### Community 35 - "dependencies"
Cohesion: 0.11
Nodes (19): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/monitoring, @zeddev/schema, @zeddev/time (+11 more)

### Community 36 - "scheduler/start.test.ts"
Cohesion: 0.16
Nodes (15): loadSchedulerSettings(), SCHEDULER_CONFIG_SCHEMA, SchedulerConfig, SchedulerSettings, logger, runSchedule(), ScheduledTask, RunningScheduler (+7 more)

### Community 37 - "config/index.ts"
Cohesion: 0.11
Nodes (25): BaseSpec, BooleanSpec, Config, ConfigSchema, ConfigSpec, ConfigValueType, DURATION_UNITS, DurationSpec (+17 more)

### Community 38 - "shell.ts"
Cohesion: 0.20
Nodes (24): isPagePath(), failedToLoadView(), frame(), notFoundView(), failureMessages(), failureView(), api, context (+16 more)

### Community 39 - "delivery.ts"
Cohesion: 0.13
Nodes (20): claimDelivery(), DELIVERY_FAILURES, DELIVERY_JOB_KIND, DELIVERY_LIMITS, DELIVERY_PRINCIPAL, DELIVERY_STATES, DeliveryClaim, DeliveryFailure (+12 more)

### Community 40 - "behavior.ts"
Cohesion: 0.09
Nodes (42): ACTION_DIRECTIVES, BEHAVIOR_LIMITS, BehaviorConfiguration, BehaviorRule, clearBehaviorInstructions(), CONDITION_BY_KIND, createBehaviorRule(), definition() (+34 more)

### Community 41 - "text"
Cohesion: 0.35
Nodes (13): accountScreen(), forgotPasswordScreen(), loginScreen(), operatorLoginScreen(), publicCard(), resetPasswordScreen(), signupScreen(), takeToken() (+5 more)

### Community 42 - "conversation/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, @zeddev/schema, @zeddev/testing, exports, @zeddev/schema, @zeddev/testing, name, private (+2 more)

### Community 43 - "dependencies"
Cohesion: 0.11
Nodes (19): dependencies, @zeddev/ai, @zeddev/bot, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/queue, @zeddev/secrets (+11 more)

### Community 44 - "verification.ts"
Cohesion: 0.10
Nodes (24): CHECK_CAPABILITY, describeDecision(), EPOCH, EXPECTED, mediaCheck(), parseVerificationInput(), pngChunk(), ProviderVerification (+16 more)

### Community 45 - "scheduler/package.json"
Cohesion: 0.14
Nodes (13): devDependencies, @zeddev/bot, @zeddev/secrets, @zeddev/testing, exports, ./config, @zeddev/bot, @zeddev/secrets (+5 more)

### Community 46 - "compilerOptions"
Cohesion: 0.06
Nodes (29): dom, dom.iterable, es2023, node, shell.ts, compilerOptions, lib, types (+21 more)

### Community 47 - "handoff.ts"
Cohesion: 0.12
Nodes (31): describeHandoffSettings(), enabledFlag(), fromRow(), HANDOFF_FIELDS, HANDOFF_LIMITS, HANDOFF_TRIGGER_DESCRIPTIONS, HANDOFF_TRIGGERS, HandoffDecision (+23 more)

### Community 48 - "SmtpMailer"
Cohesion: 0.19
Nodes (4): replyFailure(), Session, SmtpMailer, SmtpConnection

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
Nodes (27): dependencies, @zeddev/api, @zeddev/config, @zeddev/conversation-worker, @zeddev/db, @zeddev/identity, @zeddev/logging, @zeddev/mail (+19 more)

### Community 53 - "identity/index.ts"
Cohesion: 0.18
Nodes (19): ACCESS_PRINCIPAL_TYPES, AccessPrincipalType, AccessRecordInput, DENIAL_REASONS, DenialReason, IDENTITY_CONFIG_SCHEMA, IdentityConfig, loadIdentityPolicy() (+11 more)

### Community 54 - "Specs Index"
Cohesion: 0.40
Nodes (13): Decision: Ports-and-adapters for every external dependency, AI Provider Portability Spec, Authentication and Access Spec, Behavior Rules Configuration Spec, Bot Activation Control Spec, Bot Disclosure Setting Spec, Business Knowledge Configuration Spec, Client Conversation Visibility Spec (+5 more)

### Community 55 - "ai/stubs.ts"
Cohesion: 0.21
Nodes (16): SCRIPTED_FAILURE_STATUS, BASE_PATHS, decodeOpenAiContent(), firstText(), geminiError(), handleGemini(), handleOpenAi(), misbehave() (+8 more)

### Community 56 - "api/start.ts"
Cohesion: 0.13
Nodes (24): loadAll(), loadConfig(), RawEnv, createPool(), loadDatabaseConfig(), startHeartbeat(), Api, CliIo (+16 more)

### Community 57 - "IdentityService"
Cohesion: 0.20
Nodes (13): recordAccess(), recordAccessOutOfBand(), assertEmail(), assertPasswordStrength(), decoyHash(), IdentityService, secs(), nextIdentity() (+5 more)

### Community 58 - "api/app.test.ts"
Cohesion: 0.12
Nodes (16): Answer, apiWith(), call(), cookieValue(), FAST_SCRYPT, gatewayMoves(), onboard(), POLICY (+8 more)

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

### Community 64 - "queue/index.ts"
Cohesion: 0.28
Nodes (15): DEFAULT_BACKOFF, StoredJob, ClaimRow, PostgresQueueOptions, assertQueueName(), ClaimedJob, ClaimOptions, digestKey() (+7 more)

### Community 65 - "monitoring/package.json"
Cohesion: 0.09
Nodes (21): dependencies, @zeddev/db, @zeddev/errors, @zeddev/logging, @zeddev/tenancy, @zeddev/whatsapp, devDependencies, @zeddev/schema (+13 more)

### Community 66 - "storage/index.test.ts"
Cohesion: 0.16
Nodes (8): STORAGE_CONFIG_SCHEMA, TransportResponse, memoryHarness, TENANTS, S3ObjectStore, parseObjectKey(), parseObjectRef(), tenantPrefix()

### Community 67 - "Clock"
Cohesion: 0.09
Nodes (4): InMemoryObjectStore, InMemoryObjectStoreOptions, ObjectStore, Clock

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
Cohesion: 0.10
Nodes (39): DeliveryAttemptOutcome, AdmissionResult, admitLocked(), admitPendingMessages(), AggregationPolicy, assertPolicy(), closeTurn(), ContextRow (+31 more)

### Community 73 - "queue/index.test.ts"
Cohesion: 0.23
Nodes (9): ConsumerOptions, JobHandler, runConsumer(), sleepQuietly(), waitForSomething(), drain(), memoryHarness, TENANTS (+1 more)

### Community 74 - "mail/package.json"
Cohesion: 0.18
Nodes (10): devDependencies, @zeddev/testing, exports, ./testing, @zeddev/testing, name, private, type (+2 more)

### Community 75 - "Conversation Worker Job Handlers"
Cohesion: 0.09
Nodes (22): dependencies, @zeddev/config, @zeddev/errors, @zeddev/logging, @zeddev/secrets, @zeddev/tenancy, @zeddev/time, devDependencies (+14 more)

### Community 76 - "Schema Migrations Runner"
Cohesion: 0.10
Nodes (19): dependencies, @zeddev/config, @zeddev/db, @zeddev/errors, @zeddev/secrets, devDependencies, @zeddev/schema, @zeddev/testing (+11 more)

### Community 77 - "mail/types.ts"
Cohesion: 0.27
Nodes (7): MAIL_CONFIG_SCHEMA, MailConfig, assertCommandSafe(), MAIL_TLS_MODES, MailTlsMode, SmtpSettings, RFC-2047

### Community 79 - "storage/http.ts"
Cohesion: 0.27
Nodes (8): AgentOptions, createTransport(), RequestFn, send(), Transport, TransportRequest, S3ObjectStoreOptions, realTransport()

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

### Community 85 - "sigv4.ts"
Cohesion: 0.18
Nodes (22): amzDate(), canonicalHeaders, canonicalQuery(), canonicalRequest(), canonicalUri(), credentialScope(), EMPTY_PAYLOAD_SHA256, hmac() (+14 more)

### Community 86 - "PostgresQueue"
Cohesion: 0.14
Nodes (3): PostgresQueue, create(), newTenants()

### Community 87 - "web/tsconfig.json"
Cohesion: 0.15
Nodes (11): **/*.ts, ../../../tsconfig.base.json, ui/shell.ts, extends, include, extends, include, exclude (+3 more)

### Community 88 - "routes.ts"
Cohesion: 0.20
Nodes (10): disclosureScreen(), operatorAccountScreen(), PAGE_AREAS, PageArea, PagePath, PAGES, AREA_SESSIONS, CLIENT_NAV (+2 more)

### Community 89 - "time/index.ts"
Cohesion: 0.12
Nodes (6): exponentialBackoff(), ExponentialBackoffOptions, FakeClock, Millis, ScheduledTask, SystemClock

### Community 91 - "Tenancy Package Dependencies"
Cohesion: 0.05
Nodes (37): dependencies, @zeddev/config, @zeddev/errors, @zeddev/secrets, @zeddev/time, devDependencies, @zeddev/testing, exports (+29 more)

### Community 93 - "scram.ts"
Cohesion: 0.16
Nodes (13): RFC-5802, RFC-7677, hmac(), md5Password(), parseServerFinal(), parseServerFirst(), pbkdf2, SCRAM_SHA_256 (+5 more)

### Community 95 - "Identity Session Principals"
Cohesion: 0.20
Nodes (9): dependencies, devDependencies, @zeddev/testing, exports, @zeddev/testing, name, private, type (+1 more)

### Community 96 - "queue/conformance.ts"
Cohesion: 0.29
Nodes (7): asleep(), HarnessQueueOptions, PAYLOAD, QueueFixture, QueueHarness, runQueueConformance(), InMemoryQueueOptions

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
Cohesion: 0.16
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
Cohesion: 0.20
Nodes (6): AdapterDependencies, createAiProvider(), ProviderEntry, AiCapability, AiSettings, hello

### Community 132 - "conversation/index.ts"
Cohesion: 0.12
Nodes (31): ContextTurn, renderConversation(), RenderedConversation, renderMessage(), text(), TurnMessage, unsupportedNote(), cleanTranscript() (+23 more)

### Community 133 - "@zeddev/ai"
Cohesion: 0.50
Nodes (4): @zeddev/ai, @zeddev/ai, @zeddev/ai, @zeddev/ai

### Community 134 - "devDependencies"
Cohesion: 0.12
Nodes (17): devDependencies, @zeddev/ai, @zeddev/api, @zeddev/db, @zeddev/identity, @zeddev/mail, @zeddev/schema, @zeddev/testing (+9 more)

### Community 135 - "operator-screens.ts"
Cohesion: 0.07
Nodes (47): ActivationHistory, Attempt, BotStatus, CONDITION_LINKS, Connection, connectionScreen(), statusScreen(), VERIFICATION_FAILURES (+39 more)

### Community 136 - "api.ts"
Cohesion: 0.17
Nodes (6): Api, ApiError, ApiIssue, ErrorBody, FetchLike, ResponseLike

### Community 137 - "whatsapp/conformance.ts"
Cohesion: 0.11
Nodes (13): settleDelivery(), businessVerificationBlocked(), cloudFailureDeterminacy(), cloudFailureReason(), isMediaTooLarge(), probeCloudLink(), WhatsAppCloud, CloudFixture (+5 more)

### Community 138 - "attempts.ts"
Cohesion: 0.15
Nodes (15): AdapterCore, DEFAULT_AI_BACKOFF, AttemptOutcome, AttemptPolicy, AttemptTimedOut, Failure, MAX_ERROR_BODY_BYTES, MAX_RETRY_WAIT_MS (+7 more)

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
Cohesion: 0.11
Nodes (13): IdentityPolicy, ClientSessionIssued, IdentityServiceOptions, OperatorSessionIssued, Outcome, SignUpInput, SignUpResult, TenantProvisioning (+5 more)

### Community 145 - "web/package.json"
Cohesion: 0.29
Nodes (6): exports, ./config, name, private, type, version

### Community 146 - "smtp.ts"
Cohesion: 0.18
Nodes (11): RFC-821, BuiltMessage, asConfigurationError(), AttemptState, Phase, PHASE_CONFIG_KEYS, SmtpMailerOptions, SmtpReply (+3 more)

### Community 148 - "credentials.ts"
Cohesion: 0.22
Nodes (14): assertBusinessName(), COMMON_PASSWORD_STEMS, emailLocalPart(), isSequentialRun(), isSingleRepeatedCharacter(), MAX_BUSINESS_NAME_LENGTH, MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH (+6 more)

### Community 149 - "conversation-worker/package.json"
Cohesion: 0.15
Nodes (12): @zeddev/bot, devDependencies, @zeddev/bot, @zeddev/testing, exports, ./config, @zeddev/testing, name (+4 more)

### Community 150 - "deployment/index.ts"
Cohesion: 0.29
Nodes (9): target, combinedSchema(), configKeys(), ConfigSection, PLATFORM_CONFIG_SCHEMAS, renderPlatformReference(), tableOnly(), REFERENCE_PATH (+1 more)

### Community 151 - "conversations-screen.ts"
Cohesion: 0.11
Nodes (16): handoffReason(), HandoffSignal, BotEntry, ConversationList, ConversationSummary, customerBody(), CustomerEntry, DELIVERY (+8 more)

### Community 154 - "whatsapp-gateway/package.json"
Cohesion: 0.20
Nodes (9): devDependencies, @zeddev/testing, exports, ./config, @zeddev/testing, name, private, type (+1 more)

### Community 155 - "deployment/package.json"
Cohesion: 0.13
Nodes (14): devDependencies, @zeddev/queue, @zeddev/secrets, @zeddev/testing, exports, name, private, type (+6 more)

### Community 156 - "withIdentityScope"
Cohesion: 0.16
Nodes (11): newTenant(), newTenant(), newTenant(), newTenant(), newTenant(), withIdentityScope(), BASE_POLICY, countTenants() (+3 more)

### Community 157 - "tokens.ts"
Cohesion: 0.40
Nodes (6): claimedTokenKind(), hashToken(), hasTokenKind(), TOKEN_KINDS, TOKEN_PREFIXES, TokenKind

### Community 158 - "portability.test.ts"
Cohesion: 0.38
Nodes (5): scan(), sourceFiles(), SRC_DIR, stripComment(), Violation

### Community 159 - ".resolveClientSession"
Cohesion: 0.24
Nodes (5): Action, ClientPrincipal, OperatorPrincipal, Principal, principalId()

## Knowledge Gaps
- **715 isolated node(s):** `APP_SECRET`, `SEALING_KEY`, `FAST_SCRYPT`, `Client`, `name` (+710 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **14 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Implementation Plan` connect `Implementation Plan` to `mail/package.json`, `Specs Index`?**
  _High betweenness centrality (0.079) - this node is a cross-community bridge._
- **Why does `cloudFailureDeterminacy()` connect `whatsapp/conformance.ts` to `whatsapp/index.ts`, `Implementation Plan`, `delivery.ts`?**
  _High betweenness centrality (0.078) - this node is a cross-community bridge._
- **Why does `Decision: cloudFailureDeterminacy for retry-without-duplication` connect `Implementation Plan` to `whatsapp/conformance.ts`?**
  _High betweenness centrality (0.077) - this node is a cross-community bridge._
- **What connects `APP_SECRET`, `SEALING_KEY`, `FAST_SCRYPT` to the rest of the system?**
  _715 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `onboarding.test.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.09013605442176871 - nodes in this community are weakly interconnected._
- **Should `ValidationError` be split into smaller, more focused modules?**
  _Cohesion score 0.08416130917592052 - nodes in this community are weakly interconnected._
- **Should `Implementation Plan` be split into smaller, more focused modules?**
  _Cohesion score 0.12681159420289856 - nodes in this community are weakly interconnected._