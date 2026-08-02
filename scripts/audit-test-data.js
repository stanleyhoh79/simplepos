const auth = require("firebase-tools/lib/auth");
const apiv2 = require("firebase-tools/lib/apiv2");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

const project = process.argv[2];

if (!project) {
  console.error("Usage: node scripts/audit-test-data.js <project>");
  process.exit(1);
}

const collections = [
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
  "wallets",
  "merchants",
  "amsystemOrders",
  "amsystemRewards",
  "amsystemExternalOrders",
  "amsystemPointLogs",
  "amsystemRepeatCreditLogs",
  "amsystemReversalCases",
  "amsystemAdminLogs",
  "amsystemUsers"
];

async function authorizedFetch(url) {
  const token = await apiv2.getAccessToken();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
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
    const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${collectionId}?${query}`;
    const body = await authorizedFetch(url);
    documents.push(...(body.documents || []));
    pageToken = body.nextPageToken || "";
  } while (pageToken);
  return documents;
}

function documentId(document) {
  return String(document.name || "").split("/").pop();
}

function scalar(field) {
  if (!field) return null;
  return field.stringValue
    ?? field.integerValue
    ?? field.doubleValue
    ?? field.booleanValue
    ?? null;
}

function financialSummary(collectionId, documents) {
  if (collectionId === "wallets") {
    return documents.map((document) => ({
      id: documentId(document),
      balance: scalar(document.fields?.balance),
      transactionCount: document.fields?.transactions?.arrayValue?.values?.length || 0
    }));
  }
  if (collectionId === "merchants") {
    return documents.map((document) => ({
      id: documentId(document),
      status: scalar(document.fields?.status),
      totalReceived: scalar(document.fields?.totalReceived),
      refundTotal: scalar(document.fields?.refundTotal),
      settlementBalance: scalar(document.fields?.settlementBalance),
      orderCount: document.fields?.orders?.arrayValue?.values?.length || 0,
      refundCount: document.fields?.refunds?.arrayValue?.values?.length || 0,
      settlementCount: document.fields?.settlements?.arrayValue?.values?.length || 0
    }));
  }
  if (collectionId === "amsystemUsers") {
    return documents.map((document) => ({
      id: documentId(document),
      role: scalar(document.fields?.role),
      balance: scalar(document.fields?.balance),
      pendingCredits: scalar(document.fields?.pendingCredits),
      repeatCredits: scalar(document.fields?.repeatCredits)
    }));
  }
  return undefined;
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

  const result = {};
  for (const collectionId of collections) {
    const documents = await listCollection(collectionId);
    result[collectionId] = {
      count: documents.length,
      sampleIds: documents.slice(0, 8).map(documentId),
      summary: financialSummary(collectionId, documents)
    };
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
