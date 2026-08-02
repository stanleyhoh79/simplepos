const auth = require("firebase-tools/lib/auth");
const apiv2 = require("firebase-tools/lib/apiv2");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

const project = process.argv[2];
const posOrderId = process.argv[3];

if (!project || !posOrderId) {
  console.error("Usage: node scripts/check-integration-order.js <project> <posOrderId>");
  process.exit(1);
}

async function authorizedFetch(url, options = {}) {
  const token = await apiv2.getAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (response.status === 404) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${body.error?.message || response.statusText}`);
  return body;
}

async function readDocument(collection, id) {
  const path = `${collection}/${encodeURIComponent(id)}`;
  return authorizedFetch(
    `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${path}`
  );
}

async function queryDocuments(collectionId, fieldPath, stringValue) {
  const rows = await authorizedFetch(
    `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId }],
          where: {
            fieldFilter: {
              field: { fieldPath },
              op: "EQUAL",
              value: { stringValue }
            }
          },
          limit: 20
        }
      })
    }
  );
  return (rows || []).flatMap((row) => row.document ? [row.document] : []);
}

function value(field) {
  if (!field) return "";
  return field.stringValue
    ?? field.integerValue
    ?? field.doubleValue
    ?? field.booleanValue
    ?? "";
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

  const paymentJobId = `INT-${posOrderId}-simplepay-payment`;
  const affiliateJobId = `INT-${posOrderId}-affiliate-fulfill`;
  const [sale, paymentJob, affiliateJob, externalOrder] = await Promise.all([
    readDocument("sales", posOrderId),
    readDocument("integrationJobs", paymentJobId),
    readDocument("integrationJobs", affiliateJobId),
    readDocument("amsystemExternalOrders", affiliateJobId)
  ]);
  const affiliateOrderId = value(externalOrder?.fields?.affiliateOrderId);
  const referralCode = value(sale?.fields?.customer?.mapValue?.fields?.referralCode);
  const customerPhone = value(sale?.fields?.customer?.mapValue?.fields?.phone);
  const [affiliateOrder, rewards, referralOwners, buyers] = await Promise.all([
    affiliateOrderId ? readDocument("amsystemOrders", affiliateOrderId) : null,
    affiliateOrderId ? queryDocuments("amsystemRewards", "orderId", affiliateOrderId) : [],
    referralCode ? queryDocuments("amsystemUsers", "inviteCode", referralCode) : [],
    customerPhone ? queryDocuments("amsystemUsers", "phone", customerPhone) : []
  ]);
  const referralOwnerId = referralOwners[0]?.name?.split("/").pop() || "";
  const buyerReferrerId = value(buyers[0]?.fields?.referrerId);
  const fixedReferrer = buyerReferrerId
    ? await readDocument("amsystemUsers", buyerReferrerId)
    : null;

  console.log(JSON.stringify({
    sale: sale ? {
      exists: true,
      status: value(sale.fields?.status),
      simplePayStatus: value(sale.fields?.externalReferences?.mapValue?.fields?.simplePayStatus),
      affiliateStatus: value(sale.fields?.externalReferences?.mapValue?.fields?.affiliateStatus),
      affiliateOrderId: value(sale.fields?.externalReferences?.mapValue?.fields?.affiliateOrderId)
    } : { exists: false },
    paymentJob: paymentJob ? {
      exists: true,
      status: value(paymentJob.fields?.status),
      errorCode: value(paymentJob.fields?.lastError?.mapValue?.fields?.code)
    } : { exists: false },
    affiliateJob: affiliateJob ? {
      exists: true,
      status: value(affiliateJob.fields?.status),
      errorCode: value(affiliateJob.fields?.lastError?.mapValue?.fields?.code),
      errorMessage: value(affiliateJob.fields?.lastError?.mapValue?.fields?.message)
    } : { exists: false },
    affiliateOrder: affiliateOrder ? {
      exists: true,
      id: affiliateOrderId,
      status: value(affiliateOrder.fields?.status),
      planId: value(affiliateOrder.fields?.planId),
      amount: value(affiliateOrder.fields?.amount)
    } : { exists: false },
    rewards: {
      count: rewards.length,
      statuses: [...new Set(rewards.map((item) => value(item.fields?.status)).filter(Boolean))]
    },
    affiliateIdentity: {
      referralOwnerCount: referralOwners.length,
      buyerPhoneMatchCount: buyers.length,
      buyerHasFixedReferrer: Boolean(buyerReferrerId),
      fixedReferrerExists: Boolean(fixedReferrer),
      fixedReferrerCodeMatchesSale: Boolean(
        fixedReferrer
        && value(fixedReferrer.fields?.inviteCode) === referralCode
      ),
      fixedReferrerMatchesCodeOwner: Boolean(
        referralOwnerId
        && buyerReferrerId
        && referralOwnerId === buyerReferrerId
      )
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
