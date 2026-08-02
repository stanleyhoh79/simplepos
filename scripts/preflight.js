const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
let failures = 0;

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function check(condition, message) {
  if (condition) {
    console.log(`ok - ${message}`);
    return;
  }
  failures += 1;
  console.error(`fail - ${message}`);
}

function includesAll(file, tokens) {
  const content = read(file);
  return tokens.every((token) => content.includes(token));
}

check(
  includesAll("public/index.html", [
    "onAuthStateChanged",
    "simplepos-homepage-settings",
    "极简养生系统 | 轻盈健康的生活从养生开始",
    "极简养生系统 · 简介",
    "./login.html?next=./system.html?module=home",
  ])
    && includesAll("public/system.html", [
      "workspaceShell",
      "data-module=\"experience\"",
      "data-module=\"checkin\"",
      "data-module=\"measurement\"",
      "data-module=\"simplepay\"",
      "data-module=\"affiliate\"",
      "data-module=\"pos\"",
      "memberMenuBtn",
      "memberMenuPanel",
      "data-member-module=\"profile\"",
      "data-member-module=\"agreement\"",
      "data-member-module=\"terms\"",
      "./simplepay/index.html",
      "./experience/index.html",
      "./checkin/index.html",
      "./measurement/index.html",
      "./affiliate/index.html",
      "./pos/index.html",
      "./member/index.html",
      "./customer/index.html",
      "is-collapsed",
      "systemFrame",
      "workspaceLogoutBtn",
      "signOut",
      "adminNav",
      "data-admin-module=\"homepageAdmin\"",
      "data-admin-module=\"experienceAdmin\"",
      "data-admin-module=\"posAdmin\"",
      "data-admin-module=\"simplepayAdmin\"",
      "data-admin-module=\"affiliateAdmin\"",
      "adminEmail",
      "isAdminUser",
    ]),
  "Portal exposes the core systems, admin settings, and owns the shared Google login"
);

check(
  includesAll("public/admin-experience.html", [
    "portalSettings",
    "体验版首页设置",
    "completionNote",
    "保存体验版设置",
  ])
    && includesAll("public/experience/script.js", [
      "loadExperienceSettings",
      "portalSettings",
      "defaultExperienceSettings",
    ]),
  "Admins can configure the experience homepage without changing the experience state flow"
);

check(
  includesAll("public/index.html", [
    "logoDataUrl",
    "brandImage",
    "footerImage"
  ]) && includesAll("public/admin-homepage.html", [
    "settingBrandLogo",
    "clearBrandLogoBtn",
    "shrinkLogo",
    "logoDataUrl"
  ]),
  "Homepage settings support a custom compressed brand logo"
);

check(
  includesAll("public/index.html", [
    "navArticles",
    "showSubmenuArticle",
    "submenuArticle"
  ])
    && includesAll("public/admin-homepage.html", [
      "submenuArticleEditors",
      "renderSubmenuArticleEditors",
      "collectSubmenuArticles",
      "navArticles"
    ]),
  "Sub-navigation titles stay synchronized with their long-form homepage articles"
);

check(
  includesAll("public/measurement/index.html", [
    "每周测量",
    "weeklyMeasurementForm",
    "measurementHistory"
  ])
    && includesAll("public/measurement/script.js", [
      "memberProfiles",
      "baseline",
      "每周测量",
      "measuredBy"
    ]),
  "Weekly measurement is a dedicated baseline and trend module"
);

check(
  includesAll("public/checkin/index.html", [
    "每日打卡",
    "今日状态",
    "最近 7 天",
    "WhatsApp 提醒模板",
    "今日会员状态",
    "selfieInput",
    "tongueInput",
  ])
    && includesAll("public/checkin/script.js", [
      "dailyCheckins",
      "dailyCheckinMedia",
      "memberProfiles",
      "member-daily-checkin",
      "compressImage",
      "loadAdminRoster",
      "wa.me",
      "checkinReminder",
    ])
    && includesAll("firestore.rules", [
      "match /dailyCheckins/{checkinId}",
      "match /dailyCheckinMedia/{checkinId}",
      "request.resource.data.memberUid == request.auth.uid",
    ]),
  "Daily check-in isolates member records, media, and the manual WhatsApp reminder queue"
);

check(
  includesAll("public/experience/index.html", [
    "activateAffiliateButton",
  ])
    && includesAll("public/experience/script.js", [
    "memberExperiences",
    "experienceRefundRequests",
    "simplepos-experience-state",
  ])
    && includesAll("public/system.html", [
      "data-module=\"experience\" hidden",
      "data-admin-module=\"experienceAdmin\" hidden",
      "affiliateUnlocked = true",
    ])
    && includesAll("firestore.rules", [
      "match /memberExperiences/{memberUid}",
      "match /experienceRefundRequests/{requestId}",
    ]),
  "Experience flow is preserved for later testing while its member and admin entries stay hidden"
);

