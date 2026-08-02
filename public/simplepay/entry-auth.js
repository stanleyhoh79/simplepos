import {
  getApp,
  getApps,
  initializeApp,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  browserLocalPersistence,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  setPersistence,
  signInWithPopup,
  signInWithRedirect,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

let configModule;
try {
  configModule = await import("../shared/firebase-config.local.js");
} catch {
  configModule = await import("../shared/firebase-config.js");
}

const VALID_ROLES = ["user", "merchant", "admin"];
const roleTitles = {
  user: "用户界面",
  merchant: "商家界面",
  admin: "后台界面",
};
const roleFromUrl = new URLSearchParams(window.location.search).get("role");
const initialRole = VALID_ROLES.includes(roleFromUrl) ? roleFromUrl : "";
const app = getApps().length ? getApp() : initializeApp(configModule.firebaseConfig);
const auth = getAuth(app);
await setPersistence(auth, browserLocalPersistence).catch(() => {});
const provider = new GoogleAuthProvider();

function rememberRole(role) {
  if (!VALID_ROLES.includes(role)) return;
  sessionStorage.setItem("activeRole", role);
  window.__simplePaySelectedRole = role;
}

function focusRoleChoice(role) {
  if (!VALID_ROLES.includes(role)) return;
  document.querySelector(".entry-links")?.classList.add("hidden");
  document.querySelectorAll(".auth-action").forEach((button) => {
    const card = button.closest(".login-choice");
    if (card) card.classList.toggle("hidden", button.dataset.target !== role);
  });
}

function showGateway(role = initialRole) {
  document.querySelector("#login-gateway")?.classList.remove("hidden");
  document.querySelector("#app-shell")?.classList.add("locked");
  const subtitle = document.querySelector(".brand-light span");
  if (VALID_ROLES.includes(role)) {
    if (subtitle) subtitle.textContent = `正在进入${roleTitles[role]}`;
    focusRoleChoice(role);
    return;
  }
  if (subtitle) subtitle.textContent = "请选择使用身份";
  document.querySelector(".entry-links")?.classList.remove("hidden");
  document.querySelectorAll(".auth-action").forEach((button) => {
    const card = button.closest(".login-choice");
    if (card) card.classList.toggle("hidden", button.dataset.target === "admin");
    const label = button.querySelector("[data-action-label]");
    if (label) label.textContent = button.dataset.enterLabel || "进入";
  });
}

function showRole(role, user) {
  if (!VALID_ROLES.includes(role)) return;
  rememberRole(role);
  document.querySelector("#login-gateway")?.classList.add("hidden");
  document.querySelector("#app-shell")?.classList.remove("locked");
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === `${role}-view`);
  });
  const currentRole = document.querySelector("#current-role");
  const roleName = document.querySelector("#role-name");
  if (currentRole) currentRole.textContent = user?.email || user?.displayName || roleTitles[role];
  if (roleName) roleName.textContent = roleTitles[role];
}

async function enterFromButton(button) {
  const role = button?.dataset?.target;
  if (!VALID_ROLES.includes(role)) return;
  rememberRole(role);
  const label = button.querySelector("[data-action-label]");
  if (label) label.textContent = auth.currentUser ? "正在进入..." : "正在打开登录...";
  try {
    const user = auth.currentUser || (await signInWithPopup(auth, provider)).user;
    showRole(role, user);
  } catch (error) {
    if (error?.code === "auth/popup-blocked" || error?.code === "auth/cancelled-popup-request") {
      await signInWithRedirect(auth, provider);
      return;
    }
    if (label) label.textContent = button.dataset.enterLabel || "进入";
    alert(error?.code === "auth/popup-closed-by-user"
      ? "登录窗口已关闭，请再点一次并完成 Google 验证。"
      : `登录失败：${error.message || error.code || "请重试"}`);
  }
}

document.querySelectorAll(".auth-action").forEach((button) => {
  button.addEventListener("click", (event) => {
    if (window.__simplePayMainReady) {
      rememberRole(button.dataset.target);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    enterFromButton(button);
  }, true);
});

document.querySelector("#logout-button")?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopImmediatePropagation();
  sessionStorage.removeItem("activeRole");
  window.__simplePaySelectedRole = "";
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  history.replaceState(null, "", "./index.html");
  showGateway("");
}, true);

if (initialRole) {
  rememberRole(initialRole);
  focusRoleChoice(initialRole);
}

onAuthStateChanged(auth, (user) => {
  if (window.__simplePayMainReady) return;
  const role = sessionStorage.getItem("activeRole") || initialRole;
  if (user && VALID_ROLES.includes(role)) {
    showRole(role, user);
  } else {
    showGateway(role);
  }
});
