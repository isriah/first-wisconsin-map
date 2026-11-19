// FIRST Wisconsin map: contact-form relay.
//
// The map page POSTs a visitor's message here. This Worker
//   1. validates it,
//   2. checks the Turnstile token (when TURNSTILE_SECRET is set),
//   3. emails the region's champion (the address never reaches the browser),
//   4. adds the visitor to the Wix site's contacts (optional, best effort).
//
// See ../README.md for setup and the list of settings.

import { REGIONS, PROGRAMS } from "./regions.js";
import { sendEmail } from "./email.js";
import { verifyTurnstile } from "./turnstile.js";
import { addWixContact } from "./wix.js";

const MAX_BODY_BYTES = 10 * 1024;
const MAX_LENGTH = { name: 120, email: 254, role: 80, message: 4000 };
const EMAIL_PATTERN = /^[^\s@<>,;:"]+@[^\s@<>,;:"]+\.[^\s@<>,;:"]+$/;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/contact") {
      return json(404, { ok: false, error: "not_found" });
    }

    const origin = request.headers.get("Origin");
    const cors = isAllowedOrigin(origin, env) ? corsHeaders(origin) : null;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    }
    if (request.method !== "POST") {
      return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST, OPTIONS" });
    }
    if (!cors) {
      return json(403, { ok: false, error: "origin_not_allowed" });
    }

    try {
      return await handleContact(request, env, ctx, cors);
    } catch (error) {
      console.error("unexpected error:", error.message);
      return json(500, { ok: false, error: "server_error" }, cors);
    }
  },
};

async function handleContact(request, env, ctx, cors) {
  // --- Read and validate -------------------------------------------------
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: "too_large" }, cors);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return validationError({ body: "Request body must be a JSON object." }, cors);
  }

  // Honeypot: real visitors never see this field. Pretend all went well.
  if (body.website) {
    return json(200, { ok: true }, cors);
  }

  const { fields, data } = validate(body);
  if (Object.keys(fields).length > 0) {
    return validationError(fields, cors);
  }

  // --- Bot check ---------------------------------------------------------
  if (env.TURNSTILE_SECRET) {
    const ip = request.headers.get("CF-Connecting-IP");
    const human = await verifyTurnstile(env.TURNSTILE_SECRET, body.turnstileToken, ip);
    if (!human) return json(403, { ok: false, error: "bot_check" }, cors);
  }

  // --- Email the champion ------------------------------------------------
  const regionName = REGIONS[data.region];
  const programNames = data.programs.map((id) => PROGRAMS[id]);
  try {
    await sendEmail(env, {
      from: env.FROM_EMAIL,
      to: championAddresses(env, data.region),
      replyTo: data.email,
      subject: oneLine(`FIRST Wisconsin map: message from ${data.name} (${regionName})`),
      text: emailText(data, regionName, programNames),
    });
  } catch (error) {
    console.error("email: send failed:", error.message);
    return json(502, { ok: false, error: "send_failed" }, cors);
  }

  // --- Wix contact (optional; never changes the answer to the visitor) ---
  if (env.WIX_API_KEY && env.WIX_SITE_ID) {
    const labels = [
      `Map: ${regionName}`,
      ...(data.role ? [`Map role: ${data.role}`] : []),
      ...programNames.map((name) => `Map program: ${name}`),
    ];
    const wixStep = addWixContact(env, { name: data.name, email: data.email, labels }).catch(
      (error) => console.error("wix: contact not saved:", error.message),
    );
    // On Cloudflare, finish the Wix step after the visitor has their answer.
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(wixStep);
    else await wixStep;
  }

  return json(200, { ok: true }, cors);
}

// Checks every field and returns { fields: {name: problem}, data: cleaned values }.
function validate(body) {
  const fields = {};
  const data = {
    region: body.region,
    name: typeof body.name === "string" ? oneLine(body.name) : "",
    email: typeof body.email === "string" ? body.email.trim() : "",
    role: "",
    programs: [],
    message: typeof body.message === "string" ? body.message.trim() : "",
  };

  if (typeof data.region !== "string" || !Object.hasOwn(REGIONS, data.region)) {
    fields.region = "Choose a region.";
  }

  if (!data.name) fields.name = "Enter your name.";
  else if (data.name.length > MAX_LENGTH.name) fields.name = "Name is too long.";

  if (!data.email) fields.email = "Enter your email address.";
  else if (data.email.length > MAX_LENGTH.email || !EMAIL_PATTERN.test(data.email)) {
    fields.email = "Enter a valid email address.";
  }

  if (body.role !== undefined && body.role !== null) {
    if (typeof body.role !== "string") fields.role = "Role must be text.";
    else {
      data.role = oneLine(body.role);
      if (data.role.length > MAX_LENGTH.role) fields.role = "Role is too long.";
    }
  }

  if (body.programs !== undefined && body.programs !== null) {
    const valid =
      Array.isArray(body.programs) &&
      body.programs.every((id) => typeof id === "string" && Object.hasOwn(PROGRAMS, id));
    if (valid) data.programs = [...new Set(body.programs)];
    else fields.programs = "Unknown program.";
  }

  if (!data.message) fields.message = "Enter a message.";
  else if (data.message.length > MAX_LENGTH.message) fields.message = "Message is too long.";

  return { fields, data };
}

// Looks up who receives mail for a region. CHAMPION_EMAILS is a JSON object:
//   { "nel": "a@example.org", "capital": ["b@example.org", "c@example.org"], "default": "..." }
function championAddresses(env, region) {
  let map;
  try {
    map = JSON.parse(env.CHAMPION_EMAILS);
  } catch {
    throw new Error("CHAMPION_EMAILS is missing or is not valid JSON");
  }
  const entry = (map && Object.hasOwn(map, region) && map[region]) || map?.default;
  const addresses = [entry].flat().filter((a) => typeof a === "string" && a.trim() !== "");
  if (addresses.length === 0) {
    throw new Error(`CHAMPION_EMAILS has no entry for "${region}" and no "default"`);
  }
  return addresses.map((a) => a.trim());
}

function emailText(data, regionName, programNames) {
  return [
    "Someone sent you a message from the FIRST Wisconsin map.",
    "",
    `Region:   ${regionName}`,
    `Name:     ${data.name}`,
    `Email:    ${data.email}`,
    `Role:     ${data.role || "(not given)"}`,
    `Programs: ${programNames.join(", ") || "(not given)"}`,
    "",
    "Message:",
    data.message,
    "",
    "--",
    `Reply to this email to answer ${data.name} directly.`,
  ].join("\n");
}

// Collapses line breaks and repeated spaces. Anything that ends up in an email
// header (subject, names) goes through this so nobody can inject extra headers.
function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  return (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(origin);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function validationError(fields, cors) {
  return json(400, { ok: false, error: "validation", fields }, cors);
}

function json(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}
