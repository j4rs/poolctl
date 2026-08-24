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

  /** GET helper, for configuration reads that are not `/state/all`. */
  async get(path) {
    const res = await fetch(`${this.url}${path}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  }

  /** PUT helper. Returns the parsed body, or throws with njsPC's message. */
  async put(path, body, method = "PUT") {
    const res = await fetch(`${this.url}${path}`, {
      method,
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

  /** Suspends schedules for a circuit — njsPC's ManualPriorityDelay. */
  setManualPriority(id) {
    return this.put("/state/manualOperationPriority", { id });
  }

  setHeatMode(id, mode) {
    return this.put("/state/body/heatMode", { id, mode });
  }

  setSetPoint(id, setPoint) {
    return this.put("/state/body/setPoint", { id, setPoint });
  }

  /* ---- configuration -------------------------------------------------- */
  /* Everything below writes njsPC's *configuration* rather than its state:
     equipment that persists across restarts and shows up in dashPanel. These
     are the calls that create the circuit a manual program runs on. They are
     rarer and heavier than the state calls above, and none of them is on the
     path of an ordinary mode change. */

  /**
   * Pumps, their circuits and the pump-type table, in one response.
   * `/config/all` omits the type table, and the speed range lives there.
   */
  pumpOptions() {
    return this.get("/config/options/pumps");
  }

  /** Add or update a circuit. `id: 0` asks njsPC to allocate one. */
  setCircuitConfig(circuit) {
    return this.put("/config/circuit", circuit);
  }

  deleteCircuitConfig(id) {
    return this.put("/config/circuit", { id }, "DELETE");
  }

  /**
   * Replace a pump's configuration.
   *
   * The whole pump, every time. `NixiePump.setPumpAsync` assigns the body
   * over the pump rather than merging, and blanks `circuits` entirely when
   * the key is absent — so a partial write here deletes the speeds the
   * schedules depend on. Build the body with `withPumpCircuit`.
   */
  setPumpConfig(pump) {
    return this.put("/config/pump", pump);
  }

  /**
   * Change the speed of a circuit the pump already carries.
   *
   * njsPC does the read-modify-write itself here, which makes this the safe
   * way to change a speed — but it refuses a circuit that is not already in
   * the pump's list, so it cannot be used to bind one.
   */
  setPumpCircuitSpeed(pumpId, circuitId, speed) {
    return this.put("/config/pumpCircuit", { pumpId, circuitId, speed });
  }
}
