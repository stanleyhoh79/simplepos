import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
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

const app = initializeApp(configModule.firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const functions = getFunctions(app, "asia-southeast1");
const getDailyPlanStatus = httpsCallable(functions, "getDailyPlanStatus");
const startDailyPlan = httpsCallable(functions, "startDailyPlan");
await setPersistence(auth, browserLocalPersistence).catch(() => {});

const MALAYSIA_TIME_ZONE = "Asia/Kuala_Lumpur";
const DEFAULT_TEMPLATE = `{姓名}，早安。今天是{计划}第{天数}天。
请完成今天的身体记录和饮用打卡：
{链接}`;
const adminEmail = String(configModule.adminEmail || "").trim().toLowerCase();

const authState = document.querySelector("#authState");
const memberView = document.querySelector("#memberView");
const adminView = document.querySelector("#adminView");
const adminTabs = document.querySelector("#adminTabs");
const checkinForm = document.querySelector("#checkinForm");
const submitButton = document.querySelector("#submitButton");
const formStatus = document.querySelector("#formStatus");
const historyList = document.querySelector("#historyList");
const memberRoster = document.querySelector("#memberRoster");
const reminderTemplate = document.querySelector("#reminderTemplate");
const programGate = document.querySelector("#programGate");
const programGateEyebrow = document.querySelector("#programGateEyebrow");
const programGateTitle = document.querySelector("#programGateTitle");
const programGateMessage = document.querySelector("#programGateMessage");
const programGateNote = document.querySelector("#programGateNote");
const startProgramButton = document.querySelector("#startProgramButton");
const todayStrip = document.querySelector("#todayStrip");
const checkinCard = document.querySelector("#checkinCard");
const historyCard = document.querySelector("#historyCard");
const weeklyMeasurementForm = document.querySelector("#weeklyMeasurementForm");
const weeklyMemberSelect = document.querySelector("#weeklyMemberSelect");
const weeklyMeasurementHint = document.querySelector("#weeklyMeasurementHint");
const weeklyMeasurementStatus = document.querySelector("#weeklyMeasurementStatus");
const saveWeeklyMeasurementButton = document.querySelector("#saveWeeklyMeasurementButton");

let currentUser = null;
let currentProfile = null;
let currentProfileId = "";
let ownCheckins = [];
let todayCheckin = null;
let photoData = { selfie: "", tongue: "" };
let dailyProgramStatus = null;
let weeklyProfiles = [];

function clean(value) {
  return String(value || "").trim();
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function numberOrZeroOrNull(value) {
  const raw = clean(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function measurementTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-MY", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: MALAYSIA_TIME_ZONE
  }).format(date);
}

function malaysiaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: MALAYSIA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function dateDiffDays(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const start = new Date(`${startDate}T00:00:00+08:00`);
  const end = new Date(`${endDate}T00:00:00+08:00`);
  return Math.floor((end - start) / 86400000);
}

function planInfo(profile, date = malaysiaDate()) {
  const plan = profile?.plan || {};
  const program = profile?.dailyProgram || {};
  const started = clean(program.status) === "active" && Boolean(clean(program.startDate));
  const duration = Math.max(1, Number(program.durationDays || plan.durationDays || 18));
  const startDate = started ? clean(program.startDate) : "";
  const rawDay = started ? dateDiffDays(startDate, date) + 1 : 0;
  return {
    name: clean(profile?.packageName) || "极简养生第一阶段",
    startDate,
    duration,
    day: started ? Math.max(1, Math.min(duration, rawDay)) : 0,
    started
  };
}

function setProgramContentVisible(visible) {
  todayStrip.hidden = !visible;
  checkinCard.hidden = !visible;
  historyCard.hidden = !visible;
}

function renderProgramAccess(status) {
  dailyProgramStatus = status;
  const started = Boolean(status?.started);
  programGate.hidden = started;
  setProgramContentVisible(started);
  if (started) return;

  programGateEyebrow.textContent = status?.eligible ? "付款资格已确认" : "等待付款资格";
  programGateTitle.textContent = status?.eligible ? "由你决定什么时候开始" : "每日打卡尚未开放";
  programGateMessage.textContent = status?.eligible
    ? "你已经具备极简养生计划资格。准备好后自行点击开始，点击当天才算第 1 天。"
    : (status?.message || "系统尚未找到已完成且未退款的极简养生计划订单。付款确认后再回来即可。");
  programGateNote.textContent = status?.eligible
    ? "开始后会连续计算 18 天。请确认今天方便正式执行，再点击开始。"
    : "填写个人资料不会自动启动每日打卡，也不会开始计算天数。";
  startProgramButton.hidden = !status?.eligible;
  startProgramButton.disabled = false;
  startProgramButton.textContent = "我已准备好，开始 18 天计划";
}

async function refreshProgramAccess() {
  const response = await getDailyPlanStatus();
  const status = response.data || {};
  if (status.started) {
    currentProfile.dailyProgram = {
      ...(currentProfile.dailyProgram || {}),
      status: "active",
      startDate: status.startDate,
      durationDays: status.durationDays
    };
  }
  renderProgramAccess(status);
  return status;
}

function setStatus(message, isError = false) {
  formStatus.textContent = message;
  formStatus.classList.toggle("error", isError);
}

function setAuthState(title, message, isError = false) {
  authState.innerHTML = `<strong>${title}</strong><span>${message}</span>`;
  authState.classList.toggle("error", isError);
  authState.hidden = false;
}

async function loadProfileByEmail(email) {
  const snapshot = await getDocs(query(
    collection(db, "memberProfiles"),
    where("customer.email", "==", normalizeEmail(email))
  ));
  const profiles = snapshot.docs.map((item) => ({ docId: item.id, ...item.data() }));
  return profiles.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
}

async function loadOwnCheckins() {
  const snapshot = await getDocs(query(
    collection(db, "dailyCheckins"),
    where("memberUid", "==", currentUser.uid)
  ));
  ownCheckins = snapshot.docs
    .map((item) => item.data())
    .sort((a, b) => String(b.checkinDate).localeCompare(String(a.checkinDate)));
  todayCheckin = ownCheckins.find((item) => item.checkinDate === malaysiaDate()) || null;
}

function calculateStreak(records) {
  const dates = new Set(records.map((item) => item.checkinDate));
  let cursor = new Date(`${malaysiaDate()}T00:00:00+08:00`);
  if (!dates.has(malaysiaDate(cursor))) cursor = new Date(cursor.getTime() - 86400000);
  let streak = 0;
  while (dates.has(malaysiaDate(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - 86400000);
  }
  return streak;
}

function renderMemberSummary() {
  const info = planInfo(currentProfile);
  const completed = ownCheckins.filter((item) => (
    item.checkinDate >= info.startDate
    && dateDiffDays(info.startDate, item.checkinDate) < info.duration
  )).length;
  document.querySelector("#planDay").textContent = `第 ${info.day} / ${info.duration} 天`;
  document.querySelector("#streakCount").textContent = `${calculateStreak(ownCheckins)} 天`;
  document.querySelector("#completionRate").textContent = `${Math.min(100, Math.round((completed / info.duration) * 100))}%`;
  document.querySelector("#todayTitle").textContent = `${info.name} · 第 ${info.day} 天`;
  const badge = document.querySelector("#todayBadge");
  badge.textContent = todayCheckin ? "今天已完成" : "今天未打卡";
  badge.classList.toggle("done", Boolean(todayCheckin));
}

function renderHistory() {
  const recent = ownCheckins.slice(0, 7);
  if (!recent.length) {
    historyList.innerHTML = '<p class="empty-copy">还没有打卡记录，完成今天的记录后会显示在这里。</p>';
    return;
  }
  historyList.innerHTML = recent.map((item) => `
    <article class="history-row">
      <strong>${item.checkinDate}</strong>
      <span>${item.weight ? `${item.weight} kg` : "-"}</span>
      <span>${item.drinkCompleted ? "已饮用" : "未饮用"}</span>
      <span>${item.bodyFeeling || "-"}</span>
    </article>
  `).join("");
}

function fillTodayRecord() {
  if (!todayCheckin) return;
  const fields = ["weight", "waist", "visceralFat", "drinkProduct", "sleepStatus", "bowelStatus", "dietStatus", "bodyFeeling", "notes"];
  fields.forEach((name) => {
    if (checkinForm.elements[name]) checkinForm.elements[name].value = todayCheckin[name] ?? "";
  });
  const drink = checkinForm.elements.drinkCompleted;
  if (drink) {
    [...drink].forEach((radio) => {
      radio.checked = radio.value === (todayCheckin.drinkCompleted ? "yes" : "no");
    });
  }
  submitButton.textContent = "更新今日打卡";
}

function previewFile(input, preview, key) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    preview.style.backgroundImage = `url("${reader.result}")`;
    preview.classList.add("has-image");
  };
  reader.readAsDataURL(file);
  photoData[key] = "";
}

