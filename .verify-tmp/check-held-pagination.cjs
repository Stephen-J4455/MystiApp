// Throwaway validator (never shipped). Simulates the page-walking loop in
// loadOrders() against synthetic PostgREST responses, to prove it terminates
// and collects every row in each of the awkward cases: zero rows, exactly one
// page, a multi-page set, a set past PostgREST's max-rows clamp, and a row that
// leaves 'held' between two requests.
//
// Expected numbers are written BY HAND. (Learned the hard way in
// verifying-without-postgres.md: when one of these fails, the expectation is
// more likely wrong than the loop.)
const PAGE_SIZE = 200;

function makeServer(totalRows, { maxRows = 1000, churnAfter = null } = {}) {
  // The `status = 'held'` filter shrinks as rows "leave" the set.
  let live = totalRows;
  let served = 0;
  return () => {
    if (churnAfter !== null && served >= churnAfter) live -= 1;
    const remaining = Math.max(0, live - served);
    const clamped = Math.min(PAGE_SIZE, maxRows, remaining);
    const rows = Array.from({ length: clamped }, (_, i) => ({
      id: served + i + 1,
    }));
    const count = live;
    served += clamped;
    return { rows, count };
  };
}

// Mirrors the loop in SuperAgentHeldOrdersScreen.js loadOrders().
function walk(server) {
  const collected = [];
  let from = 0;
  let exactTotal = null;
  let requests = 0;
  for (;;) {
    const { rows, count } = server();
    requests++;
    if (requests > 500) return { collected, exactTotal, hung: true };
    collected.push(...rows);
    if (exactTotal === null && Number.isInteger(count)) exactTotal = count;
    from += rows.length;
    if (rows.length === 0) break;
    if (exactTotal !== null) {
      if (from >= exactTotal) break;
    } else if (rows.length < PAGE_SIZE) {
      break;
    }
  }
  return { collected, exactTotal, hung: false };
}

const cases = [
  { name: "no held orders at all", total: 0, expect: 0 },
  { name: "a single order", total: 1, expect: 1 },
  { name: "one short page", total: 57, expect: 57 },
  // 200 is the exact page size: a short-page test would wrongly stop at 200
  // having collected 200 of 401.
  { name: "exactly one full page", total: 200, expect: 200 },
  { name: "one full page plus a tail", total: 201, expect: 201 },
  { name: "a large multi-page set", total: 1234, expect: 1234 },
  // The bug being fixed: the old un-paginated select returned 1000 of these
  // and said nothing about the other 500.
  { name: "past the max-rows clamp", total: 2500, expect: 2500 },
  {
    name: "max-rows below the page size",
    total: 900,
    maxRows: 100,
    expect: 900,
  },
];

let failures = 0;
for (const c of cases) {
  const r = walk(makeServer(c.total, { maxRows: c.maxRows ?? 1000 }));
  const ok =
    !r.hung &&
    r.collected.length === c.expect &&
    r.exactTotal === c.total &&
    new Set(r.collected.map((o) => o.id)).size === c.expect; // no dupes
  if (!ok) failures++;
  console.log(
    `${ok ? "OK  " : "FAIL"}  ${c.name}: collected=${r.collected.length} ` +
      `unique=${new Set(r.collected.map((o) => o.id)).size} ` +
      `count=${r.exactTotal} expected=${c.expect} hung=${r.hung}`,
  );
}

// A row leaving 'held' mid-walk must not hang the loop on a stale count.
{
  const r = walk(makeServer(1000, { churnAfter: 400 }));
  const ok = !r.hung && r.collected.length < 1000;
  if (!ok) failures++;
  console.log(
    `${ok ? "OK  " : "FAIL"}  rows churning out mid-walk: collected=${r.collected.length} hung=${r.hung}`,
  );
}

// A server that never reports a count (count: undefined) must still terminate.
{
  let served = 0;
  const noCount = () => {
    const clamped = Math.min(PAGE_SIZE, Math.max(0, 900 - served));
    const rows = Array.from({ length: clamped }, (_, i) => ({
      id: served + i + 1,
    }));
    served += clamped;
    return { rows, count: undefined };
  };
  const r = walk(noCount);
  const ok = !r.hung && r.collected.length === 900;
  if (!ok) failures++;
  console.log(
    `${ok ? "OK  " : "FAIL"}  server reports no count: collected=${r.collected.length} hung=${r.hung}`,
  );
}

console.log(
  failures ? `\n${failures} FAILURE(S)` : "\nall pagination cases pass",
);
process.exit(failures ? 1 : 0);
