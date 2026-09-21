/**
 * TEMPORARY verification harness (deleted after the run).
 * Exercises the real edge functions and the real DataScreen with stubbed
 * transport to prove sub-agents load super-agent packages for their tier.
 */
const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");
const React = require("react");

const appRoot = path.join(__dirname, "..");
const results = [];

const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (ok
        ? ""
        : `\n        expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`),
  );
};

/* ---------------------- fake supabase (PostgREST) ---------------------- */

const createFakeSupabase = ({ user, tables = {}, userRecords = {}, missingTables = [] }) => {
  const calls = { inserts: [], updates: [] };
  const records = { ...userRecords };

  const rowsFor = (table, filters) =>
    (tables[table] || []).filter((row) =>
      filters.every(([key, value]) => (row[key] ?? null) === value),
    );

  const query = (table) => {
    const filters = [];
    let single = false;
    let maybe = false;

    const builder = {
      select: () => builder,
      eq: (key, value) => {
        filters.push([key, value]);
        return builder;
      },
      is: (key, value) => {
        filters.push([key, value]);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      single: () => {
        single = true;
        return builder;
      },
      maybeSingle: () => {
        maybe = true;
        return builder;
      },
      insert: (payload) => {
        calls.inserts.push({ table, payload });
        return builder;
      },
      update: (payload) => {
        calls.updates.push({ table, payload });
        return builder;
      },
      delete: () => builder,
      then: (resolve) => {
        if (missingTables.includes(table)) {
          resolve({
            data: null,
            error: {
              code: "42P01",
              message: `relation "public.${table}" does not exist`,
            },
          });
          return;
        }
        const rows = rowsFor(table, filters);
        resolve({
          data: single || maybe ? (rows[0] ?? null) : rows,
          error: null,
        });
      },
    };

    return builder;
  };

  const client = {
    from: (table) => query(table),
    auth: {
      getUser: async () => ({ data: { user }, error: null }),
      admin: {
        createUser: async (payload) => {
          calls.inserts.push({ table: "auth.users", payload });
          const created = {
            id: "created-agent-id",
            email: payload?.email,
            user_metadata: payload?.user_metadata,
          };
          records[created.id] = created;
          return { data: { user: created }, error: null };
        },
        getUserById: async (id) => ({
          data: { user: records[id] || null },
          error: records[id] ? null : { message: "user not found" },
        }),
        updateUserById: async (id, payload) => {
          calls.updates.push({ table: "auth.users", payload });
          records[id] = { ...(records[id] || { id }), ...payload };
          return { data: { user: records[id] }, error: null };
        },
      },
    },
    functions: { invoke: async () => ({ data: null, error: null }) },
  };

  return { client, calls, records };
};

/* --------------------------- edge fn loader --------------------------- */

const catalogState = { shouldFail: false, packages: [] };
let cachedHandler = null;

globalThis.Deno = {
  serve: (fn) => {
    cachedHandler = fn;
  },
  env: {
    get: (key) => {
      if (key === "JEHUCA_API_KEY") return "test-key";
      if (key === "SUPABASE_URL") return "http://localhost:54321";
      if (key === "SUPABASE_SERVICE_ROLE_KEY") return "test-service-role-key";
      return undefined;
    },
  },
};

globalThis.fetch = async () => {
  if (catalogState.shouldFail) throw new Error("catalog unavailable");
  return { json: async () => ({ payload: catalogState.packages }) };
};

const loadEdgeFunction = (relativeFile, supabase) => {
  const file = path.join(appRoot, relativeFile);
  const { code } = babel.transformSync(fs.readFileSync(file, "utf8"), {
    filename: file,
    presets: [require.resolve("@babel/preset-typescript")],
    plugins: [require.resolve("@babel/plugin-transform-modules-commonjs")],
    babelrc: false,
    configFile: false,
    sourceMaps: false,
  });

  const localRequire = (request) => {
    if (request.startsWith("npm:@supabase/supabase-js")) {
      return { createClient: () => supabase };
    }
    if (request.startsWith(".")) {
      throw new Error(`unstubbed relative require: ${request}`);
    }
    return require(request);
  };

  const moduleShim = { exports: {} };
  const run = new Function("require", "module", "exports", "__filename", "__dirname", code);
  run(localRequire, moduleShim, moduleShim.exports, file, path.dirname(file));

  if (!cachedHandler) throw new Error(`${relativeFile} did not register a handler`);
  const handler = cachedHandler;
  cachedHandler = null;
  return handler;
};

const invokeEdge = async (handler, body) => {
  const response = await handler(
    new Request("http://localhost/function", {
      method: "POST",
      headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

  return { status: response.status, body: await response.json() };
};

/* ---------------- scenario data ---------------- */

const offersFixture = [
  { id: 1, super_agent_id: "sa-1", network: "MTN", data_value: "ISHARE - 1GB", title: "MTN Gold 1GB", price: 12.5, tier_name: "Gold", is_active: true },
  { id: 2, super_agent_id: "sa-1", network: "MTN", data_value: "ISHARE - 2GB", title: "MTN Gold 2GB", price: 22, tier_name: "Gold", is_active: true },
  { id: 3, super_agent_id: "sa-1", network: "MTN", data_value: "ISHARE - 1GB", title: "MTN General 1GB", price: 10, tier_name: null, is_active: true },
  { id: 4, super_agent_id: "sa-1", network: "MTN", data_value: "ISHARE - 3GB", title: "MTN General 3GB", price: 30, tier_name: null, is_active: true },
  { id: 5, super_agent_id: "sa-1", network: "TELECEL", data_value: "ISHARE - 1GB", title: "TELECEL Gold 1GB", price: 11, tier_name: "Gold", is_active: true },
  { id: 6, super_agent_id: "sa-1", network: "MTN", data_value: "ISHARE - 5GB", title: "MTN Silver 5GB", price: 50, tier_name: "Silver", is_active: true },
  { id: 7, super_agent_id: "sa-1", network: "MTN", data_value: "ISHARE - 10GB", title: "MTN Gold 10GB", price: 99, tier_name: "Gold", is_active: false },
];

const catalogFixture = [
  { id: "pkg-mtn-1gb", network: "MTN", type: "ISHARE", size: 1, price: 800 },
  { id: "pkg-mtn-2gb", network: "MTN", type: "ISHARE", size: 2, price: 1600 },
  { id: "pkg-mtn-3gb", network: "MTN", type: "ISHARE", size: 3, price: 2400 },
  { id: "pkg-tc-1gb", network: "TELECEL", type: "ISHARE", size: 1, price: 900 },
];

const agentUser = (metadata = {}) => ({
  id: "agent-1",
  email: "agent@example.com",
  user_metadata: { role: "Agent", super_agent_id: "sa-1", tier_name: "Gold", ...metadata },
});

const loadOffersFunction = (user, options = {}) => {
  const fake = createFakeSupabase({
    user,
    tables: { super_agent_offers: offersFixture },
    missingTables: options.missingTables || [],
  });

  return loadEdgeFunction("supabase/functions/super-agent-offers/index.ts", fake.client);
};

const offerFor = (offers, network, dataValue) =>
  offers.find((offer) => offer.network === network && offer.data_value === dataValue);

(async () => {
  catalogState.shouldFail = false;
  catalogState.packages = catalogFixture;

  /* ---------- Gold tier: tier prices win, General fills gaps ---------- */

  const gold = await invokeEdge(loadOffersFunction(agentUser()), {
    action: "getAgentPackages",
  });

  check("agent: status 200", gold.status, 200);
  check("agent: tier echoed back", gold.body.agent_tier, "Gold");
  check(
    "agent: tier price beats the General price",
    offerFor(gold.body.offers, "MTN", "ISHARE - 1GB").price,
    12.5,
  );
  check(
    "agent: bundle only priced in the tier is kept",
    offerFor(gold.body.offers, "MTN", "ISHARE - 2GB").price,
    22,
  );
  check(
    "agent: General fills a bundle the tier does not price",
    offerFor(gold.body.offers, "MTN", "ISHARE - 3GB").price,
    30,
  );
  check(
    "agent: other tiers fully hidden",
    gold.body.offers.some((offer) => offer.data_value === "ISHARE - 5GB"),
    false,
  );
  check(
    "agent: inactive offers hidden",
    gold.body.offers.some((offer) => offer.id === 7),
    false,
  );
  check("agent: visible bundle count", gold.body.offers.length, 4);
  check(
    "agent: MTN 1GB enriched from the catalog",
    offerFor(gold.body.offers, "MTN", "ISHARE - 1GB"),
    {
      id: 1,
      network: "MTN",
      data_value: "ISHARE - 1GB",
      title: "MTN Gold 1GB",
      price: 12.5,
      tier_name: "Gold",
      package_id: "pkg-mtn-1gb",
      type: "ISHARE",
      size: 1,
    },
  );
  check(
    "agent: General fallback marked untiered",
    offerFor(gold.body.offers, "MTN", "ISHARE - 3GB").tier_name,
    null,
  );

  /* ------------------------- network filter ------------------------- */

  const telecel = await invokeEdge(loadOffersFunction(agentUser()), {
    action: "getAgentPackages",
    network: "TELECEL",
  });
  check(
    "agent: network filter returns only that network",
    telecel.body.offers.map((offer) => [offer.network, offer.price]),
    [["TELECEL", 11]],
  );

  /* --------------------- agent without a tier --------------------- */

  const generalOnly = await invokeEdge(loadOffersFunction(agentUser({ tier_name: "" })), {
    action: "getAgentPackages",
  });
  check(
    "agent: no tier sees General prices only",
    generalOnly.body.offers.map((offer) => [offer.data_value, offer.price]),
    [["ISHARE - 1GB", 10], ["ISHARE - 3GB", 30]],
  );
  check("agent: no tier echoed as null", generalOnly.body.agent_tier, null);

  /* -------------------------- edge cases -------------------------- */

  const orphan = await invokeEdge(
    loadOffersFunction(agentUser({ super_agent_id: undefined })),
    { action: "getAgentPackages" },
  );
  check(
    "agent: without a super agent nothing is published",
    [orphan.status, orphan.body.offers, orphan.body.reason],
    [200, [], "no_super_agent"],
  );

  catalogState.shouldFail = true;
  const noCatalog = await invokeEdge(loadOffersFunction(agentUser()), {
    action: "getAgentPackages",
  });
  check(
    "agent: survives a catalog outage using the descriptor size",
    [
      noCatalog.status,
      offerFor(noCatalog.body.offers, "MTN", "ISHARE - 1GB").package_id,
      offerFor(noCatalog.body.offers, "MTN", "ISHARE - 1GB").size,
    ],
    [200, null, 1],
  );
  catalogState.shouldFail = false;

  const notMigrated = await invokeEdge(
    loadOffersFunction(agentUser(), { missingTables: ["super_agent_offers"] }),
    { action: "getAgentPackages" },
  );
  check(
    "agent: reports a pending migration instead of failing",
    [notMigrated.status, notMigrated.body.offers, notMigrated.body.migration_required],
    [200, [], true],
  );

  const forbidden = await invokeEdge(loadOffersFunction(agentUser()), {
    action: "listSuperAgentOffers",
  });
  check(
    "agent: cannot call super-agent-only actions",
    [forbidden.status, forbidden.body.error],
    [403, "User not allowed"],
  );

  /* ------------- super-agent-user-management: tiers ------------- */

  const superAgentUser = {
    id: "sa-1",
    email: "sa@example.com",
    user_metadata: { role: "SuperAgent" },
  };
  const tiersFixture = [
    { super_agent_id: "sa-1", name: "Gold" },
    { super_agent_id: "sa-1", name: "Silver" },
  ];

  const loadUserManagement = (options = {}) =>
    createFakeSupabase({
      user: superAgentUser,
      tables: { super_agent_tiers: tiersFixture },
      userRecords: options.userRecords || {},
      missingTables: options.missingTables || [],
    });

  const createBody = (userData = {}) => ({
    action: "createSubAgent",
    userData: {
      email: "new@example.com",
      password: "secret1",
      full_name: "New Agent",
      business_name: "New Biz",
      phone: "0244000000",
      initialBalance: 25,
      ...userData,
    },
  });

  const createdCase = loadUserManagement();
  const created = await invokeEdge(
    loadEdgeFunction("supabase/functions/super-agent-user-management/index.ts", createdCase.client),
    createBody({ tier_name: "Gold" }),
  );
  const createdMeta = createdCase.calls.inserts.find(
    (entry) => entry.table === "auth.users",
  )?.payload?.user_metadata;

  check("createSubAgent: status 200", created.status, 200);
  check("createSubAgent: tier stored on the agent", createdMeta?.tier_name, "Gold");
  check(
    "createSubAgent: role and super agent preserved",
    [createdMeta?.role, createdMeta?.super_agent_id],
    ["Agent", "sa-1"],
  );
  check(
    "createSubAgent: wallet funded",
    createdCase.calls.inserts.find((entry) => entry.table === "agent_wallet")?.payload,
    { agent_id: "created-agent-id", balance: 25 },
  );

  const generalCase = loadUserManagement();
  const generalCreated = await invokeEdge(
    loadEdgeFunction("supabase/functions/super-agent-user-management/index.ts", generalCase.client),
    createBody({ tier_name: "" }),
  );
  check(
    "createSubAgent: no tier means General",
    [
      generalCreated.status,
      generalCase.calls.inserts.find((entry) => entry.table === "auth.users")?.payload
        ?.user_metadata?.tier_name,
    ],
    [200, null],
  );

  const unknownCase = loadUserManagement();
  const unknownCreated = await invokeEdge(
    loadEdgeFunction("supabase/functions/super-agent-user-management/index.ts", unknownCase.client),
    createBody({ tier_name: "Platinum" }),
  );
  check(
    "createSubAgent: unknown tier rejected before creating the user",
    [unknownCreated.status, unknownCreated.body.error, unknownCase.calls.inserts.length],
    [400, "Unknown tier: Platinum", 0],
  );

  /* -------------------- changing an agent's tier -------------------- */

  const updateCase = loadUserManagement({
    userRecords: {
      "agent-9": {
        id: "agent-9",
        user_metadata: { role: "Agent", super_agent_id: "sa-1", full_name: "Old Name" },
      },
    },
  });
  const updateHandler = loadEdgeFunction(
    "supabase/functions/super-agent-user-management/index.ts",
    updateCase.client,
  );

  const updated = await invokeEdge(updateHandler, {
    action: "updateSubAgent",
    userData: { agent_id: "agent-9", tier_name: "Silver" },
  });
  check("updateSubAgent: status 200", updated.status, 200);
  check(
    "updateSubAgent: tier assigned",
    updateCase.records["agent-9"].user_metadata.tier_name,
    "Silver",
  );
  check(
    "updateSubAgent: existing metadata preserved",
    [
      updateCase.records["agent-9"].user_metadata.role,
      updateCase.records["agent-9"].user_metadata.super_agent_id,
      updateCase.records["agent-9"].user_metadata.full_name,
    ],
    ["Agent", "sa-1", "Old Name"],
  );

  const cleared = await invokeEdge(updateHandler, {
    action: "updateSubAgent",
    userData: { agent_id: "agent-9", tier_name: "" },
  });
  check(
    "updateSubAgent: clearing moves the agent to General",
    [cleared.status, updateCase.records["agent-9"].user_metadata.tier_name],
    [200, null],
  );

  const rejected = await invokeEdge(updateHandler, {
    action: "updateSubAgent",
    userData: { agent_id: "agent-9", tier_name: "Platinum" },
  });
  check(
    "updateSubAgent: unknown tier rejected and nothing written",
    [
      rejected.status,
      rejected.body.error,
      updateCase.records["agent-9"].user_metadata.tier_name,
    ],
    [400, "Unknown tier: Platinum", null],
  );

  const foreignCase = loadUserManagement({
    userRecords: {
      "agent-x": { id: "agent-x", user_metadata: { role: "Agent", super_agent_id: "other-sa" } },
    },
  });
  const foreign = await invokeEdge(
    loadEdgeFunction("supabase/functions/super-agent-user-management/index.ts", foreignCase.client),
    { action: "updateSubAgent", userData: { agent_id: "agent-x", tier_name: "Gold" } },
  );
  check(
    "updateSubAgent: cannot touch another super agent's agent",
    [foreign.status, foreign.body.error],
    [403, "Sub agent does not belong to this super agent"],
  );

  const legacyCase = loadUserManagement({
    missingTables: ["super_agent_tiers"],
    userRecords: {
      "agent-9": { id: "agent-9", user_metadata: { role: "Agent", super_agent_id: "sa-1" } },
    },
  });
  const legacy = await invokeEdge(
    loadEdgeFunction("supabase/functions/super-agent-user-management/index.ts", legacyCase.client),
    { action: "updateSubAgent", userData: { agent_id: "agent-9", tier_name: "Gold" } },
  );
  check(
    "updateSubAgent: still works before the tiers migration",
    [legacy.status, legacyCase.records["agent-9"].user_metadata.tier_name],
    [200, "Gold"],
  );

  const failed = results.filter((entry) => !entry.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed` +
      (failed.length ? ` — FAILED: ${failed.map((entry) => entry.name).join(", ")}` : ""),
  );
  process.exitCode = failed.length ? 1 : 0;
})();

