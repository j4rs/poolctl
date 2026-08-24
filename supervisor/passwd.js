#!/usr/bin/env node
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { makeCredential } from "./auth.js";

/**
 * Set the password, over SSH, on the box itself.
 *
 * Deliberately not a screen in the app. A first-run "choose a password" page
 * is unauthenticated by definition, so on a shared network it is a race
 * between the owner and everyone else, and the loser is whoever reaches the
 * Pi second. There is no network path to setting this at all.
 *
 *   node supervisor/passwd.js
 *
 * Writes the credential 0600 beside the state file. Setting a new password
 * rotates the session secret with it, which signs every phone out.
 */

const AUTH_FILE = process.env.AUTH_FILE
  || fileURLToPath(new URL("./auth.json", import.meta.url));

const ETX = "\u0003";       // Ctrl-C
const EOT = "\u0004";       // Ctrl-D
const BACKSPACE = "\u0008";
const DEL = "\u007f";

/** Read a line without echoing it. Falls back to plain input on a pipe. */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;
    if (!stdin.isTTY) {
      const rl = createInterface({ input: stdin });
      rl.once("line", (line) => {
        rl.close();
        resolve(line);
      });
      return;
    }
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const done = (fn, arg) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdout.write("\n");
      fn(arg);
    };
    const onData = (ch) => {
      if (ch === "\n" || ch === "\r" || ch === EOT) return done(resolve, value);
      if (ch === ETX) return done(reject, new Error("cancelled"));
      if (ch === BACKSPACE || ch === DEL) {
        value = value.slice(0, -1);
        return;
      }
      /* Ignore the escape sequences arrow keys produce. */
      if (ch >= " ") value += ch;
    };
    stdin.on("data", onData);
  });
}

const password = await askHidden("New pool password: ");
if (process.stdin.isTTY) {
  const again = await askHidden("Again: ");
  if (again !== password) {
    console.error("They do not match. Nothing was changed.");
    process.exit(1);
  }
}

let credential;
try {
  credential = makeCredential(password.trim());
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

let existed = false;
try {
  await readFile(AUTH_FILE);
  existed = true;
} catch {
  /* first time */
}

await mkdir(dirname(AUTH_FILE), { recursive: true });
await writeFile(AUTH_FILE, JSON.stringify(credential, null, 2), { mode: 0o600 });

console.log(`Password ${existed ? "changed" : "set"}. Written to ${AUTH_FILE}`);
if (existed) console.log("Every signed-in phone has been signed out.");
console.log("Restart the supervisor for it to take effect.");