document.querySelector("#selfieInput").addEventListener("change", (event) => {
  previewFile(event.currentTarget, document.querySelector("#selfiePreview"), "selfie");
});
document.querySelector("#tongueInput").addEventListener("change", (event) => {
  previewFile(event.currentTarget, document.querySelector("#tonguePreview"), "tongue");
});

function compressImage(file, maxBytes = 180000) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 720 / Math.max(image.width, image.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      let quality = 0.78;
      let dataUrl = canvas.toDataURL("image/jpeg", quality);
      while (dataUrl.length * 0.75 > maxBytes && quality > 0.38) {
        quality -= 0.08;
        dataUrl = canvas.toDataURL("image/jpeg", quality);
      }
      resolve(dataUrl);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("照片无法读取"));
    };
    image.src = url;
  });
}

async function prepareMedia() {
  const selfieFile = checkinForm.elements.selfie.files?.[0];
  const tongueFile = checkinForm.elements.tongue.files?.[0];
  if (!selfieFile && !photoData.selfie) throw new Error("请上传正面自拍");
  if (!tongueFile && !photoData.tongue) throw new Error("请上传舌头照片");
  return {
    selfieDataUrl: selfieFile ? await compressImage(selfieFile) : photoData.selfie,
    tongueDataUrl: tongueFile ? await compressImage(tongueFile) : photoData.tongue
  };
}

