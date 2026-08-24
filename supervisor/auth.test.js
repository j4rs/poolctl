// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  makeCredential, verifyPassword, issueToken, verifyToken,
  parseCookies, sessionCookie, clearedCookie, COOKIE, SESSION_MS,
} from "./auth.js";

/**
 * Security code earns more suspicion than the rest, so these lean on the
 * cases that go wrong quietly: a token that verifies against the wrong
 * secret, an expiry that can be edited, a comparison that throws instead of
 * returning false.
 */

const PASSWORD = "a-decent-passphrase";

describe("storing a password", () => {
  it("never keeps the password itself", () => {
    const cred = makeCredential(PASSWORD);
    expect(JSON.stringify(cred)).not.toContain(PASSWORD);
  });

  it("salts, so two identical passwords do not share a hash", () => {
    /* Without this, one leaked hash tells you every account that shares it,
       and a rainbow table does the rest. */
    expect(makeCredential(PASSWORD).hash).not.toBe(makeCredential(PASSWORD).hash);
  });

  it("gives each credential its own session secret", () => {
    expect(makeCredential(PASSWORD).secret).not.toBe(makeCredential(PASSWORD).secret);
  });

  it("refuses a password too short to be worth hashing", () => {
    expect(() => makeCredential("short")).toThrow(/8 characters/);
    expect(() => makeCredential("")).toThrow();
    expect(() => makeCredential(undefined)).toThrow();
  });
});

describe("checking a password", () => {
  const cred = makeCredential(PASSWORD);

  it("accepts the right one", () => {
    expect(verifyPassword(PASSWORD, cred)).toBe(true);
  });

  it("rejects a wrong one", () => {
    expect(verifyPassword("not-the-passphrase", cred)).toBe(false);
  });

  it("rejects one that differs only at the end", () => {
    /* The case a non-constant-time compare leaks through timing. */
    expect(verifyPassword(PASSWORD + "x", cred)).toBe(false);
    expect(verifyPassword(PASSWORD.slice(0, -1), cred)).toBe(false);
  });

  it("returns false rather than throwing on rubbish", () => {
    /* An exception here would become a 500, and a 500 that only happens for
       certain inputs is itself an oracle. */
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(verifyPassword(bad, cred), String(bad)).toBe(false);
    }
    expect(verifyPassword(PASSWORD, undefined)).toBe(false);
    expect(verifyPassword(PASSWORD, {})).toBe(false);
    expect(verifyPassword(PASSWORD, { salt: "zz", hash: "zz" })).toBe(false);
  });
});

describe("session tokens", () => {
  const secret = makeCredential(PASSWORD).secret;

  it("accepts one it just issued", () => {
    expect(verifyToken(issueToken(secret), secret)).toBe(true);
  });

  it("rejects one signed with a different secret", () => {
    /* Rotating the secret is how every session is revoked at once. */
    const other = makeCredential(PASSWORD).secret;
    expect(verifyToken(issueToken(other), secret)).toBe(false);
  });

  it("rejects one that has expired", () => {
    const token = issueToken(secret, { ttlMs: 1000, now: 0 });
    expect(verifyToken(token, secret, { now: 500 })).toBe(true);
    expect(verifyToken(token, secret, { now: 2000 })).toBe(false);
  });

  it("cannot be extended by editing the expiry", () => {
    /* The signature covers the expiry, which is the whole reason this is
       signed rather than stored. */
    const token = issueToken(secret, { ttlMs: 1000, now: 0 });
    const [, sig] = token.split(".");
    const forged = `${9_999_999_999_999}.${sig}`;
    expect(verifyToken(forged, secret, { now: 2000 })).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = issueToken(secret);
    const [exp, sig] = token.split(".");
    expect(verifyToken(`${exp}.${sig.slice(0, -1)}A`, secret)).toBe(false);
  });

  it("rejects malformed tokens without throwing", () => {
    /* timingSafeEqual throws on length mismatch; a guard has to come first
       or a short token becomes a 500 instead of a refusal. */
    for (const bad of ["", ".", "abc", "abc.def", ".sig", "123.", undefined, null, 7, {}]) {
      expect(verifyToken(bad, secret), JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects everything when there is no secret", () => {
    expect(verifyToken(issueToken(secret), "")).toBe(false);
    expect(verifyToken(issueToken(secret), undefined)).toBe(false);
  });

  it("lasts a fortnight by default", () => {
    const token = issueToken(secret, { now: 0 });
    expect(verifyToken(token, secret, { now: SESSION_MS - 1000 })).toBe(true);
    expect(verifyToken(token, secret, { now: SESSION_MS + 1000 })).toBe(false);
  });
});

describe("cookies", () => {
  it("reads one out of a browser's header", () => {
    expect(parseCookies("a=1; poolctl_session=xyz; b=2").poolctl_session).toBe("xyz");
  });

  it("copes with no header at all", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
    expect(parseCookies("garbage")).toEqual({});
  });

  it("decodes an encoded value", () => {
    expect(parseCookies("x=a%20b").x).toBe("a b");
  });

  it("is HttpOnly, so a script on the page cannot read it", () => {
    expect(sessionCookie("t")).toMatch(/HttpOnly/);
  });

  it("is SameSite=Lax, which is deliberate and not a weakening", () => {
    /* Strict looks stricter and breaks the app outright: Chrome withholds a
       Strict cookie from a ws:// handshake even same-origin, so every socket
       upgrade is refused while the HTTP routes carry on authenticating. Lax
       still withholds it from cross-site sub-resources and cross-site POSTs,
       which is both of the ways state can change here. */
    expect(sessionCookie("t")).toMatch(/SameSite=Lax/);
    expect(sessionCookie("t")).not.toMatch(/SameSite=Strict/);
  });

  it("is not Secure, deliberately", () => {
    /* The supervisor serves plain HTTP. Secure here would mean the cookie is
       never stored at all — the flag belongs with TLS, not before it. */
    expect(sessionCookie("t")).not.toMatch(/Secure/);
  });

  it("clears by expiring rather than by blanking", () => {
    expect(clearedCookie()).toMatch(/Max-Age=0/);
    expect(clearedCookie()).toContain(`${COOKIE}=;`);
  });
});
