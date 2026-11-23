type Package = { provider: "jehuca" | "bisdel"; id: string; network: string; type: string; size: number };
type Payment = {
  reference: string; amount: number; email: string; phone: string; slug: string;
  is_test: boolean; status: string; updated_at: string; package: Package;
};

const readSecret = (name: string) => (Deno.env.get(name) ?? "").replace(/\0/g, "").trim();
const referencePattern = /^mysti-stf-(test|live)-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const json = (result: string, status = 200, slug?: string) => Response.json(
  { result, ...(slug ? { slug } : {}) }, { status, headers: { "Cache-Control": "no-store" } },
);

async function database<T>(path: string, input?: Record<string, unknown>): Promise<T> {
  const key = readSecret("SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${readSecret("SUPABASE_URL")}/rest/v1/${path}`, {
    method: input ? "POST" : "GET",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: input ? JSON.stringify(input) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Database request failed (${response.status})`);
  return response.json();
}

async function signedWebhook(bytes: ArrayBuffer, signature: string, secret: string) {
  if (!/^[0-9a-f]{128}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["verify"],
  );
  const expected = Uint8Array.from(signature.match(/../g)!, (part) => parseInt(part, 16));
  return crypto.subtle.verify("HMAC", key, expected, bytes);
}

function asDisplayed(payment: Payment) {
  return payment.status === "dispatching" && Date.now() - Date.parse(payment.updated_at) > 120_000
    ? "provider_review" : payment.status;
}

async function dispatch(payment: Payment): Promise<string | null> {
  const pkg = payment.package;
  const bisdel = pkg.provider === "bisdel";
  const key = bisdel ? readSecret("TELCOGH_API_KEY") || readSecret("BISDEL_DB") : readSecret("JEHUCA_API_KEY");
  if (!key) return null;

  let body;
  if (bisdel) {
    const network = pkg.network.replace(/^MTN.*$/, "MTN")
      .replace(/^(VODAFONE|VOD)$/, "TELECEL").replace(/^(AT|AIRTEL[ -]?TIGO)$/, "AIRTELTIGO");
    body = { network, recipient: payment.phone, package_size: `${pkg.size}GB` };
  } else {
    const normalized = pkg.type.trim().toUpperCase();
    const type = normalized.includes("BIG TIME") ? "BIG TIME"
      : normalized.includes("ISHARE") ? "ISHARE"
        : normalized.split(/[(-]/)[0].trim();
    body = { packages: [{
      packageId: pkg.id, size: Math.round(pkg.size * 1000), network: pkg.network, type, phone: payment.phone,
    }] };
  }

  const response = await fetch(bisdel ? "https://telcogh.com/api/v1/data" : "https://backend.jehucale-business.com/api/orders", {
    method: "POST",
    headers: {
      ...(bisdel ? { Authorization: `Bearer ${key}` } : { "X-API-Key": key }),
      "Content-Type": "application/json", Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || (bisdel ? data?.status !== "success" : data?.status !== true)) {
    console.warn("Storefront provider did not confirm acceptance:", payment.reference, pkg.provider, response.status);
    return null;
  }

  const jehucaOrder = Array.isArray(data.payload) ? data.payload[0] : data.payload;
  const orderId = bisdel
    ? data.data?.order_id ?? data.data?.reference ?? data.data?.order_reference
    : jehucaOrder?.orderId ?? data.orderId ?? jehucaOrder?.id;
  return typeof orderId === "number" || (typeof orderId === "string" && orderId.trim()) ? String(orderId) : null;
}

async function verify(reference: string, secret: string, isTest: boolean, webhook: boolean) {
  const [payment] = await database<Payment[]>(
    `mysti_store_payments?select=reference,amount,email,slug,is_test,status,updated_at&reference=eq.${reference}`,
  );
  if (!payment || payment.is_test !== isTest) return webhook ? json("ignored") : json("not_found", 404);
  if (payment.status !== "awaiting_payment") return json(asDisplayed(payment), 200, payment.slug);

  const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(10_000),
  });
  const verification = await response.json().catch(() => null);
  if (response.status === 404 || (response.status === 400 && verification?.status === false)) {
    return json("awaiting_payment", webhook ? 503 : 200, payment.slug);
  }
  if (!response.ok || verification?.status !== true) throw new Error("Paystack verification unavailable");
  const transaction = verification.data;
  if (transaction?.status !== "success") return json("awaiting_payment", webhook ? 503 : 200, payment.slug);
  const transactionId = String(transaction.id ?? "");
  if (transaction.reference !== reference || transaction.amount !== payment.amount ||
      transaction.currency !== "GHS" || transaction.domain !== (isTest ? "test" : "live") ||
      transaction.customer?.email?.toLowerCase() !== payment.email || !/^\d+$/.test(transactionId)) {
    console.error("Storefront payment verification did not match", reference);
    return json("payment_mismatch", 409, payment.slug);
  }

  const [claimed] = await database<Payment[]>("rpc/mysti_store_claim_payment", {
    p_reference: reference, p_transaction_id: transactionId,
  });
  if (!claimed) {
    const [current] = await database<Payment[]>(
      `mysti_store_payments?select=status,updated_at&reference=eq.${reference}`,
    );
    return json(current ? asDisplayed(current) : "dispatching", 200, payment.slug);
  }
  if (claimed.is_test) return json("test_paid", 200, payment.slug);

  let providerOrderId: string | null = null;
  try {
    providerOrderId = await dispatch(claimed);
  } catch (error) {
    console.error("Storefront provider outcome unknown:", reference, error instanceof Error ? error.message : "Unknown error");
  }
  try {
    const result = await database<string>("rpc/mysti_store_finish_payment", {
      p_reference: reference, p_provider_order_id: providerOrderId,
    });
    return json(result, 200, payment.slug);
  } catch (error) {
    // Preserve the claim. A concurrent retry must never send this order again.
    console.error("Storefront order requires reconciliation:", reference, providerOrderId, error instanceof Error ? error.message : "Unknown error");
    return json("provider_review", 200, payment.slug);
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json("invalid", 405);
  const endpoint = new URL(request.url).pathname.split("/").filter(Boolean).at(-1);
  const isTest = endpoint?.endsWith("-test") === true;
  const secret = readSecret(isTest ? "TEST_PAYSTACK_SECRET_KEY" : "PAYSTACK_SECRET_KEY");
  if (!secret.startsWith(isTest ? "sk_test_" : "sk_live_")) return json("payment_unavailable", 503);

  try {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 65_536) return json("invalid", 413);
    const signature = request.headers.get("x-paystack-signature");
    if (signature !== null && !await signedWebhook(bytes, signature, secret)) return json("invalid_signature", 401);
    let input;
    try { input = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json("invalid", 400); }
    const webhook = signature !== null;
    if (webhook && input?.event !== "charge.success") return json("ignored");
    const reference = webhook ? input?.data?.reference : input?.reference;
    if (typeof reference !== "string" || !referencePattern.test(reference) ||
        !reference.startsWith(`mysti-stf-${isTest ? "test" : "live"}-`)) {
      return webhook ? json("ignored") : json("invalid", 400);
    }
    return await verify(reference, secret, isTest, webhook);
  } catch (error) {
    console.error("Storefront payment confirmation failed:", error instanceof Error ? error.message : "Unknown error");
    return json("payment_unavailable", 503);
  }
});
