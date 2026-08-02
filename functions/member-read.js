"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const db = getFirestore();

// Returns one canonical profile per Google account and upgrades older
// email-based documents the first time that account opens its profile.
exports.getMemberProfile = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError("unauthenticated", "请先完成 Google 登录后再读取个人资料。");
  }

  const uid = request.auth.uid;
  const email = String(request.auth.token?.email || "").trim().toLowerCase();
  const canonicalRef = db.collection("memberProfiles").doc(`MP-${uid}`);
  const canonicalSnapshot = await canonicalRef.get();

  if (canonicalSnapshot.exists) {
    return { profileId: canonicalRef.id, profile: canonicalSnapshot.data() };
  }

  let legacySnapshot = null;
  if (email) {
    const byOwner = await db.collection("memberProfiles")
      .where("ownerEmail", "==", email)
      .limit(1)
      .get();
    legacySnapshot = byOwner.docs[0] || null;

    if (!legacySnapshot) {
      const byCustomer = await db.collection("memberProfiles")
        .where("customer.email", "==", email)
        .limit(1)
        .get();
      legacySnapshot = byCustomer.docs[0] || null;
    }
  }

  if (!legacySnapshot) return { profileId: canonicalRef.id, profile: null };

  const legacy = legacySnapshot.data();
  const migrated = {
    ...legacy,
    id: canonicalRef.id,
    ownerUid: uid,
    ownerEmail: email || legacy.ownerEmail || "",
    customer: {
      ...(legacy.customer || {}),
      ...(email ? { email } : {})
    },
    migratedFromProfileId: legacySnapshot.id,
    migratedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  await canonicalRef.set(migrated, { merge: true });
  return { profileId: canonicalRef.id, profile: { ...legacy, ...migrated } };
});
