// Run from the project root (or from worker/) with:  node --test
//
// Nothing here touches the network: globalThis.fetch is replaced by a stub
// that records every outgoing call and answers with canned responses.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const ORIGIN = "https://firstwisconsin.github.io";
const RESEND = "https://api.resend.com/emails";
const TURNSTILE = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const WIX = "https://www.wixapis.com/contacts/v4";

const realFetch = globalThis.fetch;
const realConsoleError = console.error;
let calls; // every outgoing request: { url, method, headers, body }
let routes; // url -> (call) => Response, overrides the defaults below
let errors; // everything passed to console.error

function reply(status, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const defaultRoutes = {
  [RESEND]: () => reply(200, { id: "email-1" }),
  [TURNSTILE]: () => reply(200, { success: true }),
  [`${WIX}/labels`]: (call) =>
    reply(200, { label: { key: `custom.${call.body.displayName}` }, newLabel: true }),
  [`${WIX}/contacts`]: () => reply(200, { contact: { id: "contact-new" } }),
  [`${WIX}/contacts/query`]: () => reply(200, { contacts: [{ id: "contact-old" }] }),
  [`${WIX}/contacts/contact-old/labels`]: () => reply(200, { contact: { id: "contact-old" } }),
};

beforeEach(() => {
  calls = [];
  routes = {};
  errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || "GET",
      headers: Object.fromEntries(new Headers(init.headers)),
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = routes[call.url] || defaultRoutes[call.url];
    if (!handler) throw new Error(`Unexpected fetch to ${call.url}`);
    return handler(call);
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

function env(overrides = {}) {
  return {
    FROM_EMAIL: "FIRST Wisconsin Map <map@example.org>",
    ALLOWED_ORIGINS: `https://www.example.org, ${ORIGIN}`,
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_test_key",
    CHAMPION_EMAILS: JSON.stringify({
      nel: "nel-champion@example.org",
      capital: ["cap-one@example.org", "cap-two@example.org"],
      default: "fallback@example.org",
    }),
    WIX_API_KEY: "wix-test-key",
    WIX_SITE_ID: "site-123",
    ...overrides,
  };
}

function submission(overrides = {}) {
  return {
    region: "nel",
    name: "Ada Lovelace",
    email: "ada@example.com",
    role: "Parent or guardian",
    programs: ["fll", "frc"],
    message: "Hello, how do we start a team?",
    website: "",
    ...overrides,
  };
}

function post(body, { origin = ORIGIN, path = "/contact" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (origin) headers.Origin = origin;
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const callsTo = (url) => calls.filter((call) => call.url === url);

test("happy path: emails the champion with Reply-To and saves the Wix contact", async () => {
  const response = await worker.fetch(post(submission()), env());

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);

  const [email] = callsTo(RESEND);
  assert.equal(email.method, "POST");
  assert.equal(email.headers.authorization, "Bearer re_test_key");
  assert.equal(email.body.from, "FIRST Wisconsin Map <map@example.org>");
  assert.deepEqual(email.body.to, ["nel-champion@example.org"]);
  assert.equal(email.body.reply_to, "ada@example.com");
  assert.equal(
    email.body.subject,
    "FIRST Wisconsin map: message from Ada Lovelace (Northeast & Lakeshore)",
  );
  for (const expected of [
    "Northeast & Lakeshore",
    "Ada Lovelace",
    "ada@example.com",
    "Parent or guardian",
    "FIRST LEGO League, FIRST Robotics Competition",
    "Hello, how do we start a team?",
  ]) {
    assert.ok(email.body.text.includes(expected), `email text should include "${expected}"`);
  }

  assert.deepEqual(callsTo(`${WIX}/labels`).map((call) => call.body.displayName).sort(), [
    "Map program: FIRST LEGO League",
    "Map program: FIRST Robotics Competition",
    "Map role: Parent or guardian",
    "Map: Northeast & Lakeshore",
  ]);

  const [contact] = callsTo(`${WIX}/contacts`);
  assert.equal(contact.headers.authorization, "wix-test-key");
  assert.equal(contact.headers["wix-site-id"], "site-123");
  assert.deepEqual(contact.body.info.name, { first: "Ada", last: "Lovelace" });
  assert.equal(contact.body.info.emails.items[0].email, "ada@example.com");
  assert.equal(contact.body.info.labelKeys.items.length, 4);

  // Email goes out before anything is sent to Wix.
  assert.equal(calls[0].url, RESEND);
  assert.equal(callsTo(TURNSTILE).length, 0, "no Turnstile call without TURNSTILE_SECRET");
});

test("a region can have several champions", async () => {
  await worker.fetch(post(submission({ region: "capital" })), env());
  assert.deepEqual(callsTo(RESEND)[0].body.to, ["cap-one@example.org", "cap-two@example.org"]);
});

test("region without its own entry falls back to the default address", async () => {
  const response = await worker.fetch(post(submission({ region: "driftless" })), env());
  assert.equal(response.status, 200);
  assert.deepEqual(callsTo(RESEND)[0].body.to, ["fallback@example.org"]);
});

test("optional fields may be left out", async () => {
  const { role, programs, website, ...minimal } = submission();
  const response = await worker.fetch(post(minimal), env());
  assert.equal(response.status, 200);
  assert.deepEqual(
    callsTo(`${WIX}/labels`).map((call) => call.body.displayName),
    ["Map: Northeast & Lakeshore"],
  );
});

test("honeypot: answers ok but does nothing", async () => {
  const response = await worker.fetch(post(submission({ website: "http://spam.example" })), env());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 0);
});

test("validation errors name each bad field and nothing is sent", async () => {
  const response = await worker.fetch(
    post({
      region: "atlantis",
      name: "  ",
      email: "not-an-email",
      role: "x".repeat(81),
      programs: ["fll", "chess"],
      message: "",
    }),
    env(),
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error, "validation");
  assert.deepEqual(Object.keys(body.fields).sort(), [
    "email",
    "message",
    "name",
    "programs",
    "region",
    "role",
  ]);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(calls.length, 0);
});

test("field length limits are enforced", async () => {
  const response = await worker.fetch(
    post(submission({ name: "n".repeat(121), message: "m".repeat(4001) })),
    env(),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(Object.keys((await response.json()).fields).sort(), ["message", "name"]);
});

test("body that is not JSON is a validation error", async () => {
  const response = await worker.fetch(post("region=nel"), env());
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "validation");
});

test("oversized body is rejected", async () => {
  const response = await worker.fetch(post(submission({ message: "m".repeat(11000) })), env());
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});

test("line breaks cannot be smuggled into the subject", async () => {
  await worker.fetch(post(submission({ name: "Ada\r\nBcc: evil@example.com" })), env());
  const { subject } = callsTo(RESEND)[0].body;
  assert.ok(!/[\r\n]/.test(subject));
  assert.ok(subject.includes("Ada Bcc: evil@example.com"));

  const bad = await worker.fetch(post(submission({ email: "ada@example.com\nBcc: x@y.zz" })), env());
  assert.equal(bad.status, 400);
});

test("POST from an origin that is not listed is refused", async () => {
  for (const origin of ["https://evil.example", `${ORIGIN}.evil.example`, null]) {
    const response = await worker.fetch(post(submission(), { origin }), env());
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  }
  assert.equal(calls.length, 0);
});

test("preflight is answered for listed origins only", async () => {
  const preflight = (origin) =>
    worker.fetch(
      new Request("https://worker.example/contact", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      }),
      env(),
    );

  const allowed = await preflight(ORIGIN);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(allowed.headers.get("Access-Control-Allow-Methods"), /POST/);
  assert.match(allowed.headers.get("Access-Control-Allow-Headers"), /content-type/i);

  const refused = await preflight("https://evil.example");
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("Access-Control-Allow-Origin"), null);
});

test("other methods get 405 and other paths get 404", async () => {
  const get = await worker.fetch(new Request("https://worker.example/contact"), env());
  assert.equal(get.status, 405);
  const elsewhere = await worker.fetch(post(submission(), { path: "/" }), env());
  assert.equal(elsewhere.status, 404);
});

test("Turnstile: a valid token is verified before the email is sent", async () => {
  const response = await worker.fetch(
    post(submission({ turnstileToken: "token-abc" })),
    env({ TURNSTILE_SECRET: "ts-secret" }),
  );
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, TURNSTILE);
  assert.equal(calls[0].body.secret, "ts-secret");
  assert.equal(calls[0].body.response, "token-abc");
  assert.equal(callsTo(RESEND).length, 1);
});

