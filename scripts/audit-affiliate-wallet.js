const auth = require("firebase-tools/lib/auth");
const apiv2 = require("firebase-tools/lib/apiv2");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

const project = process.argv[2];
const email = String(process.argv[3] || "").trim().toLowerCase();

if (!project || !email) {
  console.error("Usage: node scripts/audit-affiliate-wallet.js <project> <email>");
  process.exit(1);
}

let accessToken = "";

async function authorizedFetch(url) {
  if (!accessToken) accessToken = await apiv2.getAccessToken();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
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

async function listCollection(collectionId) {
  const body = await authorizedFetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${collectionId}?pageSize=300`);
  return (body.documents || []).map(decodeDocument);
}

async function main() {
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI login is required.");
  await requireAuth({ project, projectRoot: process.cwd(), user: account.user, tokens: account.tokens });

  const [users, orders, wallets] = await Promise.all([
    listCollection("amsystemUsers"),
    listCollection("amsystemOrders"),
    listCollection("wallets"),
  ]);
  const matchedUsers = users.filter((user) => String(user.account || "").trim().toLowerCase() === email);
  const userIds = new Set(matchedUsers.map((user) => user.id));
  const matchedOrders = orders.filter((order) => userIds.has(order.userId));
  const walletIds = new Set(matchedUsers.flatMap((user) => [user.firebaseUid, user.id]).filter(Boolean));
  const matchedWallets = wallets.filter((wallet) => walletIds.has(wallet.id) || String(wallet.email || "").trim().toLowerCase() === email);

  console.log(JSON.stringify({
    email,
    users: matchedUsers.map((user) => ({ id: user.id, firebaseUid: user.firebaseUid || "", account: user.account || "", name: user.name || "", points: Number(user.points || 0) })),
    orders: matchedOrders.map((order) => ({ id: order.id, userId: order.userId, status: order.status, points: Number(order.points || 0), planId: order.planId || "", paidAt: order.paidAt || "", syncedAt: order.simplePayWalletSyncedAt || "" })),
    wallets: matchedWallets.map((wallet) => ({ id: wallet.id, email: wallet.email || "", displayName: wallet.displayName || "", balance: Number(wallet.balance || 0), transactions: Array.isArray(wallet.transactions) ? wallet.transactions.map((item) => ({ source: item.source || "", amount: item.amount || "", target: item.target || "" })) : [] })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
