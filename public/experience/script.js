import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

let configModule;
try {
  configModule = await import("../shared/firebase-config.local.js");
} catch {
  configModule = await import("../shared/firebase-config.js");
}

const app = getApps().length ? getApp() : initializeApp(configModule.firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const title = document.querySelector("#experienceTitle");
const description = document.querySelector("#experienceDescription");
const statusLine = document.querySelector("#experienceStatus");
const startButton = document.querySelector("#startExperienceButton");
const completeButton = document.querySelector("#completeExperienceButton");
const completionChoices = document.querySelector("#completionChoices");
const waiveRefundCheck = document.querySelector("#waiveRefundCheck");
const activateAffiliateButton = document.querySelector("#activateAffiliateButton");
const requestRefundButton = document.querySelector("#requestRefundButton");

const defaultExperienceSettings = {
  eyebrow: "极简养生 · 新会员体验",
  title: "极简养生计划体验版",
  intro: "先用最简单的方式认识计划。体验内容与操作步骤会在这里逐步开放，无需额外重复填写资料。",
  noticeTitle: "体验版如何使用",
  noticeText: "体验由会员自行开始。你可以先试用每日打卡、每周测量和个人资料功能，再决定是否正式加入。",
  step1Title: "认识计划",
  step1Text: "了解体验版的节奏与适用方式。",
  step2Title: "自行开始",
  step2Text: "准备好后由会员自行启动，不会自动开始正式计划。",
  step3Title: "记录变化",
  step3Text: "使用每日打卡与每周测量，观察身体与习惯的变化。",
  completionNote: "体验结束后，你可以正式加入并激活简单联盟，或提交退款申请。未选择前，简单联盟会保持不可用。"
};

let currentUser = null;
let currentState = null;

function setText(selector, value) {
  const element = document.querySelector(selector);
  if (element && typeof value === "string" && value.trim()) element.textContent = value.trim();
}

async function loadExperienceSettings() {
  try {
    const snapshot = await getDoc(doc(db, "portalSettings", "experience"));
    const settings = { ...defaultExperienceSettings, ...(snapshot.exists() ? snapshot.data() : {}) };
    setText("main > .eyebrow", settings.eyebrow);
    setText("h1", settings.title);
    setText(".intro", settings.intro);
    setText(".notice strong", settings.noticeTitle);
    setText(".notice p", settings.noticeText);
    const steps = [...document.querySelectorAll(".steps .step")];
    [["step1Title", "step1Text"], ["step2Title", "step2Text"], ["step3Title", "step3Text"]].forEach(([titleKey, textKey], index) => {
      setText(`.steps .step:nth-child(${index + 1}) strong`, settings[titleKey]);
      setText(`.steps .step:nth-child(${index + 1}) p`, settings[textKey]);
    });
    setText("#completionChoices > p", settings.completionNote);
  } catch {
    // The experience flow remains usable with the built-in text when offline.
  }
}

function postExperienceState(status) {
  if (window.parent === window) return;
  window.parent.postMessage({ type: "simplepos-experience-state", status }, window.location.origin);
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (label) button.textContent = label;
}

function renderState(data) {
  currentState = data || null;
  const status = data?.status || "not_started";
  startButton.hidden = true;
  completeButton.hidden = true;
  completionChoices.hidden = true;

  if (status === "not_started") {
    title.textContent = "准备开始体验";
    description.textContent = "体验由你自行启动。开始后可使用每日打卡与每周测量，正式计划不会自动开始。";
    statusLine.textContent = "尚未开始：请在准备好后点击“开始体验”。";
    startButton.hidden = false;
    return;
  }
  if (status === "in_progress") {
    title.textContent = "体验进行中";
    description.textContent = "按自己的节奏试用系统。觉得已完成体验时，再进入下一步作出选择。";
    statusLine.textContent = "体验进行中：简单联盟暂时不可用。";
    completeButton.hidden = false;
    return;
  }
  if (status === "completed_pending_choice") {
    title.textContent = "体验已完成";
    description.textContent = "现在请选择下一步。正式加入后，简单联盟会立即开放。";
    statusLine.textContent = "等待你的决定：联盟功能仍处于锁定状态。";
    completionChoices.hidden = false;
    return;
  }
  if (status === "affiliate_activated") {
    title.textContent = "已正式加入";
    description.textContent = "简单联盟已经激活。你现在可以从左侧进入推荐、协议与佣金功能。";
    statusLine.textContent = "已完成体验并激活简单联盟。";
    postExperienceState(status);
    return;
  }
  if (status === "refund_requested") {
    title.textContent = "退款申请已提交";
    description.textContent = "工作人员会根据实际订单及适用政策处理你的申请。";
    statusLine.textContent = "退款处理中：简单联盟不会开放。";
    return;
  }
}

async function saveExperience(next) {
  if (!currentUser) return;
  const reference = doc(db, "memberExperiences", currentUser.uid);
  await setDoc(reference, {
    memberUid: currentUser.uid,
    memberEmail: currentUser.email || "",
    schemaVersion: 1,
    ...next,
    updatedAt: serverTimestamp()
  }, { merge: true });
  const saved = await getDoc(reference);
  renderState(saved.exists() ? saved.data() : null);
}

startButton.addEventListener("click", async () => {
  setBusy(startButton, true, "正在开始...");
  try {
    await saveExperience({ status: "in_progress", startedAt: serverTimestamp() });
  } catch (error) {
    statusLine.textContent = `无法开始体验：${error.code || error.message}`;
  } finally {
    setBusy(startButton, false, "开始体验");
  }
});

completeButton.addEventListener("click", async () => {
  setBusy(completeButton, true, "正在保存...");
  try {
    await saveExperience({ status: "completed_pending_choice", completedAt: serverTimestamp() });
  } catch (error) {
    statusLine.textContent = `无法完成体验：${error.code || error.message}`;
  } finally {
    setBusy(completeButton, false, "我已完成体验");
  }
});

activateAffiliateButton.addEventListener("click", async () => {
  if (!waiveRefundCheck.checked) {
    statusLine.textContent = "请先确认正式加入，并放弃本体验阶段的退款权益。";
    return;
  }
  setBusy(activateAffiliateButton, true, "正在激活...");
  try {
    await saveExperience({
      status: "affiliate_activated",
      refundDecision: "waived",
      affiliateActivatedAt: serverTimestamp()
    });
  } catch (error) {
    statusLine.textContent = `无法激活简单联盟：${error.code || error.message}`;
  } finally {
    setBusy(activateAffiliateButton, false, "正式加入并激活简单联盟");
  }
});

requestRefundButton.addEventListener("click", async () => {
  setBusy(requestRefundButton, true, "正在提交...");
  try {
    const requestId = `experience-${currentUser.uid}`;
    await setDoc(doc(db, "experienceRefundRequests", requestId), {
      id: requestId,
      memberUid: currentUser.uid,
      memberEmail: currentUser.email || "",
      status: "pending",
      reason: "体验后申请退款",
      source: "member-experience",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });
    await saveExperience({
      status: "refund_requested",
      refundDecision: "requested",
      refundRequestedAt: serverTimestamp()
    });
  } catch (error) {
    statusLine.textContent = `无法提交退款申请：${error.code || error.message}`;
  } finally {
    setBusy(requestRefundButton, false, "申请退款");
  }
});

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  if (!user) {
    title.textContent = "请先登录";
    description.textContent = "登录后才能保存体验进度与作出正式加入或退款选择。";
    statusLine.textContent = "尚未登录。";
    startButton.hidden = true;
    return;
  }
  try {
    const snapshot = await getDoc(doc(db, "memberExperiences", user.uid));
    renderState(snapshot.exists() ? snapshot.data() : null);
  } catch (error) {
    statusLine.textContent = `无法读取体验状态：${error.code || error.message}`;
  }
});

loadExperienceSettings();
