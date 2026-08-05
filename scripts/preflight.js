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
    "simplepos-homepage-settings-v3",
    "homepagePublished",
    "极简养生计划",
    "进入会员系统",
    "./login.html?next=./system.html?module=home",
    "#about",
    "#process",
    "#drinks",
    "#refund",
    "#faq",
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
  "Portal exposes the public wellness homepage, core systems, admin settings, and shared Google login"
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
    "brandLogo",
    "heroImage",
    "imageDataUrl"
  ]) && includesAll("public/admin-homepage.html", [
    "logoFile",
    "heroImageFile",
    "shrink",
    "logoDataUrl",
    "imageDataUrl"
  ]),
  "Homepage settings support compressed brand, hero, and product images"
);

check(
  includesAll("public/index.html", [
    "featureGrid",
    "processGrid",
    "drinkGrid",
    "faqList",
    "apply(raw)"
  ])
    && includesAll("public/admin-homepage.html", [
      "featureEditors",
      "processEditors",
      "drinkEditors",
      "faqEditors",
      "read()",
      "settingsForm",
      "portalSettings",
      "homepageDraft"
    ]),
  "Homepage content blocks stay synchronized with the administrator editor"
);

check(
  includesAll("public/index.html", [
    "homepagePublished",
    "simplepos-homepage-draft-preview",
    'get("preview")==="1"'
  ])
    && includesAll("public/admin-homepage.html", [
      "homepageDraft",
      "homepagePublished",
      "httpsCallable",
      "saveHomepageDraft",
      "publishHomepage",
      "restoreHomepageVersion",
      "publishBtn",
      "restoreBtn",
      "保存草稿",
      "正式发布"
    ])
    && !read("public/admin-homepage.html").includes("writeBatch"),
  "Homepage supports draft preview and callable-based publish and restore"
);

check(
  includesAll("public/admin-homepage.html", [
    "saveHomepageDraftCall({settings:next})",
    "publishHomepageCall({settings:next})",
  ]),
  "Homepage callable payload wraps settings correctly"
);

check(
  includesAll("functions/homepage.js", [
    "saveHomepageDraft",
    "publishHomepage",
    "restoreHomepageVersion",
    "homepageAdminLogs",
    "homepageDraft",
    "homepagePublished",
    "homepagePrevious",
  ])
    && includesAll("functions/index.js", [
      "...require(\"./homepage\")",
    ]),
  "Homepage cloud functions validate and own draft, publish, restore, and audit writes"
);

check(
  includesAll("public/index.html", [
    "function escapeHtml",
    "function safeLink",
    "function safeImageData",
    "javascript:",
    "vbscript:",
    "data:text/html",
  ]),
  "Public homepage escapes dynamic content and rejects unsafe links and images"
);

