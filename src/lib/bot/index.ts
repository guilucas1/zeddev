/**
 * `@zeddev/bot` — the client's configuration of their bot.
 *
 * A domain library, like `@zeddev/identity`: it contains no HTTP. It owns what is
 * *true* about a tenant's bot configuration — what a valid persona is, whether
 * the configuration satisfies the readiness gate, and the instruction text the
 * reply path assembles from it — and every function works on a connection the
 * caller has already bound to one tenant, so none of them can be pointed at
 * another tenant's data.
 *
 * Persona and tone is the first configuration here because it is the only one
 * that gates readiness (`bot-activation-control.md`). Readiness itself and the
 * go-live toggle are `activation.ts`; behaviour rules are `behavior.ts`;
 * fallback messages are `fallback.ts`; the disclosure setting is `disclosure.ts`;
 * human-handoff configuration is `handoff.ts`. Language and memory policy follow
 * in the same package.
 */

export {
  ACTIVATION_CAUSES,
  describeBotStatus,
  listBotStatuses,
  mayAutoRespond,
  parseActivationInput,
  READINESS_CONDITION_DESCRIPTIONS,
  READINESS_CONDITIONS,
  readActivationHistory,
  readBotStatus,
  setBotActive,
  type ActivationCause,
  type ActivationEvent,
  type BotStatus,
  type OperatorBotStatus,
  type ReadinessCondition,
} from './activation.ts';

export {
  clearFreeformInstructions,
  describePersona,
  FORMALITY_LEVELS,
  parsePersonaInput,
  PERSONA_FIELDS,
  PERSONA_LIMITS,
  personaDirectives,
  personaReadiness,
  readPersona,
  savePersona,
  STYLE_TRAITS,
  type Formality,
  type Persona,
  type PersonaInput,
  type PersonaReadiness,
  type StyleTrait,
} from './persona.ts';

export {
  BEHAVIOR_LIMITS,
  behaviorDirectives,
  clearBehaviorInstructions,
  createBehaviorRule,
  deleteBehaviorRule,
  describeBehaviorRule,
  describeBehaviorRules,
  parseBehaviorInstructionsInput,
  parseRuleCreateInput,
  parseRuleUpdateInput,
  readBehaviorRules,
  RULE_ACTIONS,
  RULE_CREATE_FIELDS,
  RULE_KINDS,
  RULE_UPDATE_FIELDS,
  saveBehaviorInstructions,
  setBehaviorRuleEnabled,
  updateBehaviorRule,
  type BehaviorConfiguration,
  type BehaviorRule,
  type RuleAction,
  type RuleDefinition,
  type RuleKind,
} from './behavior.ts';

export {
  describeFallbackMessages,
  FALLBACK_FIELDS,
  FALLBACK_LIMITS,
  FALLBACK_TRIGGERS,
  fallbackMessageFor,
  parseFallbackInput,
  PLATFORM_DEFAULT_FALLBACK_MESSAGES,
  previewFallbackDraft,
  previewFallbackMessages,
  readFallbackMessages,
  resolveFallbackMessage,
  saveFallbackMessages,
  type FallbackInput,
  type FallbackMessages,
  type FallbackSource,
  type FallbackTrigger,
  type ResolvedFallback,
} from './fallback.ts';

export {
  describeDisclosureSetting,
  DISCLOSURE_FIELDS,
  DISCLOSURE_MODES,
  disclosureDirectives,
  disclosureModeFor,
  parseDisclosureInput,
  PLATFORM_DEFAULT_DISCLOSURE_MODE,
  readDisclosureSetting,
  saveDisclosureSetting,
  type DisclosureMode,
  type DisclosureSetting,
  type DisclosureSource,
} from './disclosure.ts';

export {
  describeHandoffSettings,
  HANDOFF_FIELDS,
  HANDOFF_LIMITS,
  HANDOFF_TRIGGER_DESCRIPTIONS,
  HANDOFF_TRIGGERS,
  handoffDirectives,
  handoffPolicyFor,
  parseHandoffEnabledInput,
  parseHandoffInput,
  PLATFORM_DEFAULT_HANDOFF_ENABLED,
  PLATFORM_DEFAULT_HANDOFF_TRIGGERS,
  readHandoffSettings,
  resolveHandoffSignal,
  saveHandoffSettings,
  setHandoffEnabled,
  type HandoffDecision,
  type HandoffPolicy,
  type HandoffSettings,
  type HandoffSignal,
  type HandoffSource,
  type HandoffTrigger,
} from './handoff.ts';
