// Email sending. One function per provider; pick with the EMAIL_PROVIDER var.
//
// Every provider takes the same message object and throws if the email could
// not be handed over:
//   { from, to: [addresses], replyTo, subject, text }

const PROVIDERS = {
  resend: sendWithResend,
};

export async function sendEmail(env, message) {
  const name = (env.EMAIL_PROVIDER || "resend").trim().toLowerCase();
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown EMAIL_PROVIDER "${name}"`);
  await provider(env, message);
}

// Resend: https://resend.com/docs/api-reference/emails/send-email
async function sendWithResend(env, message) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "first-wisconsin-map-contact",
    },
    body: JSON.stringify({
      from: message.from,
      to: message.to,
      reply_to: message.replyTo,
      subject: message.subject,
      text: message.text,
    }),
    signal: AbortSignal.timeout(10000),
  });

  // Only the status is reported: the response body can echo addresses.
  if (!response.ok) throw new Error(`Resend answered HTTP ${response.status}`);
}