async function loadExistingMedia() {
  if (!todayCheckin?.id) return;
  const snapshot = await getDoc(doc(db, "dailyCheckinMedia", todayCheckin.id));
  if (!snapshot.exists()) return;
  photoData.selfie = clean(snapshot.data().selfieDataUrl);
  photoData.tongue = clean(snapshot.data().tongueDataUrl);
  [
    ["selfie", "#selfiePreview"],
    ["tongue", "#tonguePreview"]
  ].forEach(([key, selector]) => {
    if (!photoData[key]) return;
    const preview = document.querySelector(selector);
    preview.style.backgroundImage = `url("${photoData[key]}")`;
    preview.classList.add("has-image");
  });
  checkinForm.elements.selfie.required = false;
  checkinForm.elements.tongue.required = false;
}

async function updateProfileProgress() {
  const info = planInfo(currentProfile);
  const completed = ownCheckins.filter((item) => (
    item.checkinDate >= info.startDate
    && dateDiffDays(info.startDate, item.checkinDate) < info.duration
  )).length;
  await updateDoc(doc(db, "memberProfiles", currentProfileId), {
    progress: {
      ...(currentProfile.progress || {}),
      weight: Number(ownCheckins[0]?.weight || currentProfile.progress?.weight || currentProfile.baseline?.weight || 0) || null,
      waist: Number(ownCheckins[0]?.waist || currentProfile.progress?.waist || currentProfile.baseline?.waist || 0) || null,
      checkInDays: completed,
      completionRate: Math.min(100, Math.round((completed / info.duration) * 100)),
      lastCheckinDate: ownCheckins[0]?.checkinDate || ""
    },
    updatedAt: new Date().toISOString(),
    cloudUpdatedAt: serverTimestamp()
  });
}

checkinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser || !currentProfile) return;
  if (!dailyProgramStatus?.started || !planInfo(currentProfile).started) {
    setStatus("请先确认已付款资格，并由会员本人启动 18 天计划。", true);
    renderProgramAccess(dailyProgramStatus);
    return;
  }
  submitButton.disabled = true;
  setStatus("正在压缩照片并保存...");
  try {
    const formData = new FormData(checkinForm);
    const date = malaysiaDate();
    const info = planInfo(currentProfile, date);
    const id = `DC-${currentUser.uid}-${date}`;
    const media = await prepareMedia();
    const record = {
      id,
      memberUid: currentUser.uid,
      memberEmail: normalizeEmail(currentUser.email),
      memberProfileId: currentProfileId,
      memberName: clean(currentProfile.customer?.name) || clean(currentUser.displayName),
      memberPhone: clean(currentProfile.customer?.phone),
      branchId: clean(currentProfile.branchId),
      branchName: clean(currentProfile.branchName),
      planName: info.name,
      planStartDate: info.startDate,
      planDurationDays: info.duration,
      dayNumber: info.day,
      checkinDate: date,
      timeZone: MALAYSIA_TIME_ZONE,
      weight: numberOrNull(formData.get("weight")),
      waist: numberOrNull(formData.get("waist")),
      visceralFat: numberOrNull(formData.get("visceralFat")),
      drinkProduct: clean(formData.get("drinkProduct")),
      drinkCompleted: formData.get("drinkCompleted") === "yes",
      sleepStatus: clean(formData.get("sleepStatus")),
      bowelStatus: clean(formData.get("bowelStatus")),
      dietStatus: clean(formData.get("dietStatus")),
      bodyFeeling: clean(formData.get("bodyFeeling")),
      notes: clean(formData.get("notes")).slice(0, 500),
      onTime: true,
      source: "member-daily-checkin",
      schemaVersion: 1,
      submittedAt: serverTimestamp(),
      updatedAtIso: new Date().toISOString()
    };
    await setDoc(doc(db, "dailyCheckins", id), record);
    await setDoc(doc(db, "dailyCheckinMedia", id), {
      id,
      memberUid: currentUser.uid,
      memberEmail: normalizeEmail(currentUser.email),
      selfieDataUrl: media.selfieDataUrl,
      tongueDataUrl: media.tongueDataUrl,
      updatedAt: serverTimestamp()
    });
    await loadOwnCheckins();
    await updateProfileProgress().catch(() => {});
    renderMemberSummary();
    renderHistory();
    todayCheckin = record;
    submitButton.textContent = "更新今日打卡";
    setStatus(`打卡成功。你已连续完成 ${calculateStreak(ownCheckins)} 天，本阶段完成率 ${document.querySelector("#completionRate").textContent}。`);
  } catch (error) {
    setStatus(`提交失败：${error.code || error.message || "unknown"}`, true);
  } finally {
    submitButton.disabled = false;
  }
});

function renderTemplate(template, profile) {
  const info = planInfo(profile);
  const customer = profile.customer || {};
  const link = `${location.origin}/system.html?module=checkin`;
  return template
    .replaceAll("{姓名}", clean(customer.name) || "您好")
    .replaceAll("{计划}", info.name)
    .replaceAll("{天数}", String(info.day))
    .replaceAll("{链接}", link);
}

