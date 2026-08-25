# Image Message Understanding

## Purpose

Defines what the chatbot must do when an end-customer sends an image (e.g. a product photo, a picture of an issue, a receipt) on WhatsApp, so the bot can understand the image's content and use that understanding to produce a relevant response within the same conversation.

## Behavioral Requirements

- The system must accept image messages sent by an end-customer via WhatsApp as a valid input type, on par with text and voice messages.
- The system must derive a content understanding of each received image (e.g. what the image depicts, visible text, relevant details) sufficient to inform a response.
- The system must incorporate the derived image understanding into the same response-generation flow used for text messages, so the reply reads as one coherent conversational turn rather than a separate process.
- The system must support an end-customer sending an image together with accompanying text (a caption) in the same message, and must treat the image and its caption as related parts of one input when forming a response.
- The system must support an end-customer sending an image with no caption, and must still attempt to derive a useful understanding of the image alone.
- The system must support a single conversational turn containing multiple images sent close together, and must consider all of them when forming a response.
- The system must be able to read and use text visible within an image (e.g. text on a receipt, label, or sign) as part of its understanding when such text is present and legible.
- The system must treat an image's meaning as available context for later turns in the conversation to the same extent as text content, per the conversation memory behavior defined in `conversation-memory.md`.
- The system must handle common image formats sent by WhatsApp end-customers (e.g. photos taken and shared from a phone camera or photo library) without requiring the end-customer to do anything special to send them.
- The system must operate using an interchangeable underlying image-understanding capability, per `ai-provider-portability.md`, without this spec depending on any specific provider, model, or vendor.
- The system must apply the same fallback behavior defined in `fallback-response-behavior.md` when an image cannot be adequately understood (e.g. it is blurry, corrupted, unsupported, or unrelated to anything the bot can act on).
- The system must apply the same per-tenant configuration and isolation principles as other message types: an image sent to one client business's WhatsApp number must only be processed and interpreted in the context of that client business's own bot instance and knowledge.

## Acceptance Criteria

- Given an end-customer sends a single photo with no caption, when the bot processes the message, then the response reflects an understanding of the photo's visible content (not a generic "please describe what you sent" reply).
- Given an end-customer sends a photo with a caption (e.g. "is this still under warranty?"), when the bot processes the message, then the response addresses the caption's question using the photo's content as context.
- Given an end-customer sends a photo of a receipt or document-like image containing readable text, when the bot processes the message, then the response can reference specific text content that was visible in the image (e.g. an amount, a date, an item name).
- Given an end-customer sends two or more images in quick succession as part of one conversational turn, when the bot responds, then the response reflects understanding of all the images sent in that turn, not just the first or last one.
- Given an end-customer sends an image that is too blurry, dark, or corrupted to interpret, when the bot processes the message, then the bot follows the fallback behavior defined in `fallback-response-behavior.md` rather than fabricating a description of the image.
- Given an end-customer references "that photo I sent" in a later text message, when the bot processes the later message, then the bot's response reflects awareness of the earlier image consistent with the conversation memory behavior defined in `conversation-memory.md`.
- Given two different client businesses each receive an image from their own end-customers at the same time, when each is processed, then each image is interpreted only within its own client business's bot context, with no cross-tenant leakage of image content or derived understanding.
- Given the underlying image-understanding capability is swapped for a different provider or model, when end-customers send images, then the bot's observable behavior (accepting images, deriving understanding, incorporating it into responses) is unchanged from the tenant's and end-customer's perspective.

## Out of Scope

- General conversation flow, multi-turn context handling, and memory persistence — covered by `text-conversation-handling.md` and `conversation-memory.md`.
- Voice/audio message understanding — covered by `voice-message-understanding.md`.
- Behavior when the bot cannot produce an adequate response (including undecipherable images) — covered by `fallback-response-behavior.md`.
- Provider/model selection, switching mechanics, and portability guarantees — covered by `ai-provider-portability.md`.
- Documents, PDFs, spreadsheets, and other non-image file attachments — explicitly out of scope for v1.
- Video messages and video clips — explicitly out of scope for v1.
- Image generation, editing, or the bot sending images back to end-customers — not covered by this spec.
- Content moderation or safety filtering of received images beyond what is needed to derive an understanding — not covered by this spec.

## Open Questions / Assumptions

- Assumes "image message" refers to standard WhatsApp photo attachments (camera or gallery), not stickers or GIFs; sticker/GIF handling is unaddressed and assumed out of scope for v1.
- Assumes there is no hard cap on image resolution or file size stated by the business requirements; any such limit is assumed to be an implementation-level constraint of the underlying capability, not a product requirement.
- Assumes "multiple images in one turn" means images sent within the same short burst/session WhatsApp groups together, and that the exact grouping window is a later implementation detail, not specified here.
- Assumes text visible in images (e.g. receipts) is to be understood and used, but that this spec does not require structured extraction (e.g. itemized totals) beyond what's needed to answer the end-customer naturally — deeper structured document parsing is assumed out of scope given documents/PDFs are excluded from v1.
