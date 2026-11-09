/**
 * Which of a tenant's business knowledge one reply's prompt carries.
 *
 * `business-knowledge-configuration.md` leaves the mechanism open and asks only
 * that replies do not contradict what the client configured. Rendering every entry
 * into every prompt satisfies that best, and it is what happens whenever the
 * knowledge fits `KNOWLEDGE_SELECTION.promptBudget`: selecting has a cost in
 * accuracy, so it is not paid until it must be. Past that point a tenant at the
 * entry limits would send about 100,000 tokens with every customer message, which
 * on a free-tier provider (`cost-efficient-operation.md`) ends in rate limits and
 * every customer getting the `ai_error` fallback.
 *
 * ## The rules that protect the facts
 *
 * Selection is the one step between the client's facts and the model that can lose
 * a fact, so it is shaped around how that goes wrong:
 *
 * - **An entry is whole or absent.** Cutting one could drop the "except Sundays"
 *   that makes the first half true.
 * - **The budget is always spent.** A message that matches nothing can still be
 *   about something the client wrote in other words, so entries are ranked and
 *   the unmatched ones fill what is left, oldest first, rather than leaving the
 *   model with nothing to go on.
 * - **The model is told when it holds a selection** (`partial`, rendered by
 *   `knowledgeDirectives`). Otherwise the absence of a fact reads as the business
 *   not offering it, and the bot denies something true.
 *
 * ## How entries are ranked
 *
 * **[DECISION]** Lexical, in process: BM25 over character trigrams. Not embeddings,
 * although IMPLEMENTATION_PLAN.md first assumed them: the provider port has no
 * embedding capability, a provider swap (`ai-provider-portability.md`) would strand
 * every stored vector, and a vector index is one more always-on thing for a corpus
 * of at most 100 entries. Trigrams rather than words because the platform has no
 * language list yet and customers do not type carefully: `entregam` shares most of
 * its trigrams with `Entregamos`, `garantai` with `garantia`, in any language and
 * with no stemmer. Accents and case are folded first, so `horario` finds `Horário`.
 *
 * The query is the end of the conversation, not only the last message, because
 * "and on Saturdays?" names no topic. Recent turns count for more.
 *
 * Pure and deterministic: nothing is stored, so nothing can be stale, and an edit
 * is in force from the next reply like any other read of the configuration.
 */

import type { ConversationTurn } from '@zeddev/ai';
import type { KnowledgeConfiguration } from './knowledge.ts';
import { characters } from './shared.ts';

export const KNOWLEDGE_SELECTION = {
  /**
   * Characters of entry text one prompt may carry: about 3,000 tokens, and room
   * for dozens of the short facts a small business writes. Must stay at least
   * `KNOWLEDGE_LIMITS.entryMaxLength`, or the most relevant entry might not fit.
   */
  promptBudget: 12_000,
  /** How many of the latest conversation turns the entries are ranked against. */
  queryTurns: 4,
} as const;

/** BM25's customary constants: how fast repeats stop counting, and how much length is discounted. */
const K1 = 1.2;
const B = 0.75;

/** A word-boundary mark on each side, so `^pi` and `ix$` carry a word's edges. Neither can occur inside a word. */
const WORD_START = '^';
const WORD_END = '$';

/** How many times each character trigram occurs in `text`. */
function trigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const folded = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  for (const [word] of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    const letters = [WORD_START, ...word, WORD_END];
    for (let i = 0; i + 2 < letters.length; i += 1) {
      const gram = `${letters[i]}${letters[i + 1]}${letters[i + 2]}`;
      counts.set(gram, (counts.get(gram) ?? 0) + 1);
    }
  }
  return counts;
}

/** A part that is wholly a bracketed note is platform wording ("The customer sent a photo"), not what was said. */
const PLATFORM_NOTE = /^\[.*\]$/s;

function saidIn(turn: ConversationTurn): string {
  if (turn.role === 'bot') return turn.text;
  return turn.parts.flatMap((part) => (part.type === 'text' && !PLATFORM_NOTE.test(part.text) ? [part.text] : [])).join(' ');
}

/** Each trigram of the latest turns, weighted so that every older turn counts half as much. */
function queryWeights(turns: readonly ConversationTurn[]): Map<string, number> {
  const weights = new Map<string, number>();
  let weight = 1;
  for (const turn of turns.slice(-KNOWLEDGE_SELECTION.queryTurns).reverse()) {
    for (const gram of trigrams(saidIn(turn)).keys()) weights.set(gram, (weights.get(gram) ?? 0) + weight);
    weight /= 2;
  }
  return weights;
}

/** BM25 score of each entry against the query, in entry order. */
function scoreEntries(contents: readonly string[], query: ReadonlyMap<string, number>): number[] {
  const documents = contents.map(trigrams);
  const lengths = documents.map((document) => [...document.values()].reduce((sum, count) => sum + count, 0));
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length;
  const scores = documents.map(() => 0);
  for (const [gram, weight] of query) {
    const holders = documents.filter((document) => document.has(gram)).length;
    if (holders === 0) continue;
    const idf = Math.log(1 + (documents.length - holders + 0.5) / (holders + 0.5));
    documents.forEach((document, index) => {
      const count = document.get(gram);
      if (count === undefined) return;
      const discount = 1 - B + B * (lengths[index]! / averageLength);
      scores[index]! += (weight * idf * (count * (K1 + 1))) / (count + K1 * discount);
    });
  }
  return scores;
}

/**
 * The knowledge one reply's prompt should carry, given the conversation it answers.
 *
 * Returns `knowledge` itself when all of it fits. Otherwise returns the entries
 * that ranked highest and fit the budget, whole, in their configured order so that
 * an unchanged selection renders an unchanged prompt, marked `partial`.
 *
 * `budget` exists for tests; the reply path uses the default.
 */
export function selectKnowledge(
  knowledge: KnowledgeConfiguration,
  turns: readonly ConversationTurn[],
  budget: number = KNOWLEDGE_SELECTION.promptBudget,
): KnowledgeConfiguration {
  const sizes = knowledge.entries.map((entry) => characters(entry.content));
  if (sizes.reduce((sum, size) => sum + size, 0) <= budget) return knowledge;

  const scores = scoreEntries(
    knowledge.entries.map((entry) => entry.content),
    queryWeights(turns),
  );
  const ranked = scores.map((_, index) => index).sort((a, b) => scores[b]! - scores[a]! || a - b);

  const chosen = new Set<number>();
  let used = 0;
  for (const index of ranked) {
    // Skipped rather than stopped at: a shorter entry further down may still fit.
    if (used + sizes[index]! > budget) continue;
    used += sizes[index]!;
    chosen.add(index);
  }
  return { entries: knowledge.entries.filter((_, index) => chosen.has(index)), partial: true };
}
