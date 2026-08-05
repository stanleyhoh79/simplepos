const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

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
  createdAt
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
  const externalOrderId = safeExternalId(data && data.externalOrderId);
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

    tx.create(orderRef, {
      ...order,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    tx.set(payerRef, {
      balance: Number(wallet.balance || 0) - amount,
      dailyUsage: nextDailyUsage(wallet.dailyUsage, amount),
      transactions: [payerEntry, ...(wallet.transactions || [])].slice(0, 30),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
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
    tx.create(db.collection("transactions").doc(`payment-user-${orderId}`), ledgerRecord({
      id: `payment-user-${orderId}`,
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
      createdAt
    }));
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

    if (approved) {
      tx.set(walletRef, {
        balance: Number(wallet.balance || 0) + amount,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    tx.create(db.collection("transactions").doc(`refund-${requestId}`), ledgerRecord({
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
      createdAt: reviewedAt
    }));
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