test("Turnstile failure: 403 bot_check and nothing is sent", async () => {
  routes[TURNSTILE] = () =>
    reply(200, { success: false, "error-codes": ["invalid-input-response"] });
  const secretEnv = env({ TURNSTILE_SECRET: "ts-secret" });

  const rejected = await worker.fetch(post(submission({ turnstileToken: "bad" })), secretEnv);
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { ok: false, error: "bot_check" });

  const missing = await worker.fetch(post(submission()), secretEnv);
  assert.equal(missing.status, 403);

  assert.equal(callsTo(RESEND).length, 0);
  assert.equal(callsTo(`${WIX}/contacts`).length, 0);
});

test("email failure: 502 send_failed and Wix is not called", async () => {
  routes[RESEND] = () => reply(422, { name: "validation_error", message: "nope" });
  const response = await worker.fetch(post(submission()), env());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { ok: false, error: "send_failed" });
  assert.equal(calls.filter((call) => call.url.startsWith(WIX)).length, 0);
});

test("broken CHAMPION_EMAILS setting: 502 and no email", async () => {
  const response = await worker.fetch(post(submission()), env({ CHAMPION_EMAILS: "not json" }));
  assert.equal(response.status, 502);
  assert.equal(callsTo(RESEND).length, 0);
});

