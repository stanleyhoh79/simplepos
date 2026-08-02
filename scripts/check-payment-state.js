const auth = require("firebase-tools/lib/auth");
const apiv2 = require("firebase-tools/lib/apiv2");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

const project = process.argv[2];
const intentId = process.argv[3];

if (!project || !intentId) {
  console.error("Usage: node scripts/check-payment-state.js <project> <intentId>");
  process.exit(1);
}

async function readDocument(collection, id) {
  const token = await apiv2.getAccessToken();
  const path = `${collection}/${encodeURIComponent(id)}`;
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${path}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (response.status === 404) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${body.error?.message || response.statusText}`);
  return body;
}

function value(field) {
  if (!field) return "";
  return field.stringValue ?? field.integerValue ?? field.doubleValue ?? field.booleanValue ?? "";
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

  const [intent, job] = await Promise.all([
    readDocument("paymentIntents", intentId),
    readDocument("integrationJobs", intentId)
  ]);
  const orderId = intentId.startsWith("INT-") && intentId.endsWith("-simplepay-payment")
    ? intentId.slice(4, -"-simplepay-payment".length)
    : "";
  const sale = orderId ? await readDocument("sales", orderId) : null;
  console.log(JSON.stringify({
    sale: sale ? {
      exists: true,
      status: value(sale.fields?.status),
      syncStatus: value(sale.fields?.syncStatus),
      branchId: value(sale.fields?.branchId)
    } : { exists: false },
    intent: intent ? {
      exists: true,
      status: value(intent.fields?.status),
      branchId: value(intent.fields?.branchId),
      amountPoints: value(intent.fields?.amountPoints),
      merchantIdIsString: typeof intent.fields?.merchantId?.stringValue === "string"
        && intent.fields.merchantId.stringValue.length > 0,
      branchIdIsString: typeof intent.fields?.branchId?.stringValue === "string"
        && intent.fields.branchId.stringValue.length > 0,
      hasCustomer: Boolean(intent.fields?.customer),
      customerNameEmpty: !value(intent.fields?.customer?.mapValue?.fields?.name),
      customerPhoneEmpty: !value(intent.fields?.customer?.mapValue?.fields?.phone)
    } : { exists: false },
    job: job ? {
      exists: true,
      status: value(job.fields?.status),
      operation: value(job.fields?.operation),
      errorCode: value(job.fields?.lastError?.mapValue?.fields?.code),
      errorMessage: value(job.fields?.lastError?.mapValue?.fields?.message)
    } : { exists: false }
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
