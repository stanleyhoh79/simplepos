const auth = require("firebase-tools/lib/auth");
const apiv2 = require("firebase-tools/lib/apiv2");
const { requireAuth } = require("firebase-tools/lib/requireAuth");

const project = process.argv[2];
const services = process.argv.slice(3);
const location = "asia-southeast1";

if (!project || !services.length) {
  console.error("Usage: node scripts/set-cloud-run-callable-public.js <project> <service...>");
  process.exit(1);
}

async function request(url, options = {}) {
  const token = await apiv2.getAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.status} ${body.error?.message || response.statusText}`);
  }
  return body;
}

async function main() {
  const account = auth.getGlobalDefaultAccount();
  if (!account) throw new Error("Firebase CLI login is required.");
  await requireAuth({
    project,
    projectRoot: process.cwd(),
    user: account.user,
    tokens: account.tokens
  });

  for (const rawService of services) {
    const service = String(rawService).toLowerCase();
    const resource = `projects/${project}/locations/${location}/services/${service}`;
    const url = `https://run.googleapis.com/v2/${resource}`;
    const policy = await request(`${url}:getIamPolicy`);
    const bindings = Array.isArray(policy.bindings) ? policy.bindings : [];
    const invoker = bindings.find((binding) => binding.role === "roles/run.invoker");
    if (invoker) {
      invoker.members = [...new Set([...(invoker.members || []), "allUsers"])];
    } else {
      bindings.push({ role: "roles/run.invoker", members: ["allUsers"] });
    }
    await request(`${url}:setIamPolicy`, {
      method: "POST",
      body: JSON.stringify({
        policy: {
          bindings,
          etag: policy.etag,
          version: policy.version || 1
        }
      })
    });

    const verifiedPolicy = await request(`${url}:getIamPolicy`);
    const verified = (verifiedPolicy.bindings || []).some((binding) =>
      binding.role === "roles/run.invoker" && (binding.members || []).includes("allUsers")
    );
    if (!verified) throw new Error(`${service} did not finish enabling public invocation.`);
    console.log(`${service}: public invocation enabled`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
