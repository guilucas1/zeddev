# Bot Activation Control

## Purpose

Defines the readiness gate that determines when a client's bot is eligible to go live, and the client-controlled on/off switch that governs whether the bot is actually responding to end-customers at any given moment.

## Behavioral Requirements

- The system must track a per-client readiness state derived from whether the client's WhatsApp number is connected and whether the minimum required bot configuration has been set.
- The system must consider minimum required bot configuration to include, at minimum, persona/tone configuration being completed.
- The system must NOT allow a client to turn their bot on until the client is in a ready state.
- The system must expose an explicit, client-controlled activation toggle ("go live" / "pause") that is separate from and sits on top of readiness.
- The system must NOT automatically turn a bot on merely because the client became ready — activation always requires an explicit client action.
- The system must allow a ready client to turn their bot on at any time after becoming ready.
- The system must allow an active client to turn their bot off at any time, for any reason, with immediate effect.
- The system must allow a client who has paused their bot to turn it back on at any time, provided they are still in a ready state.
- The system must stop the bot from automatically responding to end-customer messages while the bot is off (not active), regardless of readiness state.
- The system must resume the bot automatically responding to end-customer messages as soon as the client turns it on, provided the client is ready.
- The system must treat "active"/on as always-on (24/7) with no business-hours or scheduling concept — there is no time window during which an active bot is expected to withhold responses.
- The system must re-evaluate readiness if a previously satisfied readiness condition later becomes unsatisfied (e.g., the WhatsApp connection is lost or required configuration is cleared).
- The system must turn an active bot off (or otherwise stop it from auto-responding) if the client's readiness state is lost while the bot is active.
- The system must reflect the current activation state (on/off) and the current readiness state (ready/not ready) to the client in a way the client can check at any time.
- The system must communicate to a not-ready client which readiness condition(s) remain unmet.
- The system must record when a client's bot first becomes ready.
- The system must record each time the client turns the bot on or off, including which state it transitioned to.
- The system must NOT provide the operator with an independent ability to suspend or force-off a client's bot in v1 — activation state is controlled solely by the client.

## Acceptance Criteria

- Given a client whose WhatsApp number is not yet connected, When the client attempts to turn their bot on, Then the system rejects the action and the bot remains off.
- Given a client whose WhatsApp number is connected but who has not completed minimum required bot configuration (persona/tone), When the client attempts to turn their bot on, Then the system rejects the action and the bot remains off.
- Given a client whose WhatsApp number is connected AND minimum required bot configuration is complete, When the client checks their bot status, Then the system reports the client as ready and permits the go-live action.
- Given a client who just became ready, When no further action is taken, Then the bot remains off and does not auto-respond to any end-customer message.
- Given a ready client, When the client turns the bot on, Then the bot begins auto-responding to end-customer messages, at any hour of any day, with no business-hours restriction.
- Given an active bot, When the client turns the bot off, Then the bot stops auto-responding to end-customer messages immediately, and any message received afterward while off does not trigger an automatic reply.
- Given a paused (off) bot for a still-ready client, When the client turns the bot back on, Then the bot resumes auto-responding to end-customer messages.
- Given an active bot, When a readiness condition is subsequently lost (e.g., the WhatsApp connection drops), Then the system transitions the bot to not-responding and reflects the bot as off/not ready, without requiring further client action.
- Given a bot that became inactive due to lost readiness, When the client restores the missing condition (e.g., reconnects WhatsApp) but takes no further action, Then the bot remains off until the client explicitly turns it on again.
- Given a not-ready client, When the client views their bot status, Then the system lists specifically which readiness condition(s) (WhatsApp connection, minimum configuration) are unmet.
- Given any client, When the client views their bot status at any time, Then the system shows both the current readiness state and the current activation state (on/off).
- Given a solo operator managing multiple clients, When the operator looks at a client's account, Then the operator can view that client's readiness and activation state but has no control to change the client's activation state in v1.
- Given an activation state change (on-to-off or off-to-on), When the change occurs, Then the system retains a record of the change and when it happened.

## Out of Scope

- How the WhatsApp number connection itself is established, verified, or can be lost or reconnected — see `whatsapp-number-connection.md`.
- Tenant signup, account creation, and initial client provisioning — see `client-signup-and-tenancy.md`.
- The content and mechanics of persona/tone configuration — see `persona-and-tone-configuration.md`.
- The content and mechanics of business knowledge configuration — see `business-knowledge-configuration.md`.
- The content and mechanics of behavior rules configuration — see `behavior-rules-configuration.md`.
- Any operator-side ability to suspend, disable, or force-off a client's bot — explicitly excluded from v1.
- Business-hours, scheduling, or time-windowed availability behavior — not part of v1; "active" always means 24/7.
- Notifications or alerting tied to readiness or activation changes (e.g., emailing the client when they become ready) — not addressed here.
- Billing, plan limits, or payment status as a factor in readiness or activation — not addressed here.

## Open Questions / Assumptions

- Assumed "minimum required bot configuration" for readiness is persona/tone only, per the interview decision; whether business knowledge or behavior rules configuration are ever required for readiness (now or in a future version) is not addressed here and would need to be decided in those sibling specs or a future revision of this one.
- Assumed the readiness gate and the on/off toggle apply at the level of a single client's single WhatsApp-connected bot; multi-number-per-client scenarios, if they exist, are not addressed here.
- Assumed automatic deactivation on lost readiness (e.g., disconnected WhatsApp) is desired rather than leaving the bot flagged as active-but-non-functional; this follows from the requirement that the bot must not respond while any readiness condition is unmet, but was not explicitly stated as a transition rule in the interview.
- Assumed the client is the only actor able to change activation state in v1, and that no automated system process (other than the readiness-loss case above) ever flips the toggle.
- Assumed "immediate effect" for turning the bot off means no in-flight or queued responses are sent once off, but this spec does not define exact timing/latency guarantees, which are left to implementation.
