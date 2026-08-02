const admin = require("firebase-admin");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

if (!admin.apps.length) admin.initializeApp();

const db = admin.firestore();
const PROGRAM_DURATION_DAYS = 18;

function text(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return text(value).toLowerCase();
}

function normalizePhone(value) {
  let digits = text(value).replace(/\D/g, "");
  if (digits.startsWith("0")) digits = `60${digits.slice(1)}`;
  return digits;
}

function phoneVariants(value) {
  const normalized = normalizePhone(value);
  const variants = new Set([text(value), normalized]);
  if (normalized.startsWith("60")) {
    variants.add(`+${normalized}`);
    variants.add(`0${normalized.slice(2)}`);
  }
  return [...variants].filter(Boolean);
}

function malaysiaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function isQualifiedPlanItem(item = {}) {
  const id = text(item.id).toLowerCase();
  const barcode = text(item.barcode || item.sku).toUpperCase();
  const planId = text(item.affiliatePlanId).toLowerCase();
  const name = text(item.name).toLowerCase();
  return id === "affiliate-plan-rm180"
    || barcode === "AFF-PLAN-RM180"
    || planId === "plan_rm180"
    || name.includes("极简养生")
    || (name.includes("rm180") && (name.includes("配套") || name.includes("计划")));
}

function isPaidCompletedSale(sale = {}) {
  if (text(sale.status) !== "completed" || sale.voidedAt) return false;
  const total = Number(sale.total || 0);
  const paid = Number(sale.paid || 0);
  const simplePayConfirmed = text(sale.externalReferences?.simplePayStatus) === "confirmed";
  return total > 0
    && (paid >= total || simplePayConfirmed)
    && Array.isArray(sale.items)
    && sale.items.some(isQualifiedPlanItem);
}

function isQualifiedAffiliateOrder(order = {}) {
  const plan = order.planSnapshot || {};
  const planId = text(order.planId || plan.id).toLowerCase();
  const planName = text(plan.name || order.planName || order.name).toLowerCase();
  const amount = Number(order.amount || plan.amount || 0);
  const refundStatus = text(order.refundStatus).toLowerCase();
  const refunded = Boolean(order.refundedAt || order.refundAt)
    || ["refunded", "reversed", "voided"].includes(refundStatus);

  return text(order.status).toLowerCase() === "paid"
    && !refunded
    && (
      planId === "plan_rm180"
      || planName.includes("rm180")
      || amount === 180
    );
}

async function getMemberProfile(email) {
  const snapshot = await db.collection("memberProfiles")
    .where("customer.email", "==", email)
    .limit(5)
    .get();
  if (snapshot.empty) {
    throw new HttpsError("failed-precondition", "请先完成个人健康计划，建立会员主档。");
  }
  return snapshot.docs
    .map((doc) => ({ ref: doc.ref, id: doc.id, data: doc.data() }))
    .sort((a, b) => text(b.data.updatedAt).localeCompare(text(a.data.updatedAt)))[0];
}

async function findQualifiedSale(phone) {
  const saleMap = new Map();
  for (const candidate of phoneVariants(phone)) {
    const snapshot = await db.collection("sales")
      .where("customer.phone", "==", candidate)
      .limit(25)
      .get();
    snapshot.docs.forEach((doc) => saleMap.set(doc.id, {
      id: doc.id,
      source: "pos",
      ...doc.data()
    }));
  }
  return [...saleMap.values()]
    .filter(isPaidCompletedSale)
    .sort((a, b) => text(b.createdAt).localeCompare(text(a.createdAt)))[0] || null;
}

