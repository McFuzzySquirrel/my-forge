// ─── Where a run's harness activity can be read ──────────────────────────────
//
// Worker-container attempts publish bounded activity through the service API.
// Native host attempts stream to the host-runner log instead. Both require the
// run to be submitted with `logHarnessActivity`; without it there is nothing to
// read. Keeping the decision pure makes it testable without a DOM.

export type ActivityPresentation =
  | { readonly kind: "disabled" }
  | { readonly kind: "host-log" }
  | { readonly kind: "service" };

export function activityPresentation(run: {
  readonly hostExecution?: boolean;
  readonly logHarnessActivity?: boolean;
}): ActivityPresentation {
  if (run.logHarnessActivity !== true) return { kind: "disabled" };
  return run.hostExecution === true ? { kind: "host-log" } : { kind: "service" };
}
