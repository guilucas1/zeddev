/**
 * The conversation worker's job handlers — what runs when an inbound message or
 * a turn's timer comes due.
 *
 * Three kinds, on the queue the gateway schedules onto (`INBOUND_QUEUE`):
 *
 * - `INBOUND_JOB_KIND` — a message was stored. Admit this end-customer's pending
 *   messages: aggregate them into the open turn, open a new one, or hold them.
 * - `TURN_JOB_KIND` — a turn's window may have run out. Close it, generate its
 *   answer, record it.
 * - `DELIVERY_JOB_KIND` — an answer was recorded. Send it, and let what Meta says
 *   about it reach the connection state.
 *
 * Delivery shares this queue and this process rather than getting its own,
 * despite IMPLEMENTATION_PLAN.md's component map having placed outbound send with
 * the gateway. Two reasons decided it: the outbox is this library's table, and the
 * gateway's one hard requirement is to acknowledge a webhook fast — which is a
 * poor thing to ask of a process that also holds retrying, rate-limited sends. The
 * queue's per-tenant fairness and in-flight cap are what keep the two kinds of
 * work from starving each other here.
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
import type { SecretSealer } from '@zeddev/secrets';
import type { Clock } from '@zeddev/time';
import { assertSendableText, INBOUND_JOB_KIND, readInboundMessage, type WhatsAppCloud } from '@zeddev/whatsapp';
import {
  claimDelivery,
  settleDelivery,
  DELIVERY_JOB_KIND,
  type DeliveryAttemptOutcome,
} from './delivery.ts';
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
  /** Sends the recorded answer. */
  readonly cloud: WhatsAppCloud;
  /** Unseals the tenant's access token. */
  readonly sealer: SecretSealer;
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
    [DELIVERY_JOB_KIND]: (job) => handleDelivery(dependencies, job),
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

/**
 * Send one recorded answer.
 *
 * Shaped like `handleTurn`: a short transaction that takes the row, the network
 * call outside any transaction, then a short transaction recording what happened.
 * The difference is what the middle step costs if it is repeated — a second reply
 * to a real person — which is why the claim leaves the row in `sending` and why a
 * later attempt that finds it there records a failure instead of sending again.
 */
async function handleDelivery(dependencies: ConversationWorkerDependencies, job: ClaimedJob): Promise<void> {
  const { pool, cloud, sealer, clock, logger } = dependencies;
  const turnId = payloadId(job, 'turnId');
  const fields = { tenantId: job.tenantId, turnId, jobId: job.id, attempt: job.attempt };

  const claim = await withTenant(pool, job.tenantId, (tx) => claimDelivery(tx, sealer, turnId, clock.now()));
  switch (claim.status) {
    case 'settled':
      logger.debug('conversation.delivery.settled', { ...fields, state: claim.state });
      return;
    case 'indeterminate':
      // Recorded by `claimDelivery` itself, because the decision not to re-send
      // has to be taken under the same lock that observed the state.
      logger.warn('conversation.delivery.indeterminate', fields);
      return;
    case 'expired':
      logger.warn('conversation.delivery.window_expired', fields);
      return;
    case 'disconnected':
      logger.warn('conversation.delivery.not_connected', fields);
      return;
    case 'ready':
      break;
  }

  const started = clock.monotonicMs();
  let outcome: DeliveryAttemptOutcome;
  try {
    // Checked here as well as in the adapters, because a body this port would
    // refuse is a defect in reply generation, and spending the whole retry
    // allowance rediscovering that would delay every other tenant's work behind it.
    assertSendableText({ to: claim.to, body: claim.body });
    const sent = await cloud.sendText(claim.credentials, { to: claim.to, body: claim.body });
    outcome = { status: 'sent', messageId: sent.messageId };
  } catch (error) {
    outcome = { status: 'failed', error, attemptsRemaining: job.maxAttempts - job.attempt };
  }

  const settlement = await withTenant(pool, job.tenantId, (tx) => settleDelivery(tx, turnId, outcome));
  logger.info('conversation.delivery.settled', {
    ...fields,
    endCustomerRef: endCustomerRef(job.tenantId, claim.to),
    state: settlement.state,
    failure: settlement.failure,
    reason: settlement.reason,
    durationMs: clock.monotonicMs() - started,
  });

  // Raised only after the row is settled, so the queue's backoff is what spaces
  // the retries and the row already says the attempt is over.
  if (settlement.retry && outcome.status === 'failed') throw outcome.error;
}

function withheldOf(outcome: { readonly outcome: string; readonly reason?: unknown }): string | undefined {
  return outcome.outcome === 'withheld' && typeof outcome.reason === 'string' ? outcome.reason : undefined;
}
