import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-functions.js";

let configModule;
try {
  configModule = await import("../shared/firebase-config.local.js");
} catch {
  configModule = await import("../shared/firebase-config.js");
}

const { adminEmail, firebaseConfig } = configModule;

if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith("YOUR_")) {
  window.dispatchEvent(new CustomEvent("cloud-error", {
    detail: { message: "Firebase config is missing. Create firebase-config.local.js." }
  }));
  throw new Error("Firebase config is missing. Create firebase-config.local.js.");
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const cloudFunctions = getFunctions(app, "asia-southeast1");
const provider = new GoogleAuthProvider();
let expectedGoogleEmail = "";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

async function getCloudUser(email) {
  const normalized = normalizeEmail(email);
  const snapshot = await getDoc(doc(db, "users", normalized));
  if (snapshot.exists()) return { id: snapshot.id, ...snapshot.data() };
  if (normalized === adminEmail) {
    const adminUser = {
      email: adminEmail,
      name: "Stanley Hoh",
      role: "admin",
      branchId: "hq",
      active: true,
      createdAt: serverTimestamp()
    };
    await setDoc(doc(db, "users", adminEmail), adminUser, { merge: true });
    return { id: adminEmail, ...adminUser };
  }
  return null;
}

async function refreshAuthorization() {
  const firebaseUser = auth.currentUser;
  if (!firebaseUser) return { firebaseUser: null, appUser: null };
  const appUser = await getCloudUser(firebaseUser.email);
  return {
    firebaseUser: {
      email: firebaseUser.email,
      uid: firebaseUser.uid
    },
    appUser
  };
}

async function loadCollection(name) {
  const snapshot = await getDocs(collection(db, name));
  return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
}

async function loadCollectionSafe(name) {
  try {
    return await loadCollection(name);
  } catch (error) {
    console.warn(`Cloud collection load skipped: ${name}`, error);
    return [];
  }
}

async function loadAllData() {
  const [branches, users, products, productRequests, customerIntakes, memberProfiles, sales, stockAdjustments, auditLogs, shifts] = await Promise.all([
    loadCollectionSafe("branches"),
    loadCollectionSafe("users"),
    loadCollectionSafe("products"),
    loadCollectionSafe("productRequests"),
    loadCollectionSafe("customerIntakes"),
    loadCollectionSafe("memberProfiles"),
    loadCollectionSafe("sales"),
    loadCollectionSafe("stockAdjustments"),
    loadCollectionSafe("auditLogs"),
    loadCollectionSafe("shifts")
  ]);
  return { branches, users, products, productRequests, customerIntakes, memberProfiles, sales, stockAdjustments, auditLogs, shifts };
}

async function loadUserData(appUser) {
  if (!appUser) return { branches: [], users: [], products: [], productRequests: [], customerIntakes: [], memberProfiles: [], sales: [], stockAdjustments: [], auditLogs: [], shifts: [] };
  if (appUser.role === "admin" || normalizeEmail(appUser.email) === adminEmail) {
    return loadAllData();
  }

  const branchIds = appUser.role === "regional_manager"
    ? [...new Set((Array.isArray(appUser.branchIds) ? appUser.branchIds : [appUser.branchId]).filter(Boolean))].slice(0, 30)
    : [appUser.branchId || "hq"];
  const branchQuery = (collectionName) => branchIds.length === 1
    ? query(collection(db, collectionName), where("branchId", "==", branchIds[0]))
    : query(collection(db, collectionName), where("branchId", "in", branchIds));
  const [allBranches, allProducts, productRequestsSnapshot, customerIntakesSnapshot, memberProfilesSnapshot, salesSnapshot, stockAdjustmentsSnapshot, shiftsSnapshot] = await Promise.all([
    loadCollectionSafe("branches"),
    loadCollectionSafe("products"),
    getDocs(branchQuery("productRequests")).catch((error) => {
      console.warn("Cloud branch product requests load skipped", error);
      return { docs: [] };
    }),
    getDocs(branchQuery("customerIntakes")).catch((error) => {
      console.warn("Cloud branch customer intakes load skipped", error);
      return { docs: [] };
    }),
    getDocs(branchQuery("memberProfiles")).catch((error) => {
      console.warn("Cloud branch member profiles load skipped", error);
      return { docs: [] };
    }),
    getDocs(branchQuery("sales")).catch((error) => {
      console.warn("Cloud branch sales load skipped", error);
      return { docs: [] };
    }),
    getDocs(branchQuery("stockAdjustments")).catch((error) => {
      console.warn("Cloud branch stock adjustments load skipped", error);
      return { docs: [] };
    }),
    getDocs(branchQuery("shifts")).catch((error) => {
      console.warn("Cloud branch shifts load skipped", error);
      return { docs: [] };
    })
  ]);
  const branches = allBranches.filter((branch) => branchIds.includes(branch.id));
  const products = allProducts.map((product) => ({
    ...product,
    stock: branchIds.includes("hq") ? Number(product.stock || 0) : 0,
    branchStock: Object.fromEntries(
      branchIds.map((branchId) => [branchId, Number(product.branchStock?.[branchId] || 0)])
    )
  }));
  return {
    branches,
    users: [appUser],
    products,
    productRequests: productRequestsSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })),
    customerIntakes: customerIntakesSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })),
    memberProfiles: memberProfilesSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })),
    sales: salesSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })),
    stockAdjustments: stockAdjustmentsSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })),
    auditLogs: [],
    shifts: shiftsSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
  };
}

