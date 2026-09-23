/**
 * The four model-facing tools exposed by the bridge.
 *
 * Contract (enforced by wording and by the turn policy in ./protocol.js):
 * - Codex only plans or answers; it never writes on the bridge's behalf.
 * - Every returned plan is a *candidate* the DSH side still has to approve.
 * - Approval requests coming from Codex are refused, not silently accepted.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { DEFAULT_TURN_POLICY } from './protocol.js';

const PLAN_PREFIX = [
  'You are the planning half of a two-agent workflow. The other agent is DeepSeek Harness (DSH),',
  'which executes. Do not modify files and do not run commands. Produce a plan only, as a short',
  'numbered list of steps, each naming the exact file or command it would touch. Add open questions',
  'at the end if the request is ambiguous.',
].join(' ');

const ASK_DESCRIPTION =
  'Ask Codex (the desktop/CLI planning agent) for an answer, a review, or a second opinion. ' +
  'Blocks until Codex finishes that turn, then returns its text and any plan it produced. ' +
  'Codex runs read-only through this bridge: it cannot modify files.';

const PLAN_DESCRIPTION =
  'Ask Codex to produce an implementation plan without executing it. Returns numbered steps plus ' +
  'any open questions. The plan is a candidate: nothing is executed until you do it yourself.';

const STEER_DESCRIPTION =
  'Send a follow-up message into a Codex turn that is still running (answer its question, add a ' +
  'constraint, redirect the plan). Use the threadId/turnId returned by a previous codex_ask call.';

const STATUS_DESCRIPTION =
  'Report the bridge state: whether the codex app-server child is alive, its mode (private or ' +
  'desktop daemon), cached threads, and any turn in flight.';

/** @typedef {import('./client.js').CodexAppServerClient} CodexAppServerClient */

/**
 * @param {object} deps
 * @param {CodexAppServerClient} deps.client
 * @param {number} deps.planTimeoutMs
 * @param {number} deps.askTimeoutMs
 * @param {(entry: object) => void} [deps.audit]
 */
