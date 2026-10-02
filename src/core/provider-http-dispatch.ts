import { AsyncLocalStorage } from "node:async_hooks";
import { observeProviderResponseBody } from "./provider-response-body.ts";

/** Runtime-owned identity. Never populate these fields from action input or HTTP headers. */
export interface ProviderDispatchContext {
  readonly operation: "runtime" | "action" | "proxy" | "trigger" | "credential_validation" | "oauth";
  readonly service?: string;
  readonly actionId?: string;
  readonly executionId?: string;
  readonly connectionId?: string;
  /** Alias from the resolved stored connection, not the caller's requested alias. */
  readonly connectionName?: string;
  readonly connectionRevision?: string;
}

/** Opaque authority supplied by the embedding host, independently of provider credentials. */
export interface ProviderDispatchAuthority {
  readonly workspaceId?: string;
  readonly connectionLineageId?: string;
  readonly workClass?: string;
}

/** A screened HTTP hop. URLs, paths, queries, headers and bodies are deliberately absent. */
export interface ProviderHttpAttempt {
  readonly attemptId: string;
  readonly requestId: string;
  readonly redirectHop: number;
  readonly method: string;
  readonly origin: string;
  readonly context: ProviderDispatchContext;
  readonly authority: ProviderDispatchAuthority;
}

/** Transport failures may have reached the provider; they are never evidence for a credit refund. */
export type ProviderHttpAttemptResult =
  | { readonly kind: "response"; readonly status: number; readonly retryAfter?: string }
  | { readonly kind: "transport_error" }
  | { readonly kind: "not_dispatched"; readonly reason: "cancelled" | "dispatch_failed" };

/** Separate body/operation evidence. Headers and local cancellation are not EOF. */
export interface ProviderHttpBodyEnd {
  readonly kind: "eof" | "unknown";
}

/** Set by the transport adapter, never by a provider request header or action input. */
export type ProviderResponseObservation = "body" | "metadata_only";

export interface ProviderHttpPermit {
  readonly allow: true;
  /** Awaited immediately before transport. Persist dispatch commitment here; failures deny egress. */
  readonly onDispatch?: () => void | Promise<void>;
  /** Exactly once after a permit is returned, including cancellation before dispatch. */
  readonly onResult?: (result: ProviderHttpAttemptResult) => void | Promise<void>;
  /**
   * Optional once-only EOF/unknown observer. An unread body does not complete.
   * Feedback runs independently of native body close/error/cancel; the host
   * retains conservative attempt state until its durable bookkeeping settles.
   */
  readonly onBodyEnd?: (event: ProviderHttpBodyEnd) => void | Promise<void>;
}

export interface ProviderHttpDenial {
  readonly allow: false;
  /** Retry-After delay in whole seconds. */
  readonly retryAfterSeconds?: number;
}

export interface ProviderHttpDispatchOptions {
  /** Await admission to delay a request, or return a denial. Honour the signal while queued. */
  readonly beforeAttempt: (
    attempt: ProviderHttpAttempt,
    signal: AbortSignal | undefined,
  ) => ProviderHttpPermit | ProviderHttpDenial | Promise<ProviderHttpPermit | ProviderHttpDenial>;
  /** Resolve workspace/lineage authority from runtime identity, never request credentials. */
  readonly bindAuthority?: (
    context: ProviderDispatchContext,
  ) => ProviderDispatchAuthority | Promise<ProviderDispatchAuthority>;
  /** Feedback failure leaves the attempt spent/unknown. This observer cannot change the transport result. */
  readonly onFeedbackError?: (attempt: ProviderHttpAttempt) => void | Promise<void>;
}

interface DispatchScope {
  options: ProviderHttpDispatchOptions;
  context: ProviderDispatchContext;
  receipt: { denial?: ProviderHttpDispatchError };
}

export interface GuardedHttpAttempt {
  readonly requestId: string;
  readonly redirectHop: number;
  readonly method: string;
  readonly origin: string;
  readonly responseObservation?: ProviderResponseObservation;
}

export type GuardedHttpDispatcher = (
  attempt: GuardedHttpAttempt,
  signal: AbortSignal | undefined,
  transport: () => Promise<Response>,
  revalidate: () => Promise<void>,
) => Promise<Response>;

const scopes = new AsyncLocalStorage<DispatchScope>();

/** Safe retryable denial, including hook/readiness failures; it contains no callback error details. */
export class ProviderHttpDispatchError extends Error {
  readonly retryAfterSeconds?: number;

