import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * A `fetch` that routes provider calls through Rust (`ai_chat_stream`), so the
 * API key never enters the webview. The AI SDK sees an ordinary fetch; the key
 * is read from the OS credential store on the Rust side and injected there.
 *
 * Only the path is sent — the host comes from a hardcoded allowlist in
 * `src-tauri/src/ai.rs`, so this cannot be pointed at another server.
 */

type StreamEvent =
  | { kind: "head"; status: number }
  | { kind: "chunk"; text: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

export function proxyFetch(provider: string): typeof globalThis.fetch {
  return async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const body =
      typeof init?.body === "string"
        ? init.body
        : init?.body instanceof Uint8Array
          ? new TextDecoder().decode(init.body)
          : "";
    const headers = [...new Headers(init?.headers as HeadersInit).entries()];

    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
    });

    let onHead: (status: number) => void;
    let onFail: (e: unknown) => void;
    const head = new Promise<number>((resolve, reject) => {
      onHead = resolve;
      onFail = reject;
    });

    const fail = (e: unknown) => {
      onFail(e);
      if (!closed) {
        closed = true;
        try {
          controller?.error(e);
        } catch {}
      }
    };

    const channel = new Channel<StreamEvent>();
    channel.onmessage = (event) => {
      switch (event.kind) {
        case "head":
          onHead(event.status);
          break;
        case "chunk":
          if (!closed) controller?.enqueue(encoder.encode(event.text));
          break;
        case "done":
          if (!closed) {
            closed = true;
            controller?.close();
          }
          break;
        case "error":
          fail(new Error(event.message));
          break;
      }
    };

    // Not awaited: the promise settles when the whole stream is finished, but
    // the Response must be returned as soon as the status arrives.
    invoke("ai_chat_stream", {
      provider,
      path: url.pathname + url.search,
      body,
      headers,
      onEvent: channel,
    }).catch(fail);

    const status = await head;
    return new Response(stream, {
      status,
      headers: { "content-type": "text/event-stream" },
    });
  };
}
