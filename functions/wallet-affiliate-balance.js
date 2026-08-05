"use strict";

const admin = require("firebase-admin");
const { HttpsError } = require("firebase-functions/v2/https");

function text(value) {
  return String(value || "").trim();
}

function operationId(value) {
  const key = text(value);
  if (!key || key.length > 240 || key.includes("/")) {
    throw new HttpsError("invalid-argument", "A valid idempotencyKey is required.");
  }
  return key;
}

/**
 * Applies one authoritative wallet balance change inside the caller's existing
 * Firestore transaction.  The operation document is the only idempotency
 * source; embedded wallet history is presentation data and is never used for
 * deduplication.
 */
async function applyWalletAndAffiliatePointChange(tx, {
  uid,
  affiliateUserId = "",
  affiliateUserRef = null,
  delta,
  source,
  idempotencyKey,
  description,
  metadata = {},
  walletEntry = null,
  ledgerEntry = null,
  createWalletIfMissing = false,
  walletFields = {},
}) {
  const userId = text(uid);
  const affiliateId = text(affiliateUserId);
  const change = Number(delta);
  const key = operationId(idempotencyKey);
  if (!userId || !Number.isSafeInteger(change) || change === 0) {
    throw new HttpsError("invalid-argument", "A UID and non-zero integer delta are required.");
  }

  const db = admin.firestore();
  const walletRef = db.collection("wallets").doc(userId);
  const resolvedAffiliateRef = affiliateUserRef
    || db.collection("amsystemUsers").doc(affiliateId || userId);
  const operationRef = db.collection("walletBalanceOperations").doc(key);
  const ledgerRef = ledgerEntry ? db.collection("transactions").doc(key) : null;
  const [walletSnapshot, affiliateSnapshot, operationSnapshot] = await Promise.all([
    tx.get(walletRef),
    tx.get(resolvedAffiliateRef),
    tx.get(operationRef),
  ]);

  if (operationSnapshot.exists) {
    const operation = operationSnapshot.data();
    return {
      ...(operation.result || {}),
      duplicate: true,
      affiliateUserId: operation.affiliateUserId || affiliateId || userId,
    };
  }
  if (!walletSnapshot.exists && !createWalletIfMissing) {
    throw new HttpsError("not-found", "Wallet not found.");
  }

  const wallet = walletSnapshot.exists ? walletSnapshot.data() : {};
  const balanceBefore = Number(wallet.balance || 0);
  const balanceAfter = balanceBefore + change;
  if (!Number.isSafeInteger(balanceBefore) || balanceAfter < 0) {
    throw new HttpsError("failed-precondition", "Insufficient wallet balance.");
  }

  const createdAt = new Date().toISOString();
  const entry = walletEntry
    ? { ...walletEntry, id: walletEntry.id || key, source: key, createdAt: walletEntry.createdAt || createdAt }
    : null;
  const result = {
    walletBalanceBefore: balanceBefore,
    walletBalanceAfter: balanceAfter,
    walletBalance: balanceAfter,
    affiliateMirrorUpdated: affiliateSnapshot.exists,
    affiliateUserId: affiliateSnapshot.exists ? resolvedAffiliateRef.id : "",
    duplicate: false,
  };

  tx.set(walletRef, {
    ...(walletSnapshot.exists ? {} : { role: "user", status: "active" }),
    ...(walletSnapshot.exists ? {} : walletFields),
    balance: balanceAfter,
    ...(entry ? { transactions: [entry, ...(Array.isArray(wallet.transactions) ? wallet.transactions : [])].slice(0, 30) } : {}),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  if (affiliateSnapshot.exists) {
    const affiliate = affiliateSnapshot.data();
    tx.set(resolvedAffiliateRef, {
      points: balanceAfter,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    const pointLogRef = db.collection("amsystemPointLogs").doc(`wallet-mirror-${key}`);
    tx.create(pointLogRef, {
      id: pointLogRef.id,
      userId: resolvedAffiliateRef.id,
      change: balanceAfter - Number(affiliate.points || 0),
      balance: balanceAfter,
      source: text(source) || key,
      idempotencyKey: key,
      note: text(description) || "Wallet balance mirror synchronization",
      metadata,
      walletBalanceBefore: balanceBefore,
      walletBalanceAfter: balanceAfter,
      createdAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  if (ledgerRef) {
    tx.create(ledgerRef, {
      ...ledgerEntry,
      id: key,
      idempotencyKey: key,
      createdAt: ledgerEntry.createdAt || createdAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  tx.create(operationRef, {
    id: key,
    uid: userId,
    affiliateUserId: result.affiliateUserId,
    source: text(source) || key,
    delta: change,
    description: text(description),
    metadata,
    status: "completed",
    result,
    createdAt,
    completedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return result;
}

module.exports = { applyWalletAndAffiliatePointChange };
