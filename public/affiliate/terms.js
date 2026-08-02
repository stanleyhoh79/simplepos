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
  getDoc,
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

const TERMS_VERSION = "1.0";
const form = document.querySelector("#termsForm");
const authStatus = document.querySelector("#authStatus");
const loginBtn = document.querySelector("#loginBtn");
const logoutBtn = document.querySelector("#logoutBtn");
const message = document.querySelector("#formMessage");
const acceptedCard = document.querySelector("#acceptedCard");
const acceptedMember = document.querySelector("#acceptedMember");
const acceptedEmail = document.querySelector("#acceptedEmail");
const acceptedVersion = document.querySelector("#acceptedVersion");
const acceptedAt = document.querySelector("#acceptedAt");
let firebaseUser = null;

function clean(value) {
  return String(value || "").trim();
}

function checked(formData, name) {
  return formData.get(name) === "on";
}

function setMessage(text, type = "") {
  message.textContent = text;
  message.className = `message ${type}`.trim();
}

function setSubmitEnabled() {
  form.querySelector('[type="submit"]').disabled = !firebaseUser;
}

function nextUrl() {
  return "../index.html?terms=accepted";
}

function formatAcceptedAt(value) {
  if (!value) return "-";
  if (value.toDate) return value.toDate().toLocaleString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function showAcceptedRecord(record = {}) {
  acceptedMember.textContent = record.memberName || record.userName || "-";
  acceptedEmail.textContent = record.userEmail || firebaseUser?.email || "-";
  acceptedVersion.textContent = record.termsVersion || TERMS_VERSION;
  acceptedAt.textContent = formatAcceptedAt(record.acceptedAt || record.updatedAt || record.cloudUpdatedAt);
  acceptedCard.classList.remove("hidden");
  form.classList.add("hidden");
  setMessage("此账号已完成首次条款确认，无需重复确认。", "success");
}

function showConfirmationForm() {
  acceptedCard.classList.add("hidden");
  form.classList.remove("hidden");
}

async function loadAcceptedRecord(user) {
  if (!user?.uid) return null;
  const snapshot = await getDoc(doc(db, "websiteTermsAcceptances", user.uid));
  if (!snapshot.exists()) return null;
  const data = snapshot.data() || {};
  if (data.status !== "accepted" || data.termsType !== "website-terms" || data.termsVersion !== TERMS_VERSION) return null;
  return data;
}

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

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!firebaseUser) {
    setMessage("请先使用 Google 登录，再确认条款。", "error");
    return;
  }
  if (!form.reportValidity()) return;

  const formData = new FormData(form);
  const memberName = clean(formData.get("memberName"));
  const typedSignature = clean(formData.get("typedSignature"));
  if (memberName.toLocaleLowerCase() !== typedSignature.toLocaleLowerCase()) {
    setMessage("电子签名必须与会员姓名一致。", "error");
    return;
  }

  const record = {
    id: firebaseUser.uid,
    userId: firebaseUser.uid,
    userEmail: firebaseUser.email || "",
    userName: firebaseUser.displayName || memberName,
    memberName,
    status: "accepted",
    termsType: "website-terms",
    termsVersion: TERMS_VERSION,
    source: "affiliate-first-login",
    acceptedAt: new Date().toISOString(),
    confirmations: {
      termsRead: checked(formData, "acceptTerms"),
      healthNotice: checked(formData, "acceptHealth"),
      electronicRecord: checked(formData, "acceptData"),
      ownDecision: checked(formData, "selfConfirm"),
    },
    typedSignature,
    userAgent: navigator.userAgent,
    updatedAt: new Date().toISOString(),
  };

  try {
    setMessage("正在保存条款确认...");
    await setDoc(doc(db, "websiteTermsAcceptances", firebaseUser.uid), {
      ...record,
      cloudUpdatedAt: serverTimestamp(),
    }, { merge: true });
    sessionStorage.setItem("websiteTermsAcceptedNow", `${firebaseUser.uid}:${TERMS_VERSION}`);
    showAcceptedRecord(record);
    setMessage("条款确认已保存，正在返回系统首页。");
    setTimeout(() => {
      location.href = nextUrl();
    }, 700);
  } catch (error) {
    setMessage(`保存失败：${error.code || error.message}`, "error");
  }
});

onAuthStateChanged(auth, async (user) => {
  firebaseUser = user;
  authStatus.textContent = user
    ? `已登录：${user.displayName || user.email}（${user.email || "无电邮"}）`
    : "未登录。请先 Google 登录后再确认条款。";
  const memberName = form.elements.memberName;
  if (user?.displayName && !memberName.value) memberName.value = user.displayName;
  if (!user) {
    showConfirmationForm();
    setMessage("");
    setSubmitEnabled();
    return;
  }
  try {
    const acceptedRecord = await loadAcceptedRecord(user);
    if (acceptedRecord) {
      showAcceptedRecord(acceptedRecord);
    } else {
      showConfirmationForm();
      setMessage("");
    }
  } catch (error) {
    showConfirmationForm();
    setMessage(`确认记录读取失败：${error.code || error.message}`, "error");
  }
  setSubmitEnabled();
});

setSubmitEnabled();
