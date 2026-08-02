import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore,
  serverTimestamp,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

let configModule;
try {
  configModule = await import("../shared/firebase-config.local.js");
} catch {
  configModule = await import("../shared/firebase-config.js");
}

const app = initializeApp(configModule.firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
await setPersistence(auth, browserLocalPersistence).catch(() => {});

const isEmbedded = new URLSearchParams(window.location.search).get("embed") === "1";
document.body.classList.toggle("is-embedded", isEmbedded);

const authStatus = document.querySelector("#authStatus");
const emptyState = document.querySelector("#emptyState");
const profileView = document.querySelector("#profileView");
const profileForm = document.querySelector("#profileForm");
const saveBtn = document.querySelector("#saveBtn");
const formStatus = document.querySelector("#formStatus");
const accountName = document.querySelector("#accountName");
const accountSub = document.querySelector("#accountSub");
const memberAvatar = document.querySelector("#memberAvatar");
const memberLogoutBtn = document.querySelector("#memberLogoutBtn");
const measurementHistory = document.querySelector("#measurementHistory");
const measurementRecords = document.querySelector("#measurementRecords");

let currentUser = null;
let currentProfile = null;
let currentProfileId = "";

function clean(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function normalizePhone(value) {
  return clean(value).replace(/[^\d+]/g, "");
}

function numberOrNull(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function setText(selector, value) {
  const node = document.querySelector(selector);
  if (node) node.textContent = value || "-";
}

function setStatus(node, message, isError = false) {
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("error", isError);
}

function initials(nameOrEmail) {
  const text = clean(nameOrEmail);
  if (!text) return "会";
  const emailName = text.includes("@") ? text.split("@")[0] : text;
  const words = emailName.split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return emailName.slice(0, 2).toUpperCase();
}

function setAccount(user, profile = null) {
  const customer = profile?.customer || {};
  const displayName = customer.name || user?.displayName || "会员中心";
  const email = user?.email || customer.email || "未登录";
  accountName.textContent = displayName;
  accountSub.textContent = user?.email ? email : "请先完成统一登录";
  memberAvatar.textContent = initials(displayName || email);
  memberLogoutBtn.disabled = !user;
  memberLogoutBtn.querySelector("small").textContent = user ? "退出当前 Google 账号" : "尚未登录";
}

async function loadMemberProfileForUser(user) {
  if (!user?.uid) return null;

  const token = await user.getIdToken();
  const response = await fetch(
    "https://asia-southeast1-simplepos-8d23e.cloudfunctions.net/getMemberProfile",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ data: {} })
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || "读取会员主档失败");
  }

  const result = payload?.result || payload;
  return result?.profile
    ? { docId: result.profileId || `MP-${user.uid}`, ...result.profile }
    : null;
}

function fillForm(profile) {
  const customer = profile.customer || {};
  const plan = profile.plan || {};
  const baseline = profile.baseline || {};
  const progress = profile.progress || {};
  const healthScreen = profile.healthScreen || {};
  profileForm.elements.name.value = customer.name || "";
  profileForm.elements.email.value = customer.email || currentUser?.email || "";
  profileForm.elements.phone.value = customer.phone || "";
  profileForm.elements.idLast4.value = customer.idLast4 || "";
  profileForm.elements.state.value = customer.state || "";
  profileForm.elements.city.value = customer.city || "";
  profileForm.elements.address.value = customer.address || "";
  profileForm.elements.referralCode.value = customer.referralCode || "";
  profileForm.elements.packageName.value = profile.packageName || "";
  profileForm.elements.startDate.value = plan.startDate || "";
  profileForm.elements.targetDate.value = plan.targetDate || "";
  profileForm.elements.weight.value = baseline.weight || progress.weight || "";
  profileForm.elements.waist.value = baseline.waist || progress.waist || "";
  profileForm.elements.height.value = baseline.height || "";
  profileForm.elements.bodyFatPct.value = baseline.bodyFatPct ?? "";
  profileForm.elements.visceralFatLevel.value = baseline.visceralFatLevel ?? "";
  profileForm.elements.boneMassKg.value = baseline.boneMassKg ?? "";
  profileForm.elements.basalMetabolicRateKcal.value = baseline.basalMetabolicRateKcal ?? "";
  profileForm.elements.skeletalMusclePct.value = baseline.skeletalMusclePct ?? "";
  profileForm.elements.bodyWaterPct.value = baseline.bodyWaterPct ?? "";
  profileForm.elements.checkInDays.value = progress.checkInDays || "";
  profileForm.elements.goal.value = profile.goal || "";
  profileForm.elements.healthNote.value = healthScreen.healthNote || progress.healthNote || "";
  profileForm.elements.progressNote.value = progress.progressNote || "";
}

