/**
 * Everything that shapes how a client's bot answers.
 *
 * Option lists and limits come from each GET, so a value the API accepts is one the
 * form offers, without a second copy here. Only the rules that decide what a field
 * means stay on the server: a rejected save names the field and leaves the form as
 * typed. Length is left to the server too, because it counts code points and an
 * HTML `maxlength` counts UTF-16 units.
 */

import { html, type Html } from './html.ts';
import { errorSlot, field, isChecked, list, pill, text, textArea, when, type FormValues, type Screen, type ScreenContext } from './screen.ts';

function checkboxes(name: string, options: readonly string[], selected: readonly string[], describe: (option: string) => string): Html {
  return html`<div class="choices">
    ${options.map(
      (option) => html`<label class="choice">
        <input type="checkbox" name="${name}" value="${option}" ${selected.includes(option) && html`checked`} />
        <span>${describe(option)}</span>
      </label>`,
    )}
  </div>`;
}

function select(name: string, label: string, options: readonly { readonly value: string; readonly label: string }[], value: string): Html {
  return html`<label class="field">
    <span class="label">${label}</span>
    <select name="${name}">
      ${options.map((option) => html`<option value="${option.value}" ${option.value === value && html`selected`}>${option.label}</option>`)}
    </select>
  </label>`;
}

const capitalize = (value: string): string => (value.charAt(0).toUpperCase() + value.slice(1)).replaceAll('_', ' ');

// Persona ------------------------------------------------------------------------

interface Persona {
  readonly persona: {
    readonly botName: string | null;
    readonly formality: string | null;
    readonly styleTraits: readonly string[];
    readonly freeformInstructions: string | null;
    readonly updatedAt: string | null;
  };
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly limits: { readonly botNameMaxLength: number; readonly freeformInstructionsMaxLength: number };
  readonly options: { readonly formality: readonly string[]; readonly styleTraits: readonly string[] };
}

