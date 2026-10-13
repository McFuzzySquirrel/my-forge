import type { ReceiptState } from "./types.ts";

/**
 * Receipt state machine from contract v1 §3. `ambiguous` must be reconciled to
 * `accepted` or `failed`; it never returns to `executing` as a fresh effect.
 */
export const RECEIPT_TRANSITIONS: Readonly<Record<ReceiptState, readonly ReceiptState[]>> = {
  claimed: ["executing"],
  executing: ["effect-published", "failed", "ambiguous"],
  "effect-published": ["accepted"],
  ambiguous: ["accepted", "failed"],
  accepted: [],
  failed: [],
};

export function canTransitionReceipt(from: ReceiptState, to: ReceiptState): boolean {
  return RECEIPT_TRANSITIONS[from].includes(to);
}

export function isTerminalReceipt(state: ReceiptState): boolean {
  return RECEIPT_TRANSITIONS[state].length === 0;
}
