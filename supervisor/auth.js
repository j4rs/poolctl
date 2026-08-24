import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";

/**
 * A password on the front door.
 *
 * The threat is not a determined attacker. It is everything already on the
 * wifi: a guest phone, a compromised bulb, a neighbour who has the password
 * because everyone does. Until now any of them could stop the pump.
 *
 * What this is honest about:
 *
 * **It is not encryption.** The supervisor serves plain HTTP, so a session
 * cookie crosses the LAN readable by anything that can intercept traffic.
 * This raises the bar from "anyone who joins the wifi" to "anyone who can
 * intercept traffic on it" — a large improvement against the realistic
 * threat, and not a substitute for TLS. TLS is the next layer and is
 * unpleasant on iOS, which is why it is not this one.
 *
 * **One household password, not users.** It is a pool. Integrations get
 * their own tokens rather than being handed this one.
 *
 * Nothing here is invented crypto. scrypt for the password because it is in
 * Node and is memory-hard; HMAC-SHA256 for the session because the server
 * both issues and checks it, so there is nothing to negotiate.
 */

/* ~40 ms per guess on a laptop, more on a Pi. Slow enough that an online
   brute force is hopeless and fast enough that a login feels instant. */
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;

/** Sessions last a fortnight: long enough not to be a chore, short enough
    that a lost phone stops working without anyone remembering to act. */
export const SESSION_MS = 14 * 24 * 60 * 60 * 1000;

/** A stored credential: the salt, the derived key, and the session secret. */
export function makeCredential(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("a password needs at least 8 characters");
  }
  const salt = randomBytes(16);
  return {
    salt: salt.toString("hex"),
    hash: scryptSync(password, salt, KEY_LENGTH, SCRYPT).toString("hex"),
    /* Rotating this is how every session is revoked at once — which is what
       "log everybody out" means when there is no session store. */
    secret: randomBytes(32).toString("hex"),
    setAt: new Date().toISOString(),
  };
}

/** Constant-time regardless of where the mismatch is, or whether the
    credential exists at all. */
export function verifyPassword(password, credential) {
  if (!credential?.salt || !credential?.hash) return false;
  if (typeof password !== "string") return false;
  let derived;
  try {
    derived = scryptSync(password, Buffer.from(credential.salt, "hex"), KEY_LENGTH, SCRYPT);
  } catch {
    return false;
  }
  const stored = Buffer.from(credential.hash, "hex");
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(stored, derived);
}

const sign = (secret, payload) =>
  createHmac("sha256", secret).update(payload).digest("base64url");

/**
 * A session token, signed rather than stored.
 *
 * Stateless on purpose: the Pi restarts for updates and power cuts, and a
 * session store in memory would log the household out every time. The
 * signature covers the expiry, so the token cannot be extended by editing
 * it, and rotating the secret invalidates every token ever issued.
 */
export function issueToken(secret, { ttlMs = SESSION_MS, now = Date.now() } = {}) {
  const expires = String(now + ttlMs);
  return `${expires}.${sign(secret, expires)}`;
}

/** Whether a token is genuine and still current. */
export function verifyToken(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== "string" || !secret) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expires = token.slice(0, dot);
  const given = token.slice(dot + 1);
  if (!/^\d+$/.test(expires)) return false;

  const expected = sign(secret, expires);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  /* Length is checked first because timingSafeEqual throws on a mismatch —
     and length alone leaks nothing an attacker cannot already compute. */
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Number(expires) > now;
}

/** Cookies as sent by a browser, which is a single header of `a=b; c=d`. */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export const COOKIE = "poolctl_session";

/**
 * The Set-Cookie value for a session.
 *
 * `HttpOnly` so a script injected into the page cannot read it.
 *
 * `SameSite=Lax`, and **not Strict** — this looks like a weakening and is
 * not optional. Chrome withholds a Strict cookie from a `ws://` handshake
 * even when the page is same-origin, so with Strict the HTTP routes
 * authenticate happily while every WebSocket upgrade is refused: the app
 * signs in and then sits on "Waiting for the controller" forever. Observed
 * directly — the upgrade arrived carrying other localhost cookies and not
 * this one.
 *
 * Lax still does the job it is here for. It withholds the cookie from
 * cross-site sub-resource requests and cross-site POSTs, which covers both
 * ways state can change: intents travel over the socket, and the only
 * state-changing HTTP route is the login POST. What Lax permits that Strict
 * would not is a top-level GET navigation, which cannot change anything.
 *
 * `Secure` is deliberately absent: the supervisor serves plain HTTP, and
 * setting it would mean the cookie is never stored at all. It belongs with
 * TLS, which is the next layer.
 */
export function sessionCookie(token, { ttlMs = SESSION_MS } = {}) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}`;
}

export const clearedCookie = () =>
  `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
