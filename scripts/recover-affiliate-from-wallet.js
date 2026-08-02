const auth = require("firebase-tools/lib/auth");
const apiv2 = require("firebase-tools/lib/apiv2");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

const project = process.argv[2];
const email = String(process.argv[3] || "").trim().toLowerCase();
const apply = process.argv.includes("--apply");

if (!project || !email) {
  console.error("Usage: node scripts/recover-affiliate-from-wallet.js <project> <email> [--apply]");
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
  if (value === null || value === undefined) return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "object") {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)])) } };
  }
  return { stringValue: String(value) };
}

const baseUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;

async function getDocument(path) {
  const response = await fetch(`${baseUrl}/${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (response.status === 404) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${body.error?.message || response.statusText}`);
  return decodeDocument(body);
}

async function listCollection(collectionId) {
  const body = await authorizedFetch(`${baseUrl}/${collectionId}?pageSize=300`);
  return (body.documents || []).map(decodeDocument);
}

function addDays(iso, days) {
  const date = new Date(iso);
  date.setDate(date.getDate() + Number(days || 0));
  return date.toISOString();
}

async function commitWrites(writes) {
  return authorizedFetch(`${baseUrl}:commit`, {
    method: "POST",
    body: JSON.stringify({ writes }),
  });
}

function updateWrite(path, fields) {
  return {
    update: {
      name: `projects/${project}/databases/(default)/documents/${path}`,
      fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, encodeValue(value)])),
    },
    updateMask: { fieldPaths: Object.keys(fields) },
  };
}

async function main() {
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI login is required.");
  await requireAuth({ project, projectRoot: process.cwd(), user: account.user, tokens: account.tokens });
  accessToken = await apiv2.getAccessToken();

  const [users, system] = await Promise.all([listCollection("amsystemUsers"), getDocument("amsystem/main")]);
  const user = users.find((item) => String(item.account || "").trim().toLowerCase() === email);
  if (!user) throw new Error(`Affiliate user not found for ${email}`);

  const wallet = await getDocument(`wallets/${user.firebaseUid || user.id}`);
  if (!wallet) throw new Error(`SimplePay wallet not found for ${email}`);
  const transaction = (wallet.transactions || []).find((item) => String(item.source || "").startsWith("affiliate-package:"));
  if (!transaction) throw new Error("No affiliate package payment evidence exists in this SimplePay wallet.");

  const orderId = String(transaction.source).slice("affiliate-package:".length);
  const planId = String(transaction.target || "");
  const plan = (system?.plans || []).find((item) => item.id === planId);
  if (!plan) throw new Error(`Affiliate plan ${planId || "(missing)"} is not present in amsystem/main.`);
  const existingOrder = await getDocument(`amsystemOrders/${orderId}`);
  const walletPoints = Math.max(0, Number(wallet.balance || 0));
  const points = Math.max(walletPoints, Number(plan.points || 0));
  const paidAt = transaction.createdAt || transaction.updatedAt || new Date().toISOString();
  const packageUntil = addDays(paidAt, plan.validDays || 0);
  const snapshot = {
    id: plan.id,
    name: plan.name,
    amount: Number(plan.amount || 0),
    unitAmount: 180,
    unitCount: Math.max(1, Math.round(Number(plan.amount || 0) / 180)),
    points: Number(plan.points || points),
    slots: Number(plan.slots || 0),
    repeatCredits: Number(plan.repeatCredits || 0),
    repeatCooldownHours: Number(plan.repeatCooldownHours || 0),
    validDays: Number(plan.validDays || 0),
    firstRate: Number(plan.firstRate || 0),
    directRepeatRate: Number(plan.directRepeatRate || 0),
    repeatRate: Number(plan.repeatRate || 0),
  };
  const order = {
    id: orderId,
    userId: user.id,
    planId,
    planSnapshot: snapshot,
    type: "first",
    status: "paid",
    amount: Number(plan.amount || 0),
    points,
    paymentMethod: "simplepay",
    paymentRef: orderId,
    paymentNote: "Recovered from SimplePay wallet payment evidence.",
    proofName: "",
    proofPath: "",
    proofUrl: "",
    proofInlineData: "",
    proofInlineType: "",
    proofStatus: "confirmed",
    proofError: "",
    createdAt: paidAt,
    paidAt,
    recoveredAt: new Date().toISOString(),
    recoverySource: transaction.source,
  };
  const userUpdate = {
    points: Math.max(Number(user.points || 0), points),
    slots: Math.max(Number(user.slots || 0), Number(plan.slots || 0)),
    packageUntil: user.packageUntil && new Date(user.packageUntil) > new Date(packageUntil) ? user.packageUntil : packageUntil,
    level: Number(plan.amount || 0) >= 720 ? "高级推广用户" : "推广用户",
    recoverySource: transaction.source,
    recoveredAt: new Date().toISOString(),
  };
  const pointLogId = `recover-${orderId}`.replace(/[^A-Za-z0-9_-]/g, "-");
  const pointLog = {
    id: pointLogId,
    userId: user.id,
    change: points,
    balance: userUpdate.points,
    source: orderId,
    note: "Recovered from SimplePay wallet payment evidence.",
    createdAt: paidAt,
  };

  const result = {
    mode: apply ? "apply" : "dry-run",
    user: { id: user.id, account: user.account, pointsBefore: Number(user.points || 0), pointsAfter: userUpdate.points },
    wallet: { id: wallet.id, balance: walletPoints, evidence: transaction.source },
    plan: { id: plan.id, name: plan.name, amount: plan.amount, points: plan.points },
    order: { id: orderId, existed: Boolean(existingOrder), status: order.status, points: order.points, packageUntil: userUpdate.packageUntil },
  };
  console.log(JSON.stringify(result, null, 2));
  if (!apply) return;

  await commitWrites([
    updateWrite(`amsystemUsers/${user.id}`, userUpdate),
    updateWrite(`amsystemOrders/${orderId}`, order),
    updateWrite(`amsystemPointLogs/${pointLogId}`, pointLog),
  ]);
  console.log("Recovery committed. Reload Simple Affiliate to read the restored order and points.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