  constructor(retryAfterSeconds?: number) {
    super("Provider HTTP dispatch is temporarily unavailable.");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Bind a hook to asynchronous provider work. Nested scopes inherit the configured hook;
 * concurrent requests stay isolated. Standalone providerFetch users can opt in here too.
 */
export function withProviderHttpDispatch<T>(
  context: ProviderDispatchContext,
  run: () => T,
  options?: ProviderHttpDispatchOptions,
): T {
  const parent = scopes.getStore();
  const configured = options ?? parent?.options;
  if (!configured) return run();
  // Copy an explicit allowlist so accidental credential-bearing extra fields cannot escape.
  const snapshot: ProviderDispatchContext = Object.freeze({
    operation: context.operation,
    service: context.service,
    actionId: context.actionId,
    executionId: context.executionId,
    connectionId: context.connectionId,
    connectionName: context.connectionName,
    connectionRevision: context.connectionRevision,
  });
  return scopes.run(
    { options: configured, context: snapshot, receipt: parent?.options === configured ? parent.receipt : {} },
    run,
  );
}

/**
 * A provider invocation boundary: retain the original denial even if provider code catches,
 * replaces, or converts it to a result. Each invocation owns its marker, so a sibling's
 * denial cannot override another invocation's successful retry or fallback.
 */
export async function runWithProviderHttpDispatch<T>(
  context: ProviderDispatchContext,
  run: () => T | Promise<T>,
  options?: ProviderHttpDispatchOptions,
): Promise<T> {
  return withProviderHttpDispatch(
    context,
    async () => {
      const inherited = scopes.getStore();
      if (!inherited) return run();
      const scope: DispatchScope = { ...inherited, receipt: {} };
      return scopes.run(scope, async () => {
        try {
          const result = await run();
          if (scope.receipt.denial) throw scope.receipt.denial;
          return result;
        } catch (error) {
          throw scope.receipt.denial ?? error;
        }
      });
    },
    options,
  );
}

function deny(scope: DispatchScope, retryAfterSeconds?: number): ProviderHttpDispatchError {
  return (scope.receipt.denial ??= Object.freeze(new ProviderHttpDispatchError(retryAfterSeconds)));
}

/** Whether an SDK transport needs to use the opt-in provider HTTP dispatch bridge. */
export function isProviderHttpDispatchConfigured(): boolean {
  return scopes.getStore() !== undefined;
}

/** Called only at the screened raw-transport seam, once for every HTTP attempt and redirect hop. */
export const dispatchProviderHttpAttempt: GuardedHttpDispatcher = async (target, signal, transport, revalidate) => {
  const scope = scopes.getStore();
  if (!scope) return transport();
  signal?.throwIfAborted();
  // Denial is terminal for this invocation. A provider may catch it, but must not complete
  // later side effects that the boundary would then misreport as a retryable denial.
  if (scope.receipt.denial) throw scope.receipt.denial;
  let permit: ProviderHttpPermit | ProviderHttpDenial;
  let attempt: ProviderHttpAttempt;
  try {
    const authority = await waitForSignal(Promise.resolve(scope.options.bindAuthority?.(scope.context)), signal);
    signal?.throwIfAborted();
    if (scope.receipt.denial) throw scope.receipt.denial;
    attempt = Object.freeze({
      attemptId: crypto.randomUUID(),
      requestId: target.requestId,
      redirectHop: target.redirectHop,
      method: target.method,
      origin: target.origin,
      context: scope.context,
      authority: Object.freeze({
        workspaceId: authority?.workspaceId,
        connectionLineageId: authority?.connectionLineageId,
        workClass: authority?.workClass,
      }),
    });
    permit = await waitForSignal(
      Promise.resolve(scope.options.beforeAttempt(attempt, signal)),
      signal,
      async (late) => {
        if (late?.allow)
          await reportFeedback(scope.options, attempt, late, { kind: "not_dispatched", reason: "cancelled" });
      },
    );
    if (!permit || typeof permit.allow !== "boolean") throw new ProviderHttpDispatchError();
  } catch {
    signal?.throwIfAborted();
    throw deny(scope);
  }
  if (!permit.allow) {
    const seconds = permit.retryAfterSeconds;
    throw deny(scope, Number.isSafeInteger(seconds) && seconds! >= 0 ? seconds : undefined);
  }
  const admitted = permit;
  const feedback = (result: ProviderHttpAttemptResult): Promise<void> =>
    reportFeedback(scope.options, attempt, admitted, result);
  try {
    signal?.throwIfAborted();
    if (scope.receipt.denial) throw scope.receipt.denial;
    await waitForSignal(Promise.resolve(admitted.onDispatch?.()), signal);
    if (scope.receipt.denial) throw scope.receipt.denial;
    // Admission can wait arbitrarily long. Re-screen DNS/URL before issuing the admitted hop.
    await waitForSignal(revalidate(), signal);
    signal?.throwIfAborted();
    if (scope.receipt.denial) throw scope.receipt.denial;
  } catch {
    await feedback({ kind: "not_dispatched", reason: signal?.aborted ? "cancelled" : "dispatch_failed" });
    signal?.throwIfAborted();
    throw deny(scope);
  }
  let response: Response;
  try {
    response = await transport();
  } catch (error) {
    await feedback({ kind: "transport_error" });
    throw error;
  }
  // Report every HTTP status, including redirect responses. No response body is read or exposed.
  await feedback({
    kind: "response",
    status: response.status,
    retryAfter: response.headers.get("retry-after") ?? undefined,
  });
  // Keep the exact Response and legacy body behavior when no observer is set.
  if (!admitted.onBodyEnd) return response;
  return observeProviderResponseBody(response, {
    method: target.method,
    observation: target.responseObservation ?? "body",
    signal,
    onBodyEnd: async (event) => {
      try {
        await admitted.onBodyEnd?.(event);
      } catch {
        try {
          await scope.options.onFeedbackError?.(attempt);
        } catch {
          // Completion feedback cannot cause an already-issued request replay.
        }
      }
    },
  });
};

async function reportFeedback(
  options: ProviderHttpDispatchOptions,
  attempt: ProviderHttpAttempt,
  permit: ProviderHttpPermit,
  result: ProviderHttpAttemptResult,
): Promise<void> {
  try {
    await permit.onResult?.(Object.freeze(result));
  } catch {
    try {
      await options.onFeedbackError?.(attempt);
    } catch {
      // Feedback cannot turn an already-issued request into a failure that a caller might replay.
    }
  }
}

async function waitForSignal<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  onLate?: (value: T) => Promise<void>,
): Promise<T> {
  if (!signal) return pending;
  let cancelled = false;
  const completed = pending.then(async (value) => {
    if (cancelled) await onLate?.(value);
    return value;
  });
  let abort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      cancelled = true;
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([completed, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
