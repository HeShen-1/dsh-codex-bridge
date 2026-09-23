/**
 * CodexAppServerClient — spawns `codex app-server` and speaks JSON-RPC 2.0 over
 * stdio (one JSON message per line).
 *
 * Design notes:
 * - Lazy: the child process starts on the first call, not at plugin load.
 * - Single connection, many turns: notifications are routed by `turnId`.
 * - MVP support is deliberately limited to initialize / Thread.start /
 *   Turn.start / notification collection; steering and daemon mode are stubs
 *   with the exact method names already frozen in ./protocol.js.
 *
 * Verified against Codex 0.154.0. The process needs a writable $CODEX_HOME
 * (state/logs/queue sqlite), which is why this client must run inside the DSH
 * host process and never inside the sandboxed bash tool.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  CLIENT_INFO,
  DEFAULT_TURN_POLICY,
  JSONRPC_VERSION,
  METHODS,
  NOTIFICATIONS,
  textInput,
} from './protocol.js';

const DEFAULT_DAEMON_SOCK = 'app-server-control/app-server-control.sock';

export class CodexAppServerError extends Error {
  constructor(message, { code = undefined, method = undefined } = {}) {
    super(message);
    this.name = 'CodexAppServerError';
    if (code !== undefined) this.code = code;
    if (method !== undefined) this.method = method;
  }
}

export class CodexAppServerClient extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.codexBin] executable, default `codex`
   * @param {string} [options.codexHome] overrides $CODEX_HOME for the child
   * @param {'private'|'daemon'} [options.mode] private child, or proxy to the desktop daemon
   * @param {string} [options.daemonSock] socket path for `mode: 'daemon'`
   * @param {number} [options.requestTimeoutMs] per-request JSON-RPC timeout
   * @param {number} [options.turnTimeoutMs] default whole-turn timeout
   * @param {string} [options.cwd] working root reported to Codex
   * @param {(line: string) => void} [options.onStderr] child stderr sink
   */
  constructor(options = {}) {
    super();
    this.options = {
      codexBin: 'codex',
      codexHome: undefined,
      mode: 'private',
      daemonSock: undefined,
      requestTimeoutMs: 30_000,
      turnTimeoutMs: 180_000,
      cwd: process.cwd(),
      onStderr: undefined,
      ...options,
    };
    this.child = null;
    this.initialized = false;
    this.nextId = 1;
    this.pending = new Map();
    /** @type {Map<string, TurnState>} turnId -> accumulated state */
    this.turns = new Map();
    /** @type {Map<string, string>} cwd -> threadId */
    this.threadByCwd = new Map();
    this.stdoutBuffer = '';
  }

  /** Spawn the child (idempotent) and perform the initialize handshake. */
  async ensureStarted() {
    if (this.child && this.initialized) return this;
    if (!this.child) this.spawnChild();
    if (!this.initialized) {
      await this.request(METHODS.initialize, { clientInfo: CLIENT_INFO });
      this.initialized = true;
    }
    return this;
  }

  spawnChild() {
    const { codexBin, codexHome, mode, daemonSock, cwd, onStderr } = this.options;
    const args = ['app-server'];
    if (mode === 'daemon') {
      // stdio <-> running desktop daemon control socket.
      args.push('proxy', '--sock', daemonSock ?? daemonSocketPath(codexHome));
    }
    const env = { ...process.env };
    if (codexHome) env.CODEX_HOME = codexHome;

    const child = spawn(codexBin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (onStderr) onStderr(chunk);
      else this.emit('stderr', chunk);
    });
    child.on('exit', (code, signal) => this.onExit(code, signal));
    child.on('error', (error) => this.emit('error', error));
    this.child = child;
    return child;
  }

  onStdout(chunk) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        this.emit('protocol-error', new CodexAppServerError(`non-JSON line from app-server: ${trimmed.slice(0, 200)}`));
        continue;
      }
      this.route(message);
    }
  }

  route(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(
          new CodexAppServerError(message.error.message ?? 'app-server error', {
            code: message.error.code,
            method: entry.method,
          }),
        );
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    if (message.id !== undefined && message.method) {
      // ServerRequest: Codex is asking for a decision. MVP policy: refuse.
      this.refuseServerRequest(message);
      return;
    }
    if (message.method) {
      this.onNotification(message.method, message.params ?? {});
      this.emit('notification', message);
    }
  }

  refuseServerRequest(message) {
    this.emit('approval-refused', message);
    this.write({
      jsonrpc: JSONRPC_VERSION,
      id: message.id,
      error: { code: -32601, message: 'dsh-codex-bridge: approval requests are refused in this version' },
    });
  }

  onNotification(method, params) {
    const threadId = params.threadId;
    const turnId = params.turnId;
    switch (method) {
      case NOTIFICATIONS.agentMessageDelta: {
        const turn = this.turns.get(turnId);
        if (turn) turn.text += params.delta ?? '';
        this.emit('delta', params);
        break;
      }
      case NOTIFICATIONS.planUpdated:
      case NOTIFICATIONS.planDelta: {
        const turn = this.turns.get(turnId);
        if (turn && params.plan) {
          turn.plan = params.plan;
          turn.planExplanation = params.explanation ?? null;
        }
        this.emit('plan', params);
        break;
      }
      case NOTIFICATIONS.turnCompleted: {
        const turn = this.turns.get(turnId);
        if (turn) {
          turn.status = params.turn?.status ?? 'completed';
          turn.error = params.turn?.error ?? null;
          turn.settle();
        }
        this.emit('turn-completed', params);
        break;
      }
      default:
        if (threadId) this.emit('thread-event', { method, threadId, params });
    }
  }

  onExit(code, signal) {
    const error = new CodexAppServerError(`codex app-server exited (code=${code}, signal=${signal})`);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const turn of this.turns.values()) {
      turn.settle(error);
    }
    this.turns.clear();
    this.child = null;
    this.initialized = false;
    this.threadByCwd.clear();
    this.emit('exit', { code, signal });
  }

  write(message) {
    if (!this.child?.stdin?.writable) {
      throw new CodexAppServerError('codex app-server stdin is not writable');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}, { timeoutMs } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError(`timeout after ${timeoutMs ?? this.options.requestTimeoutMs}ms`, { method }));
      }, timeoutMs ?? this.options.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ jsonrpc: JSONRPC_VERSION, id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** `Thread/list` — read-only inventory of Codex threads. */
  async listThreads(params = {}) {
    await this.ensureStarted();
    return this.request(METHODS.threadList, params);
  }

  /** Reuse the thread previously created for this cwd, else create one. */
  async ensureThread({ cwd = this.options.cwd, name } = {}) {
    await this.ensureStarted();
    const cached = this.threadByCwd.get(cwd);
    if (cached) return cached;
    const result = await this.request(METHODS.threadStart, {
      cwd,
      ...(name ? { developerInstructions: name } : {}),
    });
    const threadId = result?.thread?.id;
    if (!threadId) throw new CodexAppServerError('Thread/start returned no thread id', { method: METHODS.threadStart });
    this.threadByCwd.set(cwd, threadId);
    return threadId;
  }

  /**
   * Start one turn and wait for `Turn/completed`.
   * @returns {Promise<{threadId: string, turnId: string, text: string, plan: any[]|null, status: string, error: any, timedOut: boolean}>}
   */
  async runTurn({ threadId, text, cwd, timeoutMs = this.options.turnTimeoutMs, policy = DEFAULT_TURN_POLICY } = {}) {
    await this.ensureStarted();
    const id = await this.ensureThread({ cwd: cwd ?? this.options.cwd });
    const target = threadId ?? id;
    const turn = createTurnState();
    const response = await this.request(METHODS.turnStart, {
      threadId: target,
      input: textInput(text),
      ...policy,
    });
    const turnId = response?.turn?.id;
    if (!turnId) throw new CodexAppServerError('Turn/start returned no turn id', { method: METHODS.turnStart });
    this.turns.set(turnId, turn);

    const outcome = await Promise.race([
      turn.completed,
      delay(timeoutMs).then(() => 'timeout'),
    ]);

    if (outcome === 'timeout') {
      // Ask Codex to stop, then report what we already collected.
      await this.request(METHODS.turnInterrupt, { threadId: target, turnId }).catch(() => {});
      this.turns.delete(turnId);
      return {
        threadId: target,
        turnId,
        text: turn.text,
        plan: turn.plan,
        status: 'timeout',
        error: null,
        timedOut: true,
      };
    }

    this.turns.delete(turnId);
    if (outcome instanceof Error) throw outcome;
    return {
      threadId: target,
      turnId,
      text: turn.text,
      plan: turn.plan,
      status: turn.status,
      error: turn.error,
      timedOut: false,
    };
  }

  /** Send a follow-up into a live turn. Method is frozen; wiring lands in P2. */
  async steer({ threadId, expectedTurnId, text }) {
    await this.ensureStarted();
    return this.request(METHODS.turnSteer, {
      threadId,
      expectedTurnId,
      input: textInput(text),
    });
  }

  async dispose() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    this.initialized = false;
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2000).unref?.();
    });
  }
}

function createTurnState() {
  let settle;
  const completed = new Promise((resolve) => {
    settle = resolve;
  });
  return {
    text: '',
    plan: null,
    planExplanation: null,
    status: 'inProgress',
    error: null,
    completed,
    settle,
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

export function daemonSocketPath(codexHome = process.env.CODEX_HOME) {
  const home = codexHome ?? `${process.env.HOME}/.codex`;
  return `${home}/${DEFAULT_DAEMON_SOCK}`;
}