function renderSummary(profile) {
  const customer = profile.customer || {};
  setText("#memberName", customer.name);
  setText("#memberEmail", customer.email);
  setText("#memberPhone", customer.phone);
  setText("#memberBranch", profile.branchName || profile.branchId);
  setText("#memberPackage", profile.packageName);
  setText("#memberTerms", profile.websiteTerms?.status === "accepted" ? "已确认" : "未确认");
  setText("#memberUpdatedAt", customer.updatedAtMYT || formatUpdatedAt(profile.updatedAt));
  setText("#memberUpdatedBy", customer.updatedBy || customer.email);
}

function measurementValue(value, unit = "") {
  return value === null || value === undefined || value === "" ? "-" : `${value}${unit}`;
}

const measurementFields = [
  ["weight", "体重", "kg"],
  ["waist", "腰围", "cm"],
  ["bodyFatPct", "体脂", "%"],
  ["visceralFatLevel", "内脏脂肪", ""],
  ["boneMassKg", "骨量", "kg"],
  ["basalMetabolicRateKcal", "基础代谢", "kcal/日"],
  ["skeletalMusclePct", "骨骼肌", "%"],
  ["bodyWaterPct", "体水分", "%"]
];

function recordValue(record, field) {
  const value = Number(record?.[field]);
  return Number.isFinite(value) ? value : null;
}

function formatDelta(delta, unit) {
  if (!Number.isFinite(delta)) return "暂无对照数据";
  const prefix = delta > 0 ? "+" : "";
  return `${prefix}${Math.abs(delta) < 0.05 ? 0 : delta.toFixed(1)}${unit}`;
}

function getMeasurementRecords(profile) {
  const baseline = profile.baseline || {};
  return Array.isArray(baseline.records) && baseline.records.length
    ? baseline.records
    : (baseline.weight || baseline.waist || baseline.bodyFatPct ? [{
      id: "baseline-existing",
      type: "baseline",
      label: "基线测量",
      ...baseline
    }] : []);
}