async function findQualifiedAffiliateOrder(email) {
  if (!email) return null;

  const usersSnapshot = await db.collection("amsystemUsers")
    .where("account", "==", email)
    .limit(5)
    .get();
  const orderMap = new Map();

  for (const userDoc of usersSnapshot.docs) {
    const ordersSnapshot = await db.collection("amsystemOrders")
      .where("userId", "==", userDoc.id)
      .where("status", "==", "paid")
      .limit(25)
      .get();
    ordersSnapshot.docs.forEach((doc) => orderMap.set(doc.id, {
      id: doc.id,
      source: "affiliate",
      ...doc.data()
    }));
  }

  return [...orderMap.values()]
    .filter(isQualifiedAffiliateOrder)
    .sort((a, b) => text(b.paidAt || b.createdAt)
      .localeCompare(text(a.paidAt || a.createdAt)))[0] || null;
}

async function findQualifiedProgramOrder(phone, email) {
  const [posSale, affiliateOrder] = await Promise.all([
    findQualifiedSale(phone),
    findQualifiedAffiliateOrder(email)
  ]);

  return [posSale, affiliateOrder]
    .filter(Boolean)
    .sort((a, b) => text(b.paidAt || b.createdAt)
      .localeCompare(text(a.paidAt || a.createdAt)))[0] || null;
}

async function resolveProgramStatus(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "请先完成统一 Google 登录。");
  const email = normalizeEmail(request.auth.token?.email);
  if (!email) throw new HttpsError("unauthenticated", "当前 Google 账号没有电邮资料。");

  const profile = await getMemberProfile(email);
  const program = profile.data.dailyProgram || {};
  if (text(program.status) === "active" && text(program.startDate)) {
    return {
      email,
      profile,
      eligible: true,
      started: true,
      startDate: text(program.startDate),
      durationDays: Number(program.durationDays || PROGRAM_DURATION_DAYS),
      orderId: text(program.orderId),
      paymentVerified: true
    };
  }

  const sale = await findQualifiedProgramOrder(profile.data.customer?.phone, email);
  return {
    email,
    profile,
    eligible: Boolean(sale),
    started: false,
    startDate: "",
    durationDays: PROGRAM_DURATION_DAYS,
    orderId: sale?.id || "",
    paymentVerified: Boolean(sale),
    sale
  };
}

exports.getDailyPlanStatus = onCall(async (request) => {
  const status = await resolveProgramStatus(request);
  return {
    eligible: status.eligible,
    started: status.started,
    startDate: status.startDate,
    durationDays: status.durationDays,
    orderId: status.orderId,
    paymentVerified: status.paymentVerified,
    message: status.started
      ? "18 天计划已经开始。"
      : status.eligible
        ? "已确认付款资格。请在准备好后自行开始 18 天计划。"
        : "尚未找到已完成且未退款的极简养生计划订单。"
  };
});

exports.startDailyPlan = onCall(async (request) => {
  const isAdmin = String(request.auth?.token?.email || "").trim().toLowerCase() === "stanleyhoh79@gmail.com";
  const status = await resolveProgramStatus(request);
  if (status.started) {
    return {
      ok: true,
      alreadyStarted: true,
      startDate: status.startDate,
      durationDays: status.durationDays
    };
  }
  if (!status.eligible || !status.sale) {
    throw new HttpsError("failed-precondition", "尚未确认已付费的极简养生计划，暂时不能开始每日打卡。");
  }

  const startDate = malaysiaDate();
  const startedAtIso = new Date().toISOString();
  await status.profile.ref.set({
    dailyProgram: {
      status: "active",
      eligibilityStatus: "paid",
      paymentVerified: true,
      orderId: status.sale.id,
      paymentMethod: text(status.sale.payment?.method || status.sale.paymentMethod),
      qualifiedAt: text(status.sale.paidAt || status.sale.createdAt),
      startDate,
      durationDays: PROGRAM_DURATION_DAYS,
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      startedAtIso,
      startedByUid: request.auth.uid,
      startedByEmail: status.email,
      source: status.sale.source === "affiliate"
        ? "member-self-start-after-affiliate-payment"
        : "member-self-start-after-pos-payment"
    },
    updatedAt: startedAtIso,
    cloudUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  return {
    ok: true,
    alreadyStarted: false,
    startDate,
    durationDays: PROGRAM_DURATION_DAYS,
    message: "计划已开始，今天是第 1 天。"
  };
});
