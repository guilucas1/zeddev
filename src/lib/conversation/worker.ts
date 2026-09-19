/**
 * The conversation worker's job handlers — what runs when an inbound message or
 * a turn's timer comes due.
 *
 * Two kinds, on the queue the gateway schedules onto (`INBOUND_QUEUE`):
 *
 * - `INBOUND_JOB_KIND` — a message was stored. Admit this end-customer's pending
 *   messages: aggregate them into the open turn, open a new one, or hold them.
 * - `TURN_JOB_KIND` — a turn's window may have run out. Close it, generate its
 *   answer, record it.
 *
 * Each handler is idempotent, because the queue is at-least-once: admission pulls
 * whatever is still undecided, and a turn's answer is recorded only if none
 * exists. The model call sits between two short transactions, never inside one.
 */

import type { AiProvider, TokenUsage } from '@zeddev/ai';
import { generateReply, type ReplyDecision } from '@zeddev/bot';
import { withTenant, type Pool } from '@zeddev/db';
import { DefectError } from '@zeddev/errors';
import { endCustomerRef, type Logger } from '@zeddev/logging';
import type { ClaimedJob, JobHandler } from '@zeddev/queue';
import type { Clock } from '@zeddev/time';
import { INBOUND_JOB_KIND, readInboundMessage } from '@zeddev/whatsapp';
import {
  admitPendingMessages,
  prepareTurn,
  recordTurnOutcome,
  TURN_JOB_KIND,
  type AggregationPolicy,
  type PreparedTurn,
  type TurnScheduler,
} from './turns.ts';

export interface ConversationWorkerDependencies {
  readonly pool: Pool;
  readonly provider: AiProvider;
  readonly scheduler: TurnScheduler;
  readonly policy: AggregationPolicy;
  readonly clock: Clock;
  readonly logger: Logger;
}

function payloadId(job: ClaimedJob, key: 'inboundMessageId' | 'turnId'): string {
  const payload = job.payload;
  const value =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload[key] : undefined;
  if (typeof value !== 'string' || value === '') {
    // Not retryable: the payload will be just as malformed next time.
    throw new DefectError(`job payload has no ${key}`, {
      code: 'conversation.job_malformed',
      context: { jobId: job.id, tenantId: job.tenantId },
    });
  }
  return value;
}

/** Handlers for `runConsumer`, keyed by job kind. */
export function conversationHandlers(dependencies: ConversationWorkerDependencies): Record<string, JobHandler> {
  return {
    [INBOUND_JOB_KIND]: (job) => handleInbound(dependencies, job),
    [TURN_JOB_KIND]: (job) => handleTurn(dependencies, job),
  };
}

async function handleInbound(dependencies: ConversationWorkerDependencies, job: ClaimedJob): Promise<void> {
  const { pool, scheduler, policy, clock, logger } = dependencies;
  const messageId = payloadId(job, 'inboundMessageId');
  const result = await withTenant(pool, job.tenantId, async (tx) => {
    const message = await readInboundMessage(tx, messageId);
    if (message === undefined) return undefined;
    const admission = await admitPendingMessages(tx, message.customerId, policy, scheduler, clock.now());
    return { admission, customerId: message.customerId };
  });
  if (result === undefined) {
    // Gone with its tenant, most likely. Nothing to answer.
    logger.warn('conversation.inbound.missing', { tenantId: job.tenantId, messageId, jobId: job.id });
    return;
  }
  logger.info('conversation.inbound.admitted', {
    tenantId: job.tenantId,
    messageId,
    jobId: job.id,
    endCustomerRef: endCustomerRef(job.tenantId, result.customerId),
    count: result.admission.aggregated,
    outcome: result.admission.held > 0 ? 'held' : 'aggregated',
  });
}

async function handleTurn(dependencies: ConversationWorkerDependencies, job: ClaimedJob): Promise<void> {
  const { pool, provider, scheduler, policy, clock, logger } = dependencies;
  const turnId = payloadId(job, 'turnId');
  const fields = { tenantId: job.tenantId, turnId, jobId: job.id, attempt: job.attempt };

  const preparation = await withTenant(pool, job.tenantId, (tx) =>
    prepareTurn(tx, turnId, policy, scheduler, clock.now()),
  );
  switch (preparation.status) {
    case 'answered':
      logger.debug('conversation.turn.already_answered', fields);
      return;
    case 'open':
      logger.debug('conversation.turn.extended', {
        ...fields,
        windowMs: Math.max(0, preparation.closesAt.getTime() - clock.now().getTime()),
      });
      return;
    case 'behind':
      logger.debug('conversation.turn.waiting', fields);
      return;
    case 'decided':
      logger.info('conversation.turn.answered', { ...fields, outcome: preparation.outcome.outcome, reason: withheldOf(preparation.outcome) });
      return;
    case 'ready':
      await answer(dependencies, job, preparation.turn);
      return;
  }

  async function answer(deps: ConversationWorkerDependencies, claimed: ClaimedJob, turn: PreparedTurn): Promise<void> {
    const started = clock.monotonicMs();
    let decision: ReplyDecision;
    let usage: TokenUsage | undefined;
    if (turn.conversation.notUnderstood !== undefined) {
      // Nothing in the turn could be understood, so there is nothing to put to
      // the model — and a model shown only "a photo that could not be viewed"
      // would be tempted to describe it anyway.
      decision = { path: 'fallback', trigger: turn.conversation.notUnderstood, cause: 'not_understood' };
    } else {
      const outcome = await generateReply(provider, turn.configuration, turn.conversation.turns, {
        conversationStart: turn.conversationStart,
      });
      decision = outcome.decision;
      usage = outcome.usage;
      if (outcome.failure !== undefined) {
        logger.warn('conversation.turn.generation_failed', {
          ...fields,
          errorKind: outcome.failure.kind,
          errorCode: outcome.failure.code,
          retryable: outcome.failure.retryable,
        });
      }
    }

    const recorded = await withTenant(deps.pool, claimed.tenantId, (tx) =>
      recordTurnOutcome(tx, turn, decision, scheduler, usage),
    );
    if (!recorded.recorded || recorded.outcome === undefined) {
      logger.info('conversation.turn.duplicate', fields);
      return;
    }
    const result = recorded.outcome;
    logger.info('conversation.turn.answered', {
      ...fields,
      conversationId: turn.conversationId,
      endCustomerRef: endCustomerRef(claimed.tenantId, turn.customerId),
      outcome: result.outcome,
      trigger: result.outcome === 'fallback' ? result.trigger : undefined,
      cause: result.outcome === 'fallback' ? result.cause : undefined,
      reason: withheldOf(result),
      durationMs: clock.monotonicMs() - started,
      tokenCount: usage === undefined ? undefined : usage.inputTokens + usage.outputTokens,
    });
  }
}

function withheldOf(outcome: { readonly outcome: string; readonly reason?: unknown }): string | undefined {
  return outcome.outcome === 'withheld' && typeof outcome.reason === 'string' ? outcome.reason : undefined;
}
