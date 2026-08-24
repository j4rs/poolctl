// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { start } from "./harness.test-utils.js";
import { makeCredential } from "./auth.js";

vi.setConfig({ testTimeout: 25000, hookTimeout: 30000 });

/**
 * A supervisor with a password, spawned and attacked.
 *
 * The socket is the only thing that really matters here: every intent
 * travels over it, so an auth layer that guards the page and not the upgrade
 * would be decoration. Most of these are refusals.
 */

const PASSWORD = "correct-horse-battery";

let dir;
let sup;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "poolctl-auth-"));
  const authFile = join(dir, "auth.json");
  await writeFile(authFile, JSON.stringify(makeCredential(PASSWORD)), { mode: 0o600 });
  sup = await start({ authFile, stateFile: join(dir, "state.json") });
});

afterAll(async () => {
  await sup?.stop();
  await rm(dir, { recursive: true, force: true });
});

/** Attempt a socket with whatever cookie is given, resolving to what happened. */
const trySocket = (cookie) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${sup.port}`, {
      headers: cookie ? { Cookie: cookie } : {},
    });
    const settle = (outcome) => {
      try { ws.close(); } catch { /* already gone */ }
      resolve(outcome);
    };
    ws.on("open", () => settle("open"));
    ws.on("unexpected-response", (_req, res) => settle(res.statusCode));
    ws.on("error", () => {});
    setTimeout(() => settle("timeout"), 5000);
  });

const login = async (password) => {
  const res = await fetch(sup.url("/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return { status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie") };
};

describe("before signing in", () => {
  it("refuses the socket, which is where every intent travels", async () => {
    expect(await trySocket()).toBe(401);
  });

  it("refuses the state it would otherwise stream", async () => {
    expect((await fetch(sup.url("/state"))).status).toBe(401);
  });

  it("still serves the app itself", async () => {
    /* Markup and JavaScript with no pool state in it, and it has to load
       before anybody can sign in. */
    expect((await fetch(sup.url("/"))).status).toBe(200);
  });

  it("still answers a health check", async () => {
    /* A watchdog has no session, and "is the process alive" is not worth
       protecting — which is why no pool state is in that response. */
    const res = await fetch(sup.url("/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("ok");
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("targets");
  });

  it("says a password is wanted, so the app can show the right screen", async () => {
    /* A browser cannot read the status of a failed WebSocket upgrade, so
       without this a refused socket is indistinguishable from a supervisor
       that has stopped. */
    const body = await (await fetch(sup.url("/auth/status"))).json();
    expect(body).toEqual({ required: true, authenticated: false });
  });
});

describe("signing in", () => {
  it("refuses the wrong password", async () => {
    const { status, body } = await login("not-the-password");
    expect(status).toBe(401);
    expect(body.ok).toBe(false);
  });

  it("says the same thing however it is wrong", async () => {
    /* One secret means one sentence. Distinct messages tell an attacker
       which half of the problem to work on. */
    const a = await login("wrong");
    const b = await login("");
    expect(a.body.error).toBe(b.body.error);
  });

  it("accepts the right one and hands back a session", async () => {
    const { status, body, cookie } = await login(PASSWORD);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(cookie).toMatch(/poolctl_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    /* Lax, not Strict — see sessionCookie. Strict is withheld from ws://
       handshakes and would refuse every socket. */
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it("never sends the password back", async () => {
    const { body, cookie } = await login(PASSWORD);
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
    expect(cookie).not.toContain(PASSWORD);
  });
});

describe("with a session", () => {
  let cookie;

  beforeAll(async () => {
    cookie = (await login(PASSWORD)).cookie.split(";")[0];
  });

  it("opens the socket", async () => {
    expect(await trySocket(cookie)).toBe("open");
  });

  it("serves state", async () => {
    const res = await fetch(sup.url("/state"), { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("targets");
  });

  it("can drive the equipment", async () => {
    /* The point of all of it: with a session the intents work as before. */
    const ws = new WebSocket(`ws://127.0.0.1:${sup.port}`, { headers: { Cookie: cookie } });
    const ack = await new Promise((resolve) => {
      ws.on("open", () => ws.send(JSON.stringify({ reqId: 1, intent: "toggle", args: { key: "light" } })));
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "ack") resolve(msg);
      });
    });
    ws.close();
    expect(ack.ok).toBe(true);
  });
});

describe("forged sessions", () => {
  let cookie;

  beforeAll(async () => {
    cookie = (await login(PASSWORD)).cookie.split(";")[0];
  });

  it("refuses an invented signature", async () => {
    expect(await trySocket("poolctl_session=9999999999999.deadbeef")).toBe(401);
  });

  it("refuses a real signature with the expiry moved out", async () => {
    /* The signature covers the expiry, which is the whole reason the token
       is signed rather than stored. */
    const signature = cookie.split(".")[1];
    expect(await trySocket(`poolctl_session=9999999999999.${signature}`)).toBe(401);
  });

  it("refuses an empty or malformed cookie without falling over", async () => {
    for (const bad of ["poolctl_session=", "poolctl_session=.", "poolctl_session=abc"]) {
      expect(await trySocket(bad), bad).toBe(401);
    }
  });

  it("refuses somebody else's cookie name", async () => {
    expect(await trySocket(`other_session=${cookie.split("=")[1]}`)).toBe(401);
  });
});

describe("signing out", () => {
  it("clears the session", async () => {
    const cookie = (await login(PASSWORD)).cookie.split(";")[0];
    expect(await trySocket(cookie)).toBe("open");

    const res = await fetch(sup.url("/auth/logout"), {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
  });
});

describe("brute force", () => {
  it("locks out after a handful of wrong guesses", async () => {
    /* scrypt already costs ~40 ms a guess, so this is as much about not
       handing anyone a free way to pin the Pi's CPU. */
    let sawThrottle = false;
    for (let i = 0; i < 9; i++) {
      const { status } = await login(`guess-${i}`);
      if (status === 429) {
        sawThrottle = true;
        break;
      }
    }
    expect(sawThrottle).toBe(true);
  });

  it("throttles the right password too, so timing gives nothing away", async () => {
    const { status, body } = await login(PASSWORD);
    expect(status).toBe(429);
    expect(body.error).toMatch(/too many attempts/);
  });
});
