const fs = require("fs");
const path = require("path");
const auth = require("firebase-tools/lib/auth");
const apiv2 = require("firebase-tools/lib/apiv2");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

const project = process.argv[2];
const execute = process.argv.includes("--execute");
const confirmation = process.argv.find((value) => value.startsWith("--confirm="))?.slice("--confirm=".length);
const requiredConfirmation = "CLEAN_PRELAUNCH_TEST_DATA";

if (!project) {
  console.error("Usage: node scripts/cleanup-prelaunch-test-data.js <project> [--execute --confirm=CLEAN_PRELAUNCH_TEST_DATA]");
  process.exit(1);
}

const deleteCollections = [
  "sales",
  "shifts",
  "stockAdjustments",
  "auditLogs",
  "integrationJobs",
  "paymentIntents",
  "merchantOrders",
  "merchantRefundIntents",
  "rechargeRequests",
  "withdrawRequests",
  "refundRequests",
  "settlementRequests",
  "transactions",
  "amsystemOrders",
  "amsystemRewards",
  "amsystemExternalOrders",
  "amsystemPointLogs",
  "amsystemRepeatCreditLogs",
  "amsystemReversalCases",
  "amsystemAdminLogs"
];
const profileCollections = ["wallets", "merchants", "amsystemUsers"];
let accessToken = "";

async function authorizedFetch(url, options = {}) {
  if (!accessToken) accessToken = await apiv2.getAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${body.error?.message || response.statusText}`);
  return body;
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
    documents.push(...(body.documents || []));
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return documents;
}

function integerValue(value = 0) {
  return { integerValue: String(value) };
}

function stringValue(value = "") {
  return { stringValue: value };
}

function emptyArray() {
  return { arrayValue: { values: [] } };
}

function emptyDailyUsage() {
  return {
    mapValue: {
      fields: {
        date: stringValue(""),
        amount: integerValue(0)
      }
    }
  };
}

function updateWrite(document, fields) {
  return {
    update: {
      name: document.name,
      fields
    },
    updateMask: {
      fieldPaths: Object.keys(fields)
    }
  };
}

function profileResetWrites(snapshot) {
  const writes = [];
  for (const document of snapshot.wallets || []) {
    writes.push(updateWrite(document, {
      balance: integerValue(0),
      dailyUsage: emptyDailyUsage(),
      transactions: emptyArray(),
      usedCouponIds: emptyArray(),
      updatedAt: { timestampValue: new Date().toISOString() }
    }));
  }
  for (const document of snapshot.merchants || []) {
    writes.push(updateWrite(document, {
      totalReceived: integerValue(0),
      settlementBalance: integerValue(0),
      refundTotal: integerValue(0),
      orders: emptyArray(),
      refunds: emptyArray(),
      settlements: emptyArray(),
      transactions: emptyArray(),
      notifications: emptyArray(),
      updatedAt: { timestampValue: new Date().toISOString() }
    }));
  }
  for (const document of snapshot.amsystemUsers || []) {
    writes.push(updateWrite(document, {
      points: integerValue(0),
      slots: integerValue(0),
      repeatCredits: integerValue(0),
      repeatCreditQueueAt: stringValue(""),
      repeatCooldownUntil: stringValue(""),
      packageUntil: stringValue(""),
      level: stringValue("普通用户"),
      updatedAt: { timestampValue: new Date().toISOString() }
    }));
  }
  return writes;
}

async function commitWrites(writes) {
  for (let index = 0; index < writes.length; index += 400) {
    await authorizedFetch(
      `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:commit`,
      {
        method: "POST",
        body: JSON.stringify({ writes: writes.slice(index, index + 400) })
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
    tokens: account.tokens
  });

  const snapshot = {};
  for (const collectionId of [...deleteCollections, ...profileCollections]) {
    snapshot[collectionId] = await listCollection(collectionId);
  }

  const deleteCount = deleteCollections.reduce((total, collectionId) => total + snapshot[collectionId].length, 0);
  const resetCount = profileCollections.reduce((total, collectionId) => total + snapshot[collectionId].length, 0);
  console.log(JSON.stringify({
    mode: execute ? "execute" : "dry-run",
    deleteCount,
    resetProfileCount: resetCount,
    collections: Object.fromEntries(
      [...deleteCollections, ...profileCollections].map((collectionId) => [collectionId, snapshot[collectionId].length])
    )
  }, null, 2));

  if (!execute) return;
  if (confirmation !== requiredConfirmation) {
    throw new Error(`Execution requires --confirm=${requiredConfirmation}`);
  }

  const backupDirectory = path.join(process.cwd(), "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDirectory, `prelaunch-cloud-${timestamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify({
    project,
    exportedAt: new Date().toISOString(),
    snapshot
  }, null, 2));

  const writes = [];
  for (const collectionId of deleteCollections) {
    for (const document of snapshot[collectionId]) writes.push({ delete: document.name });
  }
  writes.push(...profileResetWrites(snapshot));
  await commitWrites(writes);

  console.log(JSON.stringify({
    cleaned: true,
    deleted: deleteCount,
    resetProfiles: resetCount,
    backupPath
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
