# Bot Disclosure Setting

## Purpose

Lets each client business decide, per bot, whether end-customers are told they are talking to an automated/AI system rather than a human. The platform must support both a disclosing mode and a non-disclosing mode, with the client's choice consistently enforced across every conversation their bot has.

## Behavioral Requirements

- The platform must provide a per-bot setting that determines whether the bot discloses its automated/AI nature to end-customers.
- The setting must support exactly two modes: "disclose" and "do not disclose."
- The setting must be configurable independently for each client business's bot; one client's choice must not affect any other client's bot.
- When a new bot is created, the setting must have a defined default value (see Open Questions / Assumptions), and the client must be able to view what the current mode is set to.
- The client must be able to change the mode at any time, and the change must take effect for conversations occurring after the change without requiring the end-customer to take any action.
- When the mode is set to "disclose," every new conversation the bot starts or responds to with an end-customer must include, at or near the start of the conversation, a clear statement that the end-customer is interacting with an automated/AI system rather than a human.
- When the mode is set to "disclose," if an end-customer directly asks (in substance) whether they are talking to a human or a bot, the bot's response must affirm that it is automated/AI, regardless of how far into the conversation the question is asked.
- When the mode is set to "do not disclose," the bot must not proactively state that it is automated/AI, and must not include an automated/AI disclosure message at the start of conversations.
- When the mode is set to "do not disclose," the bot must not be required to volunteer its automated/AI nature, but this spec does not require the bot to actively deny being automated/AI if asked (see Out of Scope).
- Changing the mode must not retroactively alter or annotate messages already sent in past conversations.
- The current mode for a given bot must be retrievable by the platform (or other configuration areas, such as persona/tone and behavior-rules configuration) so that other bot behaviors can remain consistent with the disclosure choice.
- The setting must persist across bot restarts, redeployments, or any change to other bot configuration (e.g., persona, tone, behavior rules).

## Acceptance Criteria

- Given a bot with the mode set to "disclose," when an end-customer starts a new conversation, then the bot's response includes a clear statement identifying itself as automated/AI.
- Given a bot with the mode set to "disclose," when an end-customer asks "am I talking to a real person?" (or a semantically equivalent question) at any point in the conversation, then the bot's reply affirms it is automated/AI.
- Given a bot with the mode set to "do not disclose," when an end-customer starts a new conversation, then the bot's initial response contains no statement identifying it as automated/AI.
- Given a bot with the mode set to "do not disclose," when an end-customer never asks about the bot's nature, then no automated/AI disclosure is ever sent during that conversation.
- Given a client changes the mode from "do not disclose" to "disclose" (or vice versa), when a new conversation starts afterward, then the new conversation follows the newly selected mode.
- Given a client changes the mode, when past conversation transcripts are viewed, then messages already sent before the change remain unchanged.
- Given two different client businesses' bots, when one client sets their bot's mode to "disclose" and the other sets theirs to "do not disclose," then each bot behaves only according to its own setting.
- Given a bot has never had its mode explicitly configured, when the bot is created, then it is assigned the platform's defined default mode automatically, without requiring the client to configure it first.
- Given a client business views their bot's configuration, when they check the disclosure setting, then the currently active mode ("disclose" or "do not disclose") is displayed accurately.

## Out of Scope

- Determining which specific jurisdictions legally require automated/AI disclosure, and any platform logic that would force "disclose" mode based on client or end-customer location — a platform-level legal compliance mapping is not covered here.
- The exact wording, tone, or phrasing of the disclosure message itself — covered by `persona-and-tone-configuration.md`.
- Any requirement that a "do not disclose" bot must actively deny being an AI or claim to be human if directly and repeatedly pressed — this spec only requires that disclosure not be volunteered; whether evasion or denial is permitted or restricted is covered by `behavior-rules-configuration.md`.
- Escalation or hand-off behavior to a human agent — covered by any human-handoff or escalation spec, if one exists.
- How or where the disclosure setting is surfaced in any client-facing configuration interface (layout, UI components) — this spec covers only the observable behavior, not interface design.
- Audit logging or historical reporting of when/how often the mode was changed.
- Consent collection or any requirement to obtain end-customer acknowledgment of the disclosure.

## Open Questions / Assumptions

- Assumed the default mode for newly created bots is "disclose," on the basis that a safe default is preferable when a client has not made an explicit choice; this should be confirmed with the client-facing product owner.
- Assumed "at or near the start of the conversation" is sufficiently precise for disclosure timing (e.g., first bot message in a new conversation thread); exact recency/session-boundary rules (e.g., how much time must pass before a "new conversation" requires disclosure again) are left open and may need definition in a session/conversation-lifecycle spec.
- Assumed legal compliance obligations (which vary by country/region) are entirely out of scope for this platform-level spec, and that disclose/do-not-disclose is purely a product configuration choice left to the client business's judgment and legal responsibility.
- Assumed "do not disclose" mode does not require the bot to lie or claim to be human — only that it withhold proactive disclosure — since requiring active deception was not stated as a decision in the interview.