function whatsAppUrl(profile, message) {
  const digits = clean(profile.customer?.phone).replace(/\D/g, "").replace(/^0/, "60");
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

async function loadReminderTemplate() {
  const snapshot = await getDoc(doc(db, "portalSettings", "checkinReminder"));
  reminderTemplate.value = clean(snapshot.data()?.template) || DEFAULT_TEMPLATE;
}

function getMeasurementRecords(profile) {
  const baseline = profile?.baseline || {};
  if (Array.isArray(baseline.records) && baseline.records.length) return [...baseline.records];
  const hasBaseline = ["weight", "waist", "bodyFatPct", "visceralFatLevel", "boneMassKg", "basalMetabolicRateKcal", "skeletalMusclePct", "bodyWaterPct"]
    .some((field) => baseline[field] !== null && baseline[field] !== undefined && baseline[field] !== "");
  return hasBaseline ? [{
    id: "baseline-existing",
    type: "baseline",
    label: "基线测量",
    ...baseline
  }] : [];
}

function formatMetric(value, unit = "") {
  return value === null || value === undefined || value === "" ? "-" : `${value}${unit}`;
}

function renderWeeklyMeasurementHint() {
  const profile = weeklyProfiles.find((item) => item.docId === weeklyMemberSelect.value);
  if (!profile) {
    weeklyMeasurementHint.textContent = "选择会员后会显示其初始基线数据。";
    return;
  }
  const baseline = getMeasurementRecords(profile).find((item) => item.type === "baseline") || profile.baseline || {};
  const count = getMeasurementRecords(profile).filter((item) => item.type !== "baseline").length;
  weeklyMeasurementHint.textContent = `初始基线：体重 ${formatMetric(baseline.weight, " kg")} · 腰围 ${formatMetric(baseline.waist, " cm")} · 体脂 ${formatMetric(baseline.bodyFatPct, "%")}。保存后会成为第 ${count + 1} 次后续测量。`;
}

function populateWeeklyMemberSelect(profiles) {
  if (!weeklyMemberSelect) return;
  const selected = weeklyMemberSelect.value;
  weeklyMemberSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = profiles.length ? "请选择已启动计划的会员" : "暂无已启动计划的会员";
  weeklyMemberSelect.append(placeholder);
  profiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.docId;
    option.textContent = `${clean(profile.customer?.name) || "未命名会员"} · ${clean(profile.customer?.phone) || clean(profile.customer?.email)}`;
    weeklyMemberSelect.append(option);
  });
  weeklyMemberSelect.value = profiles.some((profile) => profile.docId === selected) ? selected : "";
  renderWeeklyMeasurementHint();
}

async function loadAdminRoster() {
  memberRoster.innerHTML = "<p>正在整理今日打卡状态...</p>";
  const [profileSnapshot, checkinSnapshot] = await Promise.all([
    getDocs(collection(db, "memberProfiles")),
    getDocs(query(collection(db, "dailyCheckins"), where("checkinDate", "==", malaysiaDate())))
  ]);
  const profiles = profileSnapshot.docs
    .map((item) => ({ docId: item.id, ...item.data() }))
    .filter((item) => item.status === "active" && planInfo(item).started);
  weeklyProfiles = profiles;
  populateWeeklyMemberSelect(profiles);
  const checkedByUid = new Map(checkinSnapshot.docs.map((item) => [item.data().memberUid, item.data()]));
  const ordered = [...profiles].sort((a, b) => {
    const aDone = checkedByUid.has(a.ownerUid) || [...checkedByUid.values()].some((item) => item.memberEmail === normalizeEmail(a.customer?.email));
    const bDone = checkedByUid.has(b.ownerUid) || [...checkedByUid.values()].some((item) => item.memberEmail === normalizeEmail(b.customer?.email));
    return Number(aDone) - Number(bDone);
  });
  const checkedCount = profiles.filter((profile) => (
    [...checkedByUid.values()].some((item) => item.memberEmail === normalizeEmail(profile.customer?.email))
  )).length;
  document.querySelector("#memberTotal").textContent = profiles.length;
  document.querySelector("#checkedTotal").textContent = checkedCount;
  document.querySelector("#missingTotal").textContent = profiles.length - checkedCount;
  if (!profiles.length) {
    memberRoster.innerHTML = "<p>暂无有效会员主档。</p>";
    return;
  }
  memberRoster.innerHTML = ordered.map((profile, index) => {
    const checked = [...checkedByUid.values()].find((item) => item.memberEmail === normalizeEmail(profile.customer?.email));
    const message = renderTemplate(reminderTemplate.value || DEFAULT_TEMPLATE, profile);
    return `
      <article class="member-row ${checked ? "" : "is-missing"}">
        <div>
          <h3>${clean(profile.customer?.name) || "未命名会员"}</h3>
          <p>${clean(profile.customer?.phone) || "未填写电话"} · ${planInfo(profile).name}第 ${planInfo(profile).day} 天</p>
        </div>
        <strong class="${checked ? "done-label" : "missing-label"}">${checked ? `已打卡 ${checked.weight || "-"} kg` : "尚未打卡"}</strong>
        <div class="member-actions">
          ${checked ? "" : `<a href="${whatsAppUrl(profile, message)}" target="_blank" rel="noopener">WhatsApp 提醒</a>`}
          ${checked ? "" : `<button type="button" data-copy-index="${index}">复制文案</button>`}
        </div>
      </article>
    `;
  }).join("");
  memberRoster.querySelectorAll("[data-copy-index]").forEach((button) => {
    button.addEventListener("click", async () => {
      const profile = ordered[Number(button.dataset.copyIndex)];
      await navigator.clipboard.writeText(renderTemplate(reminderTemplate.value || DEFAULT_TEMPLATE, profile));
      button.textContent = "已复制";
    });
  });
}

document.querySelector("#saveTemplateButton").addEventListener("click", async () => {
  const template = clean(reminderTemplate.value);
  if (!template) return;
  await setDoc(doc(db, "portalSettings", "checkinReminder"), {
    template,
    updatedAt: serverTimestamp(),
    updatedBy: currentUser.email
  }, { merge: true });
  document.querySelector("#saveTemplateButton").textContent = "已保存";
});

document.querySelector("#refreshAdminButton").addEventListener("click", loadAdminRoster);

weeklyMemberSelect?.addEventListener("change", renderWeeklyMeasurementHint);

weeklyMeasurementForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const profile = weeklyProfiles.find((item) => item.docId === weeklyMemberSelect.value);
  if (!profile) {
    setStatus(weeklyMeasurementStatus, "请先选择会员。", true);
    return;
  }
  const formData = new FormData(weeklyMeasurementForm);
  const measuredOn = clean(formData.get("measuredOn"));
  const values = {
    weight: numberOrNull(formData.get("weight")),
    waist: numberOrNull(formData.get("waist")),
    bodyFatPct: numberOrZeroOrNull(formData.get("bodyFatPct")),
    visceralFatLevel: numberOrZeroOrNull(formData.get("visceralFatLevel")),
    boneMassKg: numberOrZeroOrNull(formData.get("boneMassKg")),
    basalMetabolicRateKcal: numberOrZeroOrNull(formData.get("basalMetabolicRateKcal")),
    skeletalMusclePct: numberOrZeroOrNull(formData.get("skeletalMusclePct")),
    bodyWaterPct: numberOrZeroOrNull(formData.get("bodyWaterPct"))
  };
  if (!measuredOn || !Object.values(values).some((value) => value !== null)) {
    setStatus(weeklyMeasurementStatus, "请填写测量日期，并至少录入一项身体数据。", true);
    return;
  }
  const records = getMeasurementRecords(profile);
  const weeklyCount = records.filter((item) => item.type !== "baseline").length;
  const measuredAt = `${measuredOn}T12:00:00+08:00`;
  const record = {
    id: `weekly-${Date.now()}`,
    type: "weekly",
    label: `第 ${weeklyCount + 1} 次每周测量`,
    measuredOn,
    measuredAt,
    measuredAtMYT: measurementTime(new Date(measuredAt)),
    measuredBy: normalizeEmail(currentUser?.email),
    notes: clean(formData.get("notes")).slice(0, 300),
    ...values
  };
  saveWeeklyMeasurementButton.disabled = true;
  setStatus(weeklyMeasurementStatus, "正在保存本周线下测量...");
  try {
    await updateDoc(doc(db, "memberProfiles", profile.docId), {
      baseline: {
        ...(profile.baseline || {}),
        records: [...records, record]
      },
      updatedAt: new Date().toISOString(),
      cloudUpdatedAt: serverTimestamp()
    });
    profile.baseline = { ...(profile.baseline || {}), records: [...records, record] };
    weeklyMeasurementForm.reset();
    weeklyMeasurementForm.elements.measuredOn.value = malaysiaDate();
    renderWeeklyMeasurementHint();
    setStatus(weeklyMeasurementStatus, `已保存：${clean(profile.customer?.name) || "该会员"} 的${record.label}。基线保持不变，可在会员中心查看趋势。`);
  } catch (error) {
    setStatus(weeklyMeasurementStatus, `保存失败：${error.code || error.message || "unknown"}`, true);
  } finally {
    saveWeeklyMeasurementButton.disabled = false;
  }
});

if (weeklyMeasurementForm?.elements.measuredOn) {
  weeklyMeasurementForm.elements.measuredOn.value = malaysiaDate();
}

startProgramButton.addEventListener("click", async () => {
  if (!dailyProgramStatus?.eligible || dailyProgramStatus?.started) return;
  if (!confirm("确定今天正式开始 18 天极简养生计划吗？今天会记为第 1 天。")) return;
  startProgramButton.disabled = true;
  startProgramButton.textContent = "正在开始...";
  try {
    const response = await startDailyPlan();
    const result = response.data || {};
    currentProfile = await loadProfileByEmail(currentUser.email);
    if (isAdminUser()) {
      document.querySelector("#accountLine").textContent = `${currentUser?.displayName || "Admin"} - check-in overview`;
      adminTabs.hidden = false;
      authState.hidden = true;
      await loadReminderTemplate();
      await showCheckinView("admin");
      return;
    }
    currentProfileId = currentProfile.docId;
    renderProgramAccess({
      eligible: true,
      started: true,
      startDate: result.startDate,
      durationDays: result.durationDays,
      message: result.message
    });
    await loadOwnCheckins();
    renderMemberSummary();
    renderHistory();
    setStatus("计划已开始。今天是第 1 天，可以完成今天的打卡。");
  } catch (error) {
    renderProgramAccess(dailyProgramStatus);
    programGateMessage.textContent = `无法开始：${error.message || error.code || "unknown"}`;
  }
});

function isAdminUser(user = currentUser) {
  return normalizeEmail(user?.email) === adminEmail;
}

async function showCheckinView(view) {
  const activeView = isAdminUser() && view === "admin" ? "admin" : "member";
  document.querySelectorAll("[data-view]").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.view === activeView);
  });
  memberView.hidden = activeView !== "member";
  adminView.hidden = activeView !== "admin";
  if (activeView === "admin") await loadAdminRoster();
}

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => showCheckinView(button.dataset.view));
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user?.email) {
    memberView.hidden = true;
    adminView.hidden = true;
    setAuthState("请先登录", '每日打卡只供已登录会员使用。请返回系统首页完成 Google 登录。', true);
    return;
  }
  try {
    const isAdmin = normalizeEmail(user.email) === adminEmail;
    currentProfile = await loadProfileByEmail(user.email);
    if (!currentProfile) {
      memberView.hidden = true;
      if (isAdmin) {
        document.querySelector("#accountLine").textContent = `${user.displayName || "管理员"} · 今日打卡管理`;
        adminTabs.hidden = false;
        authState.hidden = true;
        adminView.hidden = false;
        document.querySelectorAll("[data-view]").forEach((item) => {
          item.classList.toggle("is-active", item.dataset.view === "admin");
        });
        await loadReminderTemplate();
        await loadAdminRoster();
        return;
      }
      setAuthState("还没有会员主档", "请先在会员中心完成个人资料，系统才会建立你的每日打卡资料。", true);
      return;
    }
    currentProfileId = currentProfile.docId;
    document.querySelector("#accountLine").textContent = `${currentProfile.customer?.name || user.displayName || "会员"} · ${currentProfile.packageName || "极简养生计划"}`;
    authState.hidden = true;
    memberView.hidden = false;
    const programStatus = await refreshProgramAccess();
    if (programStatus.started) {
      await loadOwnCheckins();
      renderMemberSummary();
      renderHistory();
      fillTodayRecord();
      if (todayCheckin) await loadExistingMedia();
    }
    if (isAdmin) {
      adminTabs.hidden = false;
      await loadReminderTemplate();
    }
  } catch (error) {
    setAuthState("每日打卡读取失败", error.code || error.message || "unknown", true);
  }
});