test("Wix failure: still 200, and logs hold no message text or keys", async () => {
  routes[`${WIX}/contacts`] = () => reply(500, { message: "boom" });
  const response = await worker.fetch(post(submission()), env());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(callsTo(RESEND).length, 1);

  assert.ok(errors.some((line) => line.startsWith("wix:")));
  const log = errors.join("\n");
  assert.ok(!log.includes("how do we start a team"));
  assert.ok(!log.includes("wix-test-key"));
  assert.ok(!log.includes("re_test_key"));
});

test("Wix network error: still 200", async () => {
  routes[`${WIX}/contacts`] = () => {
    throw new TypeError("network down");
  };
  const response = await worker.fetch(post(submission()), env());
  assert.equal(response.status, 200);
});

test("a label that cannot be created does not stop the contact being saved", async () => {
  routes[`${WIX}/labels`] = (call) =>
    call.body.displayName.startsWith("Map role")
      ? reply(428, { message: "quota" })
      : reply(200, { label: { key: `custom.${call.body.displayName}` } });
  const response = await worker.fetch(post(submission()), env());
  assert.equal(response.status, 200);
  assert.equal(callsTo(`${WIX}/contacts`)[0].body.info.labelKeys.items.length, 3);
});

test("existing contact: found by email and labelled instead of failing", async () => {
  routes[`${WIX}/contacts`] = () => reply(409, { message: "DUPLICATE_CONTACT_EXISTS" });
  const response = await worker.fetch(post(submission()), env());
  assert.equal(response.status, 200);

  const [query] = callsTo(`${WIX}/contacts/query`);
  assert.deepEqual(query.body.query.filter, { "primaryInfo.email": { $eq: "ada@example.com" } });

  const [label] = callsTo(`${WIX}/contacts/contact-old/labels`);
  assert.equal(label.body.labelKeys.length, 4);
  assert.ok(label.body.labelKeys.includes("custom.Map: Northeast & Lakeshore"));
  assert.equal(errors.length, 0);
});

test("Wix step is skipped when the key or the site id is missing", async () => {
  for (const missing of [{ WIX_API_KEY: undefined }, { WIX_SITE_ID: "" }]) {
    calls = [];
    const response = await worker.fetch(post(submission()), env(missing));
    assert.equal(response.status, 200);
    assert.deepEqual(calls.map((call) => call.url), [RESEND]);
  }
});

test("on Cloudflare the Wix step runs in the background via ctx.waitUntil", async () => {
  const pending = [];
  const ctx = { waitUntil: (promise) => pending.push(promise) };
  const response = await worker.fetch(post(submission()), env(), ctx);
  assert.equal(response.status, 200);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(callsTo(`${WIX}/contacts`).length, 1);
});