function renderMeasurementHistory(profile) {
  if (!measurementHistory || !measurementRecords) return;
  const records = getMeasurementRecords(profile);

  if (!records.length) {
    measurementHistory.hidden = true;
    measurementRecords.replaceChildren();
    return;
  }

  const baselineRecord = records.find((record) => record.type === "baseline") || records[0];
  const weeklyRecords = records.filter((record) => record !== baselineRecord);
  const latestRecord = weeklyRecords[weeklyRecords.length - 1] || baselineRecord;
  const previousRecord = weeklyRecords.length > 1 ? weeklyRecords[weeklyRecords.length - 2] : baselineRecord;
  const analysis = document.createElement("div");
  analysis.className = "measurement-analysis";
  const analysisItems = [
    ["最新与基线", `体重 ${formatDelta(recordValue(latestRecord, "weight") - recordValue(baselineRecord, "weight"), " kg")} · 腰围 ${formatDelta(recordValue(latestRecord, "waist") - recordValue(baselineRecord, "waist"), " cm")}`],
    ["本周变化", `体重 ${formatDelta(recordValue(latestRecord, "weight") - recordValue(previousRecord, "weight"), " kg")} · 体脂 ${formatDelta(recordValue(latestRecord, "bodyFatPct") - recordValue(previousRecord, "bodyFatPct"), "%")}`],
    ["记录进度", `基线 1 次 · 后续测量 ${weeklyRecords.length} 次`]
  ];
  analysis.replaceChildren(...analysisItems.map(([label, value]) => {
    const item = document.createElement("article");
    const title = document.createElement("span");
    title.textContent = label;
    const detail = document.createElement("strong");
    detail.textContent = value;
    item.append(title, detail);
    return item;
  }));
  measurementRecords.replaceChildren(analysis, ...records.slice().reverse().map((record, reverseIndex) => {
    const item = document.createElement("article");
    item.className = "measurement-record";
    const title = document.createElement("strong");
    const order = record === baselineRecord ? "初始对照" : `第 ${weeklyRecords.length - reverseIndex} 次后续测量`;
    title.textContent = `${record.label || "身体测量"}（${order}）· ${record.measuredAtMYT || formatUpdatedAt(record.measuredAt)}`;
    const detail = document.createElement("p");
    detail.textContent = measurementFields.map(([field, label, unit]) => `${label} ${measurementValue(record[field], unit ? ` ${unit}` : "")}`).join(" · ");
    item.append(title, detail);
    return item;
  }));
  measurementHistory.hidden = false;
}

function formatUpdatedAt(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-MY", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kuala_Lumpur"
  }).format(date);
}

function numberOrZeroOrNull(value) {
  const raw = clean(value);
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sameMeasurementValue(left, right) {
  const normalized = (value) => value === null || value === undefined || value === "" ? null : Number(value);
  return normalized(left) === normalized(right);
}

function buildUpdatePayload(formData) {
  const previous = currentProfile || {};
  const now = new Date().toISOString();
  const customer = {
    ...(previous.customer || {}),
    name: clean(formData.get("name")),
    phone: normalizePhone(formData.get("phone")),
    email: normalizeEmail(currentUser?.email || formData.get("email")),
    idLast4: clean(formData.get("idLast4")).slice(0, 4),
    state: clean(formData.get("state")),
    city: clean(formData.get("city")),
    address: clean(formData.get("address")),
    referralCode: clean(formData.get("referralCode")).toUpperCase(),
    updatedAt: now,
    updatedAtMYT: new Intl.DateTimeFormat("en-MY", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kuala_Lumpur"
    }).format(new Date()),
    updatedBy: normalizeEmail(currentUser?.email)
  };
  const plan = {
    ...(previous.plan || {}),
    startDate: clean(formData.get("startDate")),
    targetDate: clean(formData.get("targetDate"))
  };
  const baseline = { ...(previous.baseline || {}) };
  const weight = numberOrNull(baseline.weight);
  const waist = numberOrNull(baseline.waist);
  const checkInDays = Number(formData.get("checkInDays") || 0);
  const safeCheckInDays = Number.isFinite(checkInDays) ? Math.max(0, Math.min(18, checkInDays)) : 0;
  return {
    source: "customer-self-form",
    status: "active",
    packageName: clean(formData.get("packageName")),
    customer,
    plan,
    goal: clean(formData.get("goal")),
    baseline,
    healthScreen: {
      ...(previous.healthScreen || {}),
      healthNote: clean(formData.get("healthNote"))
    },
    progress: {
      ...(previous.progress || {}),
      weight,
      waist,
      checkInDays: safeCheckInDays,
      completionRate: safeCheckInDays > 0 ? Math.round((safeCheckInDays / 18) * 100) : 0,
      progressNote: clean(formData.get("progressNote")),
      healthNote: clean(formData.get("healthNote"))
    },
    updatedAt: now,
    cloudUpdatedAt: serverTimestamp()
  };
}