async function saveBranch(branch) {
  await setDoc(doc(db, "branches", branch.id), {
    ...branch,
    active: branch.active ?? true,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function saveAuthorizedUser(user) {
  const email = normalizeEmail(user.email);
  await setDoc(doc(db, "users", email), {
    ...user,
    email,
    active: user.active ?? true,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function saveProduct(product) {
  await setDoc(doc(db, "products", product.id), {
    ...product,
    active: product.active ?? true,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function saveProductRequest(request) {
  await setDoc(doc(db, "productRequests", request.id), {
    ...request,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function updateProductRequest(request) {
  await setDoc(doc(db, "productRequests", request.id), {
    ...request,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function deleteProduct(productId) {
  await deleteDoc(doc(db, "products", productId));
}

async function saveStockAdjustment(adjustment) {
  await setDoc(doc(db, "stockAdjustments", adjustment.id), {
    ...adjustment,
    syncedAt: serverTimestamp()
  }, { merge: true });
}

async function saveAuditLog(log) {
  await setDoc(doc(db, "auditLogs", log.id), {
    ...log,
    syncedAt: serverTimestamp()
  }, { merge: true });
}

async function saveShift(shift) {
  try {
    const result = await httpsCallable(cloudFunctions, "posSaveShift")({ shift });
    return result.data;
  } catch (error) {
    if (error?.code !== "functions/not-found") throw error;
    await setDoc(doc(db, "shifts", shift.id), {
      ...shift,
      syncedAt: serverTimestamp()
    }, { merge: true });
    return { ok: true, shiftId: shift.id };
  }
}

async function saveSettings(settings) {
  await setDoc(doc(db, "settings", "app"), {
    ...settings,
    updatedAt: serverTimestamp()
  }, { merge: true });
}

async function previewPosTestData() {
  const result = await httpsCallable(cloudFunctions, "previewPosTestData")({});
  return result.data;
}

async function exportPosCloudBackup() {
  const result = await httpsCallable(cloudFunctions, "exportPosCloudBackup")({});
  return result.data;
}

async function clearPosCloudTestData(data) {
  const result = await httpsCallable(cloudFunctions, "clearPosCloudTestData")(data);
  return result.data;
}

async function loadSettings() {
  const snapshot = await getDoc(doc(db, "settings", "app"));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

async function saveSale(sale) {
  await setDoc(doc(db, "sales", sale.id), {
    ...sale,
    syncStatus: "synced",
    syncedAt: serverTimestamp()
  }, { merge: true });
}

async function loadSale(saleId) {
  const snapshot = await getDoc(doc(db, "sales", saleId));
  return snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null;
}

function writeIntegrationJobs(transaction, sale, eventType) {
  if (!window.integrationContract) return [];
  const jobs = window.integrationContract.buildJobs(sale, eventType);
  for (const job of jobs) {
    transaction.set(doc(db, "integrationJobs", job.id), {
      ...job,
      cloudCreatedAt: serverTimestamp(),
      cloudUpdatedAt: serverTimestamp()
    });
  }
  return jobs;
}

async function readCheckoutIntegrationJobs(transaction, sale) {
  const jobIds = Array.isArray(sale.integrationOutbox?.checkoutJobIds)
    ? sale.integrationOutbox.checkoutJobIds
    : [];
  const snapshots = [];
  for (const jobId of jobIds) {
    snapshots.push(await transaction.get(doc(db, "integrationJobs", jobId)));
  }
  return snapshots;
}

function cancelOpenIntegrationJobs(transaction, snapshots, saleId) {
  const cancellable = new Set([
    "pending",
    "processing",
    "retry",
    "blocked",
    "awaiting-customer-authorization",
    "dispatched"
  ]);
  for (const snapshot of snapshots) {
    if (!snapshot.exists() || !cancellable.has(snapshot.data().status)) continue;
    transaction.update(snapshot.ref, {
      status: "canceled",
      cancelReason: "pos-order-canceled",
      canceledPosOrderId: saleId,
      canceledAt: new Date().toISOString(),
      cloudUpdatedAt: serverTimestamp()
    });
  }
}

async function saveCheckoutDirect(sale) {
  return runTransaction(db, async (transaction) => {
    const saleRef = doc(db, "sales", sale.id);
    const existingSale = await transaction.get(saleRef);
    if (existingSale.exists()) {
      const existing = existingSale.data();
      return {
        status: existing.inventoryReview?.status === "required" ? "inventory-review" : "already-synced",
        inventoryReview: existing.inventoryReview || null
      };
    }

    const productRefs = sale.items.map((item) => doc(db, "products", item.id));
    const snapshots = [];
    for (const productRef of productRefs) {
      snapshots.push(await transaction.get(productRef));
    }

    const conflicts = [];
    snapshots.forEach((snapshot, index) => {
      const item = sale.items[index];
      if (!snapshot.exists()) {
        conflicts.push({
          productId: item.id,
          productName: item.name,
          requestedQty: Number(item.qty || 0),
          cloudStock: null,
          reason: "云端商品不存在"
        });
        return;
      }
      const product = snapshot.data();
      const branchStock = { ...(product.branchStock || {}) };
      const currentStock = Number(branchStock[sale.branchId] || 0);
      if (currentStock < item.qty) {
        conflicts.push({
          productId: item.id,
          productName: item.name,
          requestedQty: Number(item.qty || 0),
          cloudStock: currentStock,
          reason: "云端库存不足"
        });
      }
    });

    if (conflicts.length) {
      const inventoryReview = {
        status: "required",
        detectedAt: new Date().toISOString(),
        branchId: sale.branchId,
        conflicts
      };
      transaction.set(saleRef, {
        ...sale,
        inventoryReview,
        syncStatus: "review-required",
        syncedAt: serverTimestamp()
      }, { merge: true });
      const integrationJobs = writeIntegrationJobs(transaction, sale, "checkout");
      return {
        status: "inventory-review",
        inventoryReview,
        integrationJobIds: integrationJobs.map((job) => job.id)
      };
    }

    snapshots.forEach((snapshot, index) => {
      const item = sale.items[index];
      const product = snapshot.data();
      const branchStock = { ...(product.branchStock || {}) };
      const currentStock = Number(branchStock[sale.branchId] || 0);
      branchStock[sale.branchId] = currentStock - item.qty;
      transaction.update(snapshot.ref, {
        branchStock,
        stock: sale.branchId === "hq" ? branchStock[sale.branchId] : product.stock,
        updatedAt: serverTimestamp()
      });
    });

    transaction.set(saleRef, {
      ...sale,
      syncStatus: "synced",
      syncedAt: serverTimestamp()
    }, { merge: true });
    const integrationJobs = writeIntegrationJobs(transaction, sale, "checkout");
    return {
      status: "synced",
      inventoryReview: null,
      integrationJobIds: integrationJobs.map((job) => job.id)
    };
  });
}

async function saveCheckout(sale) {
  try {
    const result = await httpsCallable(cloudFunctions, "posSaveCheckout")({ sale });
    return result.data;
  } catch (error) {
    if (error?.code !== "functions/not-found") throw error;
    return saveCheckoutDirect(sale);
  }
}

async function saveVoidDirect(sale) {
  return runTransaction(db, async (transaction) => {
    const saleRef = doc(db, "sales", sale.id);
    const existingSnapshot = await transaction.get(saleRef);
    if (!existingSnapshot.exists()) {
      const integrationJobSnapshots = await readCheckoutIntegrationJobs(transaction, sale);
      transaction.set(saleRef, {
        ...sale,
        syncStatus: "synced",
        syncedAt: serverTimestamp()
      }, { merge: true });
      cancelOpenIntegrationJobs(transaction, integrationJobSnapshots, sale.id);
      return {
        status: "voided",
        stockStatus: "not-required",
        inventoryReview: sale.inventoryReview || null
      };
    }

    const existingSale = existingSnapshot.data();
    if (existingSale.status === "voided") {
      return {
        status: "already-voided",
        stockStatus: existingSale.inventoryReview?.status === "required" ? "review-required" : "already-processed",
        inventoryReview: existingSale.inventoryReview || null
      };
    }

    const integrationJobSnapshots = await readCheckoutIntegrationJobs(transaction, existingSale);
    const hadInventoryConflict = existingSale.inventoryReview?.status === "required";
    const saleItems = Array.isArray(existingSale.items) ? existingSale.items : (sale.items || []);
    const productSnapshots = [];
    if (!hadInventoryConflict) {
      for (const item of saleItems) {
        productSnapshots.push(await transaction.get(doc(db, "products", item.id)));
      }
    }

    const missingProducts = productSnapshots.flatMap((snapshot, index) => {
      if (snapshot.exists()) return [];
      const item = saleItems[index];
      return [{
        productId: item.id,
        productName: item.name,
        requestedQty: Number(item.qty || 0),
        cloudStock: null,
        reason: "退款回补时云端商品不存在"
      }];
    });

    let inventoryReview = existingSale.inventoryReview || sale.inventoryReview || null;
    if (hadInventoryConflict) {
      inventoryReview = {
        ...inventoryReview,
        status: "resolved",
        resolvedAt: sale.voidedAt || new Date().toISOString(),
        resolvedBy: sale.voidedBy || null,
        resolution: "order-voided"
      };
    } else if (missingProducts.length) {
      inventoryReview = {
        status: "required",
        type: "void-restock",
        detectedAt: new Date().toISOString(),
        branchId: existingSale.branchId || sale.branchId,
        conflicts: missingProducts
      };
    } else {
      productSnapshots.forEach((snapshot, index) => {
        const item = saleItems[index];
        const product = snapshot.data();
        const branchId = existingSale.branchId || sale.branchId;
        const branchStock = { ...(product.branchStock || {}) };
        branchStock[branchId] = Number(branchStock[branchId] || 0) + Number(item.qty || 0);
        transaction.update(snapshot.ref, {
          branchStock,
          stock: branchId === "hq" ? branchStock[branchId] : product.stock,
          updatedAt: serverTimestamp()
        });
      });
    }

    const voidedSale = {
      ...existingSale,
      ...sale,
      status: "voided",
      inventoryReview
    };
    const integrationJobs = writeIntegrationJobs(transaction, voidedSale, "void");
    transaction.update(saleRef, {
      status: "voided",
      voidedAt: sale.voidedAt || new Date().toISOString(),
      voidedBy: sale.voidedBy || null,
      integrationOutbox: sale.integrationOutbox || existingSale.integrationOutbox || null,
      inventoryReview,
      syncStatus: missingProducts.length ? "review-required" : "synced",
      updatedAt: serverTimestamp(),
      syncedAt: serverTimestamp()
    });
    cancelOpenIntegrationJobs(transaction, integrationJobSnapshots, sale.id);
    return {
      status: "voided",
      stockStatus: hadInventoryConflict
        ? "not-required"
        : (missingProducts.length ? "review-required" : "restored"),
      inventoryReview,
      integrationJobIds: integrationJobs.map((job) => job.id)
    };
  });
}

async function saveVoid(sale) {
  try {
    const result = await httpsCallable(cloudFunctions, "posVoidSale")({ sale });
    return result.data;
  } catch (error) {
    if (error?.code !== "functions/not-found") throw error;
    return saveVoidDirect(sale);
  }
}

async function signInWithGoogle(loginHint = "") {
  await signOut(auth).catch(() => {});
  const normalizedHint = normalizeEmail(loginHint);
  expectedGoogleEmail = normalizedHint;
  provider.setCustomParameters({
    prompt: normalizedHint ? "consent select_account" : "select_account",
    ...(normalizedHint ? { login_hint: normalizedHint } : {})
  });
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    expectedGoogleEmail = "";
    throw error;
  }
}

async function signOutGoogle() {
  expectedGoogleEmail = "";
  localStorage.setItem("simplepos-force-account-choice", "1");
  await signOut(auth);
  return auth.currentUser === null;
}

async function refreshAffiliateCatalog() {
  const result = await httpsCallable(cloudFunctions, "refreshAffiliateCatalog")({});
  return result.data;
}

async function loadIntegrationJobs() {
  const snapshot = await getDocs(query(
    collection(db, "integrationJobs"),
    orderBy("cloudUpdatedAt", "desc"),
    limit(50)
  ));
  return snapshot.docs.map((item) => {
    const data = item.data();
    return {
      id: item.id,
      ...data,
      cloudUpdatedAt: data.cloudUpdatedAt?.toDate
        ? data.cloudUpdatedAt.toDate().toISOString()
        : data.cloudUpdatedAt
    };
  });
}

async function retryIntegrationJob(jobId) {
  const result = await httpsCallable(cloudFunctions, "retryIntegrationJob")({ jobId });
  return result.data;
}

async function checkIntegrationConnections() {
  const result = {
    generatedAt: new Date().toISOString(),
    pos: {
      activeBranches: 0,
      orphanUsers: []
    },
    simplePay: {
      reachable: false,
      secureMoneyFunctionsEnabled: false,
      pointsPerMyr: 0,
      branches: []
    },
    affiliate: {
      reachable: false,
      activePlans: []
    }
  };

  try {
    const [branchSnapshot, userSnapshot, configSnapshot] = await Promise.all([
      getDocs(collection(db, "branches")),
      getDocs(collection(db, "users")),
      getDoc(doc(db, "systemConfig", "main"))
    ]);
    const config = configSnapshot.exists() ? configSnapshot.data() : {};
    result.simplePay.reachable = configSnapshot.exists();
    result.simplePay.secureMoneyFunctionsEnabled = config.secureMoneyFunctionsEnabled === true;
    result.simplePay.pointsPerMyr = Number(config.pointsPerMyr || 0);
    const activeBranches = branchSnapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .filter((branch) => branch.active !== false);
    const activeBranchIds = new Set(activeBranches.map((branch) => branch.id));
    result.pos.activeBranches = activeBranches.length;
    result.pos.orphanUsers = userSnapshot.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .filter((user) => user.active !== false && !activeBranchIds.has(String(user.branchId || "hq")))
      .map((user) => ({
        email: String(user.email || user.id || ""),
        branchId: String(user.branchId || "hq")
      }));
    for (const branch of activeBranches) {
      const merchantId = String(branch.simplePayMerchantId || "").trim();
      if (!merchantId) {
        result.simplePay.branches.push({
          branchId: branch.id,
          branchName: String(branch.name || ""),
          merchantConfigured: false,
          merchantExists: false,
          merchantApproved: false
        });
        continue;
      }
      const merchantSnapshot = await getDoc(doc(db, "merchants", merchantId));
      result.simplePay.branches.push({
        branchId: branch.id,
        branchName: String(branch.name || ""),
        merchantConfigured: true,
        merchantExists: merchantSnapshot.exists(),
        merchantApproved: merchantSnapshot.exists() && merchantSnapshot.data().status === "approved"
      });
    }
  } catch (error) {
    result.simplePay.errorCode = String(error?.code || "simplepay-unreachable");
  }

  try {
    const systemSnapshot = await getDoc(doc(db, "amsystem", "main"));
    const plans = systemSnapshot.exists() && Array.isArray(systemSnapshot.data().plans)
      ? systemSnapshot.data().plans
      : [];
    result.affiliate.reachable = systemSnapshot.exists();
    result.affiliate.activePlans = plans
      .filter((plan) => plan.active !== false && Number(plan.amount || 0) > 0)
      .map((plan) => ({
        planId: String(plan.id || "").trim(),
        name: String(plan.name || "").trim(),
        price: Number(Number(plan.amount || 0).toFixed(2))
      }));
  } catch (error) {
    result.affiliate.errorCode = String(error?.code || "affiliate-unreachable");
  }

  return result;
}

async function checkSimplePayReadiness(branchId) {
  const branchSnapshot = await getDoc(doc(db, "branches", branchId || "hq"));
  if (!branchSnapshot.exists() || branchSnapshot.data().active === false) {
    return {
      ready: false,
      code: "branch-not-found",
      message: `当前分行 ${branchId || "hq"} 不存在或已停用。请管理员先初始化云端分行资料。`
    };
  }
  const merchantId = String(branchSnapshot.data().simplePayMerchantId || "").trim();
  if (!merchantId) {
    return { ready: false, code: "merchant-not-configured", message: "当前分行尚未绑定 SimplePay 商家。" };
  }
  const [configSnapshot, merchantSnapshot] = await Promise.all([
    getDoc(doc(db, "systemConfig", "main")),
    getDoc(doc(db, "merchants", merchantId))
  ]);
  const config = configSnapshot.exists() ? configSnapshot.data() : {};
  if (!configSnapshot.exists() || config.secureMoneyFunctionsEnabled !== true) {
    return { ready: false, code: "secure-money-disabled", message: "SimplePay 安全资金模式尚未启用。" };
  }
  if (!(Number(config.pointsPerMyr) > 0)) {
    return { ready: false, code: "points-rate-invalid", message: "SimplePay 积分汇率尚未正确设置。" };
  }
  if (!merchantSnapshot.exists()) {
    return { ready: false, code: "merchant-not-found", message: "当前分行绑定的 SimplePay 商家不存在。" };
  }
  if (String(merchantSnapshot.data().status || "").trim() !== "approved") {
    return { ready: false, code: "merchant-not-approved", message: "当前分行的 SimplePay 商家尚未审核通过。" };
  }
  return { ready: true, code: "ready", message: "当前分行已可使用 SimplePay 收款。", branchId };
}

async function initializeIntegrationConfig(localBranches = []) {
  const email = String(auth.currentUser?.email || "").trim().toLowerCase();
  if (!email || email !== String(adminEmail || "").trim().toLowerCase()) {
    throw new Error("只有 Google 管理员可以初始化三系统配置。");
  }
  const configRef = doc(db, "systemConfig", "main");
  const affiliateRef = doc(db, "amsystem", "main");
  const [configSnapshot, affiliateSnapshot, branchSnapshot, userSnapshot] = await Promise.all([
    getDoc(configRef),
    getDoc(affiliateRef),
    getDocs(collection(db, "branches")),
    getDocs(collection(db, "users"))
  ]);
  const created = [];
  if (!configSnapshot.exists()) {
    await setDoc(configRef, {
      pointsPerMyr: 100,
      merchantFeeRate: "0.60%",
      dailyTransactionLimit: 400000,
      maintenanceMode: false,
      rechargeEnabled: true,
      withdrawEnabled: true,
      noticeTemplate: "您的交易已处理完成",
      adminWhatsapp: "",
      riskHandledIds: [],
      secureMoneyFunctionsEnabled: true,
      initializedBy: email,
      initializedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    created.push("SimplePay");
  }
  if (!affiliateSnapshot.exists()) {
    await setDoc(affiliateRef, {
      plans: [{
        id: "plan_rm180",
        name: "RM180 单位配套",
        amount: 180,
        points: 18000,
        slots: 10,
        repeatCredits: 10,
        repeatCooldownHours: 0,
        validDays: 30,
        firstRate: 20,
        directRepeatRate: 10,
        repeatRate: 10,
        active: true
      }],
      testDataClearedAt: new Date().toISOString(),
      initializedBy: email,
      initializedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    created.push("简单联盟");
  }
  const existingBranchIds = new Set(branchSnapshot.docs.map((item) => item.id));
  const localBranchById = new Map(
    (Array.isArray(localBranches) ? localBranches : [])
      .filter((branch) => branch && branch.id && branch.active !== false)
      .map((branch) => [String(branch.id), branch])
  );
  const requiredBranchIds = new Set(["hq", ...localBranchById.keys()]);
  for (const userDocument of userSnapshot.docs) {
    const user = userDocument.data();
    if (user.active !== false) requiredBranchIds.add(String(user.branchId || "hq"));
  }
  let createdBranchCount = 0;
  for (const branchId of requiredBranchIds) {
    if (!branchId || existingBranchIds.has(branchId)) continue;
    const localBranch = localBranchById.get(branchId) || {};
    await setDoc(doc(db, "branches", branchId), {
      id: branchId,
      name: String(localBranch.name || (branchId === "hq" ? "总店" : branchId)),
      simplePayMerchantId: String(localBranch.simplePayMerchantId || ""),
      active: true,
      initializedBy: email,
      initializedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    createdBranchCount += 1;
  }
  if (createdBranchCount) created.push(`POS 分行 ${createdBranchCount} 个`);
  return { created };
}

async function traceIntegrationOrder(posOrderId) {
  const result = await httpsCallable(cloudFunctions, "traceIntegrationOrder")({ posOrderId });
  return result.data;
}

let stopAuthorizationWatch = null;

function watchAuthorization(callback) {
  if (typeof stopAuthorizationWatch === "function") stopAuthorizationWatch();
  const email = normalizeEmail(auth.currentUser?.email);
  if (!email || typeof callback !== "function") return () => {};

  stopAuthorizationWatch = onSnapshot(
    doc(db, "users", email),
    (snapshot) => callback(snapshot.exists() ? { id: snapshot.id, ...snapshot.data() } : null),
    (error) => console.warn("POS authorization watch failed", error)
  );
  return () => {
    if (typeof stopAuthorizationWatch === "function") stopAuthorizationWatch();
    stopAuthorizationWatch = null;
  };
}

window.cloudPOS = {
  auth,
  db,
  signInWithGoogle,
  signOutGoogle,
  getCloudUser,
  refreshAuthorization,
  watchAuthorization,
  loadCollection,
  loadAllData,
  loadUserData,
  saveBranch,
  saveAuthorizedUser,
  saveProduct,
  saveProductRequest,
  updateProductRequest,
  deleteProduct,
  saveStockAdjustment,
  saveAuditLog,
  saveShift,
  saveSettings,
  previewPosTestData,
  exportPosCloudBackup,
  clearPosCloudTestData,
  loadSettings,
  loadSale,
  saveSale,
  saveCheckout,
  saveVoid,
  refreshAffiliateCatalog,
  loadIntegrationJobs,
  retryIntegrationJob,
  checkIntegrationConnections,
  checkSimplePayReadiness,
  initializeIntegrationConfig,
  traceIntegrationOrder
};

onAuthStateChanged(auth, async (firebaseUser) => {
  if (!firebaseUser) {
    if (typeof stopAuthorizationWatch === "function") stopAuthorizationWatch();
    stopAuthorizationWatch = null;
    emit("cloud-auth-change", { firebaseUser: null, appUser: null });
    return;
  }

  try {
    const actualEmail = normalizeEmail(firebaseUser.email);
    if (expectedGoogleEmail && actualEmail !== expectedGoogleEmail) {
      const requestedEmail = expectedGoogleEmail;
      expectedGoogleEmail = "";
      await signOut(auth);
      emit("cloud-error", {
        message: `Google 登录账号与输入邮箱不一致。请输入并登录 ${requestedEmail}。`
      });
      return;
    }
    expectedGoogleEmail = "";
    const appUser = await getCloudUser(firebaseUser.email);
    if (!auth.currentUser || auth.currentUser.uid !== firebaseUser.uid) return;
    emit("cloud-auth-change", { firebaseUser, appUser });
  } catch (error) {
    emit("cloud-error", { message: error.message });
  }
});

emit("cloud-ready", { projectId: firebaseConfig.projectId });
