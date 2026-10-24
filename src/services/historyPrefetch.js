import { supabase } from "../lib/supabase";

export const HISTORY_PAGE_SIZE = 5;
const CACHE_MS = 20_000;
const historyPageCache = new Map();
const historyPageRequests = new Map();

export const fetchHistoryOrderPage = async ({
  userId,
  isAgent,
  isSuperAgent,
  page = 0,
}) => {
  const from = page * HISTORY_PAGE_SIZE;
  const to = from + HISTORY_PAGE_SIZE - 1;
  const cacheKey =
    page === 0
      ? `${userId}:${isAgent ? "agent" : "customer"}:${isSuperAgent ? "super" : "not-super"}`
      : null;

  if (cacheKey) {
    const cached = historyPageCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const existingRequest = historyPageRequests.get(cacheKey);
    if (existingRequest) return existingRequest;
  }

  const queryPage = async () => {
    const regularOrdersRequest = supabase
      .from("orders")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(from, to);
    const agentOrdersRequest = isAgent
      ? supabase
          .from("agent_orders")
          .select("*")
          .eq("agent_id", userId)
          .order("created_at", { ascending: false })
          .range(from, to)
      : null;
    const assignedOrdersRequest = isSuperAgent
      ? supabase
          .from("agent_orders")
          .select("*")
          .eq("super_agent_id", userId)
          .order("created_at", { ascending: false })
          .range(from, to)
      : null;
    const walletOrdersRequest = isSuperAgent
      ? supabase
          .from("orders")
          .select("*")
          .eq("super_agent_id", userId)
          .order("created_at", { ascending: false })
          .range(from, to)
      : null;

    const [
      regularOrders,
      agentOrders,
      assignedOrders,
      walletOrders,
    ] = await Promise.all([
      regularOrdersRequest,
      agentOrdersRequest,
      assignedOrdersRequest,
      walletOrdersRequest,
    ]);

    return { regularOrders, agentOrders, assignedOrders, walletOrders };
  };

  if (!cacheKey) return queryPage();

  const request = queryPage().then((data) => {
    historyPageCache.set(cacheKey, {
      data,
      expiresAt: Date.now() + CACHE_MS,
    });
    return data;
  }).finally(() => {
    historyPageRequests.delete(cacheKey);
  });

  historyPageRequests.set(cacheKey, request);
  return request;
};

export const preloadHistoryFirstPage = (options) =>
  fetchHistoryOrderPage({ ...options, page: 0 });
