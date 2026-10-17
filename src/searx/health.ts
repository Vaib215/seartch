// Port of SuspendedStatus (searx/search/processors/abstract.py).
//
// Like SearXNG, suspension state lives in process memory: here, per Worker
// isolate. Isolates are reused across many requests in a data center, so a
// captcha'd engine stays suspended for most of the traffic that would hit it,
// without paying for shared storage.

import type { EngineError, EngineErrorKind } from "./types";

export interface EngineState {
  continuousErrors: number;
  /** Epoch ms. */
  suspendedUntil: number;
  reason: string;
}

export interface Outcome {
  engine: string;
  ok: boolean;
  kind?: EngineErrorKind;
  message?: string;
  suspendSeconds?: number;
}

// [base seconds, cap seconds]. Bases follow settings.yml suspended_times; the
// timeout/network/parse base is ban_time_on_fail (5s), capped at
// max_ban_time_on_fail (120s). Consecutive failures double the base up to the cap.
const POLICY: Record<EngineErrorKind, [number, number]> = {
  access_denied: [180, 6 * 3600],
  captcha: [3600, 24 * 3600],
  too_many_requests: [180, 3600],
  http: [5, 120],
  parse: [5, 120],
  timeout: [5, 120],
  network: [5, 120],
};

export function suspensionSeconds(kind: EngineErrorKind, continuousErrors: number, override?: number): number {
  const [base, cap] = POLICY[kind];
  // Engine-specified times (e.g. 15 days for a Cloudflare CAPTCHA) still get capped.
  // An override of 0 suits one server retrying a short block;
  // a fleet of Workers would just keep hammering, so it falls back to the base.
  const start = override || base;
  return Math.min(start * 2 ** Math.max(0, continuousErrors - 1), Math.max(cap, base));
}

/** Engine suspension state for this isolate. */
export class EngineHealth {
  private state = new Map<string, EngineState>();

  snapshot(): Record<string, EngineState> {
    return Object.fromEntries(this.state);
  }

  record(outcomes: Outcome[], now = Date.now()): void {
    for (const o of outcomes) {
      if (o.ok) {
        this.state.delete(o.engine);
        continue;
      }
      const errors = (this.state.get(o.engine)?.continuousErrors ?? 0) + 1;
      const seconds = suspensionSeconds(o.kind ?? "network", errors, o.suspendSeconds);
      this.state.set(o.engine, {
        continuousErrors: errors,
        suspendedUntil: now + seconds * 1000,
        reason: `${o.kind}: ${o.message ?? ""}`.trim(),
      });
    }
  }

  reset(): void {
    this.state.clear();
  }
}

export function outcomeFromError(engine: string, e: EngineError): Outcome {
  return { engine, ok: false, kind: e.kind, message: e.message, suspendSeconds: e.suspendSeconds };
}
