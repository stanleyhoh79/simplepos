import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  doc,
  getFirestore,
  serverTimestamp,
  setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

let configModule;
try {
  configModule = await import("../shared/firebase-config.local.js");
} catch {
  configModule = await import("../shared/firebase-config.js");
}

const { firebaseConfig } = configModule;
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: "select_account" });

const form = document.querySelector("#agreementForm");
const authStatus = document.querySelector("#authStatus");
const loginBtn = document.querySelector("#loginBtn");
const logoutBtn = document.querySelector("#logoutBtn");
const assistedSelect = document.querySelector("#assisted");
const assistFields = document.querySelector("#assistFields");
const confirmedAtText = document.querySelector("#confirmedAtText");
const message = document.querySelector("#formMessage");
const receipt = document.querySelector("#receipt");
const receiptGrid = document.querySelector("#receiptGrid");
const downloadBtn = document.querySelector("#downloadBtn");

let firebaseUser = null;
let lastRecord = null;

function nowText() {
  return new Intl.DateTimeFormat("en-MY", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(new Date());
}

function nowIso() {
  return new Date().toISOString();
}

function setMessage(text, type = "") {
  message.textContent = text;
  message.className = `message ${type}`.trim();
}

function clean(value) {
  return String(value || "").trim();
}

function checkbox(formData, name) {
  return formData.get(name) === "on";
}

function scheduleValue(name) {
  return clean(document.querySelector(`[name="${name}"]`)?.value);
}

function currentAgreementId() {
  return firebaseUser ? firebaseUser.uid : "";
}

function setSubmitEnabled() {
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = !firebaseUser;
}

function renderReceipt(record) {
  receiptGrid.innerHTML = [
    ["会员", record.member.name],
    ["Google 账号", record.member.email],
    ["协议版本", record.agreementVersion],
    ["确认时间", record.acceptedAtMYT],
    ["联盟编号 / 推荐码", record.member.affiliateId || "待分配"],
    ["确认语言", record.member.language],
    ["协助确认", record.assistance.assisted ? `${record.assistance.helper} · ${record.assistance.method}` : "无"],
    ["云端编号", record.id],
  ].map(([key, value]) => `<div><strong>${key}：</strong>${escapeHtml(value)}</div>`).join("");
  receipt.hidden = false;
}

function buildRecord() {
  const formData = new FormData(form);
  const memberName = clean(formData.get("memberName"));
  const typedSignature = clean(formData.get("typedSignature"));
  const signatureMatches = memberName.toLocaleLowerCase() === typedSignature.toLocaleLowerCase();
  if (!signatureMatches) {
    throw new Error("电子签名必须与会员法定姓名一致。");
  }

  const assisted = formData.get("assisted") === "yes";
  if (assisted && (!clean(formData.get("helperName")) || !clean(formData.get("helpMethod")))) {
    throw new Error("有协助阅读或操作时，必须填写协助人和协助方式。");
  }

  return {
    id: currentAgreementId(),
    userId: firebaseUser.uid,
    userEmail: firebaseUser.email || clean(formData.get("email")),
    status: "submitted",
    agreementType: "marketing-affiliate",
    agreementVersion: document.querySelector("#versionLabel").textContent,
    acceptedAt: nowIso(),
    acceptedAtMYT: confirmedAtText.value,
    member: {
      name: memberName,
      mobile: clean(formData.get("mobile")),
      email: clean(formData.get("email")),
      affiliateId: clean(formData.get("affiliateId")),
      language: clean(formData.get("language")),
    },
    assistance: assisted ? {
      assisted: true,
      helper: clean(formData.get("helperName")),
      method: clean(formData.get("helpMethod")),
      notes: clean(formData.get("helpNotes")),
    } : {
      assisted: false,
      helper: "",
      method: "",
      notes: "",
    },
    scheduleA: {
      commission: scheduleValue("commission"),
      eligibleTransactions: scheduleValue("eligible"),
      attribution: scheduleValue("attribution"),
      payout: scheduleValue("payout"),
      minimumPayout: scheduleValue("minimum"),
      reversal: scheduleValue("reversal"),
    },
    confirmations: {
      adultAndTrueInfo: checkbox(formData, "c1"),
      agreementRead: checkbox(formData, "c2"),
      relationshipDisclosure: checkbox(formData, "c3"),
      noMedicalOrGuaranteedClaims: checkbox(formData, "c4"),
      pdpaConsent: checkbox(formData, "c5"),
      ownDecision: checkbox(formData, "c6"),
    },
    typedSignature,
    source: "affiliate-online-agreement",
    userAgent: navigator.userAgent,
    updatedAt: nowIso(),
  };
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

confirmedAtText.value = nowText();
setSubmitEnabled();

assistedSelect.addEventListener("change", () => {
  const assisted = assistedSelect.value === "yes";
  assistFields.hidden = !assisted;
  assistFields.querySelector('[name="helperName"]').required = assisted;
  assistFields.querySelector('[name="helpMethod"]').required = assisted;
});

loginBtn.addEventListener("click", async () => {
  try {
    if (auth.currentUser) {
      setMessage(`已登录：${auth.currentUser.email || auth.currentUser.displayName || "Google 账号"}`, "success");
      return;
    }
    await signInWithPopup(auth, provider);
  } catch (error) {
    setMessage(`Google 登录失败：${error.code || error.message}`, "error");
  }
});

logoutBtn.addEventListener("click", async () => {
  localStorage.setItem("simplepos-force-account-choice", "1");
  await signOut(auth);
});

document.querySelector("#printBtn").addEventListener("click", () => window.print());

form.addEventListener("reset", () => {
  setTimeout(() => {
    confirmedAtText.value = nowText();
    assistFields.hidden = true;
    receipt.hidden = true;
    lastRecord = null;
    setMessage("");
  }, 0);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  confirmedAtText.value = nowText();
  if (!firebaseUser) {
    setMessage("请先使用 Google 登录，再提交协议确认。", "error");
    return;
  }
  if (!form.reportValidity()) return;

  try {
    setMessage("正在保存协议确认记录...");
    const record = buildRecord();
    await setDoc(doc(db, "affiliateAgreements", record.id), {
      ...record,
      cloudUpdatedAt: serverTimestamp(),
    }, { merge: true });
    lastRecord = record;
    renderReceipt(record);
    setMessage("协议确认已保存到云端。");
  } catch (error) {
    setMessage(error.message || `保存失败：${error.code || "unknown"}`, "error");
  }
});

downloadBtn.addEventListener("click", () => {
  if (!lastRecord) return;
  const blob = new Blob([JSON.stringify(lastRecord, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `affiliate-agreement-${lastRecord.member.email || Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

onAuthStateChanged(auth, (user) => {
  firebaseUser = user;
  authStatus.textContent = user
    ? `已登录：${user.displayName || user.email}（${user.email || "无电邮"}）`
    : "未登录。请先 Google 登录后再提交。";
  const emailInput = form.elements.email;
  if (user?.email && !emailInput.value) emailInput.value = user.email;
  setSubmitEnabled();
});
