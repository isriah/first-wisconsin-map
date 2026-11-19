// Adds the visitor to the Wix site's contact list and labels them.
//
// Docs (dev.wix.com/docs/api-reference/crm/members-contacts/contacts):
//   Find or Create Label  POST /contacts/v4/labels
//   Create Contact        POST /contacts/v4/contacts
//   Query Contacts        POST /contacts/v4/contacts/query
//   Label Contact         POST /contacts/v4/contacts/{contactId}/labels
// Auth is a site API key: `Authorization: <key>` plus `wix-site-id: <id>`.
//
// The caller treats this whole step as optional: it catches anything thrown
// here and still tells the visitor their message was sent.

const WIX_API = "https://www.wixapis.com/contacts/v4";

// submission: { name, email, labels: ["Map: Fox Valley", ...] }
export async function addWixContact(env, submission) {
  const labelKeys = await findOrCreateLabels(env, submission.labels);

  const created = await wixPost(env, "/contacts", {
    info: {
      name: splitName(submission.name),
      emails: { items: [{ tag: "MAIN", email: submission.email, primary: true }] },
      ...(labelKeys.length > 0 ? { labelKeys: { items: labelKeys } } : {}),
    },
  });
  if (created.ok) return;

  // 409 = a contact with this email already exists. Find it and label it.
  if (created.status !== 409) {
    throw new Error(`create contact answered HTTP ${created.status}`);
  }

  // Wix defines a duplicate by primary email, so that is the field to match.
  const query = await wixPost(env, "/contacts/query", {
    query: { filter: { "primaryInfo.email": { $eq: submission.email } }, paging: { limit: 1 } },
  });
  if (!query.ok) throw new Error(`query contacts answered HTTP ${query.status}`);

  const contactId = (await query.json()).contacts?.[0]?.id;
  if (!contactId) throw new Error("existing contact not found by email");
  if (labelKeys.length === 0) return;

  const labelled = await wixPost(env, `/contacts/${encodeURIComponent(contactId)}/labels`, {
    labelKeys,
  });
  if (!labelled.ok) throw new Error(`label contact answered HTTP ${labelled.status}`);
}

// Turns display names into Wix label keys. Best effort: a label that cannot
// be found or created is skipped so the contact is still saved.
async function findOrCreateLabels(env, displayNames) {
  const keys = await Promise.all(
    displayNames.map(async (displayName) => {
      try {
        const response = await wixPost(env, "/labels", { displayName });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()).label?.key;
      } catch (error) {
        console.error("wix: label skipped:", error.message);
        return undefined;
      }
    }),
  );
  return keys.filter(Boolean);
}

function wixPost(env, path, body) {
  return fetch(WIX_API + path, {
    method: "POST",
    headers: {
      Authorization: env.WIX_API_KEY,
      "wix-site-id": env.WIX_SITE_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
}

// "Ada Lovelace King" -> { first: "Ada", last: "Lovelace King" }
function splitName(fullName) {
  const [first, ...rest] = fullName.split(/\s+/);
  return rest.length > 0 ? { first, last: rest.join(" ") } : { first };
}
