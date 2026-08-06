const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { applyWalletAndAffiliatePointChange } = require("./wallet-affiliate-balance");

if (!admin.apps.length) admin.initializeApp();

const db = admin.firestore();
const posDb = db;
const OWNER_EMAIL = "stanleyhoh79@gmail.com";
const MAX_EMBEDDED_RECORDS = 50;

function text(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return text(value).toLowerCase();
}

function positiveInteger(value, field) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new HttpsError("invalid-argument", `${field} must be a positive integer.`);
  }
  return amount;
}

function positiveNumber(value, field) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpsError("invalid-argument", `${field} must be a positive number.`);
  }
  return Number(amount.toFixed(2));
}

function safeExternalId(value) {
  const normalized = text(value);
  if (!normalized || normalized.length > 160 || normalized.includes("/")) {
    throw new HttpsError("invalid-argument", "externalOrderId is invalid.");
  }
  return normalized;
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function nextDailyUsage(usage, amount) {
  const current = usage && usage.date === todayKey() ? Number(usage.amount || 0) : 0;
  return { date: todayKey(), amount: current + amount };
}

function transactionItem(id, type, target, amountText, createdAt) {
  return {
    id,
    time: "刚刚",
    type,
    target,
    amount: amountText,
    status: "成功",
    statusClass: "success",
    createdAt
  };
}

function requireUser(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  return {
    uid: request.auth.uid,
    email: normalizeEmail(request.auth.token.email)
  };
}

async function requireAdmin(request) {
  const user = requireUser(request);
  if (user.email === OWNER_EMAIL) return user;
  const snapshot = await db.collection("adminUsers").doc(user.email).get();
  if (!snapshot.exists || snapshot.data().enabled === false) {
    throw new HttpsError("permission-denied", "Admin permission required.");
  }
  return user;
}

const TEST_DATA_COLLECTIONS = [
  "wallets",
  "transactions",
  "rechargeRequests",
  "withdrawRequests",
  "merchantOrders",
  "paymentIntents",
  "refundRequests",
  "merchantRefundIntents",
  "settlementRequests",
  "integrationJobs",
  "sales",
];

const MERCHANT_TEST_OPTION = "merchants";
const MERCHANT_EMBEDDED_DATA_OPTION = "merchantEmbeddedData";
const CLEARABLE_SIMPLEPAY_OPTIONS = [
  ...TEST_DATA_COLLECTIONS,
  MERCHANT_TEST_OPTION,
  MERCHANT_EMBEDDED_DATA_OPTION,
];

const BACKUP_COLLECTIONS = [
  ...TEST_DATA_COLLECTIONS,
  "merchants",
  "adminUsers",
  "systemConfig",
  "payAuditLogs",
];

const DELETE_BATCH_SIZE = 400;

function isExplicitTestMerchant(data) {
  return data.isTest === true || data.isDemo === true || text(data.status).toLowerCase() === "demo";
}

async function deleteDocumentsInBatches(documents) {
  let deleted = 0;
  for (let index = 0; index < documents.length; index += DELETE_BATCH_SIZE) {
    const batch = db.batch();
    documents.slice(index, index + DELETE_BATCH_SIZE).forEach((item) => batch.delete(item.ref));
    await batch.commit();
    deleted += Math.min(DELETE_BATCH_SIZE, documents.length - index);
  }
  return deleted;
}

async function clearMerchantEmbeddedDataInBatches(documents) {
  let merchantsProcessed = 0;
  for (let index = 0; index < documents.length; index += DELETE_BATCH_SIZE) {
    const batch = db.batch();
    documents.slice(index, index + DELETE_BATCH_SIZE).forEach((item) => {
      batch.update(item.ref, { orders: [], transactions: [] });
    });
    await batch.commit();
    merchantsProcessed += Math.min(DELETE_BATCH_SIZE, documents.length - index);
  }
  return merchantsProcessed;
}

async function getSimplePayCleanupPreview() {
  const snapshots = await Promise.all(TEST_DATA_COLLECTIONS.map((collectionName) => db.collection(collectionName).get()));
  const collections = Object.fromEntries(
    TEST_DATA_COLLECTIONS.map((collectionName, index) => [collectionName, snapshots[index].size])
  );
  const merchantSnapshot = await db.collection("merchants").get();
  const merchantsWithEmbeddedData = merchantSnapshot.docs.filter((item) => {
    const data = item.data();
    return (Array.isArray(data.orders) && data.orders.length > 0)
      || (Array.isArray(data.transactions) && data.transactions.length > 0);
  });
  const embeddedOrderCount = merchantSnapshot.docs.reduce(
    (total, item) => total + (Array.isArray(item.data().orders) ? item.data().orders.length : 0),
    0
  );
  const embeddedTransactionCount = merchantSnapshot.docs.reduce(
    (total, item) => total + (Array.isArray(item.data().transactions) ? item.data().transactions.length : 0),
    0
  );
  const testEligible = merchantSnapshot.docs.filter((item) => isExplicitTestMerchant(item.data())).length;
  collections[MERCHANT_TEST_OPTION] = testEligible;
  collections[MERCHANT_EMBEDDED_DATA_OPTION] = merchantsWithEmbeddedData.length;
  return {
    collections,
    merchants: {
      total: merchantSnapshot.size,
      testEligible,
      withEmbeddedOrders: merchantSnapshot.docs.filter((item) => Array.isArray(item.data().orders) && item.data().orders.length > 0).length,
      embeddedOrderCount,
      embeddedTransactionCount,
    },
  };
}

function backupValue(value) {
  if (value instanceof admin.firestore.Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(backupValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, backupValue(item)]));
  }
  return value;
}

exports.exportSimplePayBackup = onCall(async (request) => {
  const reviewer = await requireAdmin(request);
  const snapshots = await Promise.all(BACKUP_COLLECTIONS.map((collectionName) => db.collection(collectionName).get()));
  const collections = Object.fromEntries(
    BACKUP_COLLECTIONS.map((collectionName, index) => [
      collectionName,
      snapshots[index].docs.map((item) => ({ id: item.id, ...backupValue(item.data()) })),
    ])
  );
  return {
    exportedAt: new Date().toISOString(),
    exportedBy: reviewer.email,
    collections,
  };
});

exports.previewSimplePayTestData = onCall(async (request) => {
  await requireAdmin(request);
  return getSimplePayCleanupPreview();
});