async function loadPage(user) {
  currentUser = user;
  currentProfile = null;
  currentProfileId = "";
  profileView.hidden = true;
  emptyState.hidden = true;
  setAccount(user);

  if (!user?.email) {
    setStatus(authStatus, "未登录。请先回到简单系统首页完成统一 Google 登录。", true);
    emptyState.hidden = false;
    return;
  }

  setStatus(authStatus, `已登录：${user.email}。正在读取会员主档...`);
  const profile = await loadMemberProfileForUser(user);
  if (!profile) {
    setStatus(authStatus, "尚未建立会员主档。请先完成个人资料。", true);
    emptyState.hidden = false;
    return;
  }

  currentProfile = profile;
  currentProfileId = profile.docId || profile.id;
  fillForm(profile);
  renderSummary(profile);
  renderMeasurementHistory(profile);
  setAccount(user, profile);
  profileView.hidden = false;
  setStatus(authStatus, "会员主档已读取。SimplePay、简单联盟等系统会使用最新资料并直接关联这份资料。");
  setStatus(formStatus, "你可以在这里更新会员资料。保存后，各系统会读取最新主档。");
}

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser?.email || !currentProfileId) {
    setStatus(formStatus, "请先登录并读取会员主档。", true);
    return;
  }
  const formData = new FormData(profileForm);
  const payload = buildUpdatePayload(formData);
  if (!payload.customer.name || !payload.customer.phone) {
    setStatus(formStatus, "姓名和电话必须填写。", true);
    return;
  }
  saveBtn.disabled = true;
  setStatus(formStatus, "正在保存会员资料...");
  try {
    const sessionUser = auth.currentUser;
    if (!sessionUser) {
      throw new Error("请先完成 Google 登录后再保存。");
    }

    const token = await sessionUser.getIdToken();
    const response = await fetch(
      "https://asia-southeast1-simplepos-8d23e.cloudfunctions.net/saveMemberProfile",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ data: { profile: payload } })
      }
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.error) {
      throw new Error(result?.error?.message || "会员主档云端保存失败。");
    }
    // The callable owns the canonical profile id; the next read refreshes local state.
    currentProfile = { ...currentProfile, ...payload, cloudUpdatedAt: null };
    fillForm(currentProfile);
    renderSummary(currentProfile);
    renderMeasurementHistory(currentProfile);
    setAccount(currentUser, currentProfile);
    localStorage.setItem("simpleposLatestMemberProfile", JSON.stringify({
      id: currentProfileId,
      intakeId: currentProfile.latestIntakeId || "",
      name: payload.customer.name,
      phone: payload.customer.phone,
      email: payload.customer.email,
      updatedAt: payload.updatedAt
    }));
    setStatus(formStatus, "会员资料已保存。身体测量由线下每周测量功能统一新增，不会覆盖初始基线。");
  } catch (error) {
    console.error("Member profile update failed", error);
    setStatus(formStatus, `保存失败：${error.code || error.message || "请检查网络后重试"}`, true);
  } finally {
    saveBtn.disabled = false;
  }
});

memberLogoutBtn.addEventListener("click", async () => {
  if (!currentUser) return;
  memberLogoutBtn.disabled = true;
  setStatus(authStatus, "正在退出登录...");
  try {
    localStorage.setItem("simplepos-force-account-choice", "1");
    await signOut(auth);
    localStorage.removeItem("simpleposUnifiedUser");
    localStorage.removeItem("simplepayUnifiedUser");
    localStorage.removeItem("simpleposPortalUserHint");
    window.top.location.replace("../login.html?forceAccount=1&next=./system.html%3Fmodule%3Dprofile");
  } catch (error) {
    console.error("Member logout failed", error);
    setStatus(authStatus, `退出失败：${error.code || error.message || "请稍后重试"}`, true);
    memberLogoutBtn.disabled = false;
  }
});

onAuthStateChanged(auth, (user) => {
  loadPage(user).catch((error) => {
    console.error("Member center load failed", error);
    setStatus(authStatus, `读取失败：${error.code || error.message || "请检查网络后重试"}`, true);
  });
});
