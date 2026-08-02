const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sources = [
  {
    label: "Simple POS",
    file: "migration-source/rules/pos.rules",
    names: [
      "signedIn",
      "isAdmin",
      "userDoc",
      "isActiveCashier",
      "sameBranch",
      "validIntegrationJobCreate",
      "validIntegrationJobCancel"
    ],
    prefix: "pos"
  },
  {
    label: "SimplePay",
    file: "migration-source/rules/simplepay.rules",
    names: [
      "signedIn",
      "ownerEmail",
      "isOwner",
      "isAdmin",
      "isSelf",
      "secureMoneyEnabled",
      "walletProfileUpdateIsSafe",
      "merchantProfileUpdateIsSafe"
    ],
    prefix: "pay"
  },
  {
    label: "Affiliate",
    file: "migration-source/rules/affiliate.rules",
    names: [
      "signedIn",
      "isAdmin",
      "isOwner",
      "userCreateIsSafe",
      "userUpdateIsSafe",
      "ownerCanCreateOrder",
      "ownerCanUpdateOrder",
      "ownerCanCreateWithdraw",
      "ownerCanUpdateWithdraw",
      "ownerCanCreateInvite",
      "ownerCanUpdateInvite",
      "ownerCanCreateReferral",
      "ownerCanUpdateReferral"
    ],
    prefix: "aff"
  }
];

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function extractDocumentBody(source, file) {
  const marker = "match /databases/{database}/documents {";
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing Firestore document block in ${file}`);

  const openIndex = markerIndex + marker.length - 1;
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openIndex + 1, index).trim();
  }
  throw new Error(`Unclosed Firestore document block in ${file}`);
}

function namespaceFunctions(body, names, prefix) {
  return names.reduce((result, name) => {
    const replacement = `${prefix}${capitalize(name)}`;
    return result.replace(new RegExp(`\\b${name}\\b`, "g"), replacement);
  }, body);
}

const sections = sources.map(({ label, file, names, prefix }) => {
  const absolute = path.join(root, file);
  const source = fs.readFileSync(absolute, "utf8");
  const body = namespaceFunctions(extractDocumentBody(source, file), names, prefix);
  return `    // ${label}\n${body.split("\n").map((line) => `    ${line}`).join("\n")}`;
});

const output = [
  "rules_version = '2';",
  "",
  "service cloud.firestore {",
  "  match /databases/{database}/documents {",
  sections.join("\n\n"),
  "  }",
  "}",
  ""
].join("\n");

fs.writeFileSync(path.join(root, "firestore.rules"), output, "utf8");
console.log("Built firestore.rules from 3 module rule files.");
