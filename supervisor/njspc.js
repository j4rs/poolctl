import { io } from "socket.io-client";

/**
 * Client for njsPC.
 *
 * Reads state two ways, deliberately. A full `/state/all` fetch is the source
 * of truth for shape; the socket is used only as a signal that something
 * changed. Patching individual socket events into a partial model would be
 * faster and would also be a second, subtly different copy of njsPC's state
 * machine — which is exactly the duplication ADR-10 was rewritten to avoid.
 *
 * Refetching is debounced, so a burst of events costs one request.
 */
export class NjsPC {
  constructor({ url = "http://localhost:4200", onState, onLink } = {}) {
    this.url = url;
    this.onState = onState || (() => {});
    this.onLink = onLink || (() => {});
    this.socket = null;
    this._timer = null;
    this._inFlight = false;
  }

  start() {
    this.socket = io(this.url, { reconnection: true, reconnectionDelay: 2000 });
    this.socket.on("connect", () => {
      this.onLink(true);
      this.refresh();
    });
    this.socket.on("disconnect", () => this.onLink(false));
    this.socket.on("connect_error", () => this.onLink(false));

    /* Any event at all means something moved; go and read the truth. */
    this.socket.onAny(() => this.schedule());

    /* Belt and braces: njsPC can change state on its own timers, and a missed
       socket event would otherwise leave the UI stale indefinitely. */
    this._poll = setInterval(() => this.refresh(), 15000);
  }

  stop() {
    clearInterval(this._poll);
    clearTimeout(this._timer);
    this.socket?.close();
  }

  schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.refresh(), 150);
  }

  async refresh() {
    if (this._inFlight) return;
    this._inFlight = true;
    try {
      const res = await fetch(`${this.url}/state/all`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`state/all ${res.status}`);
      this.onState(await res.json());
      this.onLink(true);
    } catch (err) {
      this.onLink(false, err.message);
    } finally {
      this._inFlight = false;
    }
  }

  /** PUT helper. Returns the parsed body, or throws with njsPC's message. */
  async put(path, body) {
    const res = await fetch(`${this.url}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  setCircuit(id, state) {
    return this.put("/state/circuit/setState", { id, state });
  }
}
