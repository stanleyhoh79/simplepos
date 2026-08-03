const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getApps, initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!getApps().length) {
  initializeApp();
}

const db = getFirestore();
const ADMIN_EMAIL = "stanleyhoh79@gmail.com";
const TOP_LEVEL_KEYS = [
  "version",
  "brand",
  "hero",
  "about",
  "process",
  "drinks",
  "audience",
  "system",
  "refund",
  "faq",
  "cta"
];

function fail(message) {
  throw new HttpsError("invalid-argument", message);
}

function requireAdmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Authentication required.");
  }
  const email = String(request.auth.token.email || "").trim().toLowerCase();
  if (email !== ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Admin permission required.");
  }
  return {
    uid: request.auth.uid,
    email
  };
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
}

function assertExactKeys(value, allowedKeys, label) {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length) {
    fail(`${label} contains unsupported fields: ${unknown.join(", ")}.`);
  }
  const missing = allowedKeys.filter((key) => !(key in value));
  if (missing.length) {
    fail(`${label} is missing fields: ${missing.join(", ")}.`);
  }
}

function cleanString(value, maxLength, label, { allowEmpty = true } = {}) {
  if (typeof value !== "string") {
    fail(`${label} must be a string.`);
  }
  const cleaned = value.trim();
  if (!allowEmpty && !cleaned) {
    fail(`${label} is required.`);
  }
  if (cleaned.length > maxLength) {
    fail(`${label} exceeds ${maxLength} characters.`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(cleaned)) {
    fail(`${label} contains control characters.`);
  }
  return cleaned;
}

function cleanStringArray(value, maxItems, maxLength, label) {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail(`${label} must contain at most ${maxItems} items.`);
  }
  return value.map((item, index) =>
    cleanString(item, maxLength, `${label}[${index}]`)
  );
}

function cleanImage(value, maxLength, label) {
  const cleaned = cleanString(value, maxLength, label);
  if (!cleaned) return "";
  if (!/^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=\r\n]+$/i.test(cleaned)) {
    fail(`${label} must be a PNG, JPEG, or WebP data URL.`);
  }
  return cleaned;
}

function cleanLink(value, maxLength, label) {
  const cleaned = cleanString(value, maxLength, label);
  if (!cleaned) return "";
  const lower = cleaned.toLowerCase();
  if (
    lower.startsWith("javascript:") ||
    lower.startsWith("vbscript:") ||
    lower.startsWith("data:text/html")
  ) {
    fail(`${label} uses a blocked URL scheme.`);
  }
  const allowed =
    cleaned.startsWith("#") ||
    cleaned.startsWith("./") ||
    cleaned.startsWith("../") ||
    cleaned.startsWith("/") ||
    /^https?:\/\//i.test(cleaned) ||
    /^mailto:/i.test(cleaned) ||
    /^tel:/i.test(cleaned);
  if (!allowed) {
    fail(`${label} uses an unsupported URL format.`);
  }
  return cleaned;
}

function cleanObjectArray(value, maxItems, cleaner, label) {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail(`${label} must contain at most ${maxItems} items.`);
  }
  return value.map((item, index) => cleaner(item, `${label}[${index}]`));
}

function cleanTitleText(item, label) {
  assertExactKeys(item, ["title", "text"], label);
  return {
    title: cleanString(item.title, 120, `${label}.title`),
    text: cleanString(item.text, 400, `${label}.text`)
  };
}

function cleanDrink(item, label) {
  assertExactKeys(item, ["name", "tag", "text", "imageDataUrl"], label);
  return {
    name: cleanString(item.name, 80, `${label}.name`),
    tag: cleanString(item.tag, 40, `${label}.tag`),
    text: cleanString(item.text, 400, `${label}.text`),
    imageDataUrl: cleanImage(item.imageDataUrl, 90000, `${label}.imageDataUrl`)
  };
}

function cleanFaq(item, label) {
  assertExactKeys(item, ["q", "a"], label);
  return {
    q: cleanString(item.q, 160, `${label}.q`),
    a: cleanString(item.a, 600, `${label}.a`)
  };
}

function pickHomepageFields(value) {
  assertPlainObject(value, "stored homepage");
  return Object.fromEntries(
    TOP_LEVEL_KEYS.filter((key) => key in value).map((key) => [key, value[key]])
  );
}

