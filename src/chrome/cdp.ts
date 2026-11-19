// A minimal Chrome DevTools Protocol client over `--remote-debugging-pipe`.
// Chrome reads commands on its fd 3 and writes responses and events on its fd 4;
// each message is one JSON object terminated by a NUL byte. Sessions are flat
// (`Target.attachToTarget` with `flatten: true`): a command or event names its
// target session with `sessionId`, and none means the browser itself.

import type { Problem } from "../folders.ts";

/** An Error that is also a refusal: `{ code, message, fix }`. */
export type ProblemError = Error & Problem;

export function problemError(code: string, message: string, fix: string): ProblemError {
  return Object.assign(new Error(message), { code, fix });
}

const closedError = () =>
  problemError(
    "chrome-closed",
    "The Chrome the adapter was driving closed before it answered.",
    "Try the render again. If Chrome keeps closing, ask the person to update Google Chrome.",
  );

type Listener = (params: any, sessionId?: string) => void;
interface Pending {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  method: string;
}

export class Cdp {
  #write: NodeJS.WritableStream;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Map<string, Set<Listener>>();
  #chunks: Buffer[] = [];
  #closed = false;

  constructor(write: NodeJS.WritableStream, read: NodeJS.ReadableStream) {
    this.#write = write;
    read.on("data", (chunk: Buffer | string) => this.#receive(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
    read.on("end", () => this.close());
    read.on("close", () => this.close());
    read.on("error", () => this.close());
    write.on("error", () => this.close());
    write.on("close", () => this.close());
  }

  /** Sends one command; resolves with its result, or rejects with a ProblemError. */
  send<T = unknown>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.#closed) return Promise.reject(closedError());
    const id = this.#nextId++;
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#write.write(JSON.stringify(message) + "\0");
    });
  }

  /** Listens for one event, from any session. Returns the unsubscribe. */
  on(event: string, listener: Listener): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => void set.delete(listener);
  }

  /** Stops the client: pending and later sends reject with `chrome-closed`. Does not close Chrome. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of pending) p.reject(closedError());
    this.#listeners.clear();
  }

  #receive(chunk: Buffer) {
    // Split on NUL bytes, not characters: a chunk may end inside a multi-byte character.
    let start = 0;
    let end;
    while ((end = chunk.indexOf(0, start)) !== -1) {
      this.#chunks.push(chunk.subarray(start, end));
      const text = Buffer.concat(this.#chunks).toString("utf8");
      this.#chunks = [];
      this.#dispatch(text);
      start = end + 1;
    }
    if (start < chunk.length) this.#chunks.push(chunk.subarray(start));
  }

  #dispatch(text: string) {
    if (this.#closed) return;
    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return; // Not ours to fix; the rest of the stream is still framed correctly.
    }
    if (typeof message?.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(
          problemError(
            "cdp",
            `Chrome refused ${pending.method}: ${message.error.message ?? "unknown error"}${message.error.data ? ` (${message.error.data})` : ""}`,
            "Try the render again. If it keeps failing, ask the person to update Google Chrome.",
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message?.method === "string") {
      const set = this.#listeners.get(message.method);
      if (!set) return;
      for (const listener of [...set]) {
        try {
          listener(message.params ?? {}, message.sessionId);
        } catch {
          // A listener's bug must not stop the reader or the other listeners.
        }
      }
    }
  }
}