export function personaScreen(context: ScreenContext): Screen {
  let data: Persona;
  return {
    title: 'Persona and tone',
    load: async () => {
      data = await context.api.get<Persona>('/v1/bot/persona');
    },
    view: () => {
      const { persona, limits, options, complete } = data;
      return html`<h1>Persona and tone</h1>
        ${!complete && html`<p class="warning">Give your bot a name to finish this section. It's required before you can go live.</p>`}
        <section class="card">
          <form data-form="persona">
            ${field({ name: 'botName', label: 'Bot name', value: persona.botName, hint: `Required. Up to ${limits.botNameMaxLength} characters.` })}
            ${select(
              'formality',
              'Formality',
              [{ value: '', label: 'Not specified' }, ...options.formality.map((value) => ({ value, label: capitalize(value) }))],
              persona.formality ?? '',
            )}
            <fieldset>
              <legend>Communication style</legend>
              ${checkboxes('styleTraits', options.styleTraits, persona.styleTraits, capitalize)}
            </fieldset>
            ${textArea({
              name: 'freeformInstructions',
              label: 'Anything else about how it should sound',
              value: persona.freeformInstructions,
              rows: 6,
              hint: `Optional. Up to ${limits.freeformInstructionsMaxLength} characters.`,
            })}
            ${errorSlot}
            <div class="row">
              <button class="primary">Save</button>
              ${persona.freeformInstructions !== null && html`<button type="button" data-action="clearFreeform">Clear the extra instructions</button>`}
            </div>
          </form>
        </section>
        ${persona.updatedAt !== null && html`<p class="hint">Last saved ${when(persona.updatedAt)}</p>`}`;
    },
    forms: {
      persona: async (values) => {
        const formality = text(values, 'formality');
        data = await context.api.put<Persona>('/v1/bot/persona', {
          botName: text(values, 'botName'),
          formality: formality === '' ? null : formality,
          styleTraits: list(values, 'styleTraits'),
          freeformInstructions: text(values, 'freeformInstructions'),
        });
        return 'Saved.';
      },
    },
    actions: {
      clearFreeform: async () => {
        data = await context.api.delete<Persona>('/v1/bot/persona/freeform-instructions');
        return 'Cleared.';
      },
    },
  };
}

// Behaviour rules ----------------------------------------------------------------

interface Rule {
  readonly id: string;
  readonly kind: string;
  readonly subject: string;
  readonly condition: string | null;
  readonly action: string;
  readonly enabled: boolean;
}

interface Rules {
  readonly rules: readonly Rule[];
  readonly freeformInstructions: string | null;
  readonly limits: { readonly subjectMaxLength: number; readonly conditionMaxLength: number; readonly freeformInstructionsMaxLength: number; readonly maxRules: number };
  readonly options: { readonly kinds: readonly string[]; readonly actions: readonly string[]; readonly condition: Readonly<Record<string, string>> };
}

const RULE_KIND_LABELS: Readonly<Record<string, string>> = {
  never: 'Never…',
  always: 'Always…',
  only_when: 'Only when…',
  avoid_topic: 'Avoid the topic…',
};

const RULE_ACTION_LABELS: Readonly<Record<string, string>> = {
  respond: 'Keep answering',
  handoff: 'Hand off to a person',
  fallback: 'Send the fallback message',
};

const ruleFields = (data: Rules, rule?: Rule): Html => html`
  ${select('kind', 'Type', data.options.kinds.map((value) => ({ value, label: RULE_KIND_LABELS[value] ?? capitalize(value) })), rule?.kind ?? 'never')}
  ${field({ name: 'subject', label: 'What the rule is about', value: rule?.subject, hint: `Up to ${data.limits.subjectMaxLength} characters.` })}
  ${field({ name: 'condition', label: 'Condition', value: rule?.condition, hint: 'Required for "Only when", optional for "Always", not used by the others.' })}
  ${select('action', 'When it applies', data.options.actions.map((value) => ({ value, label: RULE_ACTION_LABELS[value] ?? capitalize(value) })), rule?.action ?? 'respond')}
`;

const ruleBody = (values: FormValues): Record<string, unknown> => {
  const condition = text(values, 'condition');
  return {
    kind: text(values, 'kind'),
    subject: text(values, 'subject'),
    ...(condition.trim() === '' ? {} : { condition }),
    action: text(values, 'action'),
  };
};

export function rulesScreen(context: ScreenContext): Screen {
  let data: Rules;
  let editing: string | undefined;

  const reload = async (): Promise<void> => {
    data = await context.api.get<Rules>('/v1/bot/behavior-rules');
  };

  const row = (rule: Rule): Html =>
    rule.id === editing
      ? html`<li class="item"><form data-form="edit">
          <input type="hidden" name="id" value="${rule.id}" />
          ${ruleFields(data, rule)}
          ${errorSlot}
          <div class="row"><button class="primary">Save</button><button type="button" data-action="cancelEdit">Cancel</button></div>
        </form></li>`
      : html`<li class="item ${rule.enabled ? '' : 'disabled'}">
          <div>
            <strong>${RULE_KIND_LABELS[rule.kind] ?? rule.kind}</strong> ${rule.subject}
            ${rule.condition !== null && html`<span class="hint">when ${rule.condition}</span>`}
            <div class="hint">${RULE_ACTION_LABELS[rule.action] ?? rule.action}</div>
          </div>
          <div class="row">
            ${rule.enabled ? pill('Enabled', 'good') : pill('Disabled', 'muted')}
            <button data-action="toggle" data-id="${rule.id}" data-enabled="${rule.enabled ? 'false' : 'true'}">${rule.enabled ? 'Disable' : 'Enable'}</button>
            <button data-action="edit" data-id="${rule.id}">Edit</button>
            <button class="danger" data-action="remove" data-id="${rule.id}" data-confirm="Delete this rule?">Delete</button>
          </div>
        </li>`;

  return {
    title: 'Behaviour rules',
    load: reload,
    view: () => html`<h1>Behaviour rules</h1>
      <section class="card">
        <h2>Rules</h2>
        ${data.rules.length === 0 ? html`<p class="empty">No rules yet.</p>` : html`<ul class="items">${data.rules.map(row)}</ul>`}
      </section>
      <section class="card">
        <h2>Add a rule</h2>
        ${data.rules.length >= data.limits.maxRules
          ? html`<p class="warning">You've reached the limit of ${data.limits.maxRules} rules.</p>`
          : html`<form data-form="add">${ruleFields(data)}${errorSlot}<button class="primary">Add rule</button></form>`}
      </section>
      <section class="card">
        <h2>Other instructions</h2>
        <form data-form="freeform">
          ${textArea({
            name: 'freeformInstructions',
            label: 'Anything the rules above don\'t cover',
            value: data.freeformInstructions,
            rows: 6,
            hint: `Up to ${data.limits.freeformInstructionsMaxLength} characters. Applied together with the rules.`,
          })}
          ${errorSlot}
          <button class="primary">Save</button>
        </form>
      </section>
      <p><a href="/preview" data-nav>Try these out on a sample message</a></p>`,
    forms: {
      add: async (values) => {
        await context.api.post('/v1/bot/behavior-rules', ruleBody(values));
        await reload();
        return 'Rule added.';
      },
      edit: async (values) => {
        await context.api.put('/v1/bot/behavior-rules/rule', { id: text(values, 'id'), ...ruleBody(values) });
        editing = undefined;
        await reload();
        return 'Saved.';
      },
      freeform: async (values) => {
        data = await context.api.put<Rules>('/v1/bot/behavior-rules/freeform-instructions', {
          freeformInstructions: text(values, 'freeformInstructions'),
        });
        return 'Saved.';
      },
    },
    actions: {
      toggle: async ({ id, enabled }) => {
        await context.api.put('/v1/bot/behavior-rules/rule/enabled', { id, enabled: enabled === 'true' });
        await reload();
      },
      edit: ({ id }) => {
        editing = id;
      },
      cancelEdit: () => {
        editing = undefined;
      },
      remove: async ({ id }) => {
        await context.api.post('/v1/bot/behavior-rules/rule/delete', { id });
        await reload();
        return 'Rule deleted.';
      },
    },
  };
}

// Knowledge ----------------------------------------------------------------------

interface KnowledgeEntry {
  readonly id: string;
  readonly content: string;
  readonly updatedAt: string;
}

interface Knowledge {
  readonly entries: readonly KnowledgeEntry[];
  readonly configured: boolean;
  readonly limits: { readonly entryMaxLength: number; readonly maxEntries: number };
}

export function knowledgeScreen(context: ScreenContext): Screen {
  let data: Knowledge;
  let editing: string | undefined;

  const reload = async (): Promise<void> => {
    data = await context.api.get<Knowledge>('/v1/bot/knowledge');
  };

  const row = (entry: KnowledgeEntry): Html =>
    entry.id === editing
      ? html`<li class="item"><form data-form="edit">
          <input type="hidden" name="id" value="${entry.id}" />
          ${textArea({ name: 'content', label: 'Text', value: entry.content, rows: 6 })}
          ${errorSlot}
          <div class="row"><button class="primary">Save</button><button type="button" data-action="cancelEdit">Cancel</button></div>
        </form></li>`
      : html`<li class="item">
          <div class="prewrap">${entry.content}</div>
          <div class="row">
            <span class="hint">${when(entry.updatedAt)}</span>
            <button data-action="edit" data-id="${entry.id}">Edit</button>
            <button class="danger" data-action="remove" data-id="${entry.id}" data-confirm="Remove this from your bot's knowledge?">Remove</button>
          </div>
        </li>`;

  return {
    title: 'Business knowledge',
    load: reload,
    view: () => html`<h1>Business knowledge</h1>
      <section class="card">
        <h2>What your bot knows</h2>
        ${data.entries.length === 0
          ? html`<p class="empty">Nothing here yet. Add your hours, prices, delivery areas, and common questions so your bot can answer them.</p>`
          : html`<ul class="items">${data.entries.map(row)}</ul>`}
      </section>
      <section class="card">
        <h2>Add something</h2>
        ${data.entries.length >= data.limits.maxEntries
          ? html`<p class="warning">You've reached the limit of ${data.limits.maxEntries} entries.</p>`
          : html`<form data-form="add">
              ${textArea({ name: 'content', label: 'Text', rows: 6, placeholder: '', hint: `Up to ${data.limits.entryMaxLength} characters.` })}
              ${errorSlot}
              <button class="primary">Save</button>
            </form>`}
      </section>`,
    forms: {
      add: async (values) => {
        await context.api.post('/v1/bot/knowledge/entries', { content: text(values, 'content') });
        await reload();
        return 'Saved. Your bot can use this now.';
      },
      edit: async (values) => {
        await context.api.put('/v1/bot/knowledge/entries/entry', { id: text(values, 'id'), content: text(values, 'content') });
        editing = undefined;
        await reload();
        return 'Saved.';
      },
    },
    actions: {
      edit: ({ id }) => {
        editing = id;
      },
      cancelEdit: () => {
        editing = undefined;
      },
      remove: async ({ id }) => {
        await context.api.post('/v1/bot/knowledge/entries/entry/delete', { id });
        await reload();
        return 'Removed.';
      },
    },
  };
}

// Fallback messages --------------------------------------------------------------

interface FallbackPreview {
  readonly trigger: string;
  readonly message: string;
  readonly source: 'trigger' | 'shared' | 'platform_default';
}

interface Fallback {
  readonly sharedMessage: string | null;
  readonly triggerMessages: Readonly<Record<string, string | null>>;
  readonly updatedAt: string | null;
  readonly preview: readonly FallbackPreview[];
  readonly triggers: readonly string[];
  readonly limits: { readonly messageMaxLength: number };
}

const FALLBACK_TRIGGERS: Readonly<Record<string, string>> = {
  ai_error: 'When the AI service fails',
  low_confidence: "When the bot isn't sure of its answer",
  out_of_scope: "When the question is outside what it's set up for",
};

const SOURCE_LABELS: Readonly<Record<FallbackPreview['source'], string>> = {
  trigger: 'Your message for this case',
  shared: 'Your shared message',
  platform_default: 'Platform default',
};

export function fallbackScreen(context: ScreenContext): Screen {
  let data: Fallback;
  let draftPreview: readonly FallbackPreview[] | undefined;

  const body = (values: FormValues): Record<string, unknown> => ({
    sharedMessage: text(values, 'sharedMessage'),
    triggerMessages: Object.fromEntries(data.triggers.map((trigger) => [trigger, text(values, `trigger:${trigger}`)])),
  });

  return {
    title: 'Fallback messages',
    load: async () => {
      data = await context.api.get<Fallback>('/v1/bot/fallback-messages');
    },
    view: () => {
      const preview = draftPreview ?? data.preview;
      return html`<h1>Fallback messages</h1>
        <p>Sent word for word when your bot can't give a proper answer.</p>
        <section class="card">
          <form data-form="fallback">
            ${textArea({ name: 'sharedMessage', label: 'Message for every case', value: data.sharedMessage, hint: `Used wherever you don't write a specific one. Up to ${data.limits.messageMaxLength} characters.` })}
            ${data.triggers.map((trigger) =>
              textArea({ name: `trigger:${trigger}`, label: FALLBACK_TRIGGERS[trigger] ?? capitalize(trigger), value: data.triggerMessages[trigger] }),
            )}
            ${errorSlot}
            <div class="row">
              <button class="primary" name="intent" value="save">Save</button>
              <button name="intent" value="preview">Preview without saving</button>
            </div>
          </form>
        </section>
        <section class="card">
          <h2>${draftPreview === undefined ? 'What customers receive' : 'What customers would receive'}</h2>
          <ul class="items">
            ${preview.map(
              (item) => html`<li class="item column">
                <span class="label">${FALLBACK_TRIGGERS[item.trigger] ?? capitalize(item.trigger)}</span>
                <div class="bubble bot prewrap">${item.message}</div>
                <span class="hint">${SOURCE_LABELS[item.source]}</span>
              </li>`,
            )}
          </ul>
        </section>`;
    },
    forms: {
      fallback: async (values) => {
        if (text(values, 'intent') === 'preview') {
          const answer = await context.api.post<{ readonly preview: readonly FallbackPreview[] }>('/v1/bot/fallback-messages/preview', body(values));
          draftPreview = answer.preview;
          return undefined;
        }
        data = await context.api.put<Fallback>('/v1/bot/fallback-messages', body(values));
        draftPreview = undefined;
        return 'Saved.';
      },
    },
  };
}

// Disclosure ---------------------------------------------------------------------

interface Disclosure {
  readonly mode: string;
  readonly source: 'client' | 'platform_default';
  readonly updatedAt: string | null;
  readonly modes: readonly string[];
}

const DISCLOSURE_LABELS: Readonly<Record<string, string>> = {
  disclose: 'Tell customers they are talking to an automated assistant',
  do_not_disclose: "Don't bring it up",
};

export function disclosureScreen(context: ScreenContext): Screen {
  let data: Disclosure;
  return {
    title: 'Bot disclosure',
    load: async () => {
      data = await context.api.get<Disclosure>('/v1/bot/disclosure');
    },
    view: () => html`<h1>Bot disclosure</h1>
      <section class="card">
        <p>Currently: <strong>${DISCLOSURE_LABELS[data.mode] ?? data.mode}</strong>${data.source === 'platform_default' && ' (the platform default)'}</p>
        <form data-form="disclosure">
          <div class="choices">
            ${data.modes.map(
              (mode) => html`<label class="choice">
                <input type="radio" name="mode" value="${mode}" ${mode === data.mode && html`checked`} />
                <span>${DISCLOSURE_LABELS[mode] ?? mode}</span>
              </label>`,
            )}
          </div>
          ${errorSlot}
          <button class="primary">Save</button>
        </form>
      </section>`,
    forms: {
      disclosure: async (values) => {
        data = await context.api.put<Disclosure>('/v1/bot/disclosure', { mode: text(values, 'mode') });
        return 'Saved.';
      },
    },
  };
}

// Handoff ------------------------------------------------------------------------

interface Handoff {
  readonly enabled: boolean;
  readonly triggers: readonly string[];
  readonly customConditions: readonly string[];
  readonly source: 'client' | 'platform_default';
  readonly options: { readonly triggers: readonly string[]; readonly descriptions: Readonly<Record<string, string>> };
  readonly limits: { readonly conditionMaxLength: number; readonly maxConditions: number };
}

export function handoffScreen(context: ScreenContext): Screen {
  let data: Handoff;
  return {
    title: 'Human handoff',
    load: async () => {
      data = await context.api.get<Handoff>('/v1/bot/handoff');
    },
    view: () => html`<h1>Human handoff</h1>
      <p>When handoff applies, the bot stops answering that customer until you resume the conversation.</p>
      <section class="card">
        <form data-form="handoff">
          <label class="choice"><input type="checkbox" name="enabled" ${data.enabled && html`checked`} /> <span>Hand conversations off to a person</span></label>
          <fieldset>
            <legend>When</legend>
            ${checkboxes('triggers', data.options.triggers, data.triggers, (trigger) => data.options.descriptions[trigger] ?? capitalize(trigger))}
          </fieldset>
          ${textArea({
            name: 'customConditions',
            label: 'Your own conditions',
            value: data.customConditions.join('\n'),
            hint: `One per line. Up to ${data.limits.maxConditions}, each up to ${data.limits.conditionMaxLength} characters.`,
          })}
          ${errorSlot}
          <button class="primary">Save</button>
        </form>
      </section>`,
    forms: {
      handoff: async (values) => {
        data = await context.api.put<Handoff>('/v1/bot/handoff', {
          enabled: isChecked(values, 'enabled'),
          triggers: list(values, 'triggers'),
          customConditions: text(values, 'customConditions').split('\n'),
        });
        return 'Saved.';
      },
    },
  };
}

// Preview ------------------------------------------------------------------------

export type HandoffSignal =
  | { readonly kind: 'trigger'; readonly trigger: string }
  | { readonly kind: 'custom_condition'; readonly condition: string }
  | { readonly kind: 'behavior_rule'; readonly ruleId: string };

const HANDOFF_TRIGGERS: Readonly<Record<string, string>> = {
  human_request: 'The customer asked for a person',
  complaint: 'The customer made a complaint',
  out_of_scope: 'The question was outside what the bot is set up for',
};

export function handoffReason(reason: HandoffSignal | null): string {
  if (reason === null) return 'No reason recorded';
  switch (reason.kind) {
    case 'trigger':
      return HANDOFF_TRIGGERS[reason.trigger] ?? reason.trigger;
    case 'custom_condition':
      return `Your condition: ${reason.condition}`;
    case 'behavior_rule':
      return 'One of your behaviour rules';
  }
}

type PreviewAnswer =
  | { readonly outcome: 'reply'; readonly text: string }
  | { readonly outcome: 'handoff'; readonly reason: HandoffSignal }
  | { readonly outcome: 'fallback'; readonly trigger: string; readonly cause: string; readonly message: string; readonly source: FallbackPreview['source'] };

export function previewScreen(context: ScreenContext): Screen {
  let message = '';
  let answer: PreviewAnswer | undefined;

  const result = (preview: PreviewAnswer): Html => {
    switch (preview.outcome) {
      case 'reply':
        return html`<div class="bubble bot prewrap">${preview.text}</div>`;
      case 'handoff':
        return html`<p class="notice"><strong>This would be handed off to you.</strong> ${handoffReason(preview.reason)}.</p>`;
      case 'fallback':
        return html`<div class="bubble bot prewrap">${preview.message}</div>
          <p class="hint">A fallback message: ${FALLBACK_TRIGGERS[preview.trigger] ?? preview.trigger}. ${SOURCE_LABELS[preview.source]}.</p>`;
    }
  };

  return {
    title: 'Try it out',
    view: () => html`<h1>Try it out</h1>
      <p>See how your bot answers under its current settings. Nothing is sent to anyone.</p>
      <section class="card">
        <form data-form="preview">
          ${textArea({ name: 'message', label: 'A message from a customer', value: message, required: true })}
          ${errorSlot}
          <button class="primary">See the answer</button>
        </form>
      </section>
      ${answer !== undefined && html`<section class="card"><h2>Your bot would answer</h2>${result(answer)}</section>`}`,
    forms: {
      preview: async (values) => {
        message = text(values, 'message');
        answer = (await context.api.post<{ readonly preview: PreviewAnswer }>('/v1/bot/preview', { message })).preview;
      },
    },
  };
}

// Account ------------------------------------------------------------------------

export function accountScreen(context: ScreenContext, passwordPath = '/v1/account/password', signInPath = '/login', owner = true): Screen {
  return {
    title: 'Account',
    view: () => html`<h1>Account</h1>
      ${owner && html`<section class="card"><p>You are the <strong>owner</strong> of this workspace.</p></section>`}
      <section class="card">
        <h2>Change your password</h2>
        <form data-form="password">
          ${field({ name: 'currentPassword', label: 'Current password', type: 'password', required: true, autocomplete: 'current-password' })}
          ${field({ name: 'newPassword', label: 'New password', type: 'password', required: true, autocomplete: 'new-password' })}
          ${errorSlot}
          <button class="primary">Change password</button>
        </form>
        <p class="hint">Changing it signs you out everywhere.</p>
      </section>`,
    forms: {
      password: async (values) => {
        await context.api.post(passwordPath, { currentPassword: text(values, 'currentPassword'), newPassword: text(values, 'newPassword') });
        context.navigate(signInPath, 'Your password was changed. Sign in with the new one.');
      },
    },
  };
}
