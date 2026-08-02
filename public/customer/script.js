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
  where
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getAuth,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence
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
const form = document.querySelector("#customerIntakeForm");
const submitBtn = document.querySelector("#submitBtn");
const statusText = document.querySelector("#formStatus");
const authStatus = document.querySelector("#authStatus");
const resultPanel = document.querySelector("#submitResult");
const stepPanels = [...document.querySelectorAll("[data-step]")];
const stepChips = [...document.querySelectorAll("[data-jump-step]")];
const stepStatus = document.querySelector("#stepStatus");
const ambassadorApplyInput = form.elements.ambassadorApply;
const affiliateAgreementInput = form.elements.affiliateAgreementAccepted;
const affiliateSignatureInput = form.elements.affiliateAgreementSignature;
let currentStep = 1;
let currentUser = null;
let formUserUid = "";

function setText(selector, value) {
  const node = document.querySelector(selector);
  if (node) node.textContent = value || "-";
}

function clean(value) {
  return String(value || "").trim();
}

function checked(formData, name) {
  return formData.get(name) === "on";
}

function numberOrNull(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function numberOrZeroOrNull(value) {
  const raw = clean(value);
  if (!raw) return null;
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizePhone(value) {
  return clean(value).replace(/[^\d+]/g, "");
}

function normalizeEmail(value) {
  return clean(value).toLowerCase();
}

function memberProfileId() {
  const uid = String(currentUser?.uid || "").trim();
  if (!uid) {
    throw new Error("请先完成统一 Google 登录");
  }
  return `MP-${uid}`;
}

function setStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.classList.toggle("error", isError);
  if (stepStatus) {
    stepStatus.textContent = message;
    stepStatus.classList.toggle("error", isError);
  }
}

function setAuthStatus(message, isError = false) {
  if (!authStatus) return;
  authStatus.textContent = message;
  authStatus.classList.toggle("error", isError);
}

function showForm() {
  form.hidden = false;
  if (resultPanel) resultPanel.hidden = true;
}

function showSubmitResult(record) {
  setText("#resultFileNumber", record.fileNumber);
  setText("#resultCustomerName", record.customer.name);
  setText("#resultPhone", record.customer.phone);
  setText("#resultEmail", record.customer.email);
  setText("#resultUpdatedAt", record.customer.updatedAtMYT || record.updatedAtMYT || formatUpdatedAt(record.updatedAt));
  setText("#resultUpdatedBy", record.customer.updatedBy || record.customer.email);
  form.hidden = true;
  if (resultPanel) resultPanel.hidden = false;
  resultPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
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

function applyUnifiedUserToForm(user) {
  const emailInput = form.elements.email;
  const nameInput = form.elements.name;
  const nextUid = clean(user?.uid);
  if (formUserUid && nextUid && formUserUid !== nextUid) {
    form.reset();
    if (resultPanel) resultPanel.hidden = true;
    setStatus("");
  }
  formUserUid = nextUid;
  if (emailInput) {
    emailInput.value = user?.email || "";
    emailInput.readOnly = true;
  }
  if (nameInput && user?.displayName && !nameInput.value) {
    nameInput.value = user.displayName;
  }
}

function profileToResult(profile) {
  return {
    fileNumber: profile.latestIntakeId || profile.id || "-",
    customer: {
      name: profile.customer?.name || "-",
      phone: profile.customer?.phone || "-",
      email: profile.customer?.email || "-",
      updatedAtMYT: profile.customer?.updatedAtMYT || "",
      updatedBy: profile.customer?.updatedBy || ""
    },
    updatedAt: profile.updatedAt || ""
  };
}

async function loadMemberProfileByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  const snapshot = await getDocs(query(
    collection(db, "memberProfiles"),
    where("customer.email", "==", normalizedEmail)
  ));
  const profiles = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  return profiles.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0] || null;
}

async function loadMemberProfileForUser(user) {
  const uid = clean(user?.uid);
  if (uid) {
    const snapshot = await getDoc(doc(db, "memberProfiles", `MP-${uid}`));
    if (snapshot.exists()) return { id: snapshot.id, ...snapshot.data() };
  }
  // Legacy profiles used phone-based document IDs. Keep a read-only fallback
  // while old accounts are migrated to their Google UID document IDs.
  return loadMemberProfileByEmail(user?.email);
}

function nowText() {
  return new Intl.DateTimeFormat("en-MY", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kuala_Lumpur",
  }).format(new Date());
}

function updateAffiliateAgreementRequirement() {
  const apply = Boolean(ambassadorApplyInput?.checked);
  if (affiliateAgreementInput) affiliateAgreementInput.required = apply;
  if (affiliateSignatureInput) affiliateSignatureInput.required = apply;
}

