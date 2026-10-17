import { HOST_CONCURRENCY, RPC_TIMEOUT_MS } from "./constants.js";

export interface RpcRequest {
  method: string;
  params: unknown[];
}

export interface RpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class RpcError extends Error {
  constructor(message: string, readonly kind: "timeout" | "transport" | "rpc", readonly code?: number) {
    super(message);
  }
}

// Anything that can answer JSON-RPC: the HTTP pool in production, a recorder or replayer in tests.
export interface Rpc {
  send(body: unknown): Promise<unknown>;
}

export async function rpcCall(rpc: Rpc, request: RpcRequest): Promise<unknown> {
  const response = (await rpc.send({ jsonrpc: "2.0", id: 1, ...request })) as RpcResponse;
  if (response?.error) {
    throw new RpcError(String(response.error.message ?? "RPC error").slice(0, 200), "rpc", response.error.code);
  }
  if (!response || !("result" in response)) throw new RpcError("malformed RPC response", "transport");
  return response.result;
}

// Ids are positional so identical batches produce identical request bodies (fixtures replay by body).
export async function rpcBatch(rpc: Rpc, requests: RpcRequest[]): Promise<RpcResponse[]> {
  const body = requests.map((request, index) => ({ jsonrpc: "2.0", id: index + 1, ...request }));
  const raw = await rpc.send(body);
  if (!Array.isArray(raw)) throw new RpcError("batch response was not an array", "transport");
  const byId = new Map<number, RpcResponse>();
  for (const item of raw as Array<RpcResponse & { id?: number }>) {
    if (item && typeof item.id === "number") byId.set(item.id, item);
  }
  return requests.map((_, index) => byId.get(index + 1) ?? { error: { message: "missing from batch response" } });
}

// Fills the primary host up to its concurrency cap before overflowing to the next host.
// A host that fails at the transport level is skipped for the rest of the tool call,
// and the failed request is retried once elsewhere while budget remains.
export class RpcPool implements Rpc {
  private readonly inflight = new Map<string, number>();
  private readonly down = new Set<string>();
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly urls: readonly string[],
    private readonly deadline: number,
    private readonly timeoutMs = RPC_TIMEOUT_MS,
    private readonly cap = HOST_CONCURRENCY,
  ) {}

  async send(body: unknown): Promise<unknown> {
    const tried = new Set<string>();
    let lastError: RpcError = new RpcError("no RPC host available", "transport");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const host = await this.acquire(tried);
      if (host === null) break;
      tried.add(host);
      try {
        const remaining = this.deadline - Date.now();
        if (remaining < 250) throw new RpcError("time budget exhausted", "timeout");
        const response = await fetch(host, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(this.timeoutMs, remaining)),
          redirect: "error",
        });
        if (!response.ok) throw new RpcError(`HTTP ${response.status}`, "transport", response.status);
        return await response.json();
      } catch (error) {
        lastError = toRpcError(error);
        if (lastError.kind === "transport") this.down.add(host);
        process.stderr.write(`multiverse: ${new URL(host).hostname} ${lastError.kind}: ${lastError.message}\n`);
        if (lastError.message === "time budget exhausted") break;
      } finally {
        this.release(host);
      }
    }
    throw lastError;
  }

  private async acquire(tried: Set<string>): Promise<string | null> {
    for (;;) {
      const candidates = this.urls.filter((url) => !this.down.has(url) && !tried.has(url));
      if (candidates.length === 0) return null;
      const free = candidates.find((url) => (this.inflight.get(url) ?? 0) < this.cap);
      if (free !== undefined) {
        this.inflight.set(free, (this.inflight.get(free) ?? 0) + 1);
        return free;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private release(url: string) {
    this.inflight.set(url, Math.max(0, (this.inflight.get(url) ?? 1) - 1));
    this.waiters.shift()?.();
  }
}

function toRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  const name = (error as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") return new RpcError("request timed out", "timeout");
  return new RpcError(String((error as Error)?.message ?? error).slice(0, 200), "transport");
}
