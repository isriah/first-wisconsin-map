# Contact-form relay (Cloudflare Worker)

The map page lets a visitor write to the volunteer champion of a region. The
champions' email addresses must stay private, so the page sends the message to
this small program instead. It then:

1. checks the message (required fields, lengths, spam trap, optional Turnstile check),
2. emails the region's champion, with **Reply-To** set to the visitor so the champion can simply hit Reply,
3. adds the visitor to the Wix site's contact list with labels (optional).

If the email cannot be sent, the visitor sees an error. If only the Wix step
fails, the visitor still sees success and the problem is written to the Worker's log.

There are no npm dependencies and no build step.

| File | What it does |
| --- | --- |
| `src/index.js` | Request handling, validation, CORS, the order of the steps |
| `src/regions.js` | Region and program names (copy of `config/regions.json`, keep in sync) |
| `src/email.js` | Sends the email (Resend) |
| `src/turnstile.js` | Cloudflare Turnstile check |
| `src/wix.js` | Wix contact + labels |
| `wrangler.jsonc` | Worker name and non-secret settings |
| `test/contact.test.mjs` | Tests; run `node --test` (no network, no accounts needed) |

## Settings

Plain settings live in `wrangler.jsonc` under `vars`. Secrets are never written
to a file; they are typed into `wrangler secret put`.

| Name | Kind | Required | Meaning |
| --- | --- | --- | --- |
| `FROM_EMAIL` | var | yes | Sender, e.g. `FIRST Wisconsin Map <map@firstwisconsin.example>`. The domain must be verified with the email provider. |
| `ALLOWED_ORIGINS` | var | yes | Comma-separated list of sites allowed to post the form, e.g. `https://your-org.github.io`. Scheme + host only: no path, no trailing slash. |
| `EMAIL_PROVIDER` | var | no | `resend` (the default and the only choice today). |
| `WIX_SITE_ID` | var | no | Wix site id. Empty = skip the Wix step. |
| `CHAMPION_EMAILS` | secret | yes | JSON object: region id → address (or list of addresses), plus `default`. |
| `RESEND_API_KEY` | secret | yes | Resend API key. |
| `TURNSTILE_SECRET` | secret | no | Turnstile secret key. When set, every submission must carry a valid `turnstileToken`. |
| `WIX_API_KEY` | secret | no | Wix API key. Missing = skip the Wix step. |

Example `CHAMPION_EMAILS` value (one line when you paste it):

```json
{"milwaukee":"a@example.org","nel":["b@example.org","c@example.org"],"default":"info@example.org"}
```

Region ids: `milwaukee`, `woww`, `southshore`, `nel`, `foxvalley`, `cnw`, `north`,
`sevenrivers`, `capital`, `driftless`. A region with no entry uses `default`.

## Setup, step by step

