import type { TokenUsage } from "../types.js";

export interface BudgetReservation {
  readonly tokens: number;
}

/**
 * Absolute prompt+completion budget for one run. A limit of 0 disables
 * enforcement but keeps tracking spend. Enforcement is hard-fail: a request
 * that cannot be reserved is rejected instead of queued, because an absolute
 * budget never replenishes on its own.
 *
 * reserve() must be called synchronously before an LLM request (no await in
 * between) so parallel sub-agents cannot all observe the same remaining
 * budget and overshoot together.
 */
export class UsageMeter {
  private readonly limitTokens: number;
  private spentTokens = 0;
  private reservedTokens = 0;

  constructor(limitTokens: number) {
    this.limitTokens = Math.max(0, Math.floor(limitTokens));
  }

  get limit(): number {
    return this.limitTokens;
  }

  get spent(): number {
    return this.spentTokens;
  }

  get reserved(): number {
    return this.reservedTokens;
  }

  get enabled(): boolean {
    return this.limitTokens > 0;
  }

  get remaining(): number {
    if (!this.enabled) return Number.POSITIVE_INFINITY;
    return Math.max(
      0,
      this.limitTokens - this.spentTokens - this.reservedTokens,
    );
  }

  /** Holds tokens for the next request; null means the budget is exhausted. */
  reserve(tokens: number): BudgetReservation | null {
    const wanted = Math.max(1, Math.ceil(tokens));
    if (!this.enabled) {
      this.reservedTokens += wanted;
      return { tokens: wanted };
    }
    if (this.spentTokens + this.reservedTokens + wanted > this.limitTokens) {
      return null;
    }
    this.reservedTokens += wanted;
    return { tokens: wanted };
  }

  /** Replaces a reservation with the actual spend reported by the provider. */
  settle(reservation: BudgetReservation, usage?: TokenUsage): void {
    this.release(reservation);
    this.spentTokens += usage ? usageTotal(usage) : reservation.tokens;
  }

  release(reservation: BudgetReservation): void {
    this.reservedTokens = Math.max(0, this.reservedTokens - reservation.tokens);
  }

  /** Starts a fresh absolute budget; the top-level Agent calls this per run. */
  reset(): void {
    this.spentTokens = 0;
    this.reservedTokens = 0;
  }

  /**
   * Non-holding check used before spawning a sub-agent. The real enforcement
   * is the child's first reserve(), which serializes the parallel children.
   */
  canAfford(tokens: number): boolean {
    if (!this.enabled) return true;
    const wanted = Math.max(1, Math.ceil(tokens));
    return this.spentTokens + this.reservedTokens + wanted <= this.limitTokens;
  }

  describe(): string {
    if (!this.enabled) return "unlimited";
    return `remaining ~${this.remaining} of ${this.limitTokens} tokens`;
  }
}

function usageTotal(usage: TokenUsage): number {
  if (usage.total_tokens > 0) return usage.total_tokens;
  return usage.prompt_tokens + usage.completion_tokens;
}