function currentPanel() {
  return stepPanels.find((panel) => Number(panel.dataset.step) === currentStep);
}

function validateCurrentStep() {
  const panel = currentPanel();
  if (!panel) return true;
  const requiredFields = [...panel.querySelectorAll("[required]")];
  const missing = requiredFields.find((field) => !field.checkValidity());
  if (!missing) return true;
  missing.reportValidity();
  missing.focus();
  setStatus("这一页还有必填资料没有完成。填好后再点下一步。", true);
  return false;
}

function showStep(step) {
  currentStep = Math.max(1, Math.min(stepPanels.length, Number(step) || 1));
  stepPanels.forEach((panel) => {
    panel.hidden = Number(panel.dataset.step) !== currentStep;
  });
  stepChips.forEach((chip) => {
    chip.classList.toggle("active", Number(chip.dataset.jumpStep) === currentStep);
  });
  setStatus(currentStep === stepPanels.length ? "确认资料无误后提交。" : "填写这一页后点击下一步。");
  currentPanel()?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function buildStepActions() {
  stepPanels.forEach((panel, index) => {
    const step = index + 1;
    const actions = document.createElement("div");
    actions.className = "step-actions";
    if (step > 1) {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "secondary";
      back.textContent = "上一步";
      back.addEventListener("click", () => showStep(step - 1));
      actions.append(back);
    }
    if (step < stepPanels.length) {
      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "下一步";
      next.addEventListener("click", () => {
        if (validateCurrentStep()) showStep(step + 1);
      });
      actions.append(next);
    }
    panel.append(actions);
  });
}

stepChips.forEach((chip) => {
  chip.addEventListener("click", () => {
    const targetStep = Number(chip.dataset.jumpStep);
    if (targetStep > currentStep && !validateCurrentStep()) return;
    showStep(targetStep);
  });
});

function branchName(branchId) {
  if (branchId === "hq") return "总店";
  if (branchId === "branch-2") return "分行 2";
  return "分行 1";
}

function buildRecord(formData) {
  const branchId = clean(formData.get("branchId")) || "branch-1";
  const now = new Date().toISOString();
  const phone = normalizePhone(formData.get("phone"));
  const name = clean(formData.get("name"));
  const email = normalizeEmail(formData.get("email"));
  const id = `CI-${branchId}-${Date.now()}-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
  const checkInDays = Number(formData.get("checkInDays") || 0);
  const completionRate = checkInDays > 0 ? Math.round((Math.min(checkInDays, 18) / 18) * 100) : 0;
  const ambassadorApply = checked(formData, "ambassadorApply");
  const affiliateAgreementAccepted = checked(formData, "affiliateAgreementAccepted");
  const affiliateAgreementSignature = clean(formData.get("affiliateAgreementSignature"));
  const affiliateAgreementAcceptedAt = ambassadorApply && affiliateAgreementAccepted ? now : "";
  const websiteTermsAccepted = checked(formData, "websiteTermsAccepted");
  const websiteTermsOwnDecision = checked(formData, "websiteTermsOwnDecision");
  const baseline = {
    weight: numberOrNull(formData.get("weight")),
    waist: numberOrNull(formData.get("waist")),
    height: numberOrNull(formData.get("height")),
    bodyFatPct: numberOrZeroOrNull(formData.get("bodyFatPct")),
    visceralFatLevel: numberOrZeroOrNull(formData.get("visceralFatLevel")),
    boneMassKg: numberOrZeroOrNull(formData.get("boneMassKg")),
    basalMetabolicRateKcal: numberOrZeroOrNull(formData.get("basalMetabolicRateKcal")),
    skeletalMusclePct: numberOrZeroOrNull(formData.get("skeletalMusclePct")),
    bodyWaterPct: numberOrZeroOrNull(formData.get("bodyWaterPct")),
    measuredAt: now,
    measuredAtMYT: nowText()
  };
  baseline.records = [{
    id: `baseline-${Date.now()}`,
    type: "baseline",
    label: "基线测量",
    ...baseline
  }];

  return {
    id,
    fileNumber: id,
    status: "new",
    branchId,
    branchName: branchName(branchId),
    formType: clean(formData.get("formType")) || "profile",
    customer: {
      name,
      phone,
      email,
      idLast4: clean(formData.get("idLast4")).slice(0, 4),
      state: clean(formData.get("state")),
      city: clean(formData.get("city")),
      referralCode: clean(formData.get("referralCode")).toUpperCase(),
      updatedAt: now,
      updatedAtMYT: nowText(),
      updatedBy: email
    },
    packageName: clean(formData.get("packageName")),
    plan: {
      startDate: clean(formData.get("startDate")),
      targetDate: clean(formData.get("targetDate")),
      durationDays: 18,
      priceMyr: 180,
      successCheckInDays: 15
    },
    goal: clean(formData.get("goal")),
    baseline,
    healthScreen: {
      hypertension: checked(formData, "hypertension"),
      hyperlipidemia: checked(formData, "hyperlipidemia"),
      highBloodSugar: checked(formData, "highBloodSugar"),
      highCholesterol: checked(formData, "highCholesterol"),
      highUricAcid: checked(formData, "highUricAcid"),
      allergy: checked(formData, "allergy"),
      otherHighRiskNotAccepted: true,
      healthNote: clean(formData.get("healthNote"))
    },
    lifestyle: {
      sleep: clean(formData.get("sleep")),
      water: clean(formData.get("water")),
      diet: clean(formData.get("diet"))
    },
    progress: {
      weight: numberOrNull(formData.get("weight")),
      waist: numberOrNull(formData.get("waist")),
      checkInDays: Number.isFinite(checkInDays) ? Math.max(0, Math.min(18, checkInDays)) : 0,
      completionRate,
      progressNote: clean(formData.get("progressNote")),
      healthNote: clean(formData.get("healthNote"))
    },
    caseAuthorization: {
      publicConsent: checked(formData, "casePublicConsent"),
      allowName: checked(formData, "allowName"),
      allowPhoto: checked(formData, "allowPhoto"),
      allowBodyData: checked(formData, "allowBodyData"),
      allowAnonymous: checked(formData, "allowAnonymous"),
      note: clean(formData.get("caseNote"))
    },
    ambassadorApplication: {
      apply: ambassadorApply,
      platforms: clean(formData.get("platforms")),
      language: clean(formData.get("language")),
      note: clean(formData.get("ambassadorNote")),
      status: ambassadorApply ? "agreement-accepted-pending-review" : "not-applied",
      agreement: {
        accepted: ambassadorApply && affiliateAgreementAccepted,
        agreementType: "marketing-affiliate",
        agreementVersion: "1.0",
        acceptedAt: affiliateAgreementAcceptedAt,
        acceptedAtMYT: affiliateAgreementAcceptedAt ? nowText() : "",
        typedSignature: affiliateAgreementSignature,
        source: "customer-health-profile-step-7-embedded-full",
        confirmations: {
          adultAndTrueInfo: ambassadorApply && affiliateAgreementAccepted,
          agreementRead: ambassadorApply && affiliateAgreementAccepted,
          relationshipDisclosure: ambassadorApply && affiliateAgreementAccepted,
          noMedicalOrGuaranteedClaims: ambassadorApply && affiliateAgreementAccepted,
          pdpaConsent: ambassadorApply && affiliateAgreementAccepted,
          ownDecision: ambassadorApply && affiliateAgreementAccepted
        }
      }
    },
    websiteTerms: {
      accepted: websiteTermsAccepted && websiteTermsOwnDecision,
      status: websiteTermsAccepted && websiteTermsOwnDecision ? "accepted" : "missing",
      termsType: "website-terms",
      termsVersion: "1.0",
      acceptedAt: websiteTermsAccepted && websiteTermsOwnDecision ? now : "",
      acceptedAtMYT: websiteTermsAccepted && websiteTermsOwnDecision ? nowText() : "",
      source: "customer-health-profile-main",
      confirmations: {
        termsRead: websiteTermsAccepted,
        healthNotice: websiteTermsAccepted,
        electronicRecord: websiteTermsAccepted,
        ownDecision: websiteTermsOwnDecision
      }
    },
    pdpaConsent: true,
    medicalDisclaimerAccepted: true,
    source: "customer-self-form",
    createdAt: now,
    updatedAt: now,
    cloudCreatedAt: serverTimestamp(),
    cloudUpdatedAt: serverTimestamp()
  };
}

function buildMemberProfile(record) {
  return {
    id: memberProfileId(),
    memberUid: currentUser?.uid || "",
    source: "customer-self-form",
    status: "active",
    branchId: record.branchId,
    branchName: record.branchName,
    latestIntakeId: record.id,
    latestFormType: record.formType,
    packageName: record.packageName,
    goal: record.goal,
    customer: {
      name: record.customer.name,
      phone: record.customer.phone,
      email: record.customer.email,
      idLast4: record.customer.idLast4,
      state: record.customer.state,
      city: record.customer.city,
      referralCode: record.customer.referralCode,
      updatedAt: record.customer.updatedAt,
      updatedAtMYT: record.customer.updatedAtMYT,
      updatedBy: record.customer.updatedBy
    },
    plan: record.plan,
    baseline: record.baseline,
    healthScreen: record.healthScreen,
    lifestyle: record.lifestyle,
    progress: record.progress,
    caseAuthorization: record.caseAuthorization,
    ambassadorApplication: record.ambassadorApplication,
    websiteTerms: record.websiteTerms,
    pdpaConsent: record.pdpaConsent,
    medicalDisclaimerAccepted: record.medicalDisclaimerAccepted,
    updatedAt: record.updatedAt,
    cloudUpdatedAt: serverTimestamp()
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!currentUser?.email) {
    form.hidden = true;
    setAuthStatus("请先回到简单系统主页完成统一 Google 登录。", true);
    setStatus("未登录状态不能提交个人资料。", true);
    return;
  }
  if (form.elements.email) {
    form.elements.email.value = currentUser.email;
  }
  updateAffiliateAgreementRequirement();
  const formData = new FormData(form);
  if (!formData.get("websiteTermsAccepted") || !formData.get("websiteTermsOwnDecision")) {
    showStep(1);
    setStatus("请先在主档资料确认网站条款、健康提示、个人资料保护通知与电子记录。", true);
    return;
  }
  if (!formData.get("pdpaConsent")) {
    setStatus("请先勾选个人资料保护通知与服务跟进同意。", true);
    return;
  }
  const record = buildRecord(formData);
  if (normalizeEmail(record.customer.email) !== normalizeEmail(currentUser.email)) {
    setStatus("个人资料必须使用当前登录的 Google 电邮提交。", true);
    return;
  }
  if (!record.customer.name || !record.customer.phone || !record.customer.email) {
    setStatus("请填写姓名、电话和 Google 电邮，系统才能自动关联会员资料。", true);
    return;
  }
  if (record.ambassadorApplication.apply && !record.ambassadorApplication.agreement.accepted) {
    showStep(7);
    setStatus("申请推广大使时，请同步确认营销联盟协议。", true);
    return;
  }
  if (record.ambassadorApplication.apply && normalizeEmail(record.ambassadorApplication.agreement.typedSignature) !== normalizeEmail(record.customer.name)) {
    showStep(7);
    setStatus("电子签名需要和主档姓名一致。", true);
    affiliateSignatureInput?.focus();
    return;
  }
  submitBtn.disabled = true;
  setStatus("正在提交，请稍候...");
  try {
    try {
      await setDoc(doc(db, "customerIntakes", record.id), record);
    } catch (error) {
      throw new Error(`顾客档案写入失败：${error.code || error.message || "unknown"}`);
    }
    try {
      await setDoc(doc(db, "memberProfiles", memberProfileId()), buildMemberProfile(record), { merge: true });
    } catch (error) {
      throw new Error(`会员主档写入失败：${error.code || error.message || "unknown"}`);
    }
    localStorage.setItem("simpleposLatestMemberProfile", JSON.stringify({
      id: memberProfileId(),
      intakeId: record.id,
      name: record.customer.name,
      phone: record.customer.phone,
      email: record.customer.email,
      updatedAt: record.updatedAt
    }));
    form.reset();
    showSubmitResult(record);
    setStatus("完整档案已提交。工作人员会根据资料协助跟进。");
  } catch (error) {
    console.error("Customer intake submit failed", error);
    setStatus(`提交失败：${error.code || error.message || "请检查网络后重试"}`, true);
  } finally {
    submitBtn.disabled = false;
  }
});

ambassadorApplyInput?.addEventListener("change", updateAffiliateAgreementRequirement);
updateAffiliateAgreementRequirement();
buildStepActions();
form.hidden = true;
if (resultPanel) resultPanel.hidden = true;
setAuthStatus("正在检查统一登录状态...");
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user?.email) {
    formUserUid = "";
    form.hidden = true;
    if (resultPanel) resultPanel.hidden = true;
    setAuthStatus("未登录。请先回到简单系统主页使用 Google 登录，登录后才能填写个人资料。", true);
    setStatus("未登录状态只能浏览系统概览，不能使用个人资料功能。", true);
    return;
  }

  setAuthStatus(`已登录：${user.email}。正在检查会员主档...`);
  applyUnifiedUserToForm(user);
  try {
    const profile = await loadMemberProfileForUser(user);
    if (profile) {
      showSubmitResult(profileToResult(profile));
      setAuthStatus("已找到你的会员主档。个人资料填写入口已遮蔽，请到会员中心查阅与更新。");
      setStatus("个人资料已完成。请进入会员中心查阅与更新资料。");
      return;
    }
  } catch (error) {
    console.warn("Could not load existing member profile", error);
    setAuthStatus("暂时无法读取会员主档。你仍可继续填写，提交时系统会再次核对。", true);
  }
  showForm();
  showStep(1);
  setAuthStatus(`已登录：${user.email}。请完成自己的个人资料主档。`);
});
