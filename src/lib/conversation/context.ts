/**
 * What the model is shown of a conversation — `conversation-memory.md` and
 * `message-burst-aggregation.md`'s "combine the understood content of every
 * message in a closed turn into a single input".
 *
 * Pure functions over already-read rows, so the rendering can be tested without a
 * database and cannot differ between the live path and a test.
 *
 * Each turn becomes one customer turn holding its messages in the order the
 * end-customer sent them, followed by what the bot said in answer, if anything.
 * The provider port merges adjacent customer text with a blank line, so three
 * short messages arrive as three paragraphs of one message — the "one thought
 * split across several messages" the burst spec describes.
 *
 * A photo or voice note that was understood is shown as what it showed or said,
 * introduced by a note saying what kind of message it was, so the reply reads as an
 * answer to the content and a later "that photo I sent" has something to refer to
 * (`conversation-memory.md`). The text comes from `media.ts`, once per message.
 *
 * A message the platform could not understand is not dropped. It is shown as a
 * bracketed note saying what arrived, so the model neither answers as if the
 * customer had said nothing nor invents what the photo showed
 * (`image-message-understanding.md`: "rather than fabricating a description").
 * Whether a turn had anything understood at all is reported alongside, because a
 * turn of notes alone is not something a model can answer: it goes straight to
 * the fallback.
 */

import type { ConversationTurn, TextPart } from '@zeddev/ai';
import type { FallbackTrigger } from '@zeddev/bot';
import type { InboundContent, InboundMessageType } from '@zeddev/whatsapp';
import { TECHNICAL_MEDIA_FAILURES, type MediaUnderstandingFailure } from './media.ts';

/** One stored message of a turn, as far as rendering is concerned. */
export interface TurnMessage {
  readonly type: InboundMessageType;
  readonly upstreamType: string;
  readonly content: InboundContent;
  /**
   * What was made of an image or audio message, if anything has been yet. Absent
   * for a message that has never been through understanding, which reads the same
   * as one that failed: nobody knows what it held.
   */
  readonly understanding?:
    | { readonly text: string | undefined; readonly failure: MediaUnderstandingFailure | undefined }
    | undefined;
}

/** One turn of the conversation, oldest first when in a list. */
export interface ContextTurn {
  /** In the order the end-customer sent them. */
  readonly messages: readonly TurnMessage[];
  /** What the end-customer was sent in answer — a reply or the fallback text — if anything. */
  readonly botMessage: string | undefined;
}

const IMAGE_SEEN_NOTE = '[The customer sent a photo. What it shows:]';
const CAPTION_NOTE = "[The photo's caption:]";
const VOICE_HEARD_NOTE = '[The customer sent a voice message. What they said:]';
const AUDIO_HEARD_NOTE = '[The customer sent an audio file. What it says:]';
const IMAGE_NOTE = '[The customer sent a photo, which could not be viewed.]';
const IMAGE_CAPTION_NOTE = "[The customer sent a photo, which could not be viewed. The photo's caption:]";
const VOICE_NOTE = '[The customer sent a voice message, which could not be listened to.]';
const AUDIO_NOTE = '[The customer sent an audio file, which could not be listened to.]';

function unsupportedNote(upstreamType: string): string {
  // `upstream_type` is constrained to `^[a-z_]{1,40}$` by the gateway's parser and
  // the table's CHECK, so it cannot carry anything but a type name.
  return `[The customer sent a message of type "${upstreamType.replaceAll('_', ' ')}", which cannot be read here.]`;
}

function text(value: string): TextPart {
  return { type: 'text', text: value };
}

/** The parts one message contributes, and whether any of them is the customer's own words. */
export function renderMessage(message: TurnMessage): { readonly parts: readonly TextPart[]; readonly understood: boolean } {
  const content = message.content as Record<string, unknown>;
  switch (message.type) {
    case 'text': {
      const body = typeof content.text === 'string' ? content.text.trim() : '';
      return body === '' ? { parts: [], understood: false } : { parts: [text(body)], understood: true };
    }
    case 'image': {
      const caption = typeof content.caption === 'string' ? content.caption.trim() : '';
      const seen = message.understanding?.text;
      if (seen !== undefined) {
        const captioned = caption === '' ? [] : [text(CAPTION_NOTE), text(caption)];
        return { parts: [text(IMAGE_SEEN_NOTE), text(seen), ...captioned], understood: true };
      }
      return caption === ''
        ? { parts: [text(IMAGE_NOTE)], understood: false }
        : { parts: [text(IMAGE_CAPTION_NOTE), text(caption)], understood: true };
    }
    case 'audio': {
      const voice = content.voice === true;
      const heard = message.understanding?.text;
      return heard === undefined
        ? { parts: [text(voice ? VOICE_NOTE : AUDIO_NOTE)], understood: false }
        : { parts: [text(voice ? VOICE_HEARD_NOTE : AUDIO_HEARD_NOTE), text(heard)], understood: true };
    }
    case 'unsupported':
      return { parts: [text(unsupportedNote(message.upstreamType))], understood: false };
  }
}

/** The model's view of a conversation whose last turn is the one being answered. */
export interface RenderedConversation {
  readonly turns: readonly ConversationTurn[];
  /**
   * Set when nothing in the turn being answered could be understood, naming the
   * fallback trigger it should get instead of a model call: `ai_error` when
   * something went wrong retrieving or reading a photo or voice note,
   * `out_of_scope` when every message was a type the platform does not handle,
   * `low_confidence` when something that should have been understood was looked
   * at and was not.
   */
  readonly notUnderstood: FallbackTrigger | undefined;
}

/**
 * Render a conversation for the model. `turns` ends with the turn being
 * answered, whose `botMessage` is ignored (it has none yet).
 */
export function renderConversation(turns: readonly ContextTurn[]): RenderedConversation {
  const rendered: ConversationTurn[] = [];
  let lastUnderstood = false;
  let lastAllUnsupported = true;
  let lastTechnicalFailure = false;

  turns.forEach((turn, index) => {
    const current = index === turns.length - 1;
    const parts: TextPart[] = [];
    let understood = false;
    let allUnsupported = true;
    let technicalFailure = false;
    for (const message of turn.messages) {
      const piece = renderMessage(message);
      parts.push(...piece.parts);
      understood ||= piece.understood;
      allUnsupported &&= message.type === 'unsupported';
      const failure = message.understanding?.failure;
      technicalFailure ||= failure !== undefined && TECHNICAL_MEDIA_FAILURES.has(failure);
    }
    // An empty turn (every message blank) still stands for the customer having
    // written; the port refuses a customer turn with no parts, so it gets a note.
    if (parts.length === 0) parts.push(text('[The customer sent an empty message.]'));
    rendered.push({ role: 'customer', parts });
    if (current) {
      lastUnderstood = understood;
      lastAllUnsupported = allUnsupported && turn.messages.length > 0;
      lastTechnicalFailure = technicalFailure;
    } else if (turn.botMessage !== undefined) {
      rendered.push({ role: 'bot', text: turn.botMessage });
    }
  });

  return {
    turns: rendered,
    notUnderstood: lastUnderstood
      ? undefined
      : lastTechnicalFailure
        ? 'ai_error'
        : lastAllUnsupported
          ? 'out_of_scope'
          : 'low_confidence',
  };
}
