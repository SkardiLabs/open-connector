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
The runtime retains an invocation-local, sanitized denial marker, so a provider's
own catch/error mapping cannot turn admission denial into invalid credentials or
an upstream failure. Denial is terminal for that invocation: caught-denial retries
and fallbacks cannot dispatch later side effects and then return a retryable 429.
Independent nested invocations have independent markers and can retry explicitly.
Earlier attempts in a multi-request operation may already have reached the provider;
a later denial cannot undo those side effects or make replay inherently idempotent.

Each attempt has a unique `attemptId`. Each fetch invocation has a `requestId`,
shared by its redirect hops, with `redirectHop` starting at zero. A provider's
internal retry is another fetch invocation and requires another admission.
Manual redirects admit the first HTTP attempt only. Followed redirects are
admitted individually, using the actual hop's origin and rewritten method.

The frozen context contains only runtime-owned operation, catalog service/action,
execution ID and resolved connection ID, stored connection name and opaque
credential revision when available. The stored name is not copied from incoming
headers or action input. Revision is a string, not a host commit sequence; a
host must independently map and revalidate its own connection authority.
Action inputs,
incoming request headers, credential/profile metadata, URL paths/queries/fragments,
request headers/bodies and response bodies are absent. `bindAuthority` receives
only that context; its frozen output copies only `workspaceId`,
`connectionLineageId` and `workClass`. New-connection validation and initial OAuth
exchange have no established connection identity. The request's outer fallback
scope has operation `runtime`; a host needing stricter identity must deny unknown
contexts, not derive authority from request data.

With admission configured, execution credentials are frozen snapshots paired with
the revision that supplied their bytes. Unset credential mutability is retained.
OAuth refresh uses the connection store's optional
`updateCredentialSnapshot(input, refresh)` compare-and-swap method, which must
atomically return the written credential and new revision, or `undefined` on a
failed comparison. SQL stores implement this using `RETURNING`; a later read is
not a valid substitute because concurrent reauthorization could relabel old
credentials with a newer revision. Boolean-only custom stores still refresh
without a hook, but a configured hook fails closed before refresh if this atomic
snapshot method is unavailable. Trigger execution also rejects a changed revision
between resolving its credential snapshot and binding its target.

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
`not_dispatched` does not roll back a host's already-spent dispatch commitment;
Open Connector never refunds credits or chooses the host's replay policy.

Hosts that can affirmatively settle a completed HTTP attempt may additionally
return `onBodyEnd(event)`, where `event.kind` is `eof` or `unknown`. This is
separate from `onResult(response)`, which observes **headers**, never body EOF.
The optional body observer reads lazily, one upstream chunk per downstream
pull, preserving status, headers, response metadata and native clone behavior.
No observer means the exact original Response and body behavior are retained.

Only consuming a real response body through EOF, or an explicit real no-body
response (HEAD with a final HTTP status, 204/205/304), supplies EOF evidence.
An unread body supplies none. Cancellation, abort, stream failure, already-used
or locked bodies, status-zero error/opaque responses and unclassified null
bodies remain unknown. SDK synthetic metadata responses, including Alibaba OSS
HEAD/204, never supply real-body EOF. Re-guarding retains that restriction.
Cancelling a followed redirect's response does not prove its attempt finished;
a strict host must provide a qualified completion/reconciliation policy or
conservatively deny the next hop.

Body feedback starts once but does not delay native close, errors or
cancellation. A slow/failed bookkeeping callback cannot turn completed provider
bytes into a timeout/replay candidate; `onFeedbackError` remains advisory.
Hosts must retain the slot until their exact durable completion receipt and
exclusive-owner settlement are confirmed. The callback is not socket fencing,
generic recovery or permission to refund an uncertain request.

Library callers can use `withProviderHttpDispatch(context, run, options)` from
`src/core/provider-http-dispatch.ts` around standalone provider fetches. Nested
scopes inherit the hook and replace identity; concurrent scopes remain isolated.
Use `runWithProviderHttpDispatch` at an asynchronous invocation boundary if the
called library may catch and remap transport errors: it rethrows the original
sanitized admission denial even when the library returns a converted error result.
Hosts should use their own control-plane transport for arbiter RPCs rather than
recursively calling provider fetchers from a hook. The async scope uses
`AsyncLocalStorage.run/getStore`, available on Node, Bun and Workers with the
repository's `nodejs_compat` configuration.

Coverage is provider HTTP through the shared guarded fetch, including provider
content downloads, credential validation, OAuth requests and Trigger proxies.
Alibaba Cloud OSS SDK actions bridge the SDK's existing urllib transport into
the same guarded seam when configured. Signing, request bodies/streams, response
objects and SDK retries are retained; native redirects are surfaced as errors.
SDK transport cancellation after dispatch follows its existing timeout behavior.
Non-HTTP egress is outside this hook:
Home Assistant WebSockets, MQTT over WebSockets, and IMAP/SMTP TCP/TLS connections
keep their own SSRF guards but do not acquire an HTTP permit. Platform transit
storage, remote SaaS/Marketplace execution and host control-plane requests also
do not share local-provider admission. This HTTP seam alone is not an all-egress
rate-limit guarantee.
