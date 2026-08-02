const auth = require("firebase-tools/lib/auth");
const apiv2 = require("firebase-tools/lib/apiv2");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

const project = process.argv[2];
const execute = process.argv.includes("--execute");

if (!project) {
  console.error("Usage: node scripts/repair-simplepay-database-links.js <project> [--execute]");
  process.exit(1);
}

let accessToken = "";

async function authorizedFetch(url, options = {}) {
  if (!accessToken) accessToken = await apiv2.getAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${body.error?.message || response.statusText}`);
  return body;
}

function normalizeEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}

function decodeValue(value) {
  if (!value || typeof value !== "object") return value;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue || 0);
  if ("doubleValue" in value) return Number(value.doubleValue || 0);
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, child]) => [key, decodeValue(child)])
    );
  }
  return value;
}

function decodeDocument(document) {
  return {
    id: document.name.split("/").pop(),
    path: document.name,
    ...Object.fromEntries(
      Object.entries(document.fields || {}).map(([key, value]) => [key, decodeValue(value)])
    ),
  };
}

function stringValue(value = "") {
  return { stringValue: String(value || "") };
}

function booleanValue(value = false) {
  return { booleanValue: Boolean(value) };
}

function timestampValue() {
  return { timestampValue: new Date().toISOString() };
}

async function listCollection(collectionId) {
  const documents = [];
  let pageToken = "";
  do {
    const query = new URLSearchParams({ pageSize: "300", showMissing: "false" });
    if (pageToken) query.set("pageToken", pageToken);
    const body = await authorizedFetch(
      `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${collectionId}?${query}`
    );
    documents.push(...(body.documents || []).map(decodeDocument));
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return documents;
}

async function commitWrites(writes) {
  for (let index = 0; index < writes.length; index += 400) {
    await authorizedFetch(
      `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:commit`,
      {
        method: "POST",
        body: JSON.stringify({ writes: writes.slice(index, index + 400) }),
      }
    );
  }
}

async function main() {
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI login is required.");
  await requireAuth({
    project,
    projectRoot: process.cwd(),
    user: account.user,
    tokens: account.tokens,
  });

  const [merchants, memberProfiles] = await Promise.all([
    listCollection("merchants"),
    listCollection("memberProfiles"),
  ]);
  const profilesByEmail = new Map(
    memberProfiles
      .map((profile) => [normalizeEmail(profile.customer?.email || profile.email), profile])
      .filter(([email]) => email)
  );

  const actions = [];
  const writes = [];
  for (const merchant of merchants) {
    const email = normalizeEmail(merchant.email);
    const profile = profilesByEmail.get(email);
    if (profile) {
      const fields = {};
      if (merchant.memberProfileId !== profile.id) fields.memberProfileId = stringValue(profile.id);
      if (merchant.memberProfileLinked !== true) fields.memberProfileLinked = booleanValue(true);
      if (merchant.needsMemberProfile === true) fields.needsMemberProfile = booleanValue(false);
      if (!merchant.source) fields.source = stringValue("simplepay-member-linked");
      if (Object.keys(fields).length) {
        fields.updatedAt = timestampValue();
        writes.push({
          update: {
            name: merchant.path,
            fields,
          },
          updateMask: {
            fieldPaths: Object.keys(fields),
          },
        });
        actions.push({
          action: "link-member-profile",
          merchantId: merchant.id,
          email,
          businessName: merchant.businessName || merchant.displayName || "",
          memberProfileId: profile.id,
        });
      }
    } else if (merchant.needsMemberProfile !== true) {
      const fields = {
        needsMemberProfile: booleanValue(true),
        updatedAt: timestampValue(),
      };
      writes.push({
        update: {
          name: merchant.path,
          fields,
        },
        updateMask: {
          fieldPaths: Object.keys(fields),
        },
      });
      actions.push({
        action: "mark-needs-member-profile",
        merchantId: merchant.id,
        email,
        businessName: merchant.businessName || merchant.displayName || "",
      });
    }
  }

  console.log(JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    merchantCount: merchants.length,
    memberProfileCount: memberProfiles.length,
    plannedUpdates: writes.length,
    actions,
  }, null, 2));

  if (execute && writes.length) {
    await commitWrites(writes);
    console.log(JSON.stringify({ repaired: true, updated: writes.length }, null, 2));
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
