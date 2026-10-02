import type { ProviderHttpBodyEnd, ProviderResponseObservation } from "./provider-http-dispatch.ts";

export interface ProviderResponseBodyOptions {
  method: string;
  observation: ProviderResponseObservation;
  signal?: AbortSignal;
  onBodyEnd: (event: ProviderHttpBodyEnd) => void | Promise<void>;
}

/**
 * Observe only a real transport body. No tee/eager drain/all-body buffering is
 * introduced: one upstream chunk is read for one downstream pull. The caller
 * owns ordinary JSON/stream consumption and its existing memory limits.
 *
 * SDK metadata responses are not no-body proof. Cancellation, stream errors,
 * abort and an unclassified null body never produce EOF. An unread body stays
 * outstanding; headers alone do not complete it. Feedback starts once but is
 * not awaited by the body: a slow host cannot turn completed bytes into a
 * provider timeout or delay native cancellation. Until feedback settles the
 * host must conservatively retain the attempt, not permit another send.
 */
export async function observeProviderResponseBody(
  response: Response,
  options: ProviderResponseBodyOptions,
): Promise<Response> {
  let settled = false;
  const settle = async (kind: ProviderHttpBodyEnd["kind"]): Promise<void> => {
    if (settled) return;
    settled = true;
    options.signal?.removeEventListener("abort", abort);
    try {
      await options.onBodyEnd(Object.freeze({ kind }));
    } catch {
      // Completion feedback can fail, but cannot replace provider bytes/errors
      // with a retryable request failure after upstream was already contacted.
    }
  };
  const abort = (): void => {
    void settle("unknown");
  };

  if (options.observation === "metadata_only") {
    void settle("unknown");
    return response;
  }
  if (options.signal?.aborted) {
    void settle("unknown");
    return response;
  }
  if (!response.body) {
    const finalHttpResponse = response.status >= 200 && response.status <= 599;
    const noBody = finalHttpResponse && (options.method === "HEAD" || [204, 205, 304].includes(response.status));
    void settle(noBody ? "eof" : "unknown");
    return response;
  }
  if (response.bodyUsed || response.body.locked) {
    void settle("unknown");
    return response;
  }
  options.signal?.addEventListener("abort", abort, { once: true });
  const upstream = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller): Promise<void> {
        try {
          reader ??= upstream.getReader();
          const chunk = await reader.read();
          if (chunk.done) {
            void settle("eof");
            controller.close();
            reader.releaseLock();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          void settle("unknown");
          controller.error(error);
          reader?.releaseLock();
        }
      },
      async cancel(reason): Promise<void> {
        // Local cancellation is not proof that upstream work has terminated.
        void settle("unknown");
        try {
          // Start native cancellation without waiting on host bookkeeping.
          if (reader) await reader.cancel(reason);
          else await upstream.cancel(reason);
        } finally {
          reader?.releaseLock();
        }
      },
    },
    { highWaterMark: 0 },
  );
  const observed = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  return preserveResponseMetadata(observed, response);
}

function preserveResponseMetadata(target: Response, source: Response): Response {
  const clone = target.clone.bind(target);
  Object.defineProperties(target, {
    url: { value: source.url },
    redirected: { value: source.redirected },
    type: { value: source.type },
    // A provider-requested clone keeps native tee semantics. Both branches
    // consume the same upstream observer, so EOF/cancel is reported only once.
    clone: { value: (): Response => preserveResponseMetadata(clone(), source) },
  });
  return target;
}
