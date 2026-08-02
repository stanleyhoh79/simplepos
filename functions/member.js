"use strict";

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const db = getFirestore();

function clean(value) {
  if (value === undefined) return undefined;

  if (Array.isArray(value)) {
    return value
      .map(clean)
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, clean(item)])
        .filter(([, item]) => item !== undefined)
    );
  }

  return typeof value === "string" ? value.trim() : value;
}

/**
 * Member profiles contain sensitive health-related information.
 * The browser never writes the shared document directly.
 * This callable verifies the Google identity and writes only
 * that identity's canonical profile.
 */
exports.saveMemberProfile = onCall(async (request) => {
  if (!request.auth?.uid) {
    throw new HttpsError(
      "unauthenticated",
      "请先完成 Google 登录后再保存个人资料。"
    );
  }

  const profileInput = clean(request.data?.profile);

  if (
    !profileInput ||
    typeof profileInput !== "object" ||
    Array.isArray(profileInput)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "个人资料格式不正确。"
    );
  }

  const uid = request.auth.uid;
  const email = String(request.auth.token?.email || "")
    .trim()
    .toLowerCase();

  const ref = db
    .collection("memberProfiles")
    .doc(`MP-${uid}`);

  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const previous = snapshot.exists
      ? snapshot.data()
      : {};

    const customer = {
      ...(previous.customer || {}),
      ...(profileInput.customer || {}),
      ...(email ? { email } : {}),
    };

    tx.set(
      ref,
      {
        ...previous,
        ...profileInput,
        customer,
        id: ref.id,
        ownerUid: uid,
        ownerEmail: email || previous.ownerEmail || "",
        createdAt:
          previous.createdAt ||
          FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        updatedByUid: uid,
      },
      { merge: true }
    );
  });

  return {
    profileId: ref.id,
  };
});