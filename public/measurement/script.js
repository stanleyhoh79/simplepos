import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  collection,
  doc,
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  browserLocalPersistence,
  getAuth,
  onAuthStateChanged,
  setPersistence
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
const adminEmail = String(configModule.adminEmail || "").trim().toLowerCase();
await setPersistence(auth, browserLocalPersistence).catch(() => {});

const authState = document.querySelector("#authState");
const memberView = document.querySelector("#memberView");
const adminView = document.querySelector("#adminView");
const memberName = document.querySelector("#memberName");
const memberMessage = document.querySelector("#memberMessage");
const trendGrid = document.querySelector("#trendGrid");
const measurementHistory = document.querySelector("#measurementHistory");
const weeklyMeasurementForm = document.querySelector("#weeklyMeasurementForm");
const weeklyMemberSelect = document.querySelector("#weeklyMemberSelect");
const weeklyMeasurementHint = document.querySelector("#weeklyMeasurementHint");
const weeklyMeasurementStatus = document.querySelector("#weeklyMeasurementStatus");
const saveWeeklyMeasurementButton = document.querySelector("#saveWeeklyMeasurementButton");

let currentUser = null;
let currentProfile = null;
let weeklyProfiles = [];

const metricDefinitions = [
  ["weight", "体重", "kg"],
  ["waist", "腰围", "cm"],
  ["bodyFatPct", "体脂", "%"],
  ["visceralFatLevel", "内脏脂肪", ""],
  ["boneMassKg", "骨量", "kg"],
  ["basalMetabolicRateKcal", "基础代谢", "kcal/日"],
  ["skeletalMusclePct", "骨骼肌", "%"],
  ["bodyWaterPct", "体水分", "%"]
];

function clean(value) {
  return String(value || "").trim();
}

function malaysiaDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function malaysiaTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function numberOrNull(value, allowZero = false) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : null;
}

function recordValue(record, key) {
  return record?.metrics?.[key] ?? record?.[key] ?? null;
}

function recordsFor(profile) {
  const stored = Array.isArray(profile?.baseline?.records) ? profile.baseline.records : [];
  if (stored.length) return stored;
  return profile?.baseline ? [{ type: "baseline", label: "基线测量", ...profile.baseline }] : [];
}

function formatMetric(value, unit = "") {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric}${unit ? ` ${unit}` : ""}` : "未记录";
}

function deltaText(current, reference, unit) {
  const latest = Number(current);
  const base = Number(reference);
  if (!Number.isFinite(latest) || !Number.isFinite(base)) return "暂无可比较数据";
  const delta = latest - base;
  if (delta === 0) return "与对照持平";
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)} ${unit}`;
}

function recordTitle(record, fallbackIndex) {
  if (record?.type === "baseline") return "基线测量";
  return clean(record?.label) || `第 ${fallbackIndex} 次每周测量`;
}

function setStatus(message, isError = false) {
  weeklyMeasurementStatus.textContent = message;
  weeklyMeasurementStatus.classList.toggle("is-error", isError);
}

function renderMemberProfile(profile) {
  const records = recordsFor(profile);
  const baseline = records.find((record) => record.type === "baseline") || records[0];
  const weeklyRecords = records.filter((record) => record !== baseline);
  const latest = weeklyRecords.at(-1) || baseline;
  const previous = weeklyRecords.length > 1 ? weeklyRecords.at(-2) : baseline;
  const name = clean(profile.customer?.name) || "会员";

  memberName.textContent = `${name}的每周变化`;
  memberMessage.textContent = weeklyRecords.length
    ? `已有 ${weeklyRecords.length} 次每周测量。重点不是一次数字，而是看见持续养生带来的变化。`
    : "目前只有初始基线。完成一周养生后，可由工作人员录入第一次线下测量。";

  const cards = [
    ["最新体重", formatMetric(recordValue(latest, "weight"), "kg"), `较基线 ${deltaText(recordValue(latest, "weight"), recordValue(baseline, "weight"), "kg")}`],
    ["最新腰围", formatMetric(recordValue(latest, "waist"), "cm"), `较基线 ${deltaText(recordValue(latest, "waist"), recordValue(baseline, "waist"), "cm")}`],
    ["本周变化", deltaText(recordValue(latest, "weight"), recordValue(previous, "weight"), "kg"), `体脂变化 ${deltaText(recordValue(latest, "bodyFatPct"), recordValue(previous, "bodyFatPct"), "%")}`]
  ];
  trendGrid.replaceChildren(...cards.map(([label, value, note]) => {
    const card = document.createElement("article");
    card.className = "trend-card";
    card.innerHTML = `<span>${label}</span><strong>${value}</strong><small>${note}</small>`;
    return card;
  }));

  measurementHistory.replaceChildren(...[...records].reverse().map((record, index) => {
    const item = document.createElement("article");
    item.className = "measurement-record";
    const values = metricDefinitions
      .map(([key, label, unit]) => {
        const value = recordValue(record, key);
        return Number.isFinite(Number(value)) ? `${label} ${formatMetric(value, unit)}` : "";
      })
      .filter(Boolean)
      .join(" · ");
    const date = clean(record.measuredAtMYT) || clean(record.measuredOn) || "未记录日期";
    const note = clean(record.notes);
    item.innerHTML = `<h3><span class="record-label">${recordTitle(record, records.length - index - 1)}</span> · ${date}</h3><p>${values || "尚未录入身体指标"}</p>${note ? `<p>观察：${note}</p>` : ""}`;
    return item;
  }));
}

function renderWeeklyMeasurementHint() {
  const profile = weeklyProfiles.find((item) => item.docId === weeklyMemberSelect.value);
  if (!profile) {
    weeklyMeasurementHint.textContent = "选择会员后会显示其初始基线数据。";
    return;
  }
  const records = recordsFor(profile);
  const baseline = records.find((item) => item.type === "baseline") || records[0] || {};
  const weeklyCount = records.filter((item) => item !== baseline).length;
  weeklyMeasurementHint.textContent = `初始基线：体重 ${formatMetric(recordValue(baseline, "weight"), "kg")} · 腰围 ${formatMetric(recordValue(baseline, "waist"), "cm")} · 体脂 ${formatMetric(recordValue(baseline, "bodyFatPct"), "%")}。保存后将成为第 ${weeklyCount + 1} 次每周测量。`;
}

function populateWeeklyMemberSelect(profiles) {
  weeklyMemberSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = profiles.length ? "请选择已启动养生计划的会员" : "暂无已启动养生计划的会员";
  weeklyMemberSelect.append(placeholder);
  profiles.forEach((profile) => {
    const option = document.createElement("option");
    option.value = profile.docId;
    option.textContent = `${clean(profile.customer?.name) || "未命名会员"} · ${clean(profile.customer?.phone) || clean(profile.customer?.email)}`;
    weeklyMemberSelect.append(option);
  });
  renderWeeklyMeasurementHint();
}

async function loadAdminProfiles() {
  const snapshot = await getDocs(collection(db, "memberProfiles"));
  weeklyProfiles = snapshot.docs
    .map((item) => ({ docId: item.id, ...item.data() }))
    .filter((profile) => profile.status === "active" && profile.dailyProgram?.startedAt);
  populateWeeklyMemberSelect(weeklyProfiles);
}

async function loadMemberProfile(email) {
  const snapshot = await getDocs(query(collection(db, "memberProfiles"), where("customer.email", "==", email)));
  if (snapshot.empty) return null;
  const first = snapshot.docs[0];
  return { docId: first.id, ...first.data() };
}

weeklyMemberSelect.addEventListener("change", renderWeeklyMeasurementHint);

weeklyMeasurementForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const profile = weeklyProfiles.find((item) => item.docId === weeklyMemberSelect.value);
  const formData = new FormData(weeklyMeasurementForm);
  const measuredOn = clean(formData.get("measuredOn"));
  const metrics = Object.fromEntries(metricDefinitions.map(([key]) => [key, numberOrNull(formData.get(key), key !== "weight" && key !== "waist")]));
  if (!profile) return setStatus("请先选择会员。", true);
  if (!measuredOn || !Object.values(metrics).some((value) => value !== null)) {
    return setStatus("请填写测量日期，并至少录入一项身体数据。", true);
  }

  const records = recordsFor(profile);
  const baseline = records.find((item) => item.type === "baseline") || records[0];
  const weeklyCount = records.filter((item) => item !== baseline).length;
  const measuredAt = `${measuredOn}T12:00:00+08:00`;
  const record = {
    id: `weekly-${Date.now()}`,
    type: "weekly",
    label: `第 ${weeklyCount + 1} 次每周测量`,
    measuredOn,
    measuredAt,
    measuredAtMYT: malaysiaTime(new Date(measuredAt)),
    measuredBy: currentUser.email,
    notes: clean(formData.get("notes")),
    metrics
  };

  saveWeeklyMeasurementButton.disabled = true;
  setStatus("正在保存本周线下测量...");
  try {
    await updateDoc(doc(db, "memberProfiles", profile.docId), {
      baseline: { ...(profile.baseline || {}), records: [...records, record] },
      updatedAt: new Date().toISOString(),
      cloudUpdatedAt: serverTimestamp()
    });
    profile.baseline = { ...(profile.baseline || {}), records: [...records, record] };
    weeklyMeasurementForm.reset();
    weeklyMeasurementForm.elements.measuredOn.value = malaysiaDate();
    renderWeeklyMeasurementHint();
    setStatus(`已保存 ${clean(profile.customer?.name) || "该会员"} 的${record.label}。会员可立即查看趋势和成果。`);
    if (currentProfile?.docId === profile.docId) renderMemberProfile(profile);
  } catch (error) {
    setStatus(`保存失败：${error.code || error.message || "unknown"}`, true);
  } finally {
    saveWeeklyMeasurementButton.disabled = false;
  }
});

weeklyMeasurementForm.elements.measuredOn.value = malaysiaDate();

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user?.email) {
    authState.innerHTML = "<strong>请先登录</strong><span>登录后才可查看自己的每周测量趋势。</span>";
    return;
  }
  try {
    currentProfile = await loadMemberProfile(user.email);
    if (!currentProfile) {
      authState.innerHTML = "<strong>还没有个人资料</strong><span>请先完成个人资料，建立初始身体基线后再查看每周测量。</span>";
    } else {
      authState.hidden = true;
      memberView.hidden = false;
      renderMemberProfile(currentProfile);
    }
    if (clean(user.email).toLowerCase() === adminEmail) {
      adminView.hidden = false;
      await loadAdminProfiles();
    }
  } catch (error) {
    authState.innerHTML = `<strong>读取失败</strong><span>${error.code || error.message || "unknown"}</span>`;
  }
});