function sanitizeHomepage(raw) {
  assertExactKeys(raw, TOP_LEVEL_KEYS, "homepage");

  if (!Number.isInteger(raw.version) || raw.version < 1 || raw.version > 100) {
    fail("homepage.version must be an integer between 1 and 100.");
  }

  assertExactKeys(
    raw.brand,
    ["name", "logoDataUrl", "whatsapp", "email", "address", "slogan"],
    "homepage.brand"
  );
  const brand = {
    name: cleanString(raw.brand.name, 20, "homepage.brand.name", { allowEmpty: false }),
    logoDataUrl: cleanImage(raw.brand.logoDataUrl, 80000, "homepage.brand.logoDataUrl"),
    whatsapp: cleanString(raw.brand.whatsapp, 30, "homepage.brand.whatsapp"),
    email: cleanString(raw.brand.email, 100, "homepage.brand.email"),
    address: cleanString(raw.brand.address, 100, "homepage.brand.address"),
    slogan: cleanString(raw.brand.slogan, 80, "homepage.brand.slogan")
  };

  assertExactKeys(
    raw.hero,
    [
      "eyebrow",
      "title",
      "subtitle",
      "imageDataUrl",
      "primaryText",
      "primaryLink",
      "secondaryText",
      "secondaryLink",
      "systemText",
      "trust"
    ],
    "homepage.hero"
  );
  const hero = {
    eyebrow: cleanString(raw.hero.eyebrow, 80, "homepage.hero.eyebrow"),
    title: cleanString(raw.hero.title, 120, "homepage.hero.title", { allowEmpty: false }),
    subtitle: cleanString(raw.hero.subtitle, 320, "homepage.hero.subtitle"),
    imageDataUrl: cleanImage(raw.hero.imageDataUrl, 180000, "homepage.hero.imageDataUrl"),
    primaryText: cleanString(raw.hero.primaryText, 20, "homepage.hero.primaryText"),
    primaryLink: cleanLink(raw.hero.primaryLink, 160, "homepage.hero.primaryLink"),
    secondaryText: cleanString(raw.hero.secondaryText, 20, "homepage.hero.secondaryText"),
    secondaryLink: cleanLink(raw.hero.secondaryLink, 160, "homepage.hero.secondaryLink"),
    systemText: cleanString(raw.hero.systemText, 20, "homepage.hero.systemText"),
    trust: cleanStringArray(raw.hero.trust, 6, 80, "homepage.hero.trust")
  };

  assertExactKeys(raw.about, ["kicker", "title", "intro", "features"], "homepage.about");
  const about = {
    kicker: cleanString(raw.about.kicker, 40, "homepage.about.kicker"),
    title: cleanString(raw.about.title, 120, "homepage.about.title"),
    intro: cleanString(raw.about.intro, 400, "homepage.about.intro"),
    features: cleanObjectArray(
      raw.about.features,
      4,
      cleanTitleText,
      "homepage.about.features"
    )
  };

  assertExactKeys(raw.process, ["title", "intro", "steps"], "homepage.process");
  const process = {
    title: cleanString(raw.process.title, 120, "homepage.process.title"),
    intro: cleanString(raw.process.intro, 260, "homepage.process.intro"),
    steps: cleanObjectArray(
      raw.process.steps,
      4,
      cleanTitleText,
      "homepage.process.steps"
    )
  };

  assertExactKeys(raw.drinks, ["title", "intro", "items"], "homepage.drinks");
  const drinks = {
    title: cleanString(raw.drinks.title, 120, "homepage.drinks.title"),
    intro: cleanString(raw.drinks.intro, 320, "homepage.drinks.intro"),
    items: cleanObjectArray(raw.drinks.items, 4, cleanDrink, "homepage.drinks.items")
  };

  assertExactKeys(
    raw.audience,
    ["title", "suitableTitle", "suitable", "cautionTitle", "caution"],
    "homepage.audience"
  );
  const audience = {
    title: cleanString(raw.audience.title, 120, "homepage.audience.title"),
    suitableTitle: cleanString(raw.audience.suitableTitle, 40, "homepage.audience.suitableTitle"),
    suitable: cleanStringArray(raw.audience.suitable, 8, 240, "homepage.audience.suitable"),
    cautionTitle: cleanString(raw.audience.cautionTitle, 50, "homepage.audience.cautionTitle"),
    caution: cleanStringArray(raw.audience.caution, 8, 240, "homepage.audience.caution")
  };

  assertExactKeys(raw.system, ["kicker", "title", "text", "points"], "homepage.system");
  const system = {
    kicker: cleanString(raw.system.kicker, 40, "homepage.system.kicker"),
    title: cleanString(raw.system.title, 100, "homepage.system.title"),
    text: cleanString(raw.system.text, 400, "homepage.system.text"),
    points: cleanStringArray(raw.system.points, 6, 120, "homepage.system.points")
  };

  assertExactKeys(
    raw.refund,
    ["kicker", "title", "text", "buttonText", "buttonLink"],
    "homepage.refund"
  );
  const refund = {
    kicker: cleanString(raw.refund.kicker, 40, "homepage.refund.kicker"),
    title: cleanString(raw.refund.title, 120, "homepage.refund.title"),
    text: cleanString(raw.refund.text, 600, "homepage.refund.text"),
    buttonText: cleanString(raw.refund.buttonText, 30, "homepage.refund.buttonText"),
    buttonLink: cleanLink(raw.refund.buttonLink, 160, "homepage.refund.buttonLink")
  };

  assertExactKeys(raw.faq, ["title", "items"], "homepage.faq");
  const faq = {
    title: cleanString(raw.faq.title, 100, "homepage.faq.title"),
    items: cleanObjectArray(raw.faq.items, 8, cleanFaq, "homepage.faq.items")
  };

  assertExactKeys(raw.cta, ["title", "text", "primaryText", "contactText"], "homepage.cta");
  const cta = {
    title: cleanString(raw.cta.title, 100, "homepage.cta.title"),
    text: cleanString(raw.cta.text, 300, "homepage.cta.text"),
    primaryText: cleanString(raw.cta.primaryText, 20, "homepage.cta.primaryText"),
    contactText: cleanString(raw.cta.contactText, 20, "homepage.cta.contactText")
  };

  return {
    version: raw.version,
    brand,
    hero,
    about,
    process,
    drinks,
    audience,
    system,
    refund,
    faq,
    cta
  };
}

