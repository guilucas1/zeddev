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
 * go-live toggle are `activation.ts`; behaviour rules are `behavior.ts`.
 * Language, fallback messages, disclosure, handoff, and memory policy follow in
 * the same package.
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