You need: a free Cloudflare account, a Resend account, access to the DNS
settings of the domain you will send from, and [Node.js](https://nodejs.org) on
your computer. Open a terminal in this `worker` folder for every command below.

### 1. Email sender (Resend)

1. Sign up at <https://resend.com> and add your domain under **Domains**.
2. Resend shows DNS records to add at your domain's DNS host. Add them and wait until Resend shows the domain as verified. Until then Resend only delivers test emails to your own address.
3. Create an API key under **API Keys** (sending access is enough). Keep it for step 4.
4. Decide the sender address on that domain and put it in `FROM_EMAIL` in `wrangler.jsonc`.

### 2. Edit `wrangler.jsonc`

Replace the placeholder values of `FROM_EMAIL` and `ALLOWED_ORIGINS`.
`ALLOWED_ORIGINS` is the address the map page is served from (the GitHub Pages
address, e.g. `https://your-org.github.io`), not the Wix site that embeds it.

### 3. Create the Worker

```sh
npx wrangler login      # opens the browser; approve access to your Cloudflare account
npx wrangler deploy     # creates/updates the Worker "first-wisconsin-map-contact"
```

The second command prints the Worker's address, something like
`https://first-wisconsin-map-contact.<your-subdomain>.workers.dev`. The map page
must post to that address followed by `/contact`.

### 4. Set the secrets

Each command asks you to paste the value, then press Enter.

```sh
npx wrangler secret put CHAMPION_EMAILS
npx wrangler secret put RESEND_API_KEY
```

Send a test message from the map page. The champion for that region should
receive it, and replying should address the visitor.

### 5. Turnstile bot check (optional, recommended)

1. In the Cloudflare dashboard open **Turnstile** and add a widget. As hostname, enter the host the map page is served from (e.g. `your-org.github.io`).
2. You get a **site key** (public; it goes into the map page) and a **secret key**.
3. `npx wrangler secret put TURNSTILE_SECRET` and paste the secret key.

From then on, submissions without a valid token are refused. Only set the secret
once the page really shows the widget, or every message will be rejected.

### 6. Wix contacts (optional)

1. As the owner (or co-owner) of the Wix account, open the **API Keys Manager**: <https://manage.wix.com/account/api-keys>.
2. Generate a key. Limit it to the FIRST Wisconsin site and give it only the contacts permissions. The Worker uses the Wix scopes *Manage Contacts*, *Read Contacts* and *Manage Contact Labels*.
3. Find the site id: open the site's dashboard in Wix; the id is the part of the browser address right after `/dashboard/`.
4. Put the site id in `WIX_SITE_ID` in `wrangler.jsonc`, then:

```sh
npx wrangler secret put WIX_API_KEY
npx wrangler deploy
```

Each visitor becomes a contact (or the existing contact with that email is
reused) with labels such as `Map: Northeast & Lakeshore`,
`Map role: Parent or guardian` and `Map program: FIRST LEGO League`. Labels are
created automatically the first time they are needed.

Note: the role is free text from the form, so each new wording creates a new Wix
label. If the page offers a fixed list of roles this stays tidy. Keep Turnstile
on so a script cannot fill the label list.

### Changing things later

- New champion address: run `npx wrangler secret put CHAMPION_EMAILS` again with the full new JSON.
- Any change in `wrangler.jsonc` or `src/`: run `npx wrangler deploy` again.
- Problems: Cloudflare dashboard → the Worker → **Logs**. Lines start with `email:`, `wix:` or `turnstile:`. Message texts and keys are never logged.

## What the page sends and gets back

`POST /contact`, JSON body:

```json
{ "region": "nel", "name": "…", "email": "…", "role": "Parent or guardian",
  "programs": ["fll", "ftc", "frc", "unsure"], "message": "…", "website": "", "turnstileToken": "…" }
```

| Status | Body | When |
| --- | --- | --- |
| 200 | `{ "ok": true }` | Sent (also returned when the hidden `website` field is filled) |
| 400 | `{ "ok": false, "error": "validation", "fields": { "email": "…" } }` | A field is missing, too long or invalid, or the body is not JSON |
| 403 | `{ "ok": false, "error": "bot_check" }` | Turnstile token missing or rejected |
| 403 | `{ "ok": false, "error": "origin_not_allowed" }` | Request did not come from a site in `ALLOWED_ORIGINS` |
| 404 / 405 | `not_found` / `method_not_allowed` | Other path / other method |
| 413 | `{ "ok": false, "error": "too_large" }` | Body over 10 KB |
| 502 | `{ "ok": false, "error": "send_failed" }` | The email could not be sent (also when `CHAMPION_EMAILS` is broken) |

Limits: name 120, email 254, role 80, message 4000 characters.

## Verified against the docs / not verified

Checked against the official documentation on 2026-11-19. Nothing here has been
run against a real Cloudflare, Resend or Wix account.

**Verified in the docs**

- Resend: `POST https://api.resend.com/emails`, `Authorization: Bearer <key>`, JSON fields `from`, `to` (string or list, max 50), `subject`, `text`, `reply_to`. The sender domain must be verified, otherwise Resend answers 403.
- Turnstile: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`, JSON accepted, fields `secret`, `response`, optional `remoteip`; the answer has `success` and `error-codes`. Tokens are single-use, valid 5 minutes, at most 2048 characters.
- Wix endpoints and bodies: Create Contact (`POST /contacts/v4/contacts`, `info.name`, `info.emails.items`, `info.labelKeys.items`; HTTP 409 `DUPLICATE_CONTACT_EXISTS` when the primary email is already used), Query Contacts (`POST /contacts/v4/contacts/query`, `primaryInfo.email` supports `$eq`, answer has `contacts[].id`), Find or Create Label (`POST /contacts/v4/labels` with `displayName`, answer has `label.key`), Label Contact (`POST /contacts/v4/contacts/{contactId}/labels` with `labelKeys`).
- Wix API key auth: the key goes in `Authorization` as-is (no `Bearer`), together with `wix-site-id` for site-level calls. Only account owners and co-owners can create keys. Site id is in the dashboard URL after `/dashboard/`.
- Wrangler: `wrangler.jsonc` is the recommended format; `name`, `main`, `compatibility_date` are required; `vars` for plain values; `wrangler secret put` for secrets.

**Not verified / open points**

- **Wix: API key on the contact methods.** The Create Contact, Query Contacts, Label Contact and Find or Create Label pages list only the permission scopes they need; none of them states which identities may call them. Wix's general docs say an API key acts as its own "API key admin" identity for site-level administrative calls and that what it may do depends on the permissions chosen for the key. So it is expected to work, but the method pages do not say so explicitly. Confirm with one real test submission. If Wix answers 403, the log shows `wix: contact not saved: create contact answered HTTP 403`.
- Wix: the exact names of the permission checkboxes in the API Keys Manager were not checked, only the scope names in the API reference.
- Wix: whether the `primaryInfo.email` filter is case-sensitive is not documented. (Wix's own example filters on `info.emails.email` instead; both are documented.)
- Resend: the exact shape of error bodies is not used (only the HTTP status). The `User-Agent` header the Worker sends is a precaution and is not required by the page that was read.
- Resend and Turnstile dashboard steps above are a summary; follow the on-screen instructions where they differ.

**Cloudflare's own email sending (not used)**

Cloudflare now has an "Email Service" that lets a Worker send to any recipient
through a `send_email` binding (`env.EMAIL.send({ from, to, subject, text, replyTo })`).
According to Cloudflare's docs it is still marked **Beta** (public beta since
April 2026), sending to arbitrary recipients needs the **Workers Paid** plan, and
the sending domain must use **Cloudflare DNS** and be onboarded under Email
Sending. Because it is not generally available, it was not added as a second
`EMAIL_PROVIDER`. If it leaves beta and the domain is on Cloudflare DNS, it would
be a small addition to `src/email.js` plus a `send_email` entry in `wrangler.jsonc`.