function getSettingsPayload(request) {
  const data = request.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    fail("Request data must be an object.");
  }
  const allowed = ["settings"];
  const unknown = Object.keys(data).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    fail(`Request contains unsupported fields: ${unknown.join(", ")}.`);
  }
  if (!("settings" in data)) {
    fail("Request is missing settings.");
  }
  return sanitizeHomepage(data.settings);
}

function auditPayload(action, actor, details = {}) {
  return {
    action,
    actorUid: actor.uid,
    actorEmail: actor.email,
    createdAt: FieldValue.serverTimestamp(),
    ...details
  };
}

exports.saveHomepageDraft = onCall(async (request) => {
  const actor = requireAdmin(request);
  const settings = getSettingsPayload(request);
  const draftRef = db.doc("portalSettings/homepageDraft");
  const logRef = db.collection("homepageAdminLogs").doc();
  const batch = db.batch();

  batch.set(draftRef, {
    ...settings,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: actor.email
  });
  batch.set(logRef, auditPayload("homepage.draft.save", actor, {
    homepageVersion: settings.version
  }));
  await batch.commit();

  return { ok: true, status: "draft-saved" };
});

exports.publishHomepage = onCall(async (request) => {
  const actor = requireAdmin(request);
  const settings = getSettingsPayload(request);
  const publishedRef = db.doc("portalSettings/homepagePublished");
  const previousRef = db.doc("portalSettings/homepagePrevious");
  const draftRef = db.doc("portalSettings/homepageDraft");
  const logRef = db.collection("homepageAdminLogs").doc();

  await db.runTransaction(async (transaction) => {
    const current = await transaction.get(publishedRef);
    if (current.exists) {
      transaction.set(previousRef, {
        ...current.data(),
        archivedAt: FieldValue.serverTimestamp(),
        archivedBy: actor.email
      });
    }
    transaction.set(publishedRef, {
      ...settings,
      publishedAt: FieldValue.serverTimestamp(),
      publishedBy: actor.email
    });
    transaction.set(draftRef, {
      ...settings,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actor.email
    });
    transaction.set(logRef, auditPayload("homepage.publish", actor, {
      homepageVersion: settings.version,
      replacedExistingVersion: current.exists
    }));
  });

  return { ok: true, status: "published" };
});

exports.restoreHomepageVersion = onCall(async (request) => {
  const actor = requireAdmin(request);
  const data = request.data || {};
  if (typeof data !== "object" || Array.isArray(data) || Object.keys(data).length) {
    fail("restoreHomepageVersion does not accept request fields.");
  }

  const publishedRef = db.doc("portalSettings/homepagePublished");
  const previousRef = db.doc("portalSettings/homepagePrevious");
  const draftRef = db.doc("portalSettings/homepageDraft");
  const logRef = db.collection("homepageAdminLogs").doc();

  await db.runTransaction(async (transaction) => {
    const [current, previous] = await Promise.all([
      transaction.get(publishedRef),
      transaction.get(previousRef)
    ]);
    if (!previous.exists) {
      throw new HttpsError("failed-precondition", "No previous homepage version is available.");
    }

    const restored = sanitizeHomepage(pickHomepageFields(previous.data()));
    if (current.exists) {
      const currentSanitized = sanitizeHomepage(pickHomepageFields(current.data()));
      transaction.set(previousRef, {
        ...currentSanitized,
        archivedAt: FieldValue.serverTimestamp(),
        archivedBy: actor.email
      });
    } else {
      transaction.delete(previousRef);
    }

    transaction.set(publishedRef, {
      ...restored,
      publishedAt: FieldValue.serverTimestamp(),
      publishedBy: actor.email
    });
    transaction.set(draftRef, {
      ...restored,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: actor.email
    });
    transaction.set(logRef, auditPayload("homepage.restore", actor, {
      homepageVersion: restored.version,
      replacedExistingVersion: current.exists
    }));
  });

  return { ok: true, status: "restored" };
});
