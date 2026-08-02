const auth = require("firebase-tools/lib/auth");
const apiv2 = require("firebase-tools/lib/apiv2");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

const project = process.argv[2];
const email = String(process.argv[3] || "").trim().toLowerCase();
const execute = process.argv.includes("--execute");

if (!project || !email) {
  console.error("Usage: node scripts/repair-affiliate-wallet-points.js <project> <email> [--execute]");
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
    path: document.name,
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

  const [users, orders, wallets] = await Promise.all([
    listCollection("amsystemUsers"),
    listCollection("amsystemOrders"),
    listCollection("wallets"),
  ]);
  const user = users.find((item) => String(item.account || "").trim().toLowerCase() === email);
  if (!user) throw new Error("Affiliate user not found.");
  const walletId = user.firebaseUid || user.id;
  const wallet = wallets.find((item) => item.id === walletId) || { id: walletId, transactions: [], balance: 0 };
  const paidOrders = orders.filter((item) => item.userId === user.id && item.status === "paid");
  const existingTransactions = Array.isArray(wallet.transactions) ? wallet.transactions : [];
  const missingOrders = paidOrders.filter((order) => !existingTransactions.some((item) => item && item.source === `affiliate-package:${order.id}`));
  const addedPoints = missingOrders.reduce((sum, order) => sum + Number(order.points || 0), 0);
  const additions = missingOrders.map((order) => ({
    source: `affiliate-package:${order.id}`,
    time: "联盟配套已同步",
    type: "联盟配套积分",
    target: order.planId || "联盟配套",
    amount: `+ ${Number(order.points || 0)} 积分`,
    status: "成功",
    statusClass: "success",
    createdAt: order.paidAt || new Date().toISOString(),
  }));
  const nextBalance = Number(wallet.balance || 0) + addedPoints;

  console.log(JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    walletId,
    priorBalance: Number(wallet.balance || 0),
    missingOrderIds: missingOrders.map((order) => order.id),
    addedPoints,
    nextBalance,
  }, null, 2));

  if (!execute || !missingOrders.length) return;
  const fields = {
    email: encodeValue(email),
    displayName: encodeValue(user.name || email),
    role: encodeValue(wallet.role || "user"),
    status: encodeValue(wallet.status || "active"),
    balance: encodeValue(nextBalance),
    transactions: encodeValue([...additions, ...existingTransactions].slice(0, 30)),
    updatedAt: { timestampValue: new Date().toISOString() },
  };
  const writes = [
    {
      update: {
        name: `projects/${project}/databases/(default)/documents/wallets/${walletId}`,
        fields,
      },
      updateMask: { fieldPaths: Object.keys(fields) },
    },
    ...missingOrders.map((order) => ({
      update: {
        name: `projects/${project}/databases/(default)/documents/amsystemOrders/${order.id}`,
        fields: {
          simplePayWalletSyncedAt: { timestampValue: new Date().toISOString() },
        },
      },
      updateMask: { fieldPaths: ["simplePayWalletSyncedAt"] },
    })),
  ];
  await authorizedFetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:commit`, {
    method: "POST",
    body: JSON.stringify({ writes }),
  });
  console.log(JSON.stringify({ repaired: true, walletId, balance: nextBalance, creditedOrders: missingOrders.map((order) => order.id) }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