check(
  includesAll("public/member/index.html", [
    "会员中心",
    "个人资料",
    "简单营销联盟协议",
    "网站条款与条件",
    "退出登录",
    "document.documentElement.classList.add(\"is-embedded\")",
    "profileForm",
    "../simplepay/index.html",
    "../affiliate/index.html",
  ])
    && includesAll("public/member/script.js", [
      "isEmbedded",
      "memberProfiles",
      "onAuthStateChanged",
      "loadMemberProfileByEmail",
      "updateDoc",
      "signOut",
      "SimplePay、简单联盟等系统会使用最新资料",
    ])
    && includesAll("public/member/styles.css", [
      ".is-embedded .account-menu",
    ]),
  "Member center owns the shared member profile used by SimplePay and Affiliate"
);

check(
  includesAll("public/simplepay/index.html", [
    "data-login-label",
    "data-enter-label",
    "entry-auth.js?v=4",
    "script.js?v=37",
    "merchant-qr-render",
    "qr-placeholder",
    "apply-merchant-button",
    "data-disabled-feature=\"user-receive-code\"",
  ]),
  "SimplePay entry, merchant application, and hidden user receive-code UI are present"
);

check(
  includesAll("public/simplepay/script.js", [
    "browserLocalPersistence",
    "authStateReady",
    "signInWithRedirect",
    "simplepos-unified-google-user",
    "readUnifiedLoginHint",
    "showRoleChoiceGateway",
    "updateRoleActionLabels",
    "await enterRole(target)",
    "merchantLoading",
    "SIMPLEPAY_CACHE_VERSION",
    "window.__simplePayMainReady = true",
    "async function submitMerchantApplication",
    "function buildMerchantProfileFromMember",
    "const USER_RECEIVE_CODE_ENABLED = false",
    "createLocalQrDataUrl",
    "activeMerchantRef",
    "attachMerchantRefundIntents",
    "button.id === \"generate-merchant-code\"",
    "showRoleChoiceGateway(result.user)",
  ]),
  "SimplePay reuses portal login and enters selected roles without a second login"
);

check(
  includesAll("public/shared/qr-local.js", [
    "qrcode-generator.js",
    "createLocalQrSvg",
    "createLocalQrHtml",
    "createLocalQrDataUrl",
    "createSvgTag",
    "data:image/svg+xml",
  ])
    && !read("public/simplepay/script.js").includes("api.qrserver.com"),
  "SimplePay renders payment QR codes locally without third-party image services"
);

check(
  includesAll("public/simplepay/entry-auth.js", [
    "getApps().length ? getApp() : initializeApp",
    "stopImmediatePropagation",
    "__simplePayMainReady",
    "logout-button",
    "history.replaceState",
    "showRole(role, user)",
    "signInWithPopup",
    "signInWithRedirect",
  ]),
  "SimplePay has a small portal-auth bridge before the full module loads"
);

check(
  includesAll("public/affiliate/app.js", [
    "updateAuthButtons",
    "loginButton.hidden = Boolean(firebaseUser)",
    "applyMemberProfileToAffiliateUser",
    "websiteTerms",
    "memberProfilesRef",
    "OPEN_ADMIN_FROM_PORTAL",
    "activateView(\"adminView\")",
  ]),
  "Affiliate hides repeat login, links to the shared member profile, and supports portal admin entry"
);

check(
  includesAll("public/customer/index.html", [
    "data-step=\"1\"",
    "data-step=\"2\"",
    "data-step=\"4\"",
    "data-step=\"7\"",
    "data-step=\"8\"",
    "websiteTermsAccepted",
  ])
    && includesAll("public/customer/script.js", [
      "otherHighRiskNotAccepted",
      "memberProfiles",
      "websiteTerms",
      "customer-health-profile-main",
      "customer-health-profile-step-7-embedded-full",
    ])
    && read("firestore.rules").includes("\"websiteTerms\""),
  "Customer health profile keeps the guided multi-step member record"
);

check(
  includesAll("public/pos/app.js", [
    "pendingManagement",
    "getPendingManagementCount",
    "canManageBranch",
    "renderReceiptTemplatePreview",
    "renderTouchNGoQrPreview",
  ]),
  "POS keeps branch permissions, pending management work, receipts, and e-wallet QR settings"
);

check(
  includesAll("functions/simplepay.js", [
    "getPosPaymentIntent",
    "authorizePosPaymentIntent",
    "updatedAt: createdAt",
  ])
    && includesAll("functions/affiliate.js", ["fulfill", "referralCode"]),
  "Cloud functions keep POS, SimplePay, and affiliate integration paths"
);

if (failures) {
  console.error(`\n${failures} preflight check(s) failed.`);
  process.exit(1);
}

console.log("\nPreflight passed.");