export function createBridgeTools({ client, planTimeoutMs, askTimeoutMs, audit = () => {} }) {
  const plan = defineTool({
    name: 'codex_plan',
    description: PLAN_DESCRIPTION,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'The task Codex should plan. State the goal, the repo/working directory, and any constraints.',
      },
      cwd: {
        type: 'string',
        description: 'Working root Codex should plan against. Defaults to the current session workspace.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          threadId: { type: 'string', required: true },
          turnId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          plan: { type: 'array', items: { type: 'string' }, required: true },
          text: { type: 'string', required: true },
          openQuestions: { type: 'array', items: { type: 'string' } },
          timedOut: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderPlan(value) }],
    },
    async execute(args) {
      const started = Date.now();
      const result = await client.runTurn({
        text: `${PLAN_PREFIX}\n\nTask:\n${args.prompt}`,
        cwd: args.cwd,
        timeoutMs: planTimeoutMs,
        policy: DEFAULT_TURN_POLICY,
      });
      const steps = (result.plan ?? []).map((step) => `${statusMark(step.status)} ${step.step}`);
      const value = {
        threadId: result.threadId,
        turnId: result.turnId,
        status: result.status,
        plan: steps.length > 0 ? steps : splitNumbered(result.text),
        text: result.text,
        ...(result.timedOut ? { timedOut: true } : {}),
      };
      audit({ tool: 'codex_plan', ms: Date.now() - started, ...value });
      return value;
    },
  });

  const ask = defineTool({
    name: 'codex_ask',
    description: ASK_DESCRIPTION,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'The question or request for Codex. Be specific; Codex cannot see this conversation.',
      },
      cwd: {
        type: 'string',
        description: 'Working root Codex should answer against. Defaults to the current session workspace.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          threadId: { type: 'string', required: true },
          turnId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          text: { type: 'string', required: true },
          plan: { type: 'array', items: { type: 'string' } },
          timedOut: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderAsk(value) }],
    },
    async execute(args) {
      const started = Date.now();
      const result = await client.runTurn({
        text: args.prompt,
        cwd: args.cwd,
        timeoutMs: askTimeoutMs,
        policy: DEFAULT_TURN_POLICY,
      });
      const value = {
        threadId: result.threadId,
        turnId: result.turnId,
        status: result.status,
        text: result.text,
        ...(result.plan ? { plan: result.plan.map((step) => `${statusMark(step.status)} ${step.step}`) } : {}),
        ...(result.timedOut ? { timedOut: true } : {}),
      };
      audit({ tool: 'codex_ask', ms: Date.now() - started, ...value });
      return value;
    },
  });

  const steer = defineTool({
    name: 'codex_steer',
    description: STEER_DESCRIPTION,
    parameters: {
      threadId: { type: 'string', required: true, description: 'Codex thread id to steer.' },
      turnId: { type: 'string', required: true, description: 'The in-flight turn id (from codex_ask/codex_plan).' },
      message: { type: 'string', required: true, description: 'The message to inject into the running turn.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          threadId: { type: 'string', required: true },
          turnId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `steered turn ${value.turnId} on thread ${value.threadId}` }],
    },
    async execute(args) {
      const result = await client.steer({
        threadId: args.threadId,
        expectedTurnId: args.turnId,
        text: args.message,
      });
      const value = { threadId: args.threadId, turnId: result?.turnId ?? args.turnId };
      audit({ tool: 'codex_steer', ...value });
      return value;
    },
  });

  const status = defineTool({
    name: 'codex_status',
    description: STATUS_DESCRIPTION,
    parameters: {
      listThreads: {
        type: 'boolean',
        description: 'Also query Codex for its recent threads (Thread/list). Slower but shows what Codex already knows.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          alive: { type: 'boolean', required: true },
          initialized: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          inFlight: { type: 'number', required: true },
          threads: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute(args) {
      const value = {
        alive: Boolean(client.child),
        initialized: client.initialized,
        mode: client.options.mode,
        inFlight: client.turns.size,
        threads: [...client.threadByCwd].map(([cwd, id]) => `${id}  ${cwd}`),
      };
      if (args.listThreads) {
        const listed = await client.listThreads({ limit: 10 });
        value.threads = (listed?.data ?? []).map((thread) => `${thread.id}  ${thread.name ?? '(unnamed)'}  ${thread.cwd}`);
      }
      return value;
    },
  });

  return [plan, ask, steer, status];
}

function statusMark(status) {
  if (status === 'completed') return '[x]';
  if (status === 'inProgress') return '[~]';
  return '[ ]';
}

function splitNumbered(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^(\d+[.)]|[-*])\s+/.test(line))
    .map((line) => line.replace(/^(\d+[.)]|[-*])\s+/, ''));
}

function renderPlan(value) {
  const lines = [`Codex plan (${value.status}) — thread ${value.threadId}`];
  if (value.timedOut) lines.push('NOTE: timed out; showing partial result.');
  lines.push('');
  lines.push(...(value.plan.length > 0 ? value.plan : ['(no numbered steps returned)']));
  if (value.text && value.plan.length === 0) {
    lines.push('', value.text);
  }
  return lines.join('\n');
}

function renderAsk(value) {
  const lines = [`Codex reply (${value.status}) — thread ${value.threadId}`, ''];
  if (value.timedOut) lines.push('NOTE: timed out; showing partial result.', '');
  lines.push(value.text || '(empty reply)');
  if (value.plan?.length) lines.push('', 'Plan:', ...value.plan);
  return lines.join('\n');
}

function renderStatus(value) {
  return [
    `app-server: ${value.alive ? 'alive' : 'not started'} / initialized=${value.initialized} / mode=${value.mode}`,
    `turns in flight: ${value.inFlight}`,
    `known threads: ${value.threads.length}`,
    ...value.threads.map((line) => `  ${line}`),
  ].join('\n');
}
