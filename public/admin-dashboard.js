import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, browserLocalPersistence, onAuthStateChanged, setPersistence } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { collection, getDocs, getFirestore } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

let configModule;
try {
  configModule = await import("./shared/firebase-config.local.js");
} catch {
  configModule = await import("./shared/firebase-config.js");
}

const app = initializeApp(configModule.firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
await setPersistence(auth, browserLocalPersistence).catch(() => {});

const adminEmail = String(configModule.adminEmail || "").trim().toLowerCase();
const notice = document.querySelector("#notice");
const refreshBtn = document.querySelector("#refreshBtn");
let currentUser = null;

const setText = (id, value) => {
  const element = document.querySelector(`#${id}`);
  if (element) element.textContent = value;
};

const number = (value) => Number(value || 0);
const isPending = (data) => ["pending", "requested", "processing", "waiting"].includes(String(data?.status || "").toLowerCase());
const isPaid = (data) => ["paid", "completed", "success", "confirmed"].includes(String(data?.status || "").toLowerCase());
const formatNumber = (value) => new Intl.NumberFormat("en-MY", { maximumFractionDigits: 2 }).format(number(value));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());

async function readCollection(name) {
  try {
    const snapshot = await getDocs(collection(db, name));
    return { name, rows: snapshot.docs.map((item) => ({ id: item.id, ...item.data() })), error: null };
  } catch (error) {
    return { name, rows: [], error: error?.code || "读取失败" };
  }
}

function measurementTotal(profiles) {
  return profiles.reduce((total, profile) => {
    const baseline = profile?.baseline || {};
    const records = Array.isArray(baseline.records) ? baseline.records : [];
    return total + (baseline?.measuredAt || baseline?.weight || baseline?.weightKg ? 1 : 0) + records.length;
  }, 0);
}

function salesStats(sales) {
  const completed = sales.filter((sale) => isPaid(sale) || ["paid", "completed"].includes(String(sale?.paymentStatus || "").toLowerCase()));
  const amount = completed.reduce((total, sale) => total + number(sale?.total ?? sale?.grandTotal ?? sale?.amount), 0);
  return { completed, amount };
}

function applyDashboard(data) {
  const byName = Object.fromEntries(data.map((result) => [result.name, result.rows]));
  const profiles = byName.memberProfiles || [];
  const checkins = byName.dailyCheckins || [];
  const wallets = byName.wallets || [];
  const merchants = byName.merchants || [];
  const refunds = byName.refundRequests || [];
  const settlements = byName.settlementRequests || [];
  const affiliateUsers = byName.amsystemUsers || [];
  const affiliateOrders = byName.amsystemOrders || [];
  const affiliateWithdraws = byName.amsystemWithdraws || [];
  const affiliateRewards = byName.amsystemRewards || [];
  const branches = byName.branches || [];
  const posUsers = byName.users || [];
  const sales = byName.sales || [];
  const saleStats = salesStats(sales);

  setText("memberCount", formatNumber(profiles.length));
  setText("checkinToday", formatNumber(checkins.filter((item) => item.checkinDate === today()).length));
  setText("measurementCount", formatNumber(measurementTotal(profiles)));
  setText("salesAmount", `RM ${formatNumber(saleStats.amount)}`);
  setText("salesHint", `${formatNumber(saleStats.completed.length)} 笔已完成订单`);
  setText("walletBalance", `${formatNumber(wallets.reduce((total, wallet) => total + number(wallet?.balance), 0))} 积分`);
  setText("merchantApproved", formatNumber(merchants.filter((merchant) => String(merchant?.status || "").toLowerCase() === "approved").length));
  setText("refundPending", formatNumber(refunds.filter(isPending).length));
  setText("settlementPending", formatNumber(settlements.filter(isPending).length));
  setText("affiliateUsers", formatNumber(affiliateUsers.length));
  setText("affiliatePaidOrders", formatNumber(affiliateOrders.filter(isPaid).length));
  setText("affiliateWithdraws", formatNumber(affiliateWithdraws.filter(isPending).length));
  setText("affiliateRewards", formatNumber(affiliateRewards.filter(isPending).length));
  setText("branchCount", formatNumber(branches.filter((branch) => branch?.active !== false && branch?.status !== "disabled").length));
  setText("posUserCount", formatNumber(posUsers.length));
  setText("saleCount", formatNumber(saleStats.completed.length));

  const failures = data.filter((result) => result.error);
  setText("sources", failures.length
    ? `部分数据暂时无法读取：${failures.map((item) => `${item.name}（${item.error}）`).join("、")}。其余数据已更新。`
    : `数据已更新：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kuala_Lumpur" }).format(new Date())}（马来西亚时间）。`);
}

async function refreshDashboard() {
  if (!currentUser || currentUser.email?.trim().toLowerCase() !== adminEmail) return;
  refreshBtn.disabled = true;
  refreshBtn.textContent = "读取中…";
  notice.classList.remove("error");
  notice.textContent = "正在读取各系统云端数据…";
  const collections = [
    "memberProfiles", "dailyCheckins", "wallets", "merchants", "refundRequests", "settlementRequests",
    "amsystemUsers", "amsystemOrders", "amsystemWithdraws", "amsystemRewards", "branches", "users", "sales"
  ];
  const results = await Promise.all(collections.map(readCollection));
  applyDashboard(results);
  notice.textContent = "数据看板已更新。";
  refreshBtn.disabled = false;
  refreshBtn.textContent = "刷新数据";
}

document.querySelectorAll("[data-module]").forEach((button) => {
  button.addEventListener("click", () => {
    const module = button.dataset.module;
    window.top.location.href = `./system.html?module=${encodeURIComponent(module)}`;
  });
});

refreshBtn.addEventListener("click", refreshDashboard);

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  const isAdmin = Boolean(user?.email && user.email.trim().toLowerCase() === adminEmail);
  if (!isAdmin) {
    document.querySelector("#dashboard").innerHTML = "<section class=\"locked\"><h1>无法查看数据看板</h1><p>此页面只开放给唯一管理员账号。</p></section>";
    return;
  }
  refreshDashboard();
});