check(
  includesAll("firestore.rules", [
    "match /portalSettings/{settingId}",
    'settingId == "homepagePublished"',
    'settingId == "homepage"',
    'settingId == "homepageDraft"',
    'settingId == "homepagePrevious"',
    "&& posIsAdmin();",
    'settingId != "homepagePublished"',
    'settingId != "homepage"',
    'settingId != "homepageDraft"',
    'settingId != "homepagePrevious"',
    "match /homepageAdminLogs/{logId}",
    "allow read: if posIsAdmin();",
    "allow create, update, delete: if false;",
  ]),
  "Homepage settings and audit logs enforce public read and server-only write boundaries"
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
    "id=\"dashboardView\"",
    "id=\"profileView\"",
    "id=\"profileForm\"",
    "../simplepay/index.html",
    "../affiliate/index.html",
    "./script.js?v=20260802-3",
  ])
    && includesAll("public/member/script.js", [
      "loadMemberProfileForUser",
      "getMemberProfile",
      "saveMemberProfile",
      "onAuthStateChanged",
      "signOut",
      "data-dashboard-module",
      "simplepos-open-module",
    ])
    && includesAll("public/member/styles.css", [
      ".is-embedded .account-menu",
      ".dashboard-status-grid",
      ".dashboard-quick-grid",
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

const simplePayScript = read("public/simplepay/script.js");
const simplePayRules = read("firestore.rules");
const simplePayFunctions = read("functions/simplepay.js");
const directRefundRequestWrite = /\b(?:addDoc|setDoc|updateDoc|deleteDoc)\s*\([\s\S]{0,240}?["']refundRequests["']/.test(simplePayScript);
const directRefundRequestDocument = simplePayScript.includes('doc(db, "refundRequests"');
const refundRulesStart = simplePayRules.indexOf("match /refundRequests/{requestId}");
const refundRulesEnd = simplePayRules.indexOf("match /settlementRequests/{requestId}", refundRulesStart);
const refundRules = refundRulesStart >= 0 && refundRulesEnd > refundRulesStart
  ? simplePayRules.slice(refundRulesStart, refundRulesEnd)
  : "";
const reviewRefundStart = simplePayFunctions.indexOf("exports.reviewMerchantRefund = onCall");
const reviewRefundEnd = simplePayFunctions.indexOf("exports.submitMerchantSettlement = onCall", reviewRefundStart);
const reviewMerchantRefund = reviewRefundStart >= 0 && reviewRefundEnd > reviewRefundStart
  ? simplePayFunctions.slice(reviewRefundStart, reviewRefundEnd)
  : "";

check(
  !directRefundRequestWrite
    && !directRefundRequestDocument
    && refundRules.includes("allow create, update, delete: if false;")
    && reviewMerchantRefund.includes('db.collection("payAuditLogs").doc()')
    && reviewMerchantRefund.includes("action: \"reviewMerchantRefund\"")
    && reviewMerchantRefund.includes("tx.create(auditRef"),
  "SimplePay refunds are callable-only, rules deny client writes, and reviews write an audit record"
);

const affiliateScript = read("public/affiliate/app.js");
const affiliateFunctions = read("functions/affiliate.js");
const affiliateRules = read("firestore.rules");
const directAffiliateRefundRequestWrite = /\b(?:addDoc|setDoc|updateDoc|deleteDoc)\s*\([\s\S]{0,240}?["']amsystemRefundRequests["']/.test(affiliateScript)
  || affiliateScript.includes('doc(db, "amsystemRefundRequests"');
const affiliateRefundRulesStart = affiliateRules.indexOf("match /amsystemRefundRequests/{requestId}");
const affiliateRefundRulesEnd = affiliateRules.indexOf("match /amsystemExternalOrders/{externalOrderId}", affiliateRefundRulesStart);
const affiliateRefundRules = affiliateRefundRulesStart >= 0 && affiliateRefundRulesEnd > affiliateRefundRulesStart
  ? affiliateRules.slice(affiliateRefundRulesStart, affiliateRefundRulesEnd)
  : "";
const affiliateSubmitStart = affiliateFunctions.indexOf("exports.submitAffiliateRefundRequest = onCall");
const affiliateReviewStart = affiliateFunctions.indexOf("exports.reviewAffiliateRefundRequest = onCall");
const affiliateReviewEnd = affiliateFunctions.indexOf("exports.syncAffiliateWalletPoints = onCall", affiliateReviewStart);
const affiliateSubmit = affiliateSubmitStart >= 0 && affiliateReviewStart > affiliateSubmitStart
  ? affiliateFunctions.slice(affiliateSubmitStart, affiliateReviewStart)
  : "";
const affiliateReview = affiliateReviewStart >= 0 && affiliateReviewEnd > affiliateReviewStart
  ? affiliateFunctions.slice(affiliateReviewStart, affiliateReviewEnd)
  : "";
const affiliateRejectReview = affiliateReview.slice(0, affiliateReview.indexOf("if (!refundReference)"));
const affiliateRefundCoreStart = affiliateFunctions.indexOf("async function refundAffiliateOrderById");
const affiliateRefundCoreEnd = affiliateFunctions.indexOf("exports.confirmOrder = onCall", affiliateRefundCoreStart);
const affiliateRefundCore = affiliateRefundCoreStart >= 0 && affiliateRefundCoreEnd > affiliateRefundCoreStart
  ? affiliateFunctions.slice(affiliateRefundCoreStart, affiliateRefundCoreEnd)
  : "";
const directAffiliateRefundStateWrite = /\b(?:addDoc|setDoc|updateDoc|deleteDoc)\s*\([\s\S]{0,240}?(?:["']amsystemOrders["']|["']amsystemReversalCases["'])/.test(affiliateScript);

check(
  !directAffiliateRefundRequestWrite
    && affiliateRefundRules.includes("allow create, update, delete: if false;")
    && affiliateSubmit.includes("order.userId !== member.uid")
    && affiliateSubmit.includes('order.status !== "paid"')
    && affiliateReview.includes("return refundAffiliateOrderById(")
    && affiliateRejectReview.includes('status: "rejected"')
    && !directAffiliateRefundStateWrite
    && affiliateScript.includes('data-action="recheck"')
    && affiliateScript.includes("重新检查并完成退款")
    && affiliateRefundCore.includes("refundReviewHold: true")
    && affiliateRefundCore.includes("refundReviewHold: admin.firestore.FieldValue.delete()")
    && affiliateRefundCore.includes('status: "completed"')
    && affiliateRefundCore.includes('result: "refunded"')
    && affiliateRefundCore.includes("pointShortfall")
    && affiliateRefundCore.includes("walletShortfall")
    && !affiliateRefundCore.includes("partialRefund")
    && affiliateRejectReview.includes("refundReviewHold: admin.firestore.FieldValue.delete()"),
  "Affiliate refund requests are callable-only, enforce order ownership, reuse the refund core, and keep reversal reviews atomic"
);

if (failures) {
  console.error(`\n${failures} preflight check(s) failed.`);
  process.exit(1);
}

console.log("\nPreflight passed.");
