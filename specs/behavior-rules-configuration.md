# Behavior Rules Configuration

## Purpose

Defines how a client business configures behavioral constraints and policy rules — what the bot must never do, must always do, or must do conditionally — independent of the bot's persona/tone and its factual business knowledge. Configured rules must observably shape the bot's actual responses to end-customers.

## Behavioral Requirements

- The system must let a client business define behavior rules using a structured mechanism (discrete, individually configurable rule entries) without needing developer help.
- The system must let a client business define behavior rules using freeform instructions text without needing developer help.
- The system must let a client business use the structured mechanism and the freeform mechanism together, with both contributing to the bot's behavior simultaneously, not as mutually exclusive alternatives.
- The system must let a client business configure zero, one, or many structured rules, and independently, empty or non-empty freeform instructions text.
- The system must let a structured rule express a prohibition (the bot must never do X).
- The system must let a structured rule express an obligation (the bot must always do X, or must do X before doing Y).
- The system must let a structured rule express a conditional constraint (the bot must do X only when/if condition Y holds, e.g., only discuss a return once an order number has been provided).
- The system must let a structured rule designate a topic or subject the bot must avoid discussing or must decline to engage with.
- The system must let a structured rule reference handing off to a human as its required action, deferring the actual handoff mechanics to `human-handoff.md`.
- The system must let a structured rule reference the fallback response as its required action when the rule prevents the bot from answering directly, deferring the actual fallback mechanics to `fallback-response-behavior.md`.
- The system must let a client business enable or disable an individual structured rule without deleting it.
- The system must let a client business edit the text/definition of an individual structured rule after creation.
- The system must let a client business delete an individual structured rule.
- The system must let a client business view the full current set of structured rules and the current freeform instructions text for their business at any time.
- The system must isolate one client business's behavior rules (structured and freeform) from every other client business's, so no client business can view or be affected by another's configured rules.
- The system must apply a client business's currently enabled structured rules and current freeform instructions to every bot response generated for that business's end-customer conversations.
- The system must produce a testable, observable failure when the bot's response to an end-customer violates a currently enabled rule (structured or freeform) — rule adherence must be verifiable by inspecting bot output against configured rules, not just by inspecting configuration.
- The system must apply configured rules regardless of which end-customer or conversation is being handled, i.e., rules apply business-wide, not per individual end-customer.
- The system must resolve a rule whose required action is "hand off to a human" by following the routing and availability behavior defined in `human-handoff.md`.
- The system must resolve a rule that prevents the bot from answering directly (and no handoff applies) by following the behavior defined in `fallback-response-behavior.md`.
- The system must apply newly created, edited, enabled, disabled, or deleted rule changes starting with the bot's next response to any end-customer, without requiring an active conversation to restart or end first.
- The system must not apply a disabled or deleted structured rule to any bot response generated after that rule was disabled or deleted.
- The system must not require a client business to write or understand any code, query language, or technical syntax to define a structured rule or freeform instructions.
- The system must let a client business preview or review how their configured rules would constrain a sample bot response before relying on them in live end-customer conversations.

## Acceptance Criteria

