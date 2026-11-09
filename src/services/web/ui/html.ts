/**
 * The only way markup is made in the dashboard.
 *
 * Screens build HTML strings, and the transcript screen puts text written by
 * anyone with a phone into them. So interpolation escapes by default: a value is
 * text unless it is already an `Html`, which only this tagged template produces.
 * Getting markup out of a string needs a deliberate call to `new Html`, which no
 * screen makes.
 *
 * Values only ever go in text positions or inside quoted attributes. All five
 * special characters are escaped, so both are safe.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

/** A string already known to be safe markup. */
export class Html {
  readonly text: string;

  constructor(text: string) {
    this.text = text;
  }
}

/** What may be interpolated. `true` is excluded so that `cond && x` is the only conditional shape. */
export type Child = Html | string | number | null | undefined | false | readonly Child[];

function render(child: Child): string {
  if (child === null || child === undefined || child === false) return '';
  if (child instanceof Html) return child.text;
  if (typeof child === 'string') return escapeText(child);
  if (typeof child === 'number') return String(child);
  return child.map(render).join('');
}

export function html(strings: TemplateStringsArray, ...values: readonly Child[]): Html {
  let out = strings[0]!;
  values.forEach((value, index) => {
    out += render(value) + strings[index + 1]!;
  });
  return new Html(out);
}
