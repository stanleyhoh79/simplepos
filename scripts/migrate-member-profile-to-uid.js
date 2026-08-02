const auth = require("firebase-tools/lib/auth");
const apiv2 = require("firebase-tools/lib/apiv2");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

const project = process.argv[2];
const uid = String(process.argv[3] || "").trim();
const email = String(process.argv[4] || "").trim().toLowerCase();
const execute = process.argv.includes("--execute");

if (!project || !uid || !email) {
  console.error("Usage: node scripts/migrate-member-profile-to-uid.js <project> <firebase-uid> <email> [--execute]");
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

function decodeValue(value) {
  if (!value || typeof value !== "object") return value;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue || 0);
  if ("doubleValue" in value) return Number(value.doubleValue || 0);
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, child]) => [key, decodeValue(child)]));
  return value;
}

function decodeDocument(document) {
  return {
    id: document.name.split("/").pop(),
    ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, decodeValue(value)])),
  };
}

function encodeValue(value) {
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && typeof value === "object") {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encodeValue(child)])) } };
  }
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  return { stringValue: String(value ?? "") };
}

async function listCollection(collectionId) {
  const body = await authorizedFetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${collectionId}?pageSize=300`);
  return (body.documents || []).map(decodeDocument);
}

async function main() {
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI login is required.");
  await requireAuth({ project, projectRoot: process.cwd(), user: account.user, tokens: account.tokens });

  const [profiles, merchants] = await Promise.all([listCollection("memberProfiles"), listCollection("merchants")]);
  const targetId = `MP-${uid}`;
  const target = profiles.find((profile) => profile.id === targetId);
  const source = profiles
    .filter((profile) => String(profile.customer?.email || "").trim().toLowerCase() === email && profile.id !== targetId)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];

  if (target) {
    console.log(JSON.stringify({ mode: execute ? "execute" : "dry-run", targetId, result: "already-migrated", sourceId: source?.id || null }, null, 2));
    return;
  }
  if (!source) throw new Error("No legacy member profile matched this email.");

  const migrated = {
    ...source,
    id: targetId,
    memberUid: uid,
    updatedAt: new Date().toISOString(),
    migration: { sourceProfileId: source.id, migratedAt: new Date().toISOString() },
  };
  const linkedMerchants = merchants.filter((merchant) => merchant.memberProfileId === source.id || String(merchant.email || "").trim().toLowerCase() === email);

  console.log(JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    sourceId: source.id,
    targetId,
    email,
    linkedMerchantIds: linkedMerchants.map((merchant) => merchant.id),
  }, null, 2));
  if (!execute) return;

  const profileFields = Object.fromEntries(Object.entries(migrated).map(([key, value]) => [key, encodeValue(value)]));
  const now = new Date().toISOString();
  const writes = [
    {
      update: {
        name: `projects/${project}/databases/(default)/documents/memberProfiles/${targetId}`,
        fields: profileFields,
      },
      updateMask: { fieldPaths: Object.keys(profileFields) },
    },
    ...linkedMerchants.map((merchant) => ({
      update: {
        name: `projects/${project}/databases/(default)/documents/merchants/${merchant.id}`,
        fields: {
          memberProfileId: encodeValue(targetId),
          memberProfileLinked: encodeValue(true),
          updatedAt: { timestampValue: now },
        },
      },
      updateMask: { fieldPaths: ["memberProfileId", "memberProfileLinked", "updatedAt"] },
    })),
  ];
  await authorizedFetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:commit`, {
    method: "POST",
    body: JSON.stringify({ writes }),
  });
  console.log(JSON.stringify({ migrated: true, sourceId: source.id, targetId, updatedMerchantCount: linkedMerchants.length }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