exports.clearSimplePayTestData = onCall(async (request) => {
  const reviewer = await requireAdmin(request);
  const confirmation = text(request.data && request.data.confirmation);
  if (confirmation !== "CLEAR SIMPLEPAY TEST DATA") {
    throw new HttpsError("invalid-argument", "Confirmation text must exactly equal CLEAR SIMPLEPAY TEST DATA.");
  }
  if (request.data?.backupConfirmed !== true) {
    throw new HttpsError("failed-precondition", "Export a backup before clearing test data.");
  }
  const selectedCollections = request.data && request.data.selectedCollections;
  if (!Array.isArray(selectedCollections) || selectedCollections.some((name) => typeof name !== "string" || !CLEARABLE_SIMPLEPAY_OPTIONS.includes(name))) {
    throw new HttpsError("invalid-argument", "selectedCollections must contain only approved SimplePay business collections.");
  }
  const selected = new Set(selectedCollections);

  const deleted = {};
  const skipped = {};
  for (const collectionName of TEST_DATA_COLLECTIONS) {
    const snapshot = await db.collection(collectionName).get();
    deleted[collectionName] = selected.has(collectionName)
      ? await deleteDocumentsInBatches(snapshot.docs)
      : 0;
    skipped[collectionName] = selected.has(collectionName) ? 0 : snapshot.size;
  }

  const merchantSnapshot = await db.collection("merchants").get();
  const testMerchants = merchantSnapshot.docs.filter((item) => isExplicitTestMerchant(item.data()));
  deleted.merchants = selected.has(MERCHANT_TEST_OPTION)
    ? await deleteDocumentsInBatches(testMerchants)
    : 0;
  skipped.merchants = selected.has(MERCHANT_TEST_OPTION) ? merchantSnapshot.size - deleted.merchants : merchantSnapshot.size;

  const merchantsWithEmbeddedData = merchantSnapshot.docs.filter((item) => {
    const data = item.data();
    return (Array.isArray(data.orders) && data.orders.length > 0)
      || (Array.isArray(data.transactions) && data.transactions.length > 0);
  });
  const embeddedMerchantsToClear = selected.has(MERCHANT_TEST_OPTION)
    ? merchantsWithEmbeddedData.filter((item) => !isExplicitTestMerchant(item.data()))
    : merchantsWithEmbeddedData;
  const embeddedOrdersCleared = embeddedMerchantsToClear.reduce(
    (total, item) => total + (Array.isArray(item.data().orders) ? item.data().orders.length : 0),
    0
  );
  const embeddedTransactionsCleared = embeddedMerchantsToClear.reduce(
    (total, item) => total + (Array.isArray(item.data().transactions) ? item.data().transactions.length : 0),
    0
  );
  const merchantsProcessed = selected.has(MERCHANT_EMBEDDED_DATA_OPTION)
    ? await clearMerchantEmbeddedDataInBatches(embeddedMerchantsToClear)
    : 0;
  const embeddedRecordsCleared = selected.has(MERCHANT_EMBEDDED_DATA_OPTION)
    ? embeddedOrdersCleared + embeddedTransactionsCleared
    : 0;
  deleted[MERCHANT_EMBEDDED_DATA_OPTION] = embeddedRecordsCleared;
  skipped[MERCHANT_EMBEDDED_DATA_OPTION] = selected.has(MERCHANT_EMBEDDED_DATA_OPTION)
    ? merchantSnapshot.size - merchantsProcessed
    : merchantSnapshot.size;
  const merchantEmbeddedData = {
    merchantsProcessed,
    ordersCleared: selected.has(MERCHANT_EMBEDDED_DATA_OPTION) ? embeddedOrdersCleared : 0,
    transactionsCleared: selected.has(MERCHANT_EMBEDDED_DATA_OPTION) ? embeddedTransactionsCleared : 0,
    recordsCleared: embeddedRecordsCleared,
  };

  const backupStatus = "client JSON backup exported and confirmed";
  await db.collection("payAuditLogs").add({
    actor: reviewer.email,
    actorRole: "admin",
    module: "System config",
    action: "Clear SimplePay test data",
    target: "test business data",
    detail: JSON.stringify({ selectedCollections: [...selected], deleted, skipped, merchantEmbeddedData, backupStatus }),
    result: "success",
    createdAt: new Date().toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { deleted, skipped, merchantEmbeddedData, backupStatus };
});

function ledgerRecord({
  id,
  account,
  accountId,
  accountRole,
  counterparty,
  type,
  amount,
  amountText,
  source,
  sourceType,
  status = "成功",
  statusClass = "success",
  detail,
  createdAt,
  orderId = "",
  merchantOrderId = "",
  refundRequestId = "",
  paymentReference = "",
  externalOrderId = "",
  intentId = "",
  posOrderId = ""
}) {
  return {
    id,
    account: account || "",
    accountId: accountId || "",
    accountRole: accountRole || "",
    counterparty: counterparty || "",
    type,
    amount,
    amountText,
    source,
    sourceType,
    status,
    statusClass,
    detail: detail || "",
    orderId,
    merchantOrderId,
    refundRequestId,
    paymentReference,
    externalOrderId,
    intentId,
    posOrderId,
    createdAt,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

exports.submitRechargeRequest = onCall(async (request) => {
  const user = requireUser(request);
  const myrAmount = positiveNumber(request.data && request.data.myrAmount, "myrAmount");
  const externalRequestId = safeExternalId(request.data && request.data.externalRequestId);
  const requestId = `RC-${externalRequestId}`;
  const requestRef = db.collection("rechargeRequests").doc(requestId);
  const walletRef = db.collection("wallets").doc(user.uid);
  const configRef = db.collection("systemConfig").doc("main");

  return db.runTransaction(async (tx) => {
    const [requestSnapshot, walletSnapshot, configSnapshot] = await Promise.all([
      tx.get(requestRef),
      tx.get(walletRef),
      tx.get(configRef)
    ]);
    if (requestSnapshot.exists) {
      const existing = requestSnapshot.data();
      if (existing.userId !== user.uid || Number(existing.myrAmount) !== myrAmount) {
        throw new HttpsError("already-exists", "externalRequestId is already used.");
      }
      return { id: requestId, status: existing.status, duplicate: true };
    }
    if (!walletSnapshot.exists) throw new HttpsError("not-found", "Wallet not found.");
    const wallet = walletSnapshot.data();
    if (wallet.status === "frozen") throw new HttpsError("failed-precondition", "Wallet is frozen.");
    const pointsPerMyr = Number(configSnapshot.exists ? configSnapshot.data().pointsPerMyr : 100) || 100;
    const amount = Math.round(myrAmount * pointsPerMyr);
    const createdAt = new Date().toISOString();
    tx.create(requestRef, {
      id: requestId,
      externalRequestId,
      userId: user.uid,
      email: user.email,
      displayName: text(request.auth.token.name),
      amount,
      myrAmount,
      pointsPerMyr,
      status: "pending",
      createdAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { id: requestId, status: "pending", amount, myrAmount, duplicate: false };
  });
});

exports.submitWithdrawalRequest = onCall(async (request) => {
  const user = requireUser(request);
  const amount = positiveInteger(request.data && request.data.amount, "amount");
  const bankAccount = text(request.data && request.data.bankAccount);
  const externalRequestId = safeExternalId(request.data && request.data.externalRequestId);
  if (!bankAccount) throw new HttpsError("invalid-argument", "bankAccount is required.");

  const requestId = `WD-${externalRequestId}`;
  const requestRef = db.collection("withdrawRequests").doc(requestId);
  const walletRef = db.collection("wallets").doc(user.uid);
  const configRef = db.collection("systemConfig").doc("main");
  return db.runTransaction(async (tx) => {
    const [requestSnapshot, walletSnapshot, configSnapshot] = await Promise.all([
      tx.get(requestRef),
      tx.get(walletRef),
      tx.get(configRef)
    ]);
    if (requestSnapshot.exists) {
      const existing = requestSnapshot.data();
      if (existing.userId !== user.uid || Number(existing.amount) !== amount) {
        throw new HttpsError("already-exists", "externalRequestId is already used.");
      }
      return { id: requestId, status: existing.status, duplicate: true };
    }
    if (!walletSnapshot.exists) throw new HttpsError("not-found", "Wallet not found.");
    const wallet = walletSnapshot.data();
    if (wallet.status === "frozen") throw new HttpsError("failed-precondition", "Wallet is frozen.");
    if (Number(wallet.balance || 0) < amount) throw new HttpsError("failed-precondition", "Insufficient balance.");
    const currentDaily = wallet.dailyUsage && wallet.dailyUsage.date === todayKey()
      ? Number(wallet.dailyUsage.amount || 0)
      : 0;
    const dailyLimit = Number(configSnapshot.exists ? configSnapshot.data().dailyTransactionLimit : 0) || 0;
    if (dailyLimit > 0 && currentDaily + amount > dailyLimit) {
      throw new HttpsError("resource-exhausted", "Daily transaction limit exceeded.");
    }
    const pointsPerMyr = Number(configSnapshot.exists ? configSnapshot.data().pointsPerMyr : 100) || 100;
    const createdAt = new Date().toISOString();
    tx.create(requestRef, {
      id: requestId,
      externalRequestId,
      userId: user.uid,
      email: user.email,
      displayName: text(request.auth.token.name),
      amount,
      myrAmount: amount / pointsPerMyr,
      bankAccount,
      status: "pending",
      createdAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(walletRef, {
      dailyUsage: nextDailyUsage(wallet.dailyUsage, amount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { id: requestId, status: "pending", duplicate: false };
  });
});

exports.reviewRechargeRequest = onCall(async (request) => {
  const reviewer = await requireAdmin(request);
  const requestId = text(request.data && request.data.requestId);
  const approved = Boolean(request.data && request.data.approved);
  const paymentReference = text(request.data && request.data.paymentReference);
  const reviewNote = text(request.data && request.data.reviewNote);
  if (!requestId) throw new HttpsError("invalid-argument", "requestId is required.");
  if (approved && !paymentReference) {
    throw new HttpsError("invalid-argument", "paymentReference is required for approval.");
  }

  const requestRef = db.collection("rechargeRequests").doc(requestId);
  return db.runTransaction(async (tx) => {
    const requestSnapshot = await tx.get(requestRef);
    if (!requestSnapshot.exists) throw new HttpsError("not-found", "Recharge request not found.");
    const recharge = requestSnapshot.data();
    if (recharge.status !== "pending") {
      return { id: requestId, status: recharge.status, duplicate: true };
    }

    const walletRef = db.collection("wallets").doc(recharge.userId);
    const walletSnapshot = await tx.get(walletRef);
    if (!walletSnapshot.exists) throw new HttpsError("not-found", "Wallet not found.");
    const wallet = walletSnapshot.data();
    const amount = positiveInteger(recharge.amount, "recharge amount");
    const status = approved ? "approved" : "rejected";
    const reviewedAt = new Date().toISOString();
    const walletEntry = transactionItem(
      `recharge-${requestId}`,
      approved ? "充值" : "充值拒绝",
      "后台审批",
      approved ? `+ ${amount} 积分` : `${amount} 积分`,
      reviewedAt
    );

    tx.update(requestRef, {
      status,
      paymentReference: approved ? paymentReference : "",
      reviewNote,
      reviewedBy: reviewer.email,
      reviewedAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(walletRef, {
      balance: approved ? Number(wallet.balance || 0) + amount : Number(wallet.balance || 0),
      transactions: [walletEntry, ...(wallet.transactions || [])].slice(0, 30),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    tx.create(db.collection("transactions").doc(`recharge-${requestId}`), ledgerRecord({
      id: `recharge-${requestId}`,
      account: recharge.email || recharge.userId,
      accountId: recharge.userId,
      accountRole: "user",
      counterparty: reviewer.email,
      type: approved ? "充值审批通过" : "充值审批拒绝",
      amount,
      amountText: approved ? `+ ${amount} 积分` : `${amount} 积分`,
      source: "安全云函数",
      sourceType: "recharge",
      status: approved ? "已通过" : "已拒绝",
      statusClass: approved ? "success" : "danger",
      detail: paymentReference || reviewNote,
      createdAt: reviewedAt
    }));
    return { id: requestId, status, duplicate: false };
  });
});

exports.reviewWithdrawalRequest = onCall(async (request) => {
  const reviewer = await requireAdmin(request);
  const requestId = text(request.data && request.data.requestId);
  const approved = Boolean(request.data && request.data.approved);
  const payoutReference = text(request.data && request.data.payoutReference);
  const reviewNote = text(request.data && request.data.reviewNote);
  if (!requestId) throw new HttpsError("invalid-argument", "requestId is required.");
  if (approved && !payoutReference) {
    throw new HttpsError("invalid-argument", "payoutReference is required for approval.");
  }

  const requestRef = db.collection("withdrawRequests").doc(requestId);
  return db.runTransaction(async (tx) => {
    const requestSnapshot = await tx.get(requestRef);
    if (!requestSnapshot.exists) throw new HttpsError("not-found", "Withdrawal request not found.");
    const withdrawal = requestSnapshot.data();
    if (withdrawal.status !== "pending") {
      return { id: requestId, status: withdrawal.status, duplicate: true };
    }

    const walletRef = db.collection("wallets").doc(withdrawal.userId);
    const walletSnapshot = await tx.get(walletRef);
    if (!walletSnapshot.exists) throw new HttpsError("not-found", "Wallet not found.");
    const wallet = walletSnapshot.data();
    const amount = positiveInteger(withdrawal.amount, "withdrawal amount");
    if (approved && Number(wallet.balance || 0) < amount) {
      throw new HttpsError("failed-precondition", "Insufficient balance.");
    }

    const status = approved ? "approved" : "rejected";
    const reviewedAt = new Date().toISOString();
    const walletEntry = transactionItem(
      `withdrawal-${requestId}`,
      approved ? "提现" : "提现拒绝",
      withdrawal.bankAccount || "银行卡",
      approved ? `- ${amount} 积分` : `${amount} 积分`,
      reviewedAt
    );

    tx.update(requestRef, {
      status,
      payoutReference: approved ? payoutReference : "",
      reviewNote,
      reviewedBy: reviewer.email,
      reviewedAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(walletRef, {
      balance: approved ? Number(wallet.balance || 0) - amount : Number(wallet.balance || 0),
      transactions: [walletEntry, ...(wallet.transactions || [])].slice(0, 30),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    tx.create(db.collection("transactions").doc(`withdrawal-${requestId}`), ledgerRecord({
      id: `withdrawal-${requestId}`,
      account: withdrawal.email || withdrawal.userId,
      accountId: withdrawal.userId,
      accountRole: "user",
      counterparty: withdrawal.bankAccount || "",
      type: approved ? "提现审批通过" : "提现审批拒绝",
      amount,
      amountText: approved ? `- ${amount} 积分` : `${amount} 积分`,
      source: "安全云函数",
      sourceType: "withdrawal",
      status: approved ? "已通过" : "已拒绝",
      statusClass: approved ? "success" : "danger",
      detail: payoutReference || reviewNote,
      createdAt: reviewedAt
    }));
    return { id: requestId, status, duplicate: false };
  });
});

async function createMerchantPaymentData(data, payer) {
  const merchantId = text(data && data.merchantId);
  const merchantName = text(data && data.merchantName);
  const clientRequestId = text(data && data.clientRequestId);
  const externalOrderId = safeExternalId(clientRequestId || (data && data.externalOrderId));
  if (clientRequestId && safeExternalId(data && data.externalOrderId) !== externalOrderId) {
    throw new HttpsError("invalid-argument", "clientRequestId and externalOrderId must match.");
  }
  const amount = positiveInteger(data && data.amount, "amount");
  if (!merchantId) throw new HttpsError("invalid-argument", "merchantId is required.");

  const orderId = `SP-${externalOrderId}`;
  const orderRef = db.collection("merchantOrders").doc(orderId);
  const payerRef = db.collection("wallets").doc(payer.uid);
  const merchantRef = db.collection("merchants").doc(merchantId);
  const configRef = db.collection("systemConfig").doc("main");

  return db.runTransaction(async (tx) => {
    const [orderSnapshot, payerSnapshot, merchantSnapshot, configSnapshot] = await Promise.all([
      tx.get(orderRef),
      tx.get(payerRef),
      tx.get(merchantRef),
      tx.get(configRef)
    ]);

    if (orderSnapshot.exists) {
      const existing = orderSnapshot.data();
      if (existing.customerId !== payer.uid || existing.merchantId !== merchantId || Number(existing.amount) !== amount) {
        throw new HttpsError("already-exists", "externalOrderId is already used by another payment.");
      }
      return {
        id: orderSnapshot.id,
        status: existing.status,
        paymentReference: existing.paymentReference,
        duplicate: true
      };
    }
    if (!payerSnapshot.exists) throw new HttpsError("not-found", "Wallet not found.");
    if (!merchantSnapshot.exists) throw new HttpsError("not-found", "Merchant not found.");

    const wallet = payerSnapshot.data();
    const merchant = merchantSnapshot.data();
    const config = configSnapshot.exists ? configSnapshot.data() : {};
    if (wallet.status === "frozen") throw new HttpsError("failed-precondition", "Wallet is frozen.");
    if (merchant.status !== "approved") throw new HttpsError("failed-precondition", "Merchant is not approved.");
    if (Number(wallet.balance || 0) < amount) throw new HttpsError("failed-precondition", "Insufficient balance.");

    const currentDaily = wallet.dailyUsage && wallet.dailyUsage.date === todayKey()
      ? Number(wallet.dailyUsage.amount || 0)
      : 0;
    const dailyLimit = Number(config.dailyTransactionLimit || 0);
    if (dailyLimit > 0 && currentDaily + amount > dailyLimit) {
      throw new HttpsError("resource-exhausted", "Daily transaction limit exceeded.");
    }

    const createdAt = new Date().toISOString();
    const paymentReference = orderId;
    const order = {
      id: orderId,
      externalOrderId,
      idempotencyKey: externalOrderId,
      clientRequestId: clientRequestId || externalOrderId,
      sourceSystem: text(data && data.sourceSystem) || "simplepay",
      posOrderId: text(data && data.posOrderId),
      branchId: text(data && data.branchId),
      customerId: payer.uid,
      customer: payer.email,
      merchantId,
      merchantName: merchant.businessName || merchantName || merchantId,
      amount,
      originalAmount: amount,
      discount: 0,
      status: "approved",
      paymentReference,
      createdAt,
      updatedAt: createdAt
    };

    const payerEntry = transactionItem(
      `wallet-${orderId}`,
      "商家付款",
      order.merchantName,
      `- ${amount} 积分`,
      createdAt
    );
    const merchantEntry = transactionItem(
      `merchant-${orderId}`,
      "QR收款",
      payer.email,
      `+ ${amount} 积分`,
      createdAt
    );

    const walletChange = await applyWalletAndAffiliatePointChange(tx, {
      uid: payer.uid,
      delta: -amount,
      source: "merchant-payment",
      idempotencyKey: `merchant-payment:${orderId}`,
      description: `商家付款 ${orderId}`,
      metadata: { orderId, merchantId },
      walletEntry: payerEntry,
      ledgerEntry: ledgerRecord({
        id: `merchant-payment:${orderId}`,
        account: payer.email,
        accountId: payer.uid,
        accountRole: "user",
        counterparty: order.merchantName,
        type: "商家付款",
        amount,
        amountText: `- ${amount} 积分`,
        source: "安全云函数",
        sourceType: "payment",
        detail: `Order: ${orderId} / External: ${externalOrderId}`,
        createdAt,
        orderId,
        merchantOrderId: orderId,
        paymentReference,
        externalOrderId,
        intentId: text(data && data.intentId),
        posOrderId: text(data && data.posOrderId),
      }),
    });
    if (walletChange.duplicate) {
      return {
        id: orderId,
        status: "approved",
        paymentReference: orderId,
        duplicate: true,
        walletBalance: walletChange.walletBalanceAfter,
      };
    }
    tx.set(payerRef, {
      dailyUsage: nextDailyUsage(wallet.dailyUsage, amount),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    tx.create(orderRef, {
      ...order,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(merchantRef, {
      totalReceived: Number(merchant.totalReceived || 0) + amount,
      settlementBalance: Number(merchant.settlementBalance || 0) + amount,
      orders: [order, ...(merchant.orders || []).filter((item) => item.id !== orderId)].slice(0, MAX_EMBEDDED_RECORDS),
      transactions: [merchantEntry, ...(merchant.transactions || [])].slice(0, 30),
      notifications: [{
        text: `订单 ${orderId} 支付成功`,
        time: "刚刚",
        createdAt
      }, ...(merchant.notifications || [])].slice(0, 20),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    tx.create(db.collection("transactions").doc(`payment-merchant-${orderId}`), ledgerRecord({
      id: `payment-merchant-${orderId}`,
      account: order.merchantName,
      accountId: merchantId,
      accountRole: "merchant",
      counterparty: payer.email,
      type: "QR收款",
      amount,
      amountText: `+ ${amount} 积分`,
      source: "安全云函数",
      sourceType: "payment",
      detail: `Order: ${orderId} / External: ${externalOrderId}`,
      createdAt
    }));

    return { id: orderId, status: "approved", paymentReference, duplicate: false };
  });
}

exports.createMerchantPayment = onCall(async (request) => {
  return createMerchantPaymentData(request.data || {}, requireUser(request));
});

exports.getPosPaymentIntent = onCall(async (request) => {
  requireUser(request);
  const intentId = safeExternalId(request.data && request.data.intentId);
  const snapshot = await db.collection("paymentIntents").doc(intentId).get();
  if (!snapshot.exists) throw new HttpsError("not-found", "POS payment intent not found.");
  const intent = snapshot.data();
  return {
    id: snapshot.id,
    posOrderId: text(intent.posOrderId),
    branchName: text(intent.branchName),
    merchantId: text(intent.merchantId),
    amountMyr: Number(intent.amountMyr || 0),
    amountPoints: Number(intent.amountPoints || 0),
    status: text(intent.status)
  };
});

exports.authorizePosPaymentIntent = onCall(async (request) => {
  const payer = requireUser(request);
  const intentId = safeExternalId(request.data && request.data.intentId);
  const intentRef = db.collection("paymentIntents").doc(intentId);
  const snapshot = await intentRef.get();
  if (!snapshot.exists) throw new HttpsError("not-found", "POS payment intent not found.");
  const intent = snapshot.data();
  if (intent.status === "completed") {
    return {
      id: text(intent.paymentReference),
      status: "approved",
      paymentReference: text(intent.paymentReference),
      duplicate: true
    };
  }
  if (intent.status !== "awaiting-customer-authorization") {
    throw new HttpsError("failed-precondition", `Payment intent status is ${intent.status}.`);
  }
  const posJobSnapshot = await posDb.collection("integrationJobs").doc(intentId).get();
  if (!posJobSnapshot.exists || posJobSnapshot.data().status === "canceled") {
    await intentRef.set({
      status: "canceled",
      canceledAt: new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    throw new HttpsError("failed-precondition", "This POS order was canceled and can no longer be paid.");
  }
  if (posJobSnapshot.data().status !== "awaiting-customer-authorization") {
    throw new HttpsError(
      "failed-precondition",
      `POS integration status is ${posJobSnapshot.data().status}.`
    );
  }
  const posJob = posJobSnapshot.data();
  if (
    text(posJob.operation) !== "simplepay.payment"
    || text(posJob.posOrderId) !== text(intent.posOrderId)
    || text(posJob.branchId) !== text(intent.branchId)
    || Number(posJob.amount && posJob.amount.value) !== Number(intent.amountMyr || 0)
  ) {
    throw new HttpsError("failed-precondition", "POS payment intent no longer matches its integration job.");
  }

  const result = await createMerchantPaymentData({
    merchantId: intent.merchantId,
    merchantName: intent.branchName,
    externalOrderId: intentId,
    amount: intent.amountPoints,
    sourceSystem: "simple-pos",
    posOrderId: intent.posOrderId,
    branchId: intent.branchId
  }, payer);
  await intentRef.set({
    status: "completed",
    customerId: payer.uid,
    customerEmail: payer.email,
    paymentReference: result.paymentReference,
    completedAt: new Date().toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await posDb.collection("integrationJobs").doc(intentId).set({
    status: "completed",
    targetReference: `merchantOrders/${result.id}`,
    result: {
      paymentReference: result.paymentReference,
      merchantId: text(intent.merchantId),
      amountPoints: Number(intent.amountPoints || 0)
    },
    cloudUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  await posDb.collection("sales").doc(text(intent.posOrderId)).update({
    status: "completed",
    "externalReferences.simplePayReference": result.paymentReference,
    "externalReferences.simplePayStatus": "linked",
    "payment.reference": result.paymentReference,
    paid: Number(intent.amountMyr || 0),
    change: 0,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return result;
});

async function submitMerchantRefundData(data, merchantUser) {
  const orderId = text(data && data.orderId);
  if (!orderId) throw new HttpsError("invalid-argument", "orderId is required.");

  const orderRef = db.collection("merchantOrders").doc(orderId);
  const requestId = `RF-${orderId}`;
  const refundRef = db.collection("refundRequests").doc(requestId);
  const merchantRef = db.collection("merchants").doc(merchantUser.uid);
  const configRef = db.collection("systemConfig").doc("main");

  return db.runTransaction(async (tx) => {
    const [orderSnapshot, refundSnapshot, merchantSnapshot, configSnapshot] = await Promise.all([
      tx.get(orderRef),
      tx.get(refundRef),
      tx.get(merchantRef),
      tx.get(configRef)
    ]);
    if (!orderSnapshot.exists) throw new HttpsError("not-found", "Order not found.");
    const order = orderSnapshot.data();
    if (order.merchantId !== merchantUser.uid) throw new HttpsError("permission-denied", "Order belongs to another merchant.");
    if (refundSnapshot.exists) {
      const existing = refundSnapshot.data();
      return { id: requestId, status: existing.status, duplicate: true };
    }
    if (order.status !== "approved") throw new HttpsError("failed-precondition", "Order cannot be refunded.");
    if (!merchantSnapshot.exists) throw new HttpsError("not-found", "Merchant not found.");

    const merchant = merchantSnapshot.data();
    const pointsPerMyr = Number(configSnapshot.exists ? configSnapshot.data().pointsPerMyr : 100) || 100;
    const createdAt = new Date().toISOString();
    const refund = {
      id: requestId,
      orderId,
      externalOrderId: order.externalOrderId || "",
      merchantId: order.merchantId,
      merchantName: order.merchantName || merchant.businessName || "",
      merchantEmail: merchantUser.email,
      customerId: order.customerId,
      customerEmail: order.customer || "",
      amount: Number(order.amount || 0),
      myrAmount: Number(order.amount || 0) / pointsPerMyr,
      status: "pending",
      createdAt,
      updatedAt: createdAt
    };

    tx.create(refundRef, {
      ...refund,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.update(orderRef, {
      status: "refund_pending",
      refundRequestId: requestId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(merchantRef, {
      orders: (merchant.orders || []).map((item) =>
        item.id === orderId ? { ...item, status: "refund_pending", refundRequestId: requestId } : item
      ),
      refunds: [refund, ...(merchant.refunds || []).filter((item) => item.id !== requestId)].slice(0, 30),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { id: requestId, status: "pending", duplicate: false };
  });
}

exports.submitMerchantRefund = onCall(async (request) => {
  return submitMerchantRefundData(request.data || {}, requireUser(request));
});

exports.acceptPosRefundIntent = onCall(async (request) => {
  const merchantUser = requireUser(request);
  const intentId = safeExternalId(request.data && request.data.intentId);
  const intentRef = db.collection("merchantRefundIntents").doc(intentId);
  const snapshot = await intentRef.get();
  if (!snapshot.exists) throw new HttpsError("not-found", "POS refund intent not found.");
  const intent = snapshot.data();
  if (intent.merchantId !== merchantUser.uid) {
    throw new HttpsError("permission-denied", "Refund intent belongs to another merchant.");
  }
  if (intent.status === "submitted") {
    return { id: text(intent.refundRequestId), status: "pending", duplicate: true };
  }
  if (intent.status !== "awaiting-merchant-approval") {
    throw new HttpsError("failed-precondition", `Refund intent status is ${intent.status}.`);
  }
  const result = await submitMerchantRefundData({ orderId: intent.orderId }, merchantUser);
  await Promise.all([
    intentRef.set({
      status: "submitted",
      refundRequestId: result.id,
      submittedBy: merchantUser.email,
      submittedAt: new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true }),
    db.collection("refundRequests").doc(result.id).set({
      posJobId: text(intent.posJobId),
      posOrderId: text(intent.posOrderId),
      sourceSystem: "simple-pos",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true })
  ]);
  return result;
});

exports.syncPosRefundResult = onDocumentWritten("refundRequests/{requestId}", async (event) => {
  const before = event.data && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after.exists ? event.data.after.data() : null;
  if (!after || !text(after.posJobId) || (before && before.status === after.status)) return;
  const posJobRef = posDb.collection("integrationJobs").doc(after.posJobId);
  const posSaleRef = text(after.posOrderId)
    ? posDb.collection("sales").doc(text(after.posOrderId))
    : null;
  if (after.status === "approved") {
    await posDb.runTransaction(async (tx) => {
      tx.set(posJobRef, {
        status: "completed",
        targetReference: `refundRequests/${event.params.requestId}`,
        result: { refundReference: event.params.requestId },
        cloudUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (posSaleRef) {
        tx.set(posSaleRef, {
          "externalReferences.simplePayStatus": "refunded",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    });
  } else if (after.status === "rejected") {
    await posDb.runTransaction(async (tx) => {
      tx.set(posJobRef, {
        status: "needs-attention",
        lastError: {
          code: "refund-rejected",
          message: "SimplePay refund request was rejected.",
          at: new Date().toISOString()
        },
        cloudUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      if (posSaleRef) {
        tx.set(posSaleRef, {
          "externalReferences.simplePayStatus": "refund-failed",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    });
  }
});

exports.reviewMerchantRefund = onCall(async (request) => {
  const reviewer = await requireAdmin(request);
  const requestId = text(request.data && request.data.requestId);
  const approved = Boolean(request.data && request.data.approved);
  const reviewNote = text(request.data && request.data.reviewNote).slice(0, 500);
  if (!requestId) throw new HttpsError("invalid-argument", "requestId is required.");

  const refundRef = db.collection("refundRequests").doc(requestId);
  return db.runTransaction(async (tx) => {
    const refundSnapshot = await tx.get(refundRef);
    if (!refundSnapshot.exists) throw new HttpsError("not-found", "Refund request not found.");
    const refund = refundSnapshot.data();
    if (refund.status !== "pending") {
      return { id: requestId, status: refund.status, duplicate: true };
    }

    const orderRef = db.collection("merchantOrders").doc(refund.orderId);
    const merchantRef = db.collection("merchants").doc(refund.merchantId);
    const walletRef = db.collection("wallets").doc(refund.customerId);
    const [orderSnapshot, merchantSnapshot, walletSnapshot] = await Promise.all([
      tx.get(orderRef),
      tx.get(merchantRef),
      tx.get(walletRef)
    ]);
    if (!orderSnapshot.exists || !merchantSnapshot.exists || !walletSnapshot.exists) {
      throw new HttpsError("not-found", "Refund account data is incomplete.");
    }

    const order = orderSnapshot.data();
    const merchant = merchantSnapshot.data();
    const wallet = walletSnapshot.data();
    const amount = positiveInteger(refund.amount, "refund amount");
    const myrAmount = Number(refund.myrAmount || 0);
    const status = approved ? "approved" : "rejected";
    const orderStatus = approved ? "refunded" : "approved";
    const reviewedAt = new Date().toISOString();
    if (approved && Number(merchant.settlementBalance || 0) < amount) {
      throw new HttpsError(
        "failed-precondition",
        "Merchant settlement balance is insufficient for this refund."
      );
    }
    const walletEntry = transactionItem(
      `refund-${requestId}`,
      "商家退款",
      refund.merchantName || refund.merchantId,
      `+ ${amount} 积分`,
      reviewedAt
    );
    const refundLedger = ledgerRecord({
      id: `refund-${requestId}`,
      account: refund.customerEmail || refund.customerId,
      accountId: refund.customerId,
      accountRole: "user",
      counterparty: refund.merchantName || refund.merchantId,
      type: approved ? "退款审批通过" : "退款审批拒绝",
      amount,
      amountText: approved ? `+ ${amount} 积分` : `${amount} 积分`,
      source: "安全云函数",
      sourceType: "refund",
      status: approved ? "已通过" : "已拒绝",
      statusClass: approved ? "success" : "danger",
      detail: `Order: ${order.id}`,
      createdAt: reviewedAt,
      orderId: order.id,
      merchantOrderId: order.id,
      refundRequestId: requestId,
    });
    if (approved) {
      const walletChange = await applyWalletAndAffiliatePointChange(tx, {
        uid: refund.customerId,
        delta: amount,
        source: "merchant-refund",
        idempotencyKey: `merchant-refund:${requestId}`,
        description: `商家退款 ${refund.orderId}`,
        metadata: { orderId: refund.orderId, merchantId: refund.merchantId },
        walletEntry,
        ledgerEntry: refundLedger,
      });
      if (walletChange.duplicate) {
        return { id: requestId, status: "approved", duplicate: true };
      }
    }

    tx.update(refundRef, {
      status,
      reviewedBy: reviewer.email,
      reviewedAt,
      reviewNote,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.update(orderRef, {
      status: orderStatus,
      refundedAt: approved ? reviewedAt : "",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(merchantRef, {
      orders: (merchant.orders || []).map((item) =>
        item.id === refund.orderId ? { ...item, status: orderStatus } : item
      ),
      refunds: (merchant.refunds || []).map((item) =>
        item.id === requestId ? { ...item, status } : item
      ),
      refundTotal: approved ? Number(merchant.refundTotal || 0) + amount : Number(merchant.refundTotal || 0),
      settlementBalance: approved
        ? Number(merchant.settlementBalance || 0) - amount
        : Number(merchant.settlementBalance || 0),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    if (!approved) tx.create(db.collection("transactions").doc(`refund-${requestId}`), refundLedger);
    const auditRef = db.collection("payAuditLogs").doc();
    tx.create(auditRef, {
      id: auditRef.id,
      actor: reviewer.email,
      adminEmail: reviewer.email,
      action: "reviewMerchantRefund",
      requestId,
      orderId: refund.orderId,
      merchantId: refund.merchantId,
      customerId: refund.customerId,
      approved,
      amount,
      myrAmount,
      reviewNote,
      result: status,
      createdAt: reviewedAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { id: requestId, status, duplicate: false };
  });
});

const RECONCILIATION_SCAN_LIMIT = 25;
const RECONCILIATION_EXECUTION_LIMIT = 20;

function reconciliationId(value, field) {
  const id = text(value);
  if (!id || id.length > 240 || id.includes("/")) {
    throw new HttpsError("invalid-argument", `${field} is invalid.`);
  }
  return id;
}

function scanItemId(scanId, userId) {
  return `${scanId}__${userId}`;
}

function activeReconciliationBatchId(adminEmail) {
  return Buffer.from(text(adminEmail), "utf8").toString("base64url");
}

function scanStatusBucket(item) {
  const status = text(item && item.status);
  if (status === "proposed") return "proposedAutoCount";
  if (status === "manual-review") return "manualReviewCount";
  if (status === "applied") return "appliedCount";
  if (status === "stale") return "staleCount";
  if (status === "already-reconciled" || status === "already-consistent") return "alreadyReconciledCount";
  if (status === "failed") return "failedCount";
  if (text(item && item.classification) === "consistent" || text(item && item.classification) === "already-reconciled") return "consistentCount";
  return "skippedCount";
}

function updatedScanStatusCounts(scan, oldItem, nextItem) {
  const counts = { ...(scan?.statusCounts || {}) };
  const oldKey = oldItem ? scanStatusBucket(oldItem) : "";
  const nextKey = scanStatusBucket(nextItem);
  if (oldKey) counts[oldKey] = Math.max(0, Number(counts[oldKey] || 0) - 1);
  counts[nextKey] = Number(counts[nextKey] || 0) + 1;
  return counts;
}

function updatedScanStatusDifferenceTotals(scan, oldItem, nextItem) {
  const totals = { ...(scan?.statusDifferenceTotals || {}) };
  const oldKey = oldItem ? scanStatusBucket(oldItem) : "";
  const nextKey = scanStatusBucket(nextItem);
  const oldDifference = Number(oldItem?.difference || 0);
  const nextDifference = Number(nextItem?.difference || 0);
  if (oldKey) totals[oldKey] = Number(totals[oldKey] || 0) - oldDifference;
  totals[nextKey] = Number(totals[nextKey] || 0) + nextDifference;
  return totals;
}

function isReleasedReward(reward) {
  return Number(reward.releasedAmount || 0) > 0
    || ["confirmed", "releasing"].includes(text(reward.status))
    || (Array.isArray(reward.releasePlan) && reward.releasePlan.some((part) => part && (part.released || part.releasedAt)));
}

async function resolveAffiliateCandidatesForWallet(userId, wallet) {
  const email = normalizeEmail(wallet.email || wallet.ownerEmail);
  const queries = [
    db.collection("amsystemUsers").doc(userId).get(),
    db.collection("amsystemUsers").where("firebaseUid", "==", userId).limit(3).get(),
    db.collection("amsystemUsers").where("ownerUid", "==", userId).limit(3).get(),
    db.collection("amsystemOrders").where("walletUserId", "==", userId).limit(6).get(),
  ];
  if (email) {
    queries.push(db.collection("amsystemUsers").where("account", "==", email).limit(3).get());
    queries.push(db.collection("amsystemUsers").where("email", "==", email).limit(3).get());
  }
  const results = await Promise.all(queries);
  const candidates = new Map();
  const direct = results[0];
  if (direct.exists) candidates.set(direct.id, { id: direct.id, ref: direct.ref, ...direct.data(), matchedBy: ["document-id"] });
  results.slice(1).forEach((snapshot, index) => {
    if (!snapshot || !snapshot.docs) return;
    snapshot.docs.forEach((doc) => {
      if (doc.ref.parent.id !== "amsystemUsers") return;
      const existing = candidates.get(doc.id);
      const match = index === 0 ? "firebaseUid" : index === 1 ? "ownerUid" : index === 3 ? "account" : "email";
      candidates.set(doc.id, {
        id: doc.id,
        ref: doc.ref,
        ...doc.data(),
        matchedBy: [...(existing?.matchedBy || []), match],
      });
    });
  });
  const legacyOrderSnapshot = results[3];
  const legacyUserIds = [...new Set(legacyOrderSnapshot.docs.map((doc) => text(doc.data().userId)).filter(Boolean))];
  const legacyUsers = await Promise.all(legacyUserIds.slice(0, 3).map((id) => db.collection("amsystemUsers").doc(id).get()));
  legacyUsers.forEach((doc) => {
    if (!doc.exists) return;
    const existing = candidates.get(doc.id);
    candidates.set(doc.id, { id: doc.id, ref: doc.ref, ...doc.data(), matchedBy: [...(existing?.matchedBy || []), "legacy-order-walletUserId"] });
  });
  return [...candidates.values()];
}

function conciseDocument(doc) {
  return doc && doc.exists ? { id: doc.id, ...doc.data() } : null;
}

const RECONCILIATION_REJECTED_LEDGER_STATUSES = new Set([
  "pending", "submitted", "processing", "reviewing", "failed", "rejected",
  "cancelled", "canceled", "reversed", "reversal-review",
]);
const RECONCILIATION_SUCCESS_LEDGER_STATUSES = new Set([
  "approved", "completed", "paid", "succeeded", "successful", "refunded", "成功", "已通过",
]);

function hasExplicitSuccessfulLedgerStatus(record) {
  const status = text(record && record.status).trim().toLowerCase();
  const statusClass = text(record && record.statusClass).trim().toLowerCase();
  if (!status && !statusClass) return false;
  if (RECONCILIATION_REJECTED_LEDGER_STATUSES.has(status)) return false;
  return statusClass === "success" || RECONCILIATION_SUCCESS_LEDGER_STATUSES.has(status);
}

function isSuccessfulPaymentRecord(record) {
  return record && Number.isSafeInteger(Number(record.amount || 0))
    && text(record.sourceType) === "payment"
    && text(record.accountId)
    && hasExplicitSuccessfulLedgerStatus(record);
}

function isSuccessfulRefundRecord(record) {
  return record && Number.isSafeInteger(Number(record.amount || 0))
    && text(record.sourceType) === "refund"
    && hasExplicitSuccessfulLedgerStatus(record);
}

function referenceDecision(record, rules, detailOrderId) {
  let seen = false;
  let conflict = false;
  for (const [field, allowed] of Object.entries(rules)) {
    const value = text(record && record[field]);
    if (!value) continue;
    seen = true;
    if (!allowed.has(value)) conflict = true;
  }
  const detail = text(record && record.detail);
  const orderMatch = /^Order:\s*([^\s/]+)(?:\s*\/\s*External:\s*[^\s]+)?\s*$/i.exec(detail);
  if (orderMatch) {
    seen = true;
    if (orderMatch[1] !== detailOrderId) conflict = true;
  }
  return conflict ? "conflict" : seen ? "matched" : "missing";
}

function paymentLedgerReferenceDecision(record, order) {
  const orderId = text(order && order.id);
  return referenceDecision(record, {
    orderId: new Set([orderId]),
    merchantOrderId: new Set([orderId]),
    referenceId: new Set([orderId, text(order && order.paymentReference), text(order && order.externalOrderId), text(order && order.intentId), text(order && order.posOrderId)].filter(Boolean)),
    paymentReference: new Set([text(order && order.paymentReference)].filter(Boolean)),
    externalOrderId: new Set([text(order && order.externalOrderId)].filter(Boolean)),
    intentId: new Set([text(order && order.intentId), text(order && order.externalOrderId)].filter(Boolean)),
    posOrderId: new Set([text(order && order.posOrderId)].filter(Boolean)),
  }, orderId);
}

function refundLedgerReferenceDecision(record, refund, order) {
  const refundId = text(refund && refund.id);
  const orderId = text(order && order.id);
  return referenceDecision(record, {
    refundRequestId: new Set([refundId]),
    orderId: new Set([orderId]),
    merchantOrderId: new Set([orderId]),
    referenceId: new Set([refundId, orderId].filter(Boolean)),
  }, orderId);
}

function refundHistoryRiskReasons(refunds, limitReached) {
  const values = Array.isArray(refunds) ? refunds : [];
  const unresolved = values.filter((item) => ["pending", "submitted", "processing", "reviewing", "reversal-review"].includes(text(item.status).toLowerCase()));
  const successful = values.filter((item) => ["approved", "completed", "refunded"].includes(text(item.status).toLowerCase()));
  const orderCounts = values.reduce((counts, item) => {
    const orderId = text(item.orderId);
    if (orderId) counts.set(orderId, Number(counts.get(orderId) || 0) + 1);
    return counts;
  }, new Map());
  return [
    ...(limitReached ? ["refund-candidate-limit-reached"] : []),
    ...(successful.length > 1 ? ["multiple-successful-refunds"] : []),
    ...(unresolved.length ? ["unresolved-refund-request"] : []),
    ...([...orderCounts.values()].some((count) => count > 1) ? ["conflicting-refund-history"] : []),
  ];
}

// Test-only surface: never exported in deployed callable modules.
if (process.env.RECONCILIATION_EVIDENCE_TEST === "1") {
  module.exports.__reconciliationEvidenceTestApi = {
    isSuccessfulPaymentRecord,
    isSuccessfulRefundRecord,
    paymentLedgerReferenceDecision,
    refundLedgerReferenceDecision,
    refundHistoryRiskReasons,
  };
}

async function collectReconciliationEvidence(userId, affiliateUserId, wallet, affiliate, difference) {
  const [merchantOrdersSnapshot, refundsSnapshot, affiliateRefundsSnapshot, reversalCasesSnapshot, rewardsSnapshot] = await Promise.all([
    db.collection("merchantOrders").where("customerId", "==", userId).limit(7).get(),
    db.collection("refundRequests").where("customerId", "==", userId).limit(7).get(),
    db.collection("amsystemRefundRequests").where("userId", "==", affiliateUserId).limit(7).get(),
    db.collection("amsystemReversalCases").where("userId", "==", affiliateUserId).limit(7).get(),
    db.collection("amsystemRewards").where("userId", "==", affiliateUserId).limit(7).get(),
  ]);
  const documents = (snapshot) => snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const merchantOrders = documents(merchantOrdersSnapshot);
  const refunds = documents(refundsSnapshot);
  const amount = Math.abs(Number(difference || 0));
  const paymentCandidates = merchantOrders.filter((item) => Number(item.amount || 0) === amount);
  const refundCandidates = refunds.filter((item) => Number(item.amount || 0) === amount);
  const directIds = new Set();
  paymentCandidates.forEach((order) => {
    directIds.add(`merchant-payment:${order.id}`);
    directIds.add(`payment-user-${order.id}`);
  });
  refundCandidates.forEach((refund) => {
    directIds.add(`merchant-refund:${refund.id}`);
    directIds.add(`refund-${refund.id}`);
    if (refund.orderId) directIds.add(`refund-${refund.orderId}`);
  });
  const ledgerSnapshots = await Promise.all([...directIds].slice(0, 12).map((id) => db.collection("transactions").doc(id).get()));
  const ledgerById = new Map(ledgerSnapshots.map((snapshot) => [snapshot.id, conciseDocument(snapshot)]));
  return {
    merchantOrders,
    refunds,
    affiliateRefunds: documents(affiliateRefundsSnapshot),
    reversalCases: documents(reversalCasesSnapshot),
    rewards: documents(rewardsSnapshot),
    ledgerById,
    paymentCandidates,
    refundCandidates,
    excessiveCandidates: merchantOrdersSnapshot.size >= 7 || refundsSnapshot.size >= 7 || paymentCandidates.length > 1 || refundCandidates.length > 1,
    refundCandidateLimitReached: refundsSnapshot.size >= 7,
    releasedRewardHold: Boolean(affiliate.refundReviewHold),
    walletTransactions: Array.isArray(wallet.transactions) ? wallet.transactions.slice(0, 30) : [],
  };
}

async function exactPaymentEvidence(order, userId) {
  if (!order || order.customerId !== userId || text(order.status) !== "approved") return { evidence: null, riskReason: "invalid-merchant-order" };
  const ledgerIds = [`merchant-payment:${order.id}`, `payment-user-${order.id}`];
  const ledgers = ledgerIds.map((id) => ({ id, record: null }));
  const snapshots = await Promise.all(ledgerIds.map((id) => db.collection("transactions").doc(id).get()));
  snapshots.forEach((snapshot, index) => { ledgers[index].record = conciseDocument(snapshot); });
  const matchingLedger = ledgers.filter(({ record }) => isSuccessfulPaymentRecord(record)
    && record.accountId === userId
    && Number(record.amount || 0) === Number(order.amount || 0)
    && (text(record.id) === `merchant-payment:${order.id}` || text(record.id) === `payment-user-${order.id}`));
  if (matchingLedger.length !== 1) return { evidence: null, riskReason: "missing-or-ambiguous-payment-ledger" };
  const reference = paymentLedgerReferenceDecision(matchingLedger[0].record, order);
  if (reference !== "matched") return { evidence: null, riskReason: reference === "conflict" ? "ledger-order-reference-conflict" : "missing-ledger-order-reference" };
  const evidence = { merchantOrderId: order.id, ledgerId: matchingLedger[0].id, paymentReference: text(order.paymentReference), externalOrderId: text(order.externalOrderId) };
  if (text(order.sourceSystem) !== "simple-pos") return { evidence };
  const intentId = text(order.externalOrderId || order.intentId);
  if (!intentId) return { evidence: null, riskReason: "missing-pos-reference" };
  const [intentSnapshot, jobSnapshot, saleSnapshot] = await Promise.all([
    db.collection("paymentIntents").doc(intentId).get(),
    db.collection("integrationJobs").doc(intentId).get(),
    text(order.posOrderId) ? db.collection("sales").doc(text(order.posOrderId)).get() : Promise.resolve(null),
  ]);
  const intent = conciseDocument(intentSnapshot);
  const job = conciseDocument(jobSnapshot);
  const sale = saleSnapshot ? conciseDocument(saleSnapshot) : null;
  if (!intent || !job || !sale
    || intent.customerId !== userId
    || text(intent.status) !== "completed"
    || text(intent.paymentReference) !== text(order.paymentReference)
    || text(job.status) !== "completed"
    || text(job.targetReference) !== `merchantOrders/${order.id}`
    || text(sale.status) !== "completed"
    || text(sale.externalReferences?.simplePayReference) !== text(order.paymentReference)) return { evidence: null, riskReason: "pos-reference-conflict" };
  return { evidence: { ...evidence, intentId, integrationJobId: job.id, posOrderId: sale.id } };
}

async function exactRefundEvidence(refund, userId) {
  const terminal = ["approved", "completed", "refunded"];
  if (!refund || refund.customerId !== userId || !terminal.includes(text(refund.status))) return { evidence: null, riskReason: "invalid-refund-request" };
  const orderSnapshot = await db.collection("merchantOrders").doc(text(refund.orderId)).get();
  const order = conciseDocument(orderSnapshot);
  if (!order || order.customerId !== userId || text(order.status) !== "refunded" || Number(order.amount || 0) !== Number(refund.amount || 0)) return { evidence: null, riskReason: "refund-order-conflict" };
  const ledgerIds = [`merchant-refund:${refund.id}`, `refund-${refund.id}`, `refund-${refund.orderId}`];
  const snapshots = await Promise.all(ledgerIds.map((id) => db.collection("transactions").doc(id).get()));
  const matchingLedger = snapshots.map((snapshot) => conciseDocument(snapshot)).filter((record) => isSuccessfulRefundRecord(record)
    && record.accountId === userId
    && Number(record.amount || 0) === Number(refund.amount || 0)
    && ["merchant-refund:" + refund.id, "refund-" + refund.id, "refund-" + refund.orderId].includes(text(record.id)));
  if (matchingLedger.length !== 1) return { evidence: null, riskReason: "missing-or-ambiguous-refund-ledger" };
  const reference = refundLedgerReferenceDecision(matchingLedger[0], refund, order);
  if (reference !== "matched") return { evidence: null, riskReason: reference === "conflict" ? "ledger-refund-reference-conflict" : "missing-ledger-refund-reference" };
  return { evidence: { refundRequestId: refund.id, merchantOrderId: order.id, ledgerId: matchingLedger[0].id } };
}

async function classifyReconciliationCandidate({ userId, affiliate, wallet, candidates, evidence }) {
  const walletBalance = Number(wallet.balance || 0);
  const affiliatePoints = Number(affiliate.points || 0);
  const difference = walletBalance - affiliatePoints;
  const riskReasons = [];
  if (candidates.length !== 1) riskReasons.push(candidates.length ? "multiple-affiliate-candidates" : "affiliate-user-not-found");
  if (!Number.isSafeInteger(walletBalance) || walletBalance < 0 || !Number.isSafeInteger(affiliatePoints) || affiliatePoints < 0) riskReasons.push("invalid-balance");
  if (evidence.releasedRewardHold) riskReasons.push("refund-review-hold");
  if (evidence.rewards.some(isReleasedReward)) riskReasons.push("released-reward-exists");
  if (evidence.excessiveCandidates) riskReasons.push("excessive-candidates");
  riskReasons.push(...refundHistoryRiskReasons(evidence.refunds, evidence.refundCandidateLimitReached));
  if (evidence.affiliateRefunds.some((item) => ["pending", "reversal-review"].includes(text(item.status)))
    || evidence.reversalCases.some((item) => ["review-required", "reversal-review"].includes(text(item.status)))) {
    riskReasons.push("refund-or-reversal-review");
  }
  if (difference === 0) {
    return { classification: "consistent", recommendedAction: "skip", riskReasons, evidence: { matchedBy: affiliate.matchedBy || [] } };
  }
  if (riskReasons.length) return { classification: "manual-review", recommendedAction: "manual-review", riskReasons, evidence: { matchedBy: affiliate.matchedBy || [] } };

  let evidenceFailure = "evidence-insufficient-or-ambiguous";
  if (difference < 0 && evidence.paymentCandidates.length === 1) {
    const paymentCheck = await exactPaymentEvidence(evidence.paymentCandidates[0], userId);
    if (paymentCheck.evidence) {
    return {
      classification: "auto-reconcilable-legacy-consumption",
      recommendedAction: "mirror-wallet-balance",
      riskReasons: [],
      evidence: paymentCheck.evidence,
    };
    }
    evidenceFailure = paymentCheck.riskReason || evidenceFailure;
  }
  if (difference > 0 && evidence.refundCandidates.length === 1) {
    const refundCheck = await exactRefundEvidence(evidence.refundCandidates[0], userId);
    if (refundCheck.evidence) {
    return {
      classification: "auto-reconcilable-legacy-refund",
      recommendedAction: "mirror-wallet-balance",
      riskReasons: [],
      evidence: refundCheck.evidence,
    };
    }
    evidenceFailure = refundCheck.riskReason || evidenceFailure;
  }
  return {
    classification: "manual-review",
    recommendedAction: "manual-review",
    riskReasons: [evidenceFailure],
    evidence: { merchantPaymentMatches: evidence.paymentCandidates.map((item) => item.id), refundMatches: evidence.refundCandidates.map((item) => item.id), amount: Math.abs(difference) },
  };
}

async function analyzeWalletReconciliationCandidate(userId, wallet) {
  // Most current accounts use the shared Firebase UID as the affiliate document ID.
  // Avoid every legacy lookup when that authoritative, already-consistent mirror exists.
  const directAffiliateSnapshot = await db.collection("amsystemUsers").doc(userId).get();
  if (directAffiliateSnapshot.exists) {
    const directAffiliate = { id: directAffiliateSnapshot.id, ...directAffiliateSnapshot.data(), matchedBy: ["document-id"] };
    if (Number(wallet.balance || 0) === Number(directAffiliate.points || 0)) {
      return { userId, affiliateUserId: directAffiliate.id, email: normalizeEmail(wallet.email || directAffiliate.account || directAffiliate.email), account: text(directAffiliate.account), displayName: text(wallet.displayName || directAffiliate.name), walletBalance: Number(wallet.balance || 0), affiliatePoints: Number(directAffiliate.points || 0), difference: 0, classification: "consistent", recommendedAction: "skip", riskReasons: [], evidence: { matchedBy: directAffiliate.matchedBy } };
    }
  }
  const candidates = await resolveAffiliateCandidatesForWallet(userId, wallet);
  if (candidates.length !== 1) {
    return {
      userId,
      affiliateUserId: candidates.length === 1 ? candidates[0].id : "",
      walletBalance: Number(wallet.balance || 0),
      affiliatePoints: null,
      difference: null,
      classification: "manual-review",
      recommendedAction: "manual-review",
      riskReasons: [candidates.length ? "multiple-affiliate-candidates" : "affiliate-user-not-found"],
      evidence: { candidateIds: candidates.map((item) => item.id) },
    };
  }
  const affiliate = candidates[0];
  const difference = Number(wallet.balance || 0) - Number(affiliate.points || 0);
  if (difference === 0) {
    const prior = await db.collection("walletAffiliateReconciliations").where("userId", "==", userId).limit(1).get();
    return { userId, affiliateUserId: affiliate.id, email: normalizeEmail(wallet.email || affiliate.account || affiliate.email), account: text(affiliate.account), displayName: text(wallet.displayName || affiliate.name), walletBalance: Number(wallet.balance || 0), affiliatePoints: Number(affiliate.points || 0), difference, classification: prior.empty ? "consistent" : "already-reconciled", recommendedAction: "skip", riskReasons: [], evidence: { matchedBy: affiliate.matchedBy || [] } };
  }
  const evidence = await collectReconciliationEvidence(userId, affiliate.id, wallet, affiliate, difference);
  const summary = await classifyReconciliationCandidate({ userId, affiliate, wallet, candidates, evidence });
  return {
    userId,
    affiliateUserId: affiliate.id,
    email: normalizeEmail(wallet.email || affiliate.account || affiliate.email),
    account: text(affiliate.account),
    displayName: text(wallet.displayName || affiliate.name),
    walletBalance: Number(wallet.balance || 0),
    affiliatePoints: Number(affiliate.points || 0),
    difference: Number(wallet.balance || 0) - Number(affiliate.points || 0),
    ...summary,
  };
}

exports.scanAffiliateWalletReconciliation = onCall(async (request) => {
  const reviewer = await requireAdmin(request);
  const data = request.data || {};
  const limit = Math.max(1, Math.min(Number(data.limit) || RECONCILIATION_SCAN_LIMIT, RECONCILIATION_SCAN_LIMIT));
  const scanId = text(data.scanId) || `scan-${require("crypto").randomUUID()}`;
  const cursor = text(data.cursor);
  reconciliationId(scanId, "scanId");
  const scanRef = db.collection("walletAffiliateReconciliationScans").doc(scanId);
  const scanSnapshot = await scanRef.get();
  if (scanSnapshot.exists && text(scanSnapshot.data().createdBy) !== reviewer.email) {
    throw new HttpsError("permission-denied", "scanId belongs to another administrator.");
  }
  if (scanSnapshot.exists && !["scanning"].includes(text(scanSnapshot.data().status))) {
    throw new HttpsError("failed-precondition", "This scan is already finished; create a new scanId to scan again.");
  }
  if (scanSnapshot.exists && text(scanSnapshot.data().cursor) !== cursor) {
    // A timeout after a committed page is safe to retry: return the authoritative continuation.
    return { scanId, status: text(scanSnapshot.data().status), nextCursor: text(scanSnapshot.data().cursor), completed: text(scanSnapshot.data().status) === "ready", duplicate: true };
  }
  let walletsQuery = db.collection("wallets").orderBy(admin.firestore.FieldPath.documentId());
  if (cursor) walletsQuery = walletsQuery.startAfter(cursor);
  walletsQuery = walletsQuery.limit(limit + 1);
  const walletsSnapshot = await walletsQuery.get();
  const page = walletsSnapshot.docs.slice(0, limit);
  const hasMore = walletsSnapshot.docs.length > limit;
  const items = [];
  for (const walletDoc of page) items.push(await analyzeWalletReconciliationCandidate(walletDoc.id, walletDoc.data()));
  const counts = items.reduce((total, item) => {
    total.scannedCount += 1;
    if (item.classification.startsWith("auto-reconcilable")) total.totalDifference += Number(item.difference || 0);
    if (item.classification === "consistent" || item.classification === "already-reconciled") total.consistentCount += 1;
    else if (item.classification.startsWith("auto-reconcilable")) total.autoReconcilableCount += 1;
    else total.manualReviewCount += 1;
    return total;
  }, { scannedCount: 0, consistentCount: 0, autoReconcilableCount: 0, manualReviewCount: 0, totalDifference: 0 });
  const nextCursor = hasMore && page.length ? page[page.length - 1].id : "";
  const now = new Date().toISOString();
  await db.runTransaction(async (tx) => {
    const latest = await tx.get(scanRef);
    if (latest.exists && text(latest.data().cursor) !== cursor) throw new HttpsError("aborted", "scan cursor changed; retry from latest status.");
    items.forEach((item) => {
      const itemRef = db.collection("walletAffiliateReconciliationScanItems").doc(scanItemId(scanId, item.userId));
      tx.set(itemRef, { ...item, scanId, status: item.classification.startsWith("auto-reconcilable") ? "proposed" : item.classification === "manual-review" ? "manual-review" : "skipped", scannedAt: now, schemaVersion: 1 }, { merge: true });
    });
    const previous = latest.exists ? latest.data() : {};
    const pageStatusCounts = items.reduce((totals, item) => {
      const status = item.classification.startsWith("auto-reconcilable") ? "proposed" : item.classification === "manual-review" ? "manual-review" : "skipped";
      const key = scanStatusBucket({ ...item, status });
      totals[key] = Number(totals[key] || 0) + 1;
      return totals;
    }, {});
    tx.set(scanRef, {
      scanId,
      status: hasMore ? "scanning" : "ready",
      createdBy: reviewer.email,
      createdAt: previous.createdAt || now,
      completedAt: hasMore ? "" : now,
      scannedCount: Number(previous.scannedCount || 0) + counts.scannedCount,
      consistentCount: Number(previous.consistentCount || 0) + counts.consistentCount,
      autoReconcilableCount: Number(previous.autoReconcilableCount || 0) + counts.autoReconcilableCount,
      manualReviewCount: Number(previous.manualReviewCount || 0) + counts.manualReviewCount,
      totalDifference: Number(previous.totalDifference || 0) + counts.totalDifference,
      statusCounts: Object.fromEntries(new Set([...Object.keys(previous.statusCounts || {}), ...Object.keys(pageStatusCounts)]).values().map((key) => [key, Number(previous.statusCounts?.[key] || 0) + Number(pageStatusCounts[key] || 0)])),
      statusDifferenceTotals: { ...(previous.statusDifferenceTotals || {}), proposedAutoCount: Number(previous.statusDifferenceTotals?.proposedAutoCount || 0) + counts.totalDifference },
      cursor: nextCursor,
      schemaVersion: 1,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  return { scanId, status: hasMore ? "scanning" : "ready", ...counts, nextCursor, completed: !hasMore };
});

exports.previewAffiliateWalletReconciliationBatch = onCall(async (request) => {
  await requireAdmin(request);
  const data = request.data || {};
  const scanId = reconciliationId(data.scanId, "scanId");
  const pageLimit = Math.max(1, Math.min(Number(data.limit) || 25, 25));
  const scanSnapshot = await db.collection("walletAffiliateReconciliationScans").doc(scanId).get();
  if (!scanSnapshot.exists) throw new HttpsError("not-found", "Scan not found.");
  const scan = scanSnapshot.data();
  if (!["ready", "executing", "completed", "partial"].includes(text(scan.status))) throw new HttpsError("failed-precondition", "The scan is not ready for preview.");
  const pageFor = async (cursor, predicate) => {
    const prefix = `${scanId}__`;
    let query = db.collection("walletAffiliateReconciliationScanItems").orderBy(admin.firestore.FieldPath.documentId()).endAt(`${prefix}\uf8ff`);
    query = cursor ? query.startAfter(cursor) : query.startAt(prefix);
    const snapshot = await query.limit(Math.min(pageLimit * 4 + 1, 101)).get();
    const raw = snapshot.docs;
    const selected = raw.filter((doc) => predicate(doc.data())).slice(0, pageLimit);
    const cap = Math.min(pageLimit * 4 + 1, 101);
    const last = selected.length ? selected[selected.length - 1].id : (raw.length ? raw[raw.length - 1].id : "");
    const nextCursor = selected.length === pageLimit ? selected[selected.length - 1].id : (raw.length === cap ? last : "");
    return { items: selected.map((doc) => ({ id: doc.id, ...doc.data() })), nextCursor };
  };
  const [automatic, manualReview] = await Promise.all([
    pageFor(text(data.autoCursor), (item) => String(item.classification || "").startsWith("auto-reconcilable") && item.status === "proposed"),
    pageFor(text(data.manualCursor), (item) => item.classification === "manual-review" || item.status === "manual-review"),
  ]);
  const statusCounts = scan.statusCounts || {};
  const statusDifferenceTotals = scan.statusDifferenceTotals || {};
  return {
    scanId,
    status: scan.status,
    scannedCount: Number(scan.scannedCount || 0),
    consistentCount: Number(scan.consistentCount || 0),
    proposedAutoCount: Number(statusCounts.proposedAutoCount || 0),
    totalAutoReconcilableCount: Number(statusCounts.proposedAutoCount || 0),
    totalManualReviewCount: Number(statusCounts.manualReviewCount || 0),
    autoReconcilableCount: Number(statusCounts.proposedAutoCount || 0),
    manualReviewCount: Number(statusCounts.manualReviewCount || 0),
    appliedCount: Number(statusCounts.appliedCount || 0),
    staleCount: Number(statusCounts.staleCount || 0),
    alreadyReconciledCount: Number(statusCounts.alreadyReconciledCount || 0),
    failedCount: Number(statusCounts.failedCount || 0),
    totalDifference: Number(statusDifferenceTotals.proposedAutoCount || 0),
    canExecute: text(scan.status) === "ready" && Number(statusCounts.proposedAutoCount || 0) > 0,
    automatic: automatic.items.map((item) => ({ userId: item.userId, affiliateUserId: item.affiliateUserId, difference: item.difference, classification: item.classification, evidence: item.evidence })),
    manualReview: manualReview.items.map((item) => ({ userId: item.userId, affiliateUserId: item.affiliateUserId, riskReasons: item.riskReasons, evidence: item.evidence })),
    autoNextCursor: automatic.nextCursor,
    manualNextCursor: manualReview.nextCursor,
    message: "只更新联盟积分镜像，不改变钱包余额。",
  };
});

exports.getActiveAffiliateWalletReconciliationBatch = onCall(async (request) => {
  const reviewer = await requireAdmin(request);
  const activeSnapshot = await db.collection("walletAffiliateReconciliationActiveBatches").doc(activeReconciliationBatchId(reviewer.email)).get();
  if (!activeSnapshot.exists) return { active: false };
  const active = activeSnapshot.data();
  const batchSnapshot = await db.collection("walletAffiliateReconciliationBatches").doc(text(active.batchKey)).get();
  if (!batchSnapshot.exists || ["completed"].includes(text(batchSnapshot.data().status))) return { active: false };
  return { active: true, scanId: text(active.scanId), batchKey: text(active.batchKey), cursor: text(batchSnapshot.data().cursor), status: text(active.status), reason: text(batchSnapshot.data().reason) };
});

async function updateReconciliationScanItem(item, status, patch = {}) {
  const scanItemRef = db.collection("walletAffiliateReconciliationScanItems").doc(item.id);
  const scanRef = db.collection("walletAffiliateReconciliationScans").doc(item.scanId);
  return db.runTransaction(async (tx) => {
    const [snapshot, scanSnapshot] = await Promise.all([tx.get(scanItemRef), tx.get(scanRef)]);
    if (!snapshot.exists) return;
    const nextItem = { ...snapshot.data(), status, ...patch };
    tx.set(scanItemRef, { status, ...patch, checkedAt: new Date().toISOString(), processedAt: new Date().toISOString(), revalidatedAt: new Date().toISOString(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    if (scanSnapshot.exists) tx.set(scanRef, { statusCounts: updatedScanStatusCounts(scanSnapshot.data(), snapshot.data(), nextItem), statusDifferenceTotals: updatedScanStatusDifferenceTotals(scanSnapshot.data(), snapshot.data(), nextItem), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  });
}

async function applyReconciliationScanItem({ scanId, item, batchKey, reviewer, reason }) {
  const walletRef = db.collection("wallets").doc(item.userId);
  const refreshedWallet = await walletRef.get();
  if (!refreshedWallet.exists) {
    await updateReconciliationScanItem(item, "stale", { riskReasons: ["stale-preview", "wallet-not-found"] });
    return { status: "stale", userId: item.userId, reason: "wallet-not-found" };
  }
  const analysis = await analyzeWalletReconciliationCandidate(item.userId, refreshedWallet.data());
  if (![
    "auto-reconcilable-legacy-consumption",
    "auto-reconcilable-legacy-refund",
  ].includes(analysis.classification)) {
    const status = analysis.classification === "manual-review" ? "manual-review" : "stale";
    await updateReconciliationScanItem(item, status, { classification: analysis.classification, riskReasons: analysis.riskReasons || ["classification-changed"], evidence: analysis.evidence || {} });
    return { status, userId: item.userId, reason: analysis.riskReasons?.join(",") || "classification-changed" };
  }
  if (analysis.affiliateUserId !== item.affiliateUserId
    || analysis.walletBalance !== Number(item.walletBalance)
    || analysis.affiliatePoints !== Number(item.affiliatePoints)
    || analysis.difference !== Number(item.difference)
    || analysis.classification !== item.classification) {
    await updateReconciliationScanItem(item, "stale", { riskReasons: ["stale-preview", "scan-snapshot-changed"], evidence: analysis.evidence || {} });
    return { status: "stale", userId: item.userId, reason: "scan-snapshot-changed" };
  }

  const affiliateRef = db.collection("amsystemUsers").doc(item.affiliateUserId);
  const scanItemRef = db.collection("walletAffiliateReconciliationScanItems").doc(item.id);
  const scanRef = db.collection("walletAffiliateReconciliationScans").doc(scanId);
  const reconciliationKey = `wallet-reconciliation:${item.userId}:batch:${batchKey}`;
  const reconciliationRef = db.collection("walletAffiliateReconciliations").doc(reconciliationKey);
  return db.runTransaction(async (tx) => {
    const [walletSnapshot, affiliateSnapshot, itemSnapshot, reconciliationSnapshot, scanSnapshot] = await Promise.all([
      tx.get(walletRef),
      tx.get(affiliateRef),
      tx.get(scanItemRef),
      tx.get(reconciliationRef),
      tx.get(scanRef),
    ]);
    if (reconciliationSnapshot.exists) {
      if (itemSnapshot.exists && scanSnapshot.exists) {
        const latestItem = itemSnapshot.data();
        tx.set(scanItemRef, { status: "already-reconciled", checkedAt: new Date().toISOString(), processedAt: new Date().toISOString(), batchKey, result: { status: "already-reconciled", duplicate: true }, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        tx.set(scanRef, { statusCounts: updatedScanStatusCounts(scanSnapshot.data(), latestItem, { ...latestItem, status: "already-reconciled" }), statusDifferenceTotals: updatedScanStatusDifferenceTotals(scanSnapshot.data(), latestItem, { ...latestItem, status: "already-reconciled" }), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
      return { status: "skipped", userId: item.userId, reason: "already-applied", duplicate: true };
    }
    if (!walletSnapshot.exists || !affiliateSnapshot.exists || !itemSnapshot.exists) {
      if (itemSnapshot.exists && scanSnapshot.exists) {
        const nextItem = { ...itemSnapshot.data(), status: "stale" };
        tx.set(scanItemRef, { status: "stale", riskReasons: ["stale-preview", "record-missing"], checkedAt: new Date().toISOString(), processedAt: new Date().toISOString(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        tx.set(scanRef, { statusCounts: updatedScanStatusCounts(scanSnapshot.data(), itemSnapshot.data(), nextItem), statusDifferenceTotals: updatedScanStatusDifferenceTotals(scanSnapshot.data(), itemSnapshot.data(), nextItem), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      }
      return { status: "stale", userId: item.userId, reason: "record-missing" };
    }
    const latestItem = itemSnapshot.data();
    const walletBalance = Number(walletSnapshot.data().balance || 0);
    const affiliatePointsBefore = Number(affiliateSnapshot.data().points || 0);
    if (latestItem.status !== "proposed"
      || walletBalance !== Number(item.walletBalance)
      || affiliatePointsBefore !== Number(item.affiliatePoints)) {
      tx.set(scanItemRef, { status: "stale", riskReasons: ["stale-preview", "transaction-snapshot-changed"], staleAt: new Date().toISOString(), revalidatedAt: new Date().toISOString(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      if (scanSnapshot.exists) tx.set(scanRef, { statusCounts: updatedScanStatusCounts(scanSnapshot.data(), latestItem, { ...latestItem, status: "stale" }), statusDifferenceTotals: updatedScanStatusDifferenceTotals(scanSnapshot.data(), latestItem, { ...latestItem, status: "stale" }), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { status: "stale", userId: item.userId, reason: "transaction-snapshot-changed" };
    }
    if (walletBalance === affiliatePointsBefore) {
      tx.set(scanItemRef, { status: "already-reconciled", appliedAt: new Date().toISOString(), checkedAt: new Date().toISOString(), revalidatedAt: new Date().toISOString(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      if (scanSnapshot.exists) tx.set(scanRef, { statusCounts: updatedScanStatusCounts(scanSnapshot.data(), latestItem, { ...latestItem, status: "already-reconciled" }), statusDifferenceTotals: updatedScanStatusDifferenceTotals(scanSnapshot.data(), latestItem, { ...latestItem, status: "already-reconciled" }), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { status: "skipped", userId: item.userId, reason: "already-reconciled" };
    }
    const performedAt = new Date().toISOString();
    const differenceBefore = walletBalance - affiliatePointsBefore;
    const result = { status: "reconciled", userId: item.userId, affiliateUserId: item.affiliateUserId, walletBalance, affiliatePointsBefore, affiliatePointsAfter: walletBalance, differenceBefore };
    const pointLogRef = db.collection("amsystemPointLogs").doc(`wallet-reconciliation-${reconciliationKey}`);
    const adminLogRef = db.collection("amsystemAdminLogs").doc();
    tx.update(affiliateRef, { points: walletBalance, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.create(reconciliationRef, {
      id: reconciliationRef.id,
      userId: item.userId,
      affiliateUserId: item.affiliateUserId,
      walletBalance,
      affiliatePointsBefore,
      affiliatePointsAfter: walletBalance,
      differenceBefore,
      reason,
      performedBy: reviewer.email,
      performedAt,
      idempotencyKey: reconciliationKey,
      source: "admin-verified-batch-reconciliation",
      schemaVersion: 1,
      scanId,
      result,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.create(pointLogRef, {
      id: pointLogRef.id,
      userId: item.affiliateUserId,
      affiliateUserId: item.affiliateUserId,
      change: differenceBefore,
      balance: walletBalance,
      source: "wallet-reconciliation-batch",
      reason,
      adminEmail: reviewer.email,
      idempotencyKey: reconciliationKey,
      scanId,
      createdAt: performedAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.create(adminLogRef, {
      id: adminLogRef.id,
      action: "wallet-affiliate-reconciliation-batch-item",
      targetUserId: item.userId,
      affiliateUserId: item.affiliateUserId,
      before: affiliatePointsBefore,
      after: walletBalance,
      difference: differenceBefore,
      reason,
      actor: reviewer.email,
      scanId,
      createdAt: performedAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.set(scanItemRef, { status: "applied", appliedAt: performedAt, checkedAt: performedAt, processedAt: performedAt, batchKey, migrationRecordId: reconciliationRef.id, walletBalanceSnapshot: walletBalance, affiliatePointsSnapshot: affiliatePointsBefore, result, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    if (scanSnapshot.exists) tx.set(scanRef, { statusCounts: updatedScanStatusCounts(scanSnapshot.data(), latestItem, { ...latestItem, status: "applied" }), statusDifferenceTotals: updatedScanStatusDifferenceTotals(scanSnapshot.data(), latestItem, { ...latestItem, status: "applied" }), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { status: "applied", userId: item.userId, difference: differenceBefore };
  });
}

exports.applyAffiliateWalletReconciliationBatch = onCall(async (request) => {
  const reviewer = await requireAdmin(request);
  const data = request.data || {};
  const scanId = reconciliationId(data.scanId, "scanId");
  const confirmationText = text(data.confirmationText);
  const reason = text(data.reason);
  const batchKey = reconciliationId(data.idempotencyKey, "idempotencyKey");
  const cursor = text(data.cursor);
  if (confirmationText !== "APPLY VERIFIED WALLET MIRROR BATCH") {
    throw new HttpsError("failed-precondition", "确认文字不正确。");
  }
  if (reason.length < 5) throw new HttpsError("invalid-argument", "原因至少需要 5 个字符。");
  if (!batchKey.startsWith(`wallet-reconciliation-batch:${scanId}:`)) {
    throw new HttpsError("invalid-argument", "idempotencyKey is invalid.");
  }
  const scanRef = db.collection("walletAffiliateReconciliationScans").doc(scanId);
  const batchRef = db.collection("walletAffiliateReconciliationBatches").doc(batchKey);
  const activeBatchRef = db.collection("walletAffiliateReconciliationActiveBatches").doc(activeReconciliationBatchId(reviewer.email));
  const claim = await db.runTransaction(async (tx) => {
    const [scanSnapshot, batchSnapshot, activeBatchSnapshot] = await Promise.all([tx.get(scanRef), tx.get(batchRef), tx.get(activeBatchRef)]);
    if (!scanSnapshot.exists) throw new HttpsError("not-found", "Scan not found.");
    const scan = scanSnapshot.data();
    if (batchSnapshot.exists && text(batchSnapshot.data().scanId) !== scanId) throw new HttpsError("already-exists", "idempotencyKey belongs to another scan.");
    if (text(scan.status) === "ready") {
      if (activeBatchSnapshot.exists && text(activeBatchSnapshot.data().batchKey) !== batchKey) throw new HttpsError("failed-precondition", "Finish or resume the active reconciliation batch first.");
      tx.set(scanRef, { status: "executing", activeBatchKey: batchKey, executionStartedAt: new Date().toISOString(), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.set(activeBatchRef, { scanId, batchKey, cursor: "", status: "executing", createdAt: new Date().toISOString(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { cursor: "" };
    }
    if (text(scan.status) !== "executing" || text(scan.activeBatchKey) !== batchKey) throw new HttpsError("failed-precondition", "Only the active batch may continue execution.");
    if (batchSnapshot.exists && text(batchSnapshot.data().cursor) !== cursor) return { cursor: text(batchSnapshot.data().cursor), duplicate: true };
    return { cursor };
  });
  if (claim.duplicate) return { scanId, batchKey, nextCursor: claim.cursor, completed: false, duplicate: true };
  const itemPrefix = `${scanId}__`;
  let itemsQuery = db.collection("walletAffiliateReconciliationScanItems")
    .orderBy(admin.firestore.FieldPath.documentId())
    .endAt(`${itemPrefix}\uf8ff`);
  itemsQuery = cursor ? itemsQuery.startAfter(cursor) : itemsQuery.startAt(itemPrefix);
  const itemSnapshot = await itemsQuery.limit(RECONCILIATION_EXECUTION_LIMIT + 1).get();
  const selected = itemSnapshot.docs.slice(0, RECONCILIATION_EXECUTION_LIMIT).map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((item) => ["auto-reconcilable-legacy-consumption", "auto-reconcilable-legacy-refund"].includes(item.classification) && item.status === "proposed");
  const hasMore = itemSnapshot.docs.length > RECONCILIATION_EXECUTION_LIMIT;
  const results = [];
  for (const item of selected) {
    try { results.push(await applyReconciliationScanItem({ scanId, item, batchKey, reviewer, reason })); }
    catch (error) {
      await updateReconciliationScanItem(item, "failed", { errorCode: text(error.code) || "failed" });
      results.push({ status: "failed", userId: item.userId, reason: error.message || "failed" });
    }
  }
  const nextCursor = hasMore && itemSnapshot.docs.length ? itemSnapshot.docs[Math.min(RECONCILIATION_EXECUTION_LIMIT, itemSnapshot.docs.length) - 1].id : "";
  const counts = results.reduce((total, item) => { total[item.status] = Number(total[item.status] || 0) + 1; return total; }, { applied: 0, skipped: 0, stale: 0, failed: 0, "manual-review": 0 });
  const completed = !hasMore;
  const now = new Date().toISOString();
  await db.runTransaction(async (tx) => {
    const [latestBatch, latestScan, activeBatchSnapshot] = await Promise.all([tx.get(batchRef), tx.get(scanRef), tx.get(activeBatchRef)]);
    if (latestBatch.exists && text(latestBatch.data().cursor) !== cursor) throw new HttpsError("aborted", "batch cursor changed; retry from latest status.");
    if (!latestScan.exists || text(latestScan.data().activeBatchKey) !== batchKey) throw new HttpsError("aborted", "batch is no longer active.");
    const auditRef = db.collection("amsystemAdminLogs").doc();
    tx.set(batchRef, {
      id: batchKey,
      scanId,
      status: completed ? (counts.failed || counts.stale || counts["manual-review"] ? "partial" : "completed") : "executing",
      createdBy: reviewer.email,
      createdAt: latestBatch.exists ? latestBatch.data().createdAt : now,
      completedAt: completed ? now : "",
      cursor: nextCursor,
      reason,
      totals: Object.fromEntries(Object.keys(counts).map((key) => [key, Number(latestBatch.exists ? latestBatch.data().totals?.[key] || 0 : 0) + Number(counts[key] || 0)])),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(scanRef, { status: completed ? (counts.failed || counts.stale || counts["manual-review"] ? "partial" : "completed") : "executing", executionUpdatedAt: now, executionTotals: Object.fromEntries(Object.keys(counts).map((key) => [key, Number(latestScan.data().executionTotals?.[key] || 0) + Number(counts[key] || 0)])), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    if (completed) tx.delete(activeBatchRef);
    else tx.set(activeBatchRef, { scanId, batchKey, cursor: nextCursor, status: "executing", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    tx.create(auditRef, { id: auditRef.id, action: "wallet-affiliate-reconciliation-batch", scanId, batchKey, reason, actor: reviewer.email, counts, nextCursor, completed, createdAt: now, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  return { scanId, batchKey, ...counts, manualReview: counts["manual-review"], nextCursor, completed };
});

exports.previewAffiliateWalletReconciliation = onCall(async (request) => {
  await requireAdmin(request);
  const userId = text(request.data && request.data.userId);
  if (!userId) throw new HttpsError("invalid-argument", "userId is required.");
  const walletRef = db.collection("wallets").doc(userId);
  const affiliateRef = db.collection("amsystemUsers").doc(userId);
  const [walletSnapshot, affiliateSnapshot, pointLogsSnapshot, merchantOrdersSnapshot, affiliateOrdersSnapshot] = await Promise.all([
    walletRef.get(),
    affiliateRef.get(),
    db.collection("amsystemPointLogs").where("userId", "==", userId).limit(12).get(),
    db.collection("merchantOrders").where("customerId", "==", userId).limit(12).get(),
    db.collection("amsystemOrders").where("userId", "==", userId).limit(12).get(),
  ]);
  if (!walletSnapshot.exists) throw new HttpsError("not-found", "Wallet not found.");
  const wallet = walletSnapshot.data();
  const walletBalance = Number(wallet.balance || 0);
  const affiliatePoints = affiliateSnapshot.exists ? Number(affiliateSnapshot.data().points || 0) : null;
  const summarize = (snapshot, fields) => snapshot.docs.map((doc) => {
    const data = doc.data();
    return Object.fromEntries(["id", ...fields].map((field) => [field, field === "id" ? doc.id : data[field] ?? null]));
  });
  return {
    userId,
    walletBalance,
    affiliatePoints,
    difference: affiliatePoints === null ? null : walletBalance - affiliatePoints,
    recommendedMirrorValue: walletBalance,
    needsCorrection: affiliatePoints !== null && affiliatePoints !== walletBalance,
    recent: {
      walletTransactions: (Array.isArray(wallet.transactions) ? wallet.transactions : []).slice(0, 12),
      pointLogs: summarize(pointLogsSnapshot, ["change", "balance", "source", "note", "createdAt"]),
      merchantOrders: summarize(merchantOrdersSnapshot, ["amount", "status", "merchantId", "createdAt"]),
      affiliateOrders: summarize(affiliateOrdersSnapshot, ["points", "status", "amount", "createdAt"]),
    },
  };
});

exports.applyAffiliateWalletReconciliation = onCall(async (request) => {
  const reviewer = await requireAdmin(request);
  const data = request.data || {};
  const userId = text(data.userId);
  const affiliateUserId = text(data.affiliateUserId) || userId;
  const expectedWalletBalance = Number(data.expectedWalletBalance);
  const expectedAffiliatePoints = Number(data.expectedAffiliatePoints);
  const reason = text(data.reason);
  const confirmationText = text(data.confirmationText);
  const idempotencyKey = text(data.idempotencyKey);
  const requiredPrefix = `wallet-reconciliation:${userId}:`;

  if (!userId || userId.length > 160 || userId.includes("/")) {
    throw new HttpsError("invalid-argument", "userId is required.");
  }
  if (!affiliateUserId || affiliateUserId.length > 160 || affiliateUserId.includes("/")) {
    throw new HttpsError("invalid-argument", "affiliateUserId is invalid.");
  }
  if (confirmationText !== "APPLY WALLET MIRROR RECONCILIATION") {
    throw new HttpsError("failed-precondition", "确认文字不正确。");
  }
  if (reason.length < 5) throw new HttpsError("invalid-argument", "原因至少需要 5 个字符。");
  if (!idempotencyKey.startsWith(requiredPrefix) || idempotencyKey.length > 240 || idempotencyKey.includes("/")) {
    throw new HttpsError("invalid-argument", "idempotencyKey is invalid.");
  }
  if (!Number.isSafeInteger(expectedWalletBalance) || !Number.isSafeInteger(expectedAffiliatePoints)) {
    throw new HttpsError("invalid-argument", "预览余额格式无效，请重新预览。");
  }

  const walletRef = db.collection("wallets").doc(userId);
  const affiliateRef = db.collection("amsystemUsers").doc(affiliateUserId);
  const reconciliationRef = db.collection("walletAffiliateReconciliations").doc(idempotencyKey);
  return db.runTransaction(async (tx) => {
    const [walletSnapshot, affiliateSnapshot, reconciliationSnapshot] = await Promise.all([
      tx.get(walletRef),
      tx.get(affiliateRef),
      tx.get(reconciliationRef),
    ]);
    if (reconciliationSnapshot.exists) {
      return { ...(reconciliationSnapshot.data().result || {}), duplicate: true };
    }
    if (!walletSnapshot.exists) throw new HttpsError("not-found", "Wallet not found.");
    if (!affiliateSnapshot.exists) throw new HttpsError("not-found", "Affiliate user not found.");

    const walletBalance = Number(walletSnapshot.data().balance || 0);
    const affiliatePointsBefore = Number(affiliateSnapshot.data().points || 0);
    if (!Number.isSafeInteger(walletBalance) || walletBalance < 0 || !Number.isSafeInteger(affiliatePointsBefore)) {
      throw new HttpsError("failed-precondition", "当前余额数据无效，无法执行对账。");
    }
    if (walletBalance !== expectedWalletBalance || affiliatePointsBefore !== expectedAffiliatePoints) {
      throw new HttpsError("failed-precondition", "stale-preview / 数据已变化，请重新预览。");
    }
    if (walletBalance === affiliatePointsBefore) {
      return {
        status: "already-reconciled",
        userId,
        affiliateUserId,
        walletBalance,
        affiliatePointsBefore,
        affiliatePointsAfter: affiliatePointsBefore,
        differenceBefore: 0,
        duplicate: false,
      };
    }

    const performedAt = new Date().toISOString();
    const differenceBefore = walletBalance - affiliatePointsBefore;
    const result = {
      status: "reconciled",
      userId,
      affiliateUserId,
      walletBalance,
      affiliatePointsBefore,
      affiliatePointsAfter: walletBalance,
      differenceBefore,
      duplicate: false,
    };
    const pointLogRef = db.collection("amsystemPointLogs").doc(`wallet-reconciliation-${idempotencyKey}`);
    const adminLogRef = db.collection("amsystemAdminLogs").doc();

    tx.update(affiliateRef, {
      points: walletBalance,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.create(reconciliationRef, {
      id: reconciliationRef.id,
      userId,
      affiliateUserId,
      walletBalance,
      affiliatePointsBefore,
      affiliatePointsAfter: walletBalance,
      differenceBefore,
      reason,
      performedBy: reviewer.email,
      performedAt,
      idempotencyKey,
      source: "admin-controlled-reconciliation",
      schemaVersion: 1,
      result,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.create(pointLogRef, {
      id: pointLogRef.id,
      userId,
      affiliateUserId,
      change: differenceBefore,
      balance: walletBalance,
      source: "wallet-reconciliation",
      reason,
      adminEmail: reviewer.email,
      idempotencyKey,
      createdAt: performedAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.create(adminLogRef, {
      id: adminLogRef.id,
      action: "wallet-affiliate-reconciliation",
      targetUserId: userId,
      affiliateUserId,
      before: affiliatePointsBefore,
      after: walletBalance,
      difference: differenceBefore,
      reason,
      actor: reviewer.email,
      adminEmail: reviewer.email,
      createdAt: performedAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return result;
  });
});

exports.submitMerchantSettlement = onCall(async (request) => {
  const merchantUser = requireUser(request);
  const amount = positiveInteger(request.data && request.data.amount, "amount");
  const externalRequestId = safeExternalId(request.data && request.data.externalRequestId);
  const requestId = `ST-${externalRequestId}`;
  const settlementRef = db.collection("settlementRequests").doc(requestId);
  const merchantRef = db.collection("merchants").doc(merchantUser.uid);
  const configRef = db.collection("systemConfig").doc("main");

  return db.runTransaction(async (tx) => {
    const [settlementSnapshot, merchantSnapshot, configSnapshot] = await Promise.all([
      tx.get(settlementRef),
      tx.get(merchantRef),
      tx.get(configRef)
    ]);
    if (settlementSnapshot.exists) {
      const existing = settlementSnapshot.data();
      if (existing.merchantId !== merchantUser.uid || Number(existing.amount) !== amount) {
        throw new HttpsError("already-exists", "externalRequestId is already used.");
      }
      return { id: requestId, status: existing.status, duplicate: true };
    }
    if (!merchantSnapshot.exists) throw new HttpsError("not-found", "Merchant not found.");
    const merchant = merchantSnapshot.data();
    const pointsPerMyr = Number(configSnapshot.exists ? configSnapshot.data().pointsPerMyr : 100) || 100;
    if (merchant.status !== "approved") throw new HttpsError("failed-precondition", "Merchant is not approved.");
    if (!merchant.settlementBank || !merchant.settlementAccount) {
      throw new HttpsError("failed-precondition", "Settlement profile is incomplete.");
    }
    if (Number(merchant.settlementBalance || 0) < amount) {
      throw new HttpsError("failed-precondition", "Insufficient settlement balance.");
    }

    const createdAt = new Date().toISOString();
    const settlement = {
      id: requestId,
      externalRequestId,
      merchantId: merchantUser.uid,
      merchantName: merchant.businessName || merchantUser.email,
      merchantEmail: merchantUser.email,
      settlementBank: merchant.settlementBank,
      settlementAccount: merchant.settlementAccount,
      amount,
      myrAmount: amount / pointsPerMyr,
      status: "pending",
      createdAt,
      updatedAt: createdAt
    };
    tx.create(settlementRef, {
      ...settlement,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(merchantRef, {
      settlementBalance: Number(merchant.settlementBalance || 0) - amount,
      settlements: [settlement, ...(merchant.settlements || []).filter((item) => item.id !== requestId)].slice(0, 30),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return { id: requestId, status: "pending", duplicate: false };
  });
});

exports.reviewMerchantSettlement = onCall(async (request) => {
  const reviewer = await requireAdmin(request);
  const requestId = text(request.data && request.data.requestId);
  const approved = Boolean(request.data && request.data.approved);
  const payoutReference = text(request.data && request.data.payoutReference);
  const reviewNote = text(request.data && request.data.reviewNote);
  if (!requestId) throw new HttpsError("invalid-argument", "requestId is required.");
  if (approved && !payoutReference) {
    throw new HttpsError("invalid-argument", "payoutReference is required for approval.");
  }

  const settlementRef = db.collection("settlementRequests").doc(requestId);
  return db.runTransaction(async (tx) => {
    const settlementSnapshot = await tx.get(settlementRef);
    if (!settlementSnapshot.exists) throw new HttpsError("not-found", "Settlement request not found.");
    const settlement = settlementSnapshot.data();
    if (settlement.status !== "pending") {
      return { id: requestId, status: settlement.status, duplicate: true };
    }

    const merchantRef = db.collection("merchants").doc(settlement.merchantId);
    const merchantSnapshot = await tx.get(merchantRef);
    if (!merchantSnapshot.exists) throw new HttpsError("not-found", "Merchant not found.");
    const merchant = merchantSnapshot.data();
    const amount = positiveInteger(settlement.amount, "settlement amount");
    const status = approved ? "approved" : "rejected";
    const reviewedAt = new Date().toISOString();

    tx.update(settlementRef, {
      status,
      payoutReference: approved ? payoutReference : "",
      reviewNote,
      reviewedBy: reviewer.email,
      reviewedAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(merchantRef, {
      settlementBalance: approved
        ? Number(merchant.settlementBalance || 0)
        : Number(merchant.settlementBalance || 0) + amount,
      settlements: (merchant.settlements || []).map((item) =>
        item.id === requestId
          ? { ...item, status, payoutReference: approved ? payoutReference : "", reviewNote }
          : item
      ),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    tx.create(db.collection("transactions").doc(`settlement-${requestId}`), ledgerRecord({
      id: `settlement-${requestId}`,
      account: settlement.merchantName || settlement.merchantId,
      accountId: settlement.merchantId,
      accountRole: "merchant",
      counterparty: settlement.settlementAccount,
      type: approved ? "结算审批通过" : "结算审批拒绝",
      amount,
      amountText: approved ? `${amount} 积分` : `+ ${amount} 积分`,
      source: "安全云函数",
      sourceType: "settlement",
      status: approved ? "已通过" : "已拒绝",
      statusClass: approved ? "success" : "danger",
      detail: payoutReference || reviewNote,
      createdAt: reviewedAt
    }));
    return { id: requestId, status, duplicate: false };
  });
});
