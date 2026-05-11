function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class WebSocketRPCClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.pending = new Map();
    this.connectPromise = null;
    this.forcedClose = false;
  }

  connect() {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);
      } catch (error) {
        this.connectPromise = null;
        reject(error);
        return;
      }

      this.ws.onopen = (event) => {
        this.onopen?.(event);
        resolve();
      };

      this.ws.onmessage = (event) => {
        this.#handleMessage(event);
        this.onmessage?.(event);
      };

      this.ws.onerror = (event) => {
        this.onerror?.(event);
      };

      this.ws.onclose = (event) => {
        this.onclose?.(event);
        if (!this.forcedClose) {
          this.connectPromise = null;
        }
      };
    });
    return this.connectPromise;
  }

  #handleMessage(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    const deferred = this.pending.get(data.id);
    if (!deferred) return;
    this.pending.delete(data.id);
    if (data.error) {
      const message =
        data.error.message ||
        data.error.data ||
        `JSON-RPC error ${data.error.code ?? ""}`.trim();
      deferred.reject(new Error(String(message)));
      return;
    }
    deferred.resolve(data.result);
  }

  async rpc(method, params, timeoutMs = 15000) {
    await this.connect();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    const id = crypto.randomUUID();
    const deferred = createDeferred();
    this.pending.set(id, deferred);
    this.ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id,
      }),
    );
    if (!timeoutMs) {
      return deferred.promise;
    }
    const timeout = setTimeout(() => {
      if (this.pending.has(id)) {
        this.pending.delete(id);
        deferred.reject(new Error(`RPC timeout: ${method}`));
      }
    }, timeoutMs);
    return deferred.promise.finally(() => clearTimeout(timeout));
  }

  close() {
    this.forcedClose = true;
    this.pending.forEach((deferred) =>
      deferred.reject(new Error("WebSocket closed")),
    );
    this.pending.clear();
    if (this.ws) {
      this.ws.close();
    }
  }
}
