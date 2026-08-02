const auth = require("firebase-tools/lib/auth");
const apiv2 = require("firebase-tools/lib/apiv2");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

const project = process.argv[2];

if (!project) {
  console.error("Usage: node scripts/audit-simplepay-database.js <project>");
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
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, child]) => [key, decodeValue(child)])
    );
  }
  return value;
}

function decodeDocument(document) {
  const id = document.name.split("/").pop();
  return {
    id,
    path: document.name,
    ...Object.fromEntries(
      Object.entries(document.fields || {}).map(([key, value]) => [key, decodeValue(value)])
    ),
  };
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

function groupBy(items, keyGetter) {
  const groups = new Map();
  for (const item of items) {
    const key = keyGetter(item) || "(blank)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function merchantProfileComplete(merchant) {
  return Boolean(
    merchant.businessName
      && merchant.email
      && merchant.contactName
      && merchant.contactPhone
      && merchant.businessAddress
      && merchant.settlementBank
      && merchant.settlementAccount
  );
}

function compactMerchant(merchant) {
  return {
    id: merchant.id,
    email: merchant.email || "",
    businessName: merchant.businessName || merchant.displayName || "",
    status: merchant.status || "pending",
    profileOk: merchantProfileComplete(merchant),
    memberProfileId: merchant.memberProfileId || "",
    memberProfileLinked: Boolean(merchant.memberProfileLinked),
    hasQr: Boolean(merchant.merchantCode),
    totalReceived: Number(merchant.totalReceived || 0),
    settlementBalance: Number(merchant.settlementBalance || 0),
    orderCount: Array.isArray(merchant.orders) ? merchant.orders.length : 0,
    updatedAt: merchant.updatedAt || merchant.createdAt || "",
  };
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

  const [
    merchants,
    wallets,
    memberProfiles,
    merchantOrders,
    refundRequests,
    settlementRequests,
    merchantRefundIntents,
  ] = await Promise.all([
    listCollection("merchants"),
    listCollection("wallets"),
    listCollection("memberProfiles"),
    listCollection("merchantOrders"),
    listCollection("refundRequests"),
    listCollection("settlementRequests"),
    listCollection("merchantRefundIntents"),
  ]);

  const memberEmails = new Set(memberProfiles.map((profile) => normalizeEmail(profile.customer?.email || profile.email)));
  const merchantsByEmail = groupBy(merchants, (merchant) => normalizeEmail(merchant.email));

  const duplicateMerchantEmails = [...merchantsByEmail.entries()]
    .filter(([email, docs]) => email !== "(blank)" && docs.length > 1)
    .map(([email, docs]) => ({ email, count: docs.length, merchants: docs.map(compactMerchant) }));

  const merchantIssues = merchants.map((merchant) => {
    const issues = [];
    const email = normalizeEmail(merchant.email);
    if (!email) issues.push("missing-email");
    if (!memberEmails.has(email)) issues.push("no-linked-member-profile-by-email");
    if (!merchantProfileComplete(merchant)) issues.push("merchant-profile-incomplete");
    if ((merchant.status || "") === "approved" && !merchant.merchantCode) issues.push("approved-without-qr");
    return { ...compactMerchant(merchant), issues };
  }).filter((merchant) => merchant.issues.length);

  const summary = {
    project,
    checkedAt: new Date().toISOString(),
    counts: {
      merchants: merchants.length,
      wallets: wallets.length,
      memberProfiles: memberProfiles.length,
      merchantOrders: merchantOrders.length,
      refundRequests: refundRequests.length,
      settlementRequests: settlementRequests.length,
      merchantRefundIntents: merchantRefundIntents.length,
    },
    duplicateMerchantEmails,
    merchantIssues,
    allMerchants: merchants.map(compactMerchant).sort((a, b) => normalizeEmail(a.email).localeCompare(normalizeEmail(b.email))),
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
