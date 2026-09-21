import { ApiError, apiUrl, credentials } from "./api";

/**
 * Server-Sent Events over fetch().
 *
 * The browser's native EventSource cannot send an Authorization header, and every harness endpoint requires
 * a Bearer key. Putting the key in the URL would leak it into proxy logs and history, so we speak the same SSE
 * wire protocol over fetch() with a streaming reader. Still SSE, still no WebSocket, no backend change.
 */
export interface SseFrame {
  id?: string;
  event: string;
  data: string;
}

/** Incremental parser: feed arbitrary text chunks, get complete frames. Handles CRLF, comments, multi-line data. */
export function createSseParser(onFrame: (f: SseFrame) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n?/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let id: string | undefined;
        let event = "message";
        const data: string[] = [];
        for (const line of raw.split("\n")) {
          if (!line || line.startsWith(":")) continue; // keep-alive / comment
          const colon = line.indexOf(":");
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
          if (field === "id") id = value;
          else if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
        if (data.length || id !== undefined || event !== "message") onFrame({ id, event, data: data.join("\n") });
      }
    },
  };
}

export async function streamSse(
  path: string,
  onFrame: (f: SseFrame) => void,
  signal: AbortSignal,
  onOpen?: () => void,
): Promise<void> {
  const token = credentials.get();
  const res = await fetch(apiUrl(path), {
    headers: { Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    signal,
  });
  if (!res.ok || !res.body) {
    let message = res.statusText;
    try {
      message = (await res.json())?.error?.message ?? message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  onOpen?.();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(onFrame);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    parser.push(decoder.decode(value, { stream: true }));
  }
}
