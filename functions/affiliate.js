const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
const { applyWalletAndAffiliatePointChange } = require("./wallet-affiliate-balance");

if (!admin.apps.length) admin.initializeApp();

const db = admin.firestore();
const posDb = db;

const ADMIN_EMAILS = [
  "stanleyhoh79@gmail.com",
];

const TEST_INSTANT_MODE = false;
const CONFIRM_DAYS = TEST_INSTANT_MODE ? 0 : 7;
const REPEAT_RELEASE_DAYS = TEST_INSTANT_MODE ? [0] : [7, 14, 30];
const PACKAGE_UNIT_AMOUNT = 180;

function text(value) {
  return String(value || "").trim();
}

function safeExternalId(value) {
  const normalized = text(value);
  if (!normalized || normalized.length > 160 || normalized.includes("/")) {
    throw new HttpsError("invalid-argument", "externalOrderId is invalid.");
  }
  return normalized;
}

function normalizeInviteCode(value) {
  return text(value).toUpperCase();
}

async function resolveReferralOwner(referralCode, buyerUserId) {
  const inviteRef = db.collection("amsystemInviteCodes").doc(referralCode);
  const inviteSnapshot = await inviteRef.get();
  if (inviteSnapshot.exists) return text(inviteSnapshot.data().userId);

  const usersSnapshot = await db.collection("amsystemUsers")
    .where("inviteCode", "==", referralCode)
    .limit(2)
    .get();
  if (usersSnapshot.size > 1) {
    throw new HttpsError("failed-precondition", "Referral code belongs to multiple users.");
  }
  if (usersSnapshot.empty) {
    const buyerSnapshot = await db.collection("amsystemUsers").doc(buyerUserId).get();
    const fixedReferrerId = text(buyerSnapshot.exists && buyerSnapshot.data().referrerId);
    if (!fixedReferrerId) {
      throw new HttpsError("not-found", "Referral code not found.");
    }
    const fixedReferrerSnapshot = await db.collection("amsystemUsers").doc(fixedReferrerId).get();
    if (!fixedReferrerSnapshot.exists) {
      throw new HttpsError("not-found", "The buyer's fixed referrer was not found.");
    }
    return fixedReferrerId;
  }

  const owner = usersSnapshot.docs[0];
  const profile = owner.data();
  await inviteRef.set({
    id: referralCode,
    code: referralCode,
    userId: owner.id,
    name: text(profile.name),
    slots: Number(profile.slots || 0),
    packageUntil: text(profile.packageUntil),
    frozen: Boolean(profile.frozen),
    repairedAt: new Date().toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return owner.id;
}

function isValidPackageAmount(amount) {
  const value = Number(amount || 0);
  return value > 0 && value % PACKAGE_UNIT_AMOUNT === 0;
}

function assertAdmin(request) {
  const email = request.auth && request.auth.token && request.auth.token.email;
  if (!email || !ADMIN_EMAILS.includes(email)) {
    throw new HttpsError("permission-denied", "Admin permission required.");
  }
  return email;
}

function requireAffiliateMember(request) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  return {
    uid: request.auth.uid,
    email: text(request.auth.token && request.auth.token.email).toLowerCase(),
  };
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next.toISOString();
}

function addHours(date, hours) {
  const next = new Date(date);
  next.setHours(next.getHours() + Number(hours || 0));
  return next.toISOString();
}

function planRepeatCooldownHours(plan) {
  if (TEST_INSTANT_MODE) return 0;
  return Number(plan.repeatCooldownHours ?? 24);
}

function money(value) {
  return `RM${Number(value || 0).toFixed(2)}`;
}

function planRepeatCredits(plan) {
  return Number(plan.repeatCredits ?? 10);
}

function planDirectRepeatRate(plan) {
  return Number(plan && plan.directRepeatRate !== undefined ? plan.directRepeatRate : 10);
}

function planPoolRepeatRate(plan) {
  return Number(plan && plan.repeatRate !== undefined ? plan.repeatRate : 10);
}

function isActivePackage(user) {
  return Boolean(user && user.packageUntil) && new Date(user.packageUntil) > new Date() && !user.frozen;
}

function orderPlan(order, plans) {
  const currentPlan = (plans || []).find((item) => item.id === order.planId);
  const snapshot = order.planSnapshot || {};
  if (!currentPlan && !Object.keys(snapshot).length) return null;
  return {
    ...(currentPlan || {}),
    ...snapshot,
    id: order.planId,
    name: snapshot.name || (currentPlan && currentPlan.name) || "Deleted plan",
  };
}

function planSnapshot(plan) {
  return {
    id: plan.id,
    name: plan.name,
    amount: Number(plan.amount || 0),
    unitAmount: PACKAGE_UNIT_AMOUNT,
    unitCount: Number(plan.amount || 0) / PACKAGE_UNIT_AMOUNT,
    points: Number(plan.points || 0),
    slots: Number(plan.slots || 0),
    repeatCredits: planRepeatCredits(plan),
    repeatCooldownHours: planRepeatCooldownHours(plan),
    validDays: Number(plan.validDays || 0),
    firstRate: Number(plan.firstRate || 0),
    directRepeatRate: planDirectRepeatRate(plan),
    repeatRate: planPoolRepeatRate(plan),
  };
}

async function resolveExternalUserId(data = {}) {
  const explicitUserId = text(data.userId);
  if (explicitUserId) return explicitUserId;
  const customerPhone = text(data.customerPhone || (data.customer && data.customer.phone));
  if (!customerPhone) {
    throw new HttpsError("invalid-argument", "userId or customerPhone is required.");
  }
  const snapshot = await db.collection("amsystemUsers")
    .where("phone", "==", customerPhone)
    .limit(2)
    .get();
  if (snapshot.empty) {
    throw new HttpsError("not-found", "No affiliate user matches this phone.");
  }
  if (snapshot.size > 1) {
    throw new HttpsError("failed-precondition", "Multiple affiliate users match this phone.");
  }
  return snapshot.docs[0].id;
}

function rewardAmount(order, rate) {
  return Number((Number(order.amount || 0) * (Number(rate || 0) / 100)).toFixed(2));
}

function createReleasePlan(totalAmount, paidAt) {
  const amount = Number(totalAmount || 0);
  let remaining = amount;
  return REPEAT_RELEASE_DAYS.map((days, index) => {
    const isLast = index === REPEAT_RELEASE_DAYS.length - 1;
    const partAmount = isLast
      ? remaining
      : Number((amount / REPEAT_RELEASE_DAYS.length).toFixed(2));
    remaining = Number((remaining - partAmount).toFixed(2));
    return {
      amount: partAmount,
      releaseAt: addDays(paidAt, days),
      released: TEST_INSTANT_MODE,
      releasedAt: TEST_INSTANT_MODE ? paidAt : "",
    };
  });
}

function createAdminLog(tx, action, target, detail, adminEmail) {
  const ref = db.collection("amsystemAdminLogs").doc();
  tx.set(ref, {
    id: ref.id,
    adminEmail,
    action,
    target,
    detail,
    createdAt: new Date().toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

const AFFILIATE_DELETE_BATCH_SIZE = 400;

async function deleteAffiliateDocumentsInBatches(documents) {
  const uniqueDocuments = [...new Map(documents.map((item) => [item.ref.path, item])).values()];
  let deleted = 0;
  for (let index = 0; index < uniqueDocuments.length; index += AFFILIATE_DELETE_BATCH_SIZE) {
    const batch = db.batch();
    uniqueDocuments.slice(index, index + AFFILIATE_DELETE_BATCH_SIZE).forEach((item) => batch.delete(item.ref));
    await batch.commit();
    deleted += Math.min(AFFILIATE_DELETE_BATCH_SIZE, uniqueDocuments.length - index);
  }
  return deleted;
}

function isAdminAffiliateUserRecord(user) {
  return [user && user.account, user && user.email]
    .some((value) => ADMIN_EMAILS.includes(text(value).toLowerCase()));
}

exports.deleteAffiliateTestUser = onCall(async (request) => {
  const adminEmail = assertAdmin(request);
  const data = request.data || {};
  const userId = safeExternalId(data.userId);
  if (text(data.confirmation) !== "DELETE AFFILIATE TEST USER") {
    throw new HttpsError("invalid-argument", "Confirmation text must exactly equal DELETE AFFILIATE TEST USER.");
  }

  const userRef = db.collection("amsystemUsers").doc(userId);
  const userSnapshot = await userRef.get();
  if (!userSnapshot.exists) throw new HttpsError("not-found", "Affiliate user not found.");
  if (isAdminAffiliateUserRecord(userSnapshot.data())) {
    throw new HttpsError("permission-denied", "Administrator accounts cannot be deleted.");
  }

  const [ordersSnapshot, rewardsByUserSnapshot, rewardsBySourceSnapshot, withdrawalsSnapshot, pointLogsSnapshot, repeatLogsSnapshot, referralsByReferrerSnapshot, referralsByInviteeSnapshot, inviteCodesSnapshot] = await Promise.all([
    db.collection("amsystemOrders").where("userId", "==", userId).get(),
    db.collection("amsystemRewards").where("userId", "==", userId).get(),
    db.collection("amsystemRewards").where("sourceUserId", "==", userId).get(),
    db.collection("amsystemWithdraws").where("userId", "==", userId).get(),
    db.collection("amsystemPointLogs").where("userId", "==", userId).get(),
    db.collection("amsystemRepeatCreditLogs").where("userId", "==", userId).get(),
    db.collection("amsystemReferrals").where("referrerId", "==", userId).get(),
    db.collection("amsystemReferrals").where("inviteeId", "==", userId).get(),
    db.collection("amsystemInviteCodes").where("userId", "==", userId).get(),
  ]);

  const deleted = {
    amsystemOrders: await deleteAffiliateDocumentsInBatches(ordersSnapshot.docs),
    amsystemRewards: await deleteAffiliateDocumentsInBatches([...rewardsByUserSnapshot.docs, ...rewardsBySourceSnapshot.docs]),
    amsystemWithdraws: await deleteAffiliateDocumentsInBatches(withdrawalsSnapshot.docs),
    amsystemPointLogs: await deleteAffiliateDocumentsInBatches(pointLogsSnapshot.docs),
    amsystemRepeatCreditLogs: await deleteAffiliateDocumentsInBatches(repeatLogsSnapshot.docs),
    amsystemReferrals: await deleteAffiliateDocumentsInBatches([...referralsByReferrerSnapshot.docs, ...referralsByInviteeSnapshot.docs]),
    amsystemInviteCodes: await deleteAffiliateDocumentsInBatches(inviteCodesSnapshot.docs),
    amsystemUsers: await deleteAffiliateDocumentsInBatches([userSnapshot]),
  };

  const auditRef = db.collection("amsystemAdminLogs").doc();
  await auditRef.set({
    id: auditRef.id,
    adminEmail,
    action: "删除测试用户",
    target: userId,
    detail: JSON.stringify({ account: text(userSnapshot.data().account), deleted, firebaseAuthDeleted: false }),
    createdAt: new Date().toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { userId, deleted };
});

function createReward(tx, payload) {
  const rewardRef = db.collection("amsystemRewards").doc();
  tx.set(rewardRef, {
    id: rewardRef.id,
    status: TEST_INSTANT_MODE ? "confirmed" : "pending",
    confirmAfter: addDays(payload.createdAt, CONFIRM_DAYS),
    reviewedAt: TEST_INSTANT_MODE ? payload.createdAt : "",
    reviewNote: TEST_INSTANT_MODE ? "测试即时模式自动确认" : "",
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...payload,
  });
}

function createRepeatCreditLog(tx, payload) {
  const logRef = db.collection("amsystemRepeatCreditLogs").doc();
  tx.set(logRef, {
    id: logRef.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...payload,
  });
}

function simplePayWalletTransaction(order, plan, points, createdAt) {
  return {
    id: `affiliate-package-${order.id}`,
    source: `affiliate-package:${order.id}`,
    time: "刚刚",
    type: "联盟配套积分",
    target: plan.name || "联盟配套",
    amount: `+ ${Number(points || 0)} 积分`,
    status: "成功",
    statusClass: "success",
    createdAt,
  };
}

function hasWalletTransaction(wallet, source) {
  return Array.isArray(wallet?.transactions)
    && wallet.transactions.some((item) => item && item.source === source);
}

async function creditSimplePayWallet(tx, { order, buyer, plan, points, createdAt }) {
  const walletUserId = text(buyer.firebaseUid) || text(order.userId);
  if (!walletUserId) {
    throw new HttpsError("failed-precondition", "Affiliate user is missing a Firebase UID.");
  }

  const entry = simplePayWalletTransaction(order, plan, points, createdAt);
  return applyWalletAndAffiliatePointChange(tx, {
    uid: walletUserId,
    affiliateUserId: order.userId,
    delta: Number(points || 0),
    source: "affiliate-package",
    idempotencyKey: `affiliate-confirm:${order.id}`,
    description: `联盟配套积分发放 ${order.id}`,
    metadata: { orderId: order.id, planId: text(plan.id) },
    walletEntry: entry,
    createWalletIfMissing: true,
    walletFields: {
      email: text(buyer.account),
      displayName: text(buyer.name) || text(buyer.account),
    },
  });
}


function simplePayRefundTransaction(order, plan, points, createdAt, refundReference) {
  return {
    id: `affiliate-refund-${order.id}`,
    source: `affiliate-refund:${order.id}`,
    time: "刚刚",
    type: "联盟配套退款",
    target: plan.name || "联盟配套",
    amount: `- ${Number(points || 0)} 积分`,
    status: "成功",
    statusClass: "success",
    detail: refundReference,
    createdAt,
  };
}

function walletIdForAffiliateOrder(order, buyer) {
  return text(buyer && buyer.firebaseUid) || text(order && order.userId);
}

async function confirmOrderById(orderId, adminEmail, reviewNote = "") {
  const safeOrderId = safeExternalId(orderId);
  const normalizedReviewNote = text(reviewNote).slice(0, 500);

  const orderRef = db.collection("amsystemOrders").doc(safeOrderId);
  const systemRef = db.collection("amsystem").doc("main");

  const result = await db.runTransaction(async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) {
      throw new HttpsError("not-found", "Order not found.");
    }

    const order = orderSnap.data();
    if (order.status === "paid") {
      return {
        alreadyPaid: true,
        orderId: safeOrderId,
        status: "paid",
        paidAt: text(order.paidAt),
      };
    }
    if (order.status !== "pending") {
      throw new HttpsError("failed-precondition", "Only pending orders can be confirmed.");
    }

    const userRef = db.collection("amsystemUsers").doc(order.userId);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) {
      throw new HttpsError("not-found", "User not found.");
    }

    const systemSnap = await tx.get(systemRef);
    const plans = systemSnap.exists && Array.isArray(systemSnap.data().plans) ? systemSnap.data().plans : [];
    const plan = orderPlan(order, plans);
    if (!plan) {
      throw new HttpsError("not-found", "Plan not found.");
    }
    const orderAmount = Number(order.amount || 0);
    const planAmount = Number(plan.amount || 0);
    const pointChange = Number(plan.points || 0);
    const validDays = Number(plan.validDays || 0);
    if (!isValidPackageAmount(orderAmount) || !isValidPackageAmount(planAmount)) {
      throw new HttpsError("failed-precondition", `Package amount must be a multiple of RM${PACKAGE_UNIT_AMOUNT}.`);
    }
    if (orderAmount !== planAmount) {
      throw new HttpsError("failed-precondition", "Order amount does not match the saved package snapshot.");
    }
    if (!Number.isFinite(pointChange) || pointChange <= 0) {
      throw new HttpsError("failed-precondition", "Package points must be greater than zero.");
    }
    if (!Number.isFinite(validDays) || validDays <= 0) {
      throw new HttpsError("failed-precondition", "Package validity days must be greater than zero.");
    }

    const buyer = userSnap.data();
    const paidOrdersSnap = await tx.get(
      db.collection("amsystemOrders")
        .where("userId", "==", order.userId)
        .where("status", "==", "paid")
    );
    const actualType = paidOrdersSnap.empty ? "first" : "repeat";
    const paidAt = new Date().toISOString();
    const currentPackageUntil = text(buyer.packageUntil);
    const packageBase = currentPackageUntil && new Date(currentPackageUntil) > new Date(paidAt)
      ? currentPackageUntil
      : paidAt;
    const packageUntil = addDays(packageBase, validDays);
    const currentRepeatCredits = Number(buyer.repeatCredits || 0);
    const nextRepeatCredits = currentRepeatCredits;
    const buyerQueueAt = buyer.repeatCreditQueueAt || "";

    let referrerSnap = null;
    if (buyer.referrerId) {
      referrerSnap = await tx.get(db.collection("amsystemUsers").doc(buyer.referrerId));
    }

    let repeatReceiver = null;
    if (actualType === "repeat") {
      const eligibleSnap = await tx.get(
        db.collection("amsystemUsers").where("repeatCredits", ">", 0)
      );
      const eligibleUsers = [];
      eligibleSnap.forEach((doc) => {
        if (doc.id === order.userId) return;
        const data = doc.data();
        if (data.frozen) return;
        eligibleUsers.push({ id: doc.id, ref: doc.ref, ...data });
      });
      eligibleUsers.sort((a, b) =>
        new Date(a.repeatCreditQueueAt || "9999-12-31") - new Date(b.repeatCreditQueueAt || "9999-12-31")
      );
      repeatReceiver = eligibleUsers[0] || null;
    }

    const walletChange = await creditSimplePayWallet(tx, {
      order,
      buyer,
      plan,
      points: pointChange,
      createdAt: paidAt,
    });

    tx.update(orderRef, {
      status: "paid",
      type: actualType,
      points: pointChange,
      paidAt,
      reviewedAt: paidAt,
      reviewedBy: adminEmail,
      reviewNote: normalizedReviewNote,
      simplePayWalletSyncedAt: !walletChange.duplicate ? paidAt : (order.simplePayWalletSyncedAt || paidAt),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.set(userRef, {
      slots: Math.max(Number(buyer.slots || 0), Number(plan.slots || 0)),
      repeatCredits: nextRepeatCredits,
      repeatCreditQueueAt: buyerQueueAt,
      repeatCooldownUntil: actualType === "repeat" ? addHours(paidAt, planRepeatCooldownHours(plan)) : (buyer.repeatCooldownUntil || ""),
      packageUntil,
      level: Number(plan.amount || 0) >= 720 ? "高级推广用户" : "推广用户",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });


    if (actualType === "first" && !buyer.refundReviewHold && referrerSnap && referrerSnap.exists) {
      const referrer = referrerSnap.data();
      const rate = Number(plan.firstRate || 0);
      if (!referrer.frozen && rate > 0) {
        createReward(tx, {
          userId: buyer.referrerId,
          sourceUserId: order.userId,
          sourceUserName: buyer.name || "",
          sourceUserAccount: buyer.account || "",
          sourceUserInviteCode: buyer.inviteCode || "",
          orderId: order.id,
          type: "first",
          rate,
          amount: rewardAmount(order, rate),
          createdAt: paidAt,
        });
      }
    }

    if (actualType === "repeat" && !buyer.refundReviewHold && repeatReceiver) {
      const rate = planPoolRepeatRate(plan);
      if (rate > 0) {
        const receiverCredits = Math.max(Number(repeatReceiver.repeatCredits || 0) - 1, 0);
        tx.set(repeatReceiver.ref, {
          repeatCredits: receiverCredits,
          repeatCreditQueueAt: receiverCredits > 0 ? (repeatReceiver.repeatCreditQueueAt || "") : "",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });

        createRepeatCreditLog(tx, {
          userId: repeatReceiver.id,
          change: -1,
          balance: receiverCredits,
          reason: "used",
          source: order.id,
          note: `Repeat pool reward from ${buyer.name || buyer.account || order.userId}`,
          createdAt: paidAt,
        });

        const repeatRewardAmount = rewardAmount(order, rate);
        createReward(tx, {
          userId: repeatReceiver.id,
          sourceUserId: order.userId,
          sourceUserName: buyer.name || "",
          sourceUserAccount: buyer.account || "",
          sourceUserInviteCode: buyer.inviteCode || "",
          orderId: order.id,
          type: "repeat",
          rewardMode: "pool",
          rate,
          amount: repeatRewardAmount,
          releasedAmount: TEST_INSTANT_MODE ? repeatRewardAmount : 0,
          releasePlan: createReleasePlan(repeatRewardAmount, paidAt),
          createdAt: paidAt,
        });
      }
    }

    if (actualType === "repeat" && !buyer.refundReviewHold && referrerSnap && referrerSnap.exists) {
      const referrer = referrerSnap.data();
      const rate = planDirectRepeatRate(plan);
      if (isActivePackage(referrer) && rate > 0) {
        const directRewardAmount = rewardAmount(order, rate);
        createReward(tx, {
          userId: buyer.referrerId,
          sourceUserId: order.userId,
          sourceUserName: buyer.name || "",
          sourceUserAccount: buyer.account || "",
          sourceUserInviteCode: buyer.inviteCode || "",
          orderId: order.id,
          type: "repeat",
          rewardMode: "direct",
          rate,
          amount: directRewardAmount,
          releasedAmount: TEST_INSTANT_MODE ? directRewardAmount : 0,
          releasePlan: createReleasePlan(directRewardAmount, paidAt),
          createdAt: paidAt,
        });
      }
    }

    const confirmationDetail = [
      `金额 ${money(orderAmount)}`,
      `积分 +${pointChange}`,
      `配套有效至 ${packageUntil}`,
      `SimplePay ${!walletChange.duplicate ? "已入账" : "已存在"}`,
      normalizedReviewNote ? `备注：${normalizedReviewNote}` : "无备注",
    ].join(" / ");
    createAdminLog(tx, "确认付款", order.id, confirmationDetail, adminEmail);

    return {
      alreadyPaid: false,
      orderId: safeOrderId,
      status: "paid",
      type: actualType,
      points: pointChange,
      packageUntil,
      walletCredited: !walletChange.duplicate,
      paidAt,
    };
  });

  return { ok: true, ...result };
}


async function refundAffiliateOrderById(orderId, adminEmail, refundReference, reason = "", review = {}) {
  const safeOrderId = safeExternalId(orderId);
  const normalizedRefundReference = text(refundReference).slice(0, 160);
  const normalizedReason = text(reason).slice(0, 500) || "会员配套退款";
  const refundRequestId = text(review.refundRequestId);
  const reviewNote = text(review.reviewNote).slice(0, 500);
  if (!normalizedRefundReference) {
    throw new HttpsError("invalid-argument", "refundReference is required.");
  }

  const orderRef = db.collection("amsystemOrders").doc(safeOrderId);
  const caseRef = db.collection("amsystemReversalCases").doc(`REF-${safeOrderId}`);
  const refundRequestRef = refundRequestId
    ? db.collection("amsystemRefundRequests").doc(safeExternalId(refundRequestId))
    : null;

  return db.runTransaction(async (tx) => {
    const [orderSnapshot, refundRequestSnapshot, reversalCaseSnapshot] = await Promise.all([
      tx.get(orderRef),
      refundRequestRef ? tx.get(refundRequestRef) : Promise.resolve(null),
      tx.get(caseRef),
    ]);
    if (!orderSnapshot.exists) throw new HttpsError("not-found", "Order not found.");
    const order = orderSnapshot.data();

    if (refundRequestRef) {
      if (!refundRequestSnapshot.exists) {
        throw new HttpsError("not-found", "Affiliate refund request not found.");
      }
      const refundRequest = refundRequestSnapshot.data();
      if (refundRequest.orderId !== safeOrderId || refundRequest.userId !== order.userId) {
        throw new HttpsError("failed-precondition", "Refund request does not match the order.");
      }
      if (!["pending", "reversal-review"].includes(refundRequest.status)) {
        throw new HttpsError("failed-precondition", "Refund request has already been handled.");
      }
    }

    if (order.status === "refunded") {
      if (refundRequestRef) {
        tx.set(refundRequestRef, {
          status: "completed",
          result: "refunded",
          refundReference: normalizedRefundReference,
          reviewedBy: adminEmail,
          reviewedAt: new Date().toISOString(),
          reviewNote,
          completedAt: new Date().toISOString(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return {
        ok: true,
        status: "refunded",
        duplicate: true,
        orderId: safeOrderId,
        caseId: caseRef.id,
      };
    }
    if (refundRequestRef && refundRequestSnapshot.data().status === "reversal-review"
      && (!reversalCaseSnapshot.exists
        || reversalCaseSnapshot.data().status !== "review-required"
        || order.status !== "reversal-review")) {
      throw new HttpsError("failed-precondition", "退款复核状态不一致，请刷新后重试。");
    }
    if (!["paid", "reversal-review"].includes(order.status)) {
      throw new HttpsError("failed-precondition", "Only paid orders can be refunded.");
    }

    const userRef = db.collection("amsystemUsers").doc(order.userId);
    const userSnapshot = await tx.get(userRef);
    if (!userSnapshot.exists) throw new HttpsError("not-found", "Affiliate user not found.");
    const buyer = userSnapshot.data();

    const rewardsSnapshot = await tx.get(
      db.collection("amsystemRewards").where("orderId", "==", safeOrderId)
    );
    const repeatLogsSnapshot = await tx.get(
      db.collection("amsystemRepeatCreditLogs").where("source", "==", safeOrderId)
    );
    const remainingOrdersSnapshot = await tx.get(
      db.collection("amsystemOrders")
        .where("userId", "==", order.userId)
        .where("status", "==", "paid")
    );

    const walletUserId = walletIdForAffiliateOrder(order, buyer);
    const walletRef = walletUserId ? db.collection("wallets").doc(walletUserId) : null;
    const walletSnapshot = walletRef ? await tx.get(walletRef) : null;

    const receiverRefs = [];
    for (const logDoc of repeatLogsSnapshot.docs) {
      const log = logDoc.data();
      if (Number(log.change || 0) >= 0) continue;
      const receiverRef = db.collection("amsystemUsers").doc(log.userId);
      receiverRefs.push({
        log,
        userRef: receiverRef,
        userSnapshot: await tx.get(receiverRef),
      });
    }

    const rewards = rewardsSnapshot.docs.map((doc) => ({
      id: doc.id,
      ref: doc.ref,
      ...doc.data(),
    }));
    const pointChange = Number(order.points || 0);
    if (!Number.isFinite(pointChange) || pointChange <= 0) {
      throw new HttpsError("failed-precondition", "Refund order points must be greater than zero.");
    }

    const wallet = walletSnapshot && walletSnapshot.exists ? walletSnapshot.data() : null;
    const hasReleasedRewards = rewards.some(rewardHasReleasedValue);
    const hasMissingWallet = !walletRef || !wallet;
    const hasInsufficientWalletPoints = Boolean(wallet) && Number(wallet.balance || 0) < pointChange;
    const riskReasons = [
      hasReleasedRewards ? "released-rewards" : "",
      hasMissingWallet ? "wallet-not-found" : "",
      hasInsufficientWalletPoints ? "insufficient-wallet-points" : "",
    ].filter(Boolean);
    const requiresManualReview = riskReasons.length > 0;
    const createdAt = new Date().toISOString();
    const affiliatePointBalance = Number(buyer.points || 0);
    const walletPointBalance = wallet ? Number(wallet.balance || 0) : null;
    const pointShortfall = Math.max(pointChange - affiliatePointBalance, 0);
    const walletShortfall = wallet ? Math.max(pointChange - walletPointBalance, 0) : pointChange;
    const reviewMessage = walletShortfall > 0
      ? `当前 SimplePay 钱包仍差 ${walletShortfall} 积分，请会员补足后再重新检查。`
      : pointShortfall > 0
        ? `当前联盟积分仍差 ${pointShortfall} 积分，请会员补足后再重新检查。`
        : "当前退款仍需人工复核，请管理员处理风险原因后再重新检查。";

    if (requiresManualReview) {
      rewards.forEach((reward) => {
        tx.set(reward.ref, {
          previousStatus: reward.previousStatus || reward.status,
          status: "frozen",
          reversalCaseId: caseRef.id,
          reviewNote: [reward.reviewNote, `退款冻结：${normalizedRefundReference}`]
            .filter(Boolean)
            .join(" / "),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      tx.set(orderRef, {
        status: "reversal-review",
        refundReference: normalizedRefundReference,
        refundReason: normalizedReason,
        reversalCaseId: caseRef.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      tx.set(userRef, {
        refundReviewHold: true,
        refundReviewOrderId: safeOrderId,
        refundReviewStartedAt: buyer.refundReviewStartedAt || createdAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      tx.set(caseRef, {
        id: caseRef.id,
        sourceType: "affiliate-order",
        affiliateOrderId: safeOrderId,
        userId: order.userId,
        refundReference: normalizedRefundReference,
        reason: normalizedReason,
        status: "review-required",
        riskReasons,
        orderPoints: pointChange,
        affiliatePointBalance,
        walletPointBalance,
        pointShortfall,
        walletShortfall,
        lastCheckedAt: createdAt,
        releasedRewardAmount: rewards.reduce(
          (sum, reward) => sum + Number(reward.releasedAmount || 0),
          0
        ),
        rewardIds: rewards.map((reward) => reward.id),
        createdAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      if (refundRequestRef) {
        tx.set(refundRequestRef, {
          status: "reversal-review",
          refundReference: normalizedRefundReference,
          reviewedBy: adminEmail,
          reviewedAt: createdAt,
          reviewNote,
          result: "reversal-review",
          riskReasons,
          orderPoints: pointChange,
          affiliatePointBalance,
          walletPointBalance,
          pointShortfall,
          walletShortfall,
          lastCheckedAt: createdAt,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      createAdminLog(
        tx,
        "会员配套退款待复核",
        safeOrderId,
        `${normalizedRefundReference} / ${riskReasons.join(", ")} / ${normalizedReason}`,
        adminEmail
      );
      return {
        ok: true,
        status: "review-required",
        duplicate: order.status === "reversal-review",
        orderId: safeOrderId,
        caseId: caseRef.id,
        riskReasons,
        message: reviewMessage,
      };
    }

    const remainingOrders = remainingOrdersSnapshot.docs
      .filter((doc) => doc.id !== safeOrderId)
      .map((doc) => ({ id: doc.id, ...doc.data() }));
    const entitlements = entitlementFromOrders(remainingOrders);
    const plan = order.planSnapshot || { name: "联盟配套" };
    const walletEntry = simplePayRefundTransaction(
      { id: safeOrderId },
      plan,
      pointChange,
      createdAt,
      normalizedRefundReference
    );
    const walletChange = await applyWalletAndAffiliatePointChange(tx, {
      uid: walletUserId,
      affiliateUserId: order.userId,
      delta: -pointChange,
      source: "affiliate-refund",
      idempotencyKey: `affiliate-refund:${safeOrderId}`,
      description: `会员配套退款 ${normalizedRefundReference}`,
      metadata: { orderId: safeOrderId, refundReference: normalizedRefundReference },
      walletEntry,
    });
    if (walletChange.duplicate) {
      return {
        ok: true,
        status: "refunded",
        duplicate: true,
        orderId: safeOrderId,
        caseId: caseRef.id,
        pointsReversed: pointChange,
        affiliatePointBalance: walletChange.walletBalanceAfter,
        walletPointBalance: walletChange.walletBalanceAfter,
      };
    }
    const nextAffiliatePoints = walletChange.walletBalance;
    const nextWalletBalance = walletChange.walletBalance;

    rewards.forEach((reward) => {
      tx.set(reward.ref, {
        previousStatus: reward.previousStatus || reward.status,
        status: "cancelled",
        reversalCaseId: caseRef.id,
        reviewedAt: createdAt,
        reviewNote: [reward.reviewNote, `退款撤销：${normalizedRefundReference}`]
          .filter(Boolean)
          .join(" / "),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    receiverRefs.forEach(({ log, userRef: receiverRef, userSnapshot: receiverSnapshot }) => {
      if (!receiverSnapshot.exists) return;
      const receiver = receiverSnapshot.data();
      const restoredCredits = Number(receiver.repeatCredits || 0) - Number(log.change || 0);
      tx.set(receiverRef, {
        repeatCredits: restoredCredits,
        repeatCreditQueueAt: receiver.repeatCreditQueueAt || createdAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      createRepeatCreditLog(tx, {
        userId: log.userId,
        change: -Number(log.change || 0),
        balance: restoredCredits,
        reason: "refund-reversal",
        source: safeOrderId,
        note: `Restored after affiliate refund ${normalizedRefundReference}`,
        createdAt,
      });
    });

    tx.set(userRef, {
      ...entitlements,
      refundReviewHold: admin.firestore.FieldValue.delete(),
      refundReviewOrderId: admin.firestore.FieldValue.delete(),
      refundReviewStartedAt: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    tx.set(orderRef, {
      status: "refunded",
      refundedAt: createdAt,
      refundedBy: adminEmail,
      refundReference: normalizedRefundReference,
      refundReason: normalizedReason,
      reversalCaseId: caseRef.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    tx.set(caseRef, {
      id: caseRef.id,
      sourceType: "affiliate-order",
      affiliateOrderId: safeOrderId,
      userId: order.userId,
      refundReference: normalizedRefundReference,
      reason: normalizedReason,
      status: "resolved",
      orderPoints: pointChange,
      affiliatePointBalanceBefore: Number(buyer.points || 0),
      affiliatePointBalanceAfter: nextAffiliatePoints,
      walletPointBalanceBefore: Number(wallet.balance || 0),
      walletPointBalanceAfter: nextWalletBalance,
      releasedRewardAmount: 0,
      rewardIds: rewards.map((reward) => reward.id),
      createdAt,
      resolvedAt: createdAt,
      resolvedBy: adminEmail,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    if (refundRequestRef) {
      tx.set(refundRequestRef, {
        status: "completed",
        refundReference: normalizedRefundReference,
        reviewedBy: adminEmail,
        reviewedAt: createdAt,
        reviewNote,
        result: "refunded",
        completedAt: createdAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    createAdminLog(
      tx,
      "会员配套退款",
      safeOrderId,
      `${normalizedRefundReference} / 扣回 ${pointChange} 积分 / ${normalizedReason}`,
      adminEmail
    );

    return {
      ok: true,
      status: "refunded",
      duplicate: false,
      orderId: safeOrderId,
      caseId: caseRef.id,
      pointsReversed: pointChange,
      affiliatePointBalance: nextAffiliatePoints,
      walletPointBalance: nextWalletBalance,
    };
  });
}

exports.confirmOrder = onCall(
  {
    invoker: "public",
  },
  async (request) => {
    const adminEmail = assertAdmin(request);
    const orderId = request.data && request.data.orderId;
    const reviewNote = request.data && request.data.reviewNote;
    return confirmOrderById(orderId, adminEmail, reviewNote);
  },
);

exports.setAffiliateUserFrozenState = onCall(async (request) => {
  const adminEmail = assertAdmin(request);
  const data = request.data || {};
  const userId = safeExternalId(data.userId);
  const frozen = Boolean(data.frozen);
  const reason = text(data.reason).slice(0, 500);
  const idempotencyKey = safeExternalId(data.idempotencyKey);
  const userRef = db.collection("amsystemUsers").doc(userId);
  const operationRef = db.collection("amsystemAdminOperations").doc(`freeze:${idempotencyKey}`);

  return db.runTransaction(async (tx) => {
    const [operationSnapshot, userSnapshot] = await Promise.all([
      tx.get(operationRef),
      tx.get(userRef),
    ]);
    if (operationSnapshot.exists) return { ...operationSnapshot.data().result, duplicate: true };
    if (!userSnapshot.exists) throw new HttpsError("not-found", "Affiliate user not found.");
    const user = userSnapshot.data();
    const account = text(user.account || user.email).toLowerCase();
    if (ADMIN_EMAILS.includes(account) || ADMIN_EMAILS.includes(text(user.ownerEmail).toLowerCase())) {
      throw new HttpsError("failed-precondition", "Administrator accounts cannot be frozen.");
    }
    const updatedAt = new Date().toISOString();
    const result = { userId, frozen, updatedAt };
    tx.update(userRef, {
      frozen,
      frozenAt: frozen ? updatedAt : admin.firestore.FieldValue.delete(),
      unfrozenAt: frozen ? admin.firestore.FieldValue.delete() : updatedAt,
      frozenReason: reason || admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    createAdminLog(tx, frozen ? "冻结用户" : "解冻用户", userId, reason || "无备注", adminEmail);
    tx.create(operationRef, {
      id: operationRef.id,
      type: "affiliate-user-frozen-state",
      userId,
      frozen,
      reason,
      adminEmail,
      result,
      createdAt: updatedAt,
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return { ...result, duplicate: false };
  });
});


exports.refundAffiliateOrder = onCall(
  {
    invoker: "public",
  },
  async (request) => {
    const adminEmail = assertAdmin(request);
    const data = request.data || {};
    return refundAffiliateOrderById(
      data.orderId,
      adminEmail,
      data.refundReference,
      data.reason
    );
  },
);

exports.submitAffiliateRefundRequest = onCall(async (request) => {
  const member = requireAffiliateMember(request);
  const data = request.data || {};
  const orderId = safeExternalId(data.orderId);
  const reason = text(data.reason).slice(0, 500);
  if (!reason) throw new HttpsError("invalid-argument", "reason is required.");

  const orderRef = db.collection("amsystemOrders").doc(orderId);
  const userRef = db.collection("amsystemUsers").doc(member.uid);
  const refundRequestRef = db.collection("amsystemRefundRequests").doc(orderId);
  return db.runTransaction(async (tx) => {
    const [orderSnapshot, userSnapshot, existingSnapshot] = await Promise.all([
      tx.get(orderRef),
      tx.get(userRef),
      tx.get(refundRequestRef),
    ]);
    if (!orderSnapshot.exists) throw new HttpsError("not-found", "Order not found.");
    const order = orderSnapshot.data();
    if (order.userId !== member.uid) {
      throw new HttpsError("permission-denied", "You can only request a refund for your own order.");
    }
    if (order.status !== "paid") {
      throw new HttpsError("failed-precondition", "Only paid orders can request a refund.");
    }
    if (!userSnapshot.exists) throw new HttpsError("not-found", "Affiliate user not found.");
    if (existingSnapshot.exists) {
      const existing = existingSnapshot.data();
      if (["pending", "approved", "completed", "reversal-review"].includes(existing.status)) {
        throw new HttpsError("already-exists", "A refund request already exists for this order.");
      }
    }

    const buyer = userSnapshot.data();
    const createdAt = new Date().toISOString();
    tx.set(refundRequestRef, {
      id: refundRequestRef.id,
      orderId,
      userId: member.uid,
      account: text(buyer.account) || member.email,
      email: member.email,
      points: Number(order.points || 0),
      amountMyr: Number(order.amount || 0),
      reason,
      status: "pending",
      createdAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { id: refundRequestRef.id, orderId, status: "pending" };
  });
});

exports.reviewAffiliateRefundRequest = onCall(async (request) => {
  const adminEmail = assertAdmin(request);
  const data = request.data || {};
  const requestId = safeExternalId(data.requestId);
  const approved = Boolean(data.approved);
  const reviewNote = text(data.reviewNote).slice(0, 500);
  const refundReference = text(data.refundReference).slice(0, 160);
  const refundRequestRef = db.collection("amsystemRefundRequests").doc(requestId);

  if (!approved) {
    return db.runTransaction(async (tx) => {
      const refundRequestSnapshot = await tx.get(refundRequestRef);
      if (!refundRequestSnapshot.exists) throw new HttpsError("not-found", "Affiliate refund request not found.");
      const refundRequest = refundRequestSnapshot.data();
      if (!["pending", "reversal-review"].includes(refundRequest.status)) {
        throw new HttpsError("failed-precondition", "Refund request has already been handled.");
      }
      const reviewedAt = new Date().toISOString();
      const orderRef = db.collection("amsystemOrders").doc(refundRequest.orderId);
      const caseRef = db.collection("amsystemReversalCases").doc(`REF-${refundRequest.orderId}`);
      const [orderSnapshot, userSnapshot, rewardsSnapshot, paidOrdersSnapshot] = await Promise.all([
        tx.get(orderRef),
        tx.get(db.collection("amsystemUsers").doc(refundRequest.userId)),
        tx.get(db.collection("amsystemRewards").where("orderId", "==", refundRequest.orderId)),
        tx.get(db.collection("amsystemOrders").where("userId", "==", refundRequest.userId).where("status", "==", "paid")),
      ]);
      tx.update(refundRequestRef, {
        status: "rejected",
        reviewedBy: adminEmail,
        reviewedAt,
        reviewNote,
        result: "rejected",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (refundRequest.status === "reversal-review" && orderSnapshot.exists) {
        const order = orderSnapshot.data();
        const paidOrders = [
          ...paidOrdersSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
          { id: orderSnapshot.id, ...order, status: "paid" },
        ];
        rewardsSnapshot.docs.forEach((rewardDoc) => {
          const reward = rewardDoc.data();
          tx.set(rewardDoc.ref, {
            status: reward.previousStatus || "pending",
            reversalCaseId: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        });
        tx.set(orderRef, { status: "paid", updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        tx.set(caseRef, { status: "rejected", resolvedAt: reviewedAt, resolvedBy: adminEmail, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        if (userSnapshot.exists) {
          tx.set(userSnapshot.ref, {
            ...entitlementFromOrders(paidOrders),
            refundReviewHold: admin.firestore.FieldValue.delete(),
            refundReviewOrderId: admin.firestore.FieldValue.delete(),
            refundReviewStartedAt: admin.firestore.FieldValue.delete(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        }
      }
      createAdminLog(
        tx,
        "拒绝会员退款申请",
        refundRequest.orderId,
        `${requestId} / ${reviewNote || "无备注"}`,
        adminEmail
      );
      return { id: requestId, orderId: refundRequest.orderId, status: "rejected" };
    });
  }

  if (!refundReference) {
    throw new HttpsError("invalid-argument", "refundReference is required for approval.");
  }
  const refundRequestSnapshot = await refundRequestRef.get();
  if (!refundRequestSnapshot.exists) throw new HttpsError("not-found", "Affiliate refund request not found.");
  const refundRequest = refundRequestSnapshot.data();
  return refundAffiliateOrderById(
    refundRequest.orderId,
    adminEmail,
    refundReference,
    refundRequest.reason,
    { refundRequestId: requestId, reviewNote }
  );
});

exports.syncAffiliateWalletPoints = onCall(async (request) => {
  const adminEmail = assertAdmin(request);
  const paidOrdersSnapshot = await db.collection("amsystemOrders").where("status", "==", "paid").get();
  let credited = 0;
  let skipped = 0;
  let unavailable = 0;

  for (const orderDoc of paidOrdersSnapshot.docs) {
    const result = await db.runTransaction(async (tx) => {
      const orderSnap = await tx.get(orderDoc.ref);
      if (!orderSnap.exists) return "skipped";
      const order = orderSnap.data();
      if (order.status !== "paid") return "skipped";

      const buyerRef = db.collection("amsystemUsers").doc(order.userId);
      const buyerSnap = await tx.get(buyerRef);
      if (!buyerSnap.exists) return "unavailable";
      const buyer = buyerSnap.data();
      const points = Number(order.points || order.planSnapshot?.points || 0);
      if (!Number.isFinite(points) || points <= 0) return "skipped";

      const plan = {
        name: text(order.planSnapshot?.name) || text(order.planName) || "联盟配套",
      };
      const syncedAt = new Date().toISOString();
      const walletChange = await creditSimplePayWallet(tx, {
        order,
        buyer,
        plan,
        points,
        createdAt: syncedAt,
      });

      if (!walletChange.duplicate) {
        tx.set(orderDoc.ref, {
          simplePayWalletSyncedAt: syncedAt,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      return walletChange.duplicate ? "skipped" : "credited";
    });

    if (result === "credited") credited += 1;
    else if (result === "unavailable") unavailable += 1;
    else skipped += 1;
  }

  await db.collection("amsystemAdminLogs").add({
    adminEmail,
    action: "同步 SimplePay 联盟积分",
    target: "SimplePay 钱包",
    detail: `入账 ${credited} 笔，已存在 ${skipped} 笔，无法处理 ${unavailable} 笔`,
    createdAt: new Date().toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true, credited, skipped, unavailable };
});

async function ingestPosOrderData(data, adminEmail) {
  const externalOrderId = safeExternalId(data.externalOrderId);
  const posOrderId = text(data.posOrderId) || externalOrderId;
  const paymentReference = text(data.paymentReference);
  const amount = Number(data.amount || 0);
  const planId = text(data.planId) || "plan_rm180";
  const referralCode = normalizeInviteCode(data.referralCode);
  if (data.paymentStatus !== "confirmed" || !paymentReference) {
    throw new HttpsError("failed-precondition", "Confirmed payment and paymentReference are required.");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpsError("invalid-argument", "amount must be positive.");
  }

  const userId = await resolveExternalUserId(data);
  const externalRef = db.collection("amsystemExternalOrders").doc(externalOrderId);
  const orderId = `POS-${externalOrderId}`;
  const orderRef = db.collection("amsystemOrders").doc(orderId);
  const userRef = db.collection("amsystemUsers").doc(userId);
  const systemRef = db.collection("amsystem").doc("main");
  const referralOwnerId = referralCode
    ? await resolveReferralOwner(referralCode, userId)
    : "";

  const result = await db.runTransaction(async (tx) => {
    const externalSnapshot = await tx.get(externalRef);
    const orderSnapshot = await tx.get(orderRef);
    const userSnapshot = await tx.get(userRef);
    const systemSnapshot = await tx.get(systemRef);

    if (!userSnapshot.exists) throw new HttpsError("not-found", "Affiliate user not found.");
    const buyer = userSnapshot.data();
    const plans = systemSnapshot.exists && Array.isArray(systemSnapshot.data().plans)
      ? systemSnapshot.data().plans
      : [];
    const plan = plans.find((item) => item.id === planId);
    if (!plan) throw new HttpsError("not-found", "Affiliate plan not found.");
    if (!isValidPackageAmount(plan.amount) || Number(plan.amount) !== amount) {
      throw new HttpsError(
        "failed-precondition",
        `POS amount must match affiliate plan price RM${Number(plan.amount || 0).toFixed(2)}.`
      );
    }
    if (referralCode) {
      if (!buyer.referrerId || buyer.referrerId !== referralOwnerId) {
        throw new HttpsError("failed-precondition", "Referral code does not match the user's fixed referrer.");
      }
    }

    if (externalSnapshot.exists) {
      const existing = externalSnapshot.data();
      if (
        existing.userId !== userId
        || existing.planId !== planId
        || Number(existing.amount) !== amount
        || existing.paymentReference !== paymentReference
      ) {
        throw new HttpsError("already-exists", "externalOrderId is already linked to different data.");
      }
      return {
        orderId: existing.affiliateOrderId || orderId,
        duplicate: true,
        status: existing.status || (orderSnapshot.exists ? orderSnapshot.data().status : "pending")
      };
    }
    if (orderSnapshot.exists) {
      throw new HttpsError("already-exists", "Affiliate order ID already exists.");
    }

    const createdAt = text(data.createdAt) || new Date().toISOString();
    const order = {
      id: orderId,
      userId,
      planId,
      planSnapshot: planSnapshot(plan),
      type: "",
      status: "pending",
      amount: Number(plan.amount),
      points: 0,
      paymentMethod: text(data.paymentMethod) || "SimplePay",
      paymentRef: paymentReference,
      paymentNote: `POS ${posOrderId}`,
      proofStatus: "external-confirmed",
      sourceSystem: "simple-pos",
      externalOrderId,
      posOrderId,
      branchId: text(data.branchId),
      referralCode,
      createdAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    tx.create(orderRef, order);
    tx.create(externalRef, {
      id: externalOrderId,
      idempotencyKey: externalOrderId,
      sourceSystem: "simple-pos",
      posOrderId,
      affiliateOrderId: orderId,
      userId,
      planId,
      amount: Number(plan.amount),
      paymentReference,
      referralCode,
      branchId: text(data.branchId),
      status: "pending-confirmation",
      createdAt,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    createAdminLog(
      tx,
      "接收 POS 订单",
      orderId,
      `POS ${posOrderId} / ${money(amount)} / ${paymentReference}`,
      adminEmail
    );
    return { orderId, duplicate: false, status: "pending" };
  });

  try {
    await confirmOrderById(result.orderId, adminEmail);
    await externalRef.set({
      status: "paid",
      confirmedAt: new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return {
      ok: true,
      externalOrderId,
      affiliateOrderId: result.orderId,
      status: "paid",
      duplicate: result.duplicate
    };
  } catch (error) {
    await externalRef.set({
      status: "confirmation-failed",
      lastError: error.message || "Order confirmation failed.",
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    throw error;
  }
}

exports.ingestPosOrder = onCall(async (request) => {
  const adminEmail = assertAdmin(request);
  return ingestPosOrderData(request.data || {}, adminEmail);
});

function rewardHasReleasedValue(reward = {}) {
  if (Number(reward.releasedAmount || 0) > 0) return true;
  if (["confirmed", "releasing"].includes(reward.status)) return true;
  return Array.isArray(reward.releasePlan)
    && reward.releasePlan.some((part) => part.released || part.releasedAt);
}

function entitlementFromOrders(orders = []) {
  const paid = orders
    .filter((order) => order.status === "paid")
    .sort((a, b) => new Date(b.paidAt || b.createdAt) - new Date(a.paidAt || a.createdAt));
  if (!paid.length) {
    return {
      slots: 0,
      packageUntil: "",
      repeatCooldownUntil: "",
      level: "普通用户"
    };
  }
  const latest = paid[0];
  const plans = paid.map((order) => order.planSnapshot || {});
  const maxAmount = Math.max(...plans.map((plan) => Number(plan.amount || 0)), 0);
  const latestPlan = latest.planSnapshot || {};
  return {
    slots: Math.max(...plans.map((plan) => Number(plan.slots || 0)), 0),
    packageUntil: addDays(
      latest.paidAt || latest.createdAt,
      Number(latestPlan.validDays || 0)
    ),
    repeatCooldownUntil: latest.type === "repeat"
      ? addHours(latest.paidAt || latest.createdAt, planRepeatCooldownHours(latestPlan))
      : "",
    level: maxAmount >= 720 ? "高级推广用户" : "推广用户"
  };
}

async function reversePosOrderData(data, adminEmail) {
  const externalOrderId = safeExternalId(data.externalOrderId);
  const refundReference = text(data.refundReference);
  const reason = text(data.reason) || "POS order refunded";
  if (!refundReference) {
    throw new HttpsError("invalid-argument", "refundReference is required.");
  }

  const externalRef = db.collection("amsystemExternalOrders").doc(externalOrderId);
  const caseRef = db.collection("amsystemReversalCases").doc(`REV-${externalOrderId}`);

  return db.runTransaction(async (tx) => {
    const externalSnapshot = await tx.get(externalRef);
    if (!externalSnapshot.exists) throw new HttpsError("not-found", "External order not found.");
    const externalOrder = externalSnapshot.data();
    const orderRef = db.collection("amsystemOrders").doc(externalOrder.affiliateOrderId);
    const orderSnapshot = await tx.get(orderRef);
    if (!orderSnapshot.exists) throw new HttpsError("not-found", "Affiliate order not found.");
    const order = orderSnapshot.data();

    if (externalOrder.status === "reversed" || order.status === "refunded") {
      return {
        ok: true,
        status: "reversed",
        duplicate: true,
        caseId: caseRef.id
      };
    }
    if (!["paid", "reversal-review"].includes(order.status)) {
      throw new HttpsError("failed-precondition", "Only paid orders can be reversed.");
    }

    const userRef = db.collection("amsystemUsers").doc(order.userId);
    const userSnapshot = await tx.get(userRef);
    const rewardsSnapshot = await tx.get(
      db.collection("amsystemRewards").where("orderId", "==", order.id)
    );
    const repeatLogsSnapshot = await tx.get(
      db.collection("amsystemRepeatCreditLogs").where("source", "==", order.id)
    );
    const remainingOrdersSnapshot = await tx.get(
      db.collection("amsystemOrders")
        .where("userId", "==", order.userId)
        .where("status", "==", "paid")
    );
    if (!userSnapshot.exists) throw new HttpsError("not-found", "Affiliate user not found.");

    const rewards = rewardsSnapshot.docs.map((doc) => ({ id: doc.id, ref: doc.ref, ...doc.data() }));
    const buyer = userSnapshot.data();
    const walletUserId = walletIdForAffiliateOrder(order, buyer);
    const walletRef = walletUserId ? db.collection("wallets").doc(walletUserId) : null;
    const walletSnapshot = walletRef ? await tx.get(walletRef) : null;
    const wallet = walletSnapshot && walletSnapshot.exists ? walletSnapshot.data() : null;
    const hasReleasedRewards = rewards.some(rewardHasReleasedValue);
    const hasMissingWallet = !wallet;
    const hasInsufficientWalletPoints = Boolean(wallet) && Number(wallet.balance || 0) < Number(order.points || 0);
    const requiresManualReview = hasReleasedRewards || hasMissingWallet || hasInsufficientWalletPoints;
    const createdAt = new Date().toISOString();

    if (requiresManualReview) {
      rewards.forEach((reward) => {
        tx.set(reward.ref, {
          previousStatus: reward.status,
          status: "frozen",
          reversalCaseId: caseRef.id,
          reviewNote: [reward.reviewNote, `退款冻结：${refundReference}`].filter(Boolean).join(" / "),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      });
      tx.set(orderRef, {
        status: "reversal-review",
        reversalCaseId: caseRef.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      tx.set(externalRef, {
        status: "reversal-review",
        refundReference,
        reversalCaseId: caseRef.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      tx.set(caseRef, {
        id: caseRef.id,
        externalOrderId,
        affiliateOrderId: order.id,
        userId: order.userId,
        refundReference,
        reason,
        status: "review-required",
        riskReasons: [
          hasReleasedRewards ? "released-rewards" : "",
          hasMissingWallet ? "wallet-not-found" : "",
          hasInsufficientWalletPoints ? "insufficient-wallet-points" : ""
        ].filter(Boolean),
        releasedRewardAmount: rewards.reduce(
          (sum, reward) => sum + Number(reward.releasedAmount || reward.amount || 0),
          0
        ),
        rewardIds: rewards.map((reward) => reward.id),
        createdAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      createAdminLog(
        tx,
        "POS 退款待复核",
        order.id,
        `${refundReference} / ${hasReleasedRewards ? "已释放奖励" : "钱包积分不足"}，相关奖励已冻结`,
        adminEmail
      );
      return {
        ok: true,
        status: "review-required",
        duplicate: false,
        caseId: caseRef.id
      };
    }

    const receiverRefs = [];
    for (const logDoc of repeatLogsSnapshot.docs) {
      const log = logDoc.data();
      if (Number(log.change || 0) >= 0) continue;
      receiverRefs.push({
        log,
        logRef: logDoc.ref,
        userRef: db.collection("amsystemUsers").doc(log.userId),
        userSnapshot: await tx.get(db.collection("amsystemUsers").doc(log.userId))
      });
    }

    const remainingOrders = remainingOrdersSnapshot.docs
      .filter((doc) => doc.id !== order.id)
      .map((doc) => ({ id: doc.id, ...doc.data() }));
    const entitlements = entitlementFromOrders(remainingOrders);
    const walletEntry = simplePayRefundTransaction(
      { id: order.id },
      order.planSnapshot || { name: "联盟配套" },
      Number(order.points || 0),
      createdAt,
      refundReference
    );
    const walletChange = await applyWalletAndAffiliatePointChange(tx, {
      uid: walletUserId,
      affiliateUserId: order.userId,
      delta: -Number(order.points || 0),
      source: "pos-reversal",
      idempotencyKey: `pos-reversal:${externalOrderId}`,
      description: `POS 订单反转 ${refundReference}`,
      metadata: { externalOrderId, orderId: order.id, refundReference },
      walletEntry,
    });
    if (walletChange.duplicate) {
      return { ok: true, status: "reversed", duplicate: true, caseId: caseRef.id };
    }

    rewards.forEach((reward) => {
      tx.set(reward.ref, {
        previousStatus: reward.status,
        status: "cancelled",
        reversalCaseId: caseRef.id,
        reviewedAt: createdAt,
        reviewNote: [reward.reviewNote, `POS 退款撤销：${refundReference}`].filter(Boolean).join(" / "),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    });
    receiverRefs.forEach(({ log, userRef: receiverRef, userSnapshot: receiverSnapshot }) => {
      if (!receiverSnapshot.exists) return;
      const receiver = receiverSnapshot.data();
      const restoredCredits = Number(receiver.repeatCredits || 0) - Number(log.change || 0);
      tx.set(receiverRef, {
        repeatCredits: restoredCredits,
        repeatCreditQueueAt: receiver.repeatCreditQueueAt || createdAt,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      createRepeatCreditLog(tx, {
        userId: log.userId,
        change: -Number(log.change || 0),
        balance: restoredCredits,
        reason: "refund-reversal",
        source: order.id,
        note: `Restored after POS refund ${refundReference}`,
        createdAt
      });
    });
    tx.set(userRef, {
      ...entitlements,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    tx.set(orderRef, {
      status: "refunded",
      refundedAt: createdAt,
      refundReference,
      reversalCaseId: caseRef.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    tx.set(externalRef, {
      status: "reversed",
      reversedAt: createdAt,
      refundReference,
      reversalCaseId: caseRef.id,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    tx.set(caseRef, {
      id: caseRef.id,
      externalOrderId,
      affiliateOrderId: order.id,
      userId: order.userId,
      refundReference,
      reason,
      status: "reversed",
      releasedRewardAmount: 0,
      rewardIds: rewards.map((reward) => reward.id),
      createdAt,
      resolvedAt: createdAt,
      resolvedBy: adminEmail,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    createAdminLog(tx, "撤销 POS 订单", order.id, `${refundReference} / ${reason}`, adminEmail);
    return {
      ok: true,
      status: "reversed",
      duplicate: false,
      caseId: caseRef.id
    };
  });
}

exports.reversePosOrder = onCall(async (request) => {
  const adminEmail = assertAdmin(request);
  return reversePosOrderData(request.data || {}, adminEmail);
});

exports.processPosIntegrationCommand = onDocumentCreated(
  "amsystemIntegrationCommands/{commandId}",
  async (event) => {
    const commandRef = event.data.ref;
    const claimed = await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(commandRef);
      if (!snapshot.exists) return null;
      const command = snapshot.data();
      if (command.status !== "pending") return null;
      tx.update(commandRef, {
        status: "processing",
        attempts: Number(command.attempts || 0) + 1,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return command;
    });
    if (!claimed) return;

    const posJobId = text(claimed.posJobId || event.params.commandId);
    try {
      const initialPosJob = await posDb.collection("integrationJobs").doc(posJobId).get();
      if (
        !initialPosJob.exists
        || initialPosJob.data().status === "canceled"
        || text(claimed.sourceSystem) !== "simple-pos"
      ) {
        await commandRef.set({
          status: "canceled",
          cancelReason: "pos-job-not-active",
          canceledAt: new Date().toISOString(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return;
      }
      let result;
      if (claimed.operation === "ingestPosOrder") {
        result = await ingestPosOrderData(claimed.payload || {}, "simple-pos-worker@system");
      } else if (claimed.operation === "reversePosOrder") {
        result = await reversePosOrderData(claimed.payload || {}, "simple-pos-worker@system");
      } else {
        throw new Error(`Unsupported integration operation: ${claimed.operation}`);
      }
      const posOrderId = text(claimed.payload && claimed.payload.posOrderId);
      const posJobRef = posDb.collection("integrationJobs").doc(posJobId);
      const posSaleRef = posOrderId ? posDb.collection("sales").doc(posOrderId) : null;
      let lateCancellation = false;

      if (claimed.operation === "ingestPosOrder" && posSaleRef) {
        await posDb.runTransaction(async (tx) => {
          const [jobSnapshot, saleSnapshot] = await Promise.all([
            tx.get(posJobRef),
            tx.get(posSaleRef)
          ]);
          lateCancellation = !jobSnapshot.exists
            || jobSnapshot.data().status === "canceled"
            || !saleSnapshot.exists
            || saleSnapshot.data().status === "voided";
          if (lateCancellation) return;
          tx.set(posJobRef, {
            status: "completed",
            targetReference: `amsystemIntegrationCommands/${event.params.commandId}`,
            result: {
              affiliateOrderId: text(result.affiliateOrderId),
              affiliateStatus: text(result.status)
            },
            cloudUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          tx.update(posSaleRef, {
            "externalReferences.affiliateOrderId": text(result.affiliateOrderId),
            "externalReferences.affiliateStatus": "linked",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });
      }

      if (lateCancellation) {
        const reversal = await reversePosOrderData({
          externalOrderId: text(claimed.payload && claimed.payload.externalOrderId),
          refundReference: `POS-VOID-${posOrderId || posJobId}`,
          reason: "POS order was canceled while affiliate fulfillment was processing"
        }, "simple-pos-worker@system");
        const affiliateStatus = reversal.status === "reversed" ? "reversed" : "review-required";
        await Promise.all([
          commandRef.set({
            status: "canceled-after-processing",
            result: { ...result, lateCancellation: true, reversal },
            completedAt: new Date().toISOString(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true }),
          posJobRef.set({
            status: "canceled",
            result: {
              affiliateOrderId: text(result.affiliateOrderId),
              affiliateStatus,
              reversalCaseId: text(reversal.caseId)
            },
            cloudUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true }),
          posSaleRef.set({
            "externalReferences.affiliateOrderId": text(result.affiliateOrderId),
            "externalReferences.affiliateStatus": affiliateStatus,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true })
        ]);
        return;
      }

      if (claimed.operation === "reversePosOrder") {
        await posJobRef.set({
          status: "completed",
          targetReference: `amsystemIntegrationCommands/${event.params.commandId}`,
          result: {
            affiliateStatus: text(result.status),
            reversalCaseId: text(result.caseId)
          },
          cloudUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        if (posSaleRef) {
          await posSaleRef.set({
            "externalReferences.affiliateStatus": result.status === "reversed"
              ? "reversed"
              : "review-required",
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
      }
      await commandRef.set({
        status: "completed",
        result,
        completedAt: new Date().toISOString(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (error) {
      console.error("POS integration command failed", event.params.commandId, error);
      const failure = {
        code: text(error.code || "affiliate-integration-error"),
        message: text(error.message || "Affiliate integration failed"),
        at: new Date().toISOString()
      };
      await commandRef.set({
        status: "failed",
        lastError: failure,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      await posDb.collection("integrationJobs").doc(posJobId).set({
        status: "needs-attention",
        lastError: failure,
        cloudUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
  }
);

