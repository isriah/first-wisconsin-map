// Cloudflare Turnstile server-side check.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048;

// Returns true when the token is valid. Any problem counts as a failed check.
export async function verifyTurnstile(secret, token, remoteIp) {
  if (typeof token !== "string" || token === "" || token.length > MAX_TOKEN_LENGTH) {
    return false;
  }

  try {
    const body = { secret, response: token };
    if (remoteIp) body.remoteip = remoteIp;

    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (result.success !== true) {
      console.error("turnstile: rejected", JSON.stringify(result["error-codes"] || []));
    }
    return result.success === true;
  } catch (error) {
    console.error("turnstile: check failed:", error.message);
    return false;
  }
}