- Given a client business has defined no structured rules and no freeform instructions, when the bot responds to an end-customer, then no behavior-rule constraint from this spec restricts that response beyond platform defaults.
- Given a client business has defined a structured rule prohibiting a specific action (e.g., "never quote a price without confirming stock"), when an end-customer's message would otherwise cause the bot to take that prohibited action, then the bot's response does not take that action.
- Given a client business has defined a structured rule requiring a precondition before an action (e.g., "always ask for an order number before discussing a return"), when an end-customer asks about a return without having provided an order number, then the bot's response asks for the order number rather than discussing the return.
- Given a client business has defined a topic the bot must avoid (e.g., competitors), when an end-customer asks about that topic, then the bot's response does not engage in discussion of that topic.
- Given a client business has defined freeform instructions text containing a constraint, when an end-customer's message would otherwise violate that constraint, then the bot's response observably honors the constraint.
- Given a client business has defined both structured rules and freeform instructions simultaneously, when the bot responds, then the response honors both the structured rules and the freeform instructions concurrently.
- Given a structured rule's required action is "hand off to a human," when the rule's condition is met, then the conversation is routed per `human-handoff.md` rather than the bot answering the constrained content itself.
- Given a rule prevents the bot from answering directly and no handoff applies, when the rule's condition is met, then the end-customer receives the fallback behavior defined in `fallback-response-behavior.md`.
- Given a client business disables a structured rule, when the bot responds to any end-customer message after the disable, then that rule no longer constrains the response.
- Given a client business deletes a structured rule, when the bot responds to any end-customer message after the deletion, then that rule no longer constrains the response.
- Given a client business edits an existing structured rule's definition, when the bot responds to any end-customer message after the edit, then the response reflects the updated rule, not the prior version.
- Given a client business updates their freeform instructions text, when the bot responds to any end-customer message after the update, then the response reflects the updated instructions.
- Given a rule change (create, edit, enable, disable, delete) is saved while an end-customer conversation is already in progress, when the bot sends its next response in that same conversation, then the response reflects the new rule state.
- Given two different client businesses have each configured different, conflicting rules (e.g., one prohibits discussing competitors, the other explicitly allows it), when each business's bot responds to its own end-customers, then each bot's behavior follows only its own business's configured rules.
- Given a client business views their rules configuration, when they open it, then they see the complete current set of structured rules (with each rule's enabled/disabled state) and the current freeform instructions text.
- Given a client business previews their configured rules against a sample message, when they run the preview, then the previewed response demonstrates the same constraints that would apply to a real end-customer conversation.

## Out of Scope

- Defining the bot's persona, tone, or communication style — see `persona-and-tone-configuration.md`.
- Defining or configuring the bot's factual business knowledge (products, prices, policies as facts) — see `business-knowledge-configuration.md`.
- The actual mechanics of routing, offering, or executing a handoff to a human once a rule calls for it — see `human-handoff.md`.
- The actual mechanics of composing or sending a fallback response once a rule prevents a direct answer — see `fallback-response-behavior.md`.
- Detecting or scoring rule violations after the fact for analytics, auditing, or compliance reporting purposes beyond what's needed to make a violation observably testable.
- Any specific technique, model, or mechanism used internally to enforce rules — this spec defines observable behavioral outcomes only.
- Rule templates, suggested/prebuilt rule libraries, or industry-specific rule presets.
- Conflict detection or warnings when a client business's own rules contradict each other or contradict their persona/knowledge configuration.
- Versioning or audit history of rule changes over time (who changed what, when) beyond the requirement that the latest configuration takes effect for future responses.
- Multi-language variants of freeform instructions text or structured rule text.
- Rate limits or caps on the number of structured rules a client business may configure.

## Open Questions / Assumptions

- Assumed "structured mechanism" means discrete, individually addressable rule entries (each with its own enable/disable, edit, and delete lifecycle) as opposed to a specific UI form/field design, which is left to implementation.
- Assumed conflicts between structured rules and freeform instructions (e.g., one says never discuss X, the other implies it's fine) are resolved by treating both as binding constraints the bot must satisfy simultaneously; no precedence order between the two mechanisms is specified here, and this is flagged as an open question for a later phase.
- Assumed there is no fixed maximum number of structured rules or freeform instruction length; any practical limits are an implementation concern, not a behavioral requirement.
- Assumed "next response to any end-customer" means the change need not retroactively alter or resend any message already sent before the change was saved.
- Assumed rule evaluation applies uniformly across all conversation channels supported by the platform (currently WhatsApp per other specs), not channel-specific behavior.
- Assumed "preview" here is a lightweight, non-live check (sample input against current rules) rather than a full test-conversation environment; if a richer testing capability is needed, that may warrant its own spec.
- Assumed a rule's required action beyond "hand off" or "fallback" (e.g., "always ask for X") is expressed and enforced as a behavioral constraint on the bot's own generated response, not as a separate workflow/automation step.
