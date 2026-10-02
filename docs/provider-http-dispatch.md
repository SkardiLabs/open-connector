# Provider HTTP dispatch hooks

Embedding hosts can opt into admission for each provider HTTP attempt with
`createConnectorRuntime({ ..., providerHttpDispatch })` or
`createConnectApp({ ..., providerHttpDispatch })`. There is no hook when the
option is absent. A hook applies to module-level provider fetchers as well as
executor-injected fetchers, and survives rewrapping a fetcher with a different
egress policy.

```typescript
const providerHttpDispatch = {
  async bindAuthority(context) {
    // Resolve these opaque IDs from the host's trusted runtime configuration.
    return { workspaceId: hostWorkspaceId, connectionLineageId: await lineageFor(context.connectionId) };
  },
  async beforeAttempt(attempt, signal) {
    const permit = await arbiter.admit(attempt, signal);
    if (!permit.allowed) return { allow: false, retryAfterSeconds: permit.retryAfterSeconds };
    return {
      allow: true,
      onDispatch: () => arbiter.commitDispatch(attempt.attemptId),
      onResult: (result) => arbiter.recordResult(attempt.attemptId, result),
    };
  },
};
```

The example's arbiter and identity resolver belong to the host; Open Connector
does not add a scheduler, budget, persistence store or default rate policy.
`beforeAttempt` may wait to delay dispatch, or return `allow: false` to deny it.
A denial becomes `rate_limited` / HTTP 429, with `Retry-After` when the hook
provides a nonnegative safe integer `retryAfterSeconds`. Authority-binding,
admission and dispatch-commit failures fail closed with the same safe retryable
denial. Callback error strings are never exposed to clients.

Each attempt has a unique `attemptId`. Each fetch invocation has a `requestId`,
shared by its redirect hops, with `redirectHop` starting at zero. A provider's
internal retry is another fetch invocation and requires another admission.
Manual redirects admit the first HTTP attempt only. Followed redirects are
admitted individually, using the actual hop's origin and rewritten method.

The frozen context contains only runtime-owned operation, catalog service/action,
execution ID and resolved connection ID/revision when available. Action inputs,
incoming request headers, credential/profile metadata, URL paths/queries/fragments,
request headers/bodies and response bodies are absent. `bindAuthority` receives
only that context; its frozen output copies only `workspaceId`,
`connectionLineageId` and `workClass`. New-connection validation and initial OAuth
exchange have no established connection identity. The request's outer fallback
scope has operation `runtime`; a host needing stricter identity must deny unknown
contexts, not derive authority from request data.

Admission runs after the initial URL/DNS guard. The guard runs again after
admission and dispatch commitment, immediately before egress, because queued
work may wait long enough for DNS answers to change. Private-network opt-in,
redirect checks and cross-origin credential stripping remain in force.

`onDispatch` completes before transport is called. `onResult` receives a frozen
`response` result (status and the response's `Retry-After` header only),
`transport_error` (the request may have reached the provider), or
`not_dispatched` (cancellation or failed dispatch commitment/revalidation).
Queued cancellation returns promptly even if admission ignores the signal;
a late permit receives `not_dispatched`. Cancellation after transport starts
does not retract or refund the attempt. Hosts must never refund spent credit
based on missing result feedback. `onResult` failure preserves the original
response/error and optionally invokes `onFeedbackError(attempt)`; that observer
also cannot change the transport outcome. Keep callbacks bounded and persist
dispatch commitment before allowing a request.

Library callers can use `withProviderHttpDispatch(context, run, options)` from
`src/core/provider-http-dispatch.ts` around standalone provider fetches. Nested
scopes inherit the hook and replace identity; concurrent scopes remain isolated.
Hosts should use their own control-plane transport for arbiter RPCs rather than
recursively calling provider fetchers from a hook. The async scope uses
`AsyncLocalStorage.run/getStore`, available on Node, Bun and Workers with the
repository's `nodejs_compat` configuration.

Coverage is provider HTTP through the shared guarded fetch, including provider
content downloads, credential validation, OAuth requests and Trigger proxies.
The existing Alibaba Cloud OSS SDK action transport requires a separate bridge
before it can share this admission seam. Non-HTTP egress is outside this hook:
Home Assistant WebSockets, MQTT over WebSockets, and IMAP/SMTP TCP/TLS connections
keep their own SSRF guards but do not acquire an HTTP permit. Platform transit
storage, remote SaaS/Marketplace execution and host control-plane requests also
do not share local-provider admission. This HTTP seam alone is not an all-egress
rate-limit guarantee.
