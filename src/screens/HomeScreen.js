import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  TouchableOpacity,
  Text,
  View,
  ScrollView,
  Linking,
  ImageBackground,
  Animated,
  StyleSheet,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { useTheme } from "../contexts/ThemeContext";
import { useDockBottomPadding } from "../hooks/useDockBottomPadding";
import { removeChannelSafe, uniqueTopic } from "../lib/realtime";
import { splitReceiptNumber } from "../lib/receiptNumber";
import {
  canReorderHeldOrders,
  isHeldWindowElapsed,
  isReorderableHeldOrder,
  reorderHeldOrder,
} from "../lib/heldOrderReorder";
import { fonts, networks } from "../components/theme";

// Contact numbers and the WhatsApp opener both come from lib/whatsapp.js.
// The admin number used to be defined HERE as "45GU7PROOYDFE1", which is a
// WhatsApp BUSINESS ACCOUNT ID, not a phone number. See lib/whatsapp.js for
// why the `wa.me/message/<id>` form silently drops the message body.
// Do not reintroduce local copies of these constants.
import {
  ADMIN_WHATSAPP,
  SUPPORT_WHATSAPP,
  openWhatsApp,
} from "../lib/whatsapp";

// Width of the super-agent drawer. Doubles as the closed slide distance so
// the panel parks fully off-screen instead of peeking past the right edge.
const DRAWER_WIDTH = 292;

const formatGhc = (value) => `Ghc ${Number(value || 0).toFixed(2)}`;

// Order status -> label + pill colours. Delegates to the shared, per-scheme
// tone table in theme.js so every screen agrees on wording and colour.
// "cancelled" is deliberately distinct from "failed": both read red (a dead
// order is an error signal) but the label keeps them distinguishable, which
// matches ReceiptScreen rendering the raw status.
const statusTone = (status, tones) => {
  switch (String(status || "").toLowerCase()) {
    case "completed":
    case "success":
      return tones.completed;
    case "processing":
      return tones.processing;
    case "pending":
      return tones.pending;
    case "failed":
      return tones.failed;
    case "cancelled":
    case "canceled": // US spelling, in case the backend ever uses it
      return tones.cancelled;
    case "refunded":
      return tones.refunded;
    // Lifecycle states the app owns itself. Both are in the shared map now, so
    // this is a lookup rather than a special case - but the case is spelled out
    // because the previous default-to-null behaviour silently dropped the pill.
    case "held":
      return tones.held;
    case "expired":
      return tones.expired;
    default:
      return null;
  }
};

const relativeTime = (iso) => {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < minute) return "Just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
};

// Builds an entrance style: fade + rise, staggered by `index`.
const useEntrance = (index, duration = 520) => {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration,
      delay: 90 * index,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, duration, index]);

  return {
    opacity: progress,
    transform: [
      {
        translateY: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [22, 0],
        }),
      },
    ],
  };
};

// `styles` and `c` are passed in rather than read from module scope: the
// stylesheet is per-colour-scheme now, so this helper has no way to reach
// the active palette on its own.
function SectionHead({ eyebrow, title, action, onAction, styles, c }) {
  return (
    <View style={styles.sectionHead}>
      <View style={styles.sectionHeadText}>
        {eyebrow ? <Text style={styles.sectionEyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {action ? (
        <TouchableOpacity
          style={styles.sectionAction}
          onPress={onAction}
          activeOpacity={0.7}
          hitSlop={8}
        >
          <Text style={styles.sectionActionText}>{action}</Text>
          <Ionicons name="arrow-forward" size={13} color={c.mint} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

export default function HomeScreen({ navigation }) {
  const { c, isDark, statusTone: tones } = useTheme();
  const styles = useStyles(c);
  // Clears the floating bottom dock so the footer text is never trapped
  // underneath it. Zero on web, where there is no dock.
  const dockPadding = useDockBottomPadding(16);
  const [user, setUser] = useState(null);
  const [isAgent, setIsAgent] = useState(false);
  const [isSuperAgent, setIsSuperAgent] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [transactions, setTransactions] = useState([]);
  const [loadingTransactions, setLoadingTransactions] = useState(true);
  const [ads, setAds] = useState([]);
  const [loadingAds, setLoadingAds] = useState(true);
  const [currentAdIndex, setCurrentAdIndex] = useState(0);
  const [viewedAds, setViewedAds] = useState(new Set()); // Track viewed ads for impressions
  const [menuOpen, setMenuOpen] = useState(false);
  // The drawer host is a full-screen absolute overlay, so keeping it mounted
  // while closed means it sits on top of the very button that opens it. That
  // is fragile - whether it swallows the tap depends on how the platform
  // resolves pointerEvents - and the failure mode is silent: the button looks
  // dead. Tracking mount state explicitly removes the ambiguity; `menuOpen`
  // only drives the animation, `menuMounted` drives the presence in the tree.
  const [menuMounted, setMenuMounted] = useState(false);
  const [isEnterpriseSuperAgent, setIsEnterpriseSuperAgent] = useState(true);
  const [walletBalance, setWalletBalance] = useState(null);
  const [loadingWallet, setLoadingWallet] = useState(false);
  const adsScrollViewRef = useRef(null);
  const autoScrollIntervalRef = useRef(null);
  const adRefs = useRef({}); // Refs for each ad component
  const { showSuccess, showError } = useNotification();
  // Id of the held order currently being retried, or null. One id rather than a
  // boolean so a second row cannot be tapped mid-flight and the tapped row shows
  // its own spinner.
  const [reorderingId, setReorderingId] = useState(null);
  const transactionsSkeletonOpacity = useRef(new Animated.Value(0.6)).current;
  const drawerAnim = useRef(new Animated.Value(0)).current;

  // Open: mount first, then slide in. Close: slide out, then unmount once the
  // animation settles. Unmounting immediately would make the panel disappear
  // mid-slide instead of sliding away, which is why the mount flag exists
  // rather than gating the render on `menuOpen` alone.
  useEffect(() => {
    if (menuOpen) {
      setMenuMounted(true);
      const anim = Animated.timing(drawerAnim, {
        toValue: 1,
        duration: 220,
        useNativeDriver: true,
      });
      anim.start();
      return () => anim.stop();
    }

    const anim = Animated.timing(drawerAnim, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    });
    anim.start(({ finished }) => {
      if (finished) setMenuMounted(false);
    });
    return () => anim.stop();
  }, [drawerAnim, menuOpen]);

  const toggleMenu = () => {
    if (menuOpen) {
      setMenuOpen(false);
    } else {
      setMenuMounted(true);
      setMenuOpen(true);
    }
  };

  const drawerStyle = useMemo(
    () => ({
      transform: [
        {
          translateX: drawerAnim.interpolate({
            inputRange: [0, 1],
            outputRange: [DRAWER_WIDTH + 40, 0],
          }),
        },
      ],
    }),
    [drawerAnim],
  );

  const heroEntrance = useEntrance(0);
  const quickEntrance = useEntrance(1);
  const suiteEntrance = useEntrance(2);
  const networkEntrance = useEntrance(3);
  const activityEntrance = useEntrance(4);
  const promoEntrance = useEntrance(5);

  const badgeValue = String(
    user?.user_metadata?.super_agent_badge ||
      user?.app_metadata?.super_agent_badge ||
      "enterprise",
  ).toLowerCase();
  const isProSuperAgent = isSuperAgent && badgeValue === "pro";

  // Does this hero show a WALLET, as opposed to the "Your data hub" summary?
  //
  // A wallet row is not the same thing as holding the super agent role. A
  // sub-agent demoted from Super Agent still owns their `super_agent_wallets`
  // row - the table is keyed on `super_agent_id` and its RLS is
  // `super_agent_id = auth.uid()` with no role term - so their balance is real
  // and belongs on screen. Gating this on the role is what made the money look
  // like it had vanished.
  //
  // A current super agent gets the wallet presentation even before their row
  // exists, because the top-up flow is what creates it; the amount itself still
  // renders the "Ghc —.—" placeholder until the read lands.
  const hasWallet = isSuperAgent || walletBalance !== null;

  const networkCards = [
    {
      key: "mtn",
      name: "MTN",
      desc: "Super Fast Data",
      sub: "5G Ready",
      tag: "Best Value",
      accent: networks.mtn,
      image: require("../../assets/mtn.jpg"),
    },
    {
      key: "telecel",
      name: "Telecel",
      desc: "Voice & Bundles",
      sub: "Flexible Plans",
      tag: "Popular",
      accent: networks.telecel,
      image: require("../../assets/telecel.jpg"),
    },
    {
      key: "airteltigo",
      name: "AirtelTigo",
      desc: "Stay Connected",
      sub: "Daily Deals",
      tag: "Hot",
      accent: networks.airteltigo,
      image: require("../../assets/airteltigo.jpg"),
    },
  ];

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(transactionsSkeletonOpacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(transactionsSkeletonOpacity, {
          toValue: 0.6,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [transactionsSkeletonOpacity]);

  useEffect(() => {
    getCurrentUser();
    fetchUnreadNotifications();

    // Add listener to refresh data when returning to screen
    const unsubscribe = navigation.addListener("focus", () => {
      checkAgentStatus({ refreshTransactions: false, refreshAds: false });
      fetchUnreadNotifications(); // Refresh notification count when screen comes into focus
      setViewedAds(new Set()); // Reset viewed ads when returning to screen
    });

    return unsubscribe;
  }, [navigation]);

  // Real-time notification count updates
  useEffect(() => {
    const subscriptionRef = { current: null };

    const setupRealtimeSubscription = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          subscriptionRef.current = supabase
            .channel(uniqueTopic("notification_count_realtime"))
            .on(
              "postgres_changes",
              {
                event: "INSERT",
                schema: "public",
                table: "notifications",
                filter: `user_id=eq.${user.id}`,
              },
              (payload) => {
                // Increment count if the new notification is unread
                if (!payload.new.read) {
                  setUnreadCount((prev) => prev + 1);
                }
              },
            )
            .on(
              "postgres_changes",
              {
                event: "UPDATE",
                schema: "public",
                table: "notifications",
                filter: `user_id=eq.${user.id}`,
              },
              (payload) => {
                // Handle read status changes
                if (payload.old.read !== payload.new.read) {
                  if (payload.new.read) {
                    // Marked as read - decrement count
                    setUnreadCount((prev) => Math.max(0, prev - 1));
                  } else {
                    // Marked as unread - increment count
                    setUnreadCount((prev) => prev + 1);
                  }
                }
              },
            )
            .on(
              "postgres_changes",
              {
                event: "DELETE",
                schema: "public",
                table: "notifications",
                filter: `user_id=eq.${user.id}`,
              },
              (payload) => {
                // Decrement count if the deleted notification was unread
                if (!payload.old.read) {
                  setUnreadCount((prev) => Math.max(0, prev - 1));
                }
              },
            )
            .subscribe();
        }
      } catch (error) {
        console.error(
          "Error setting up notification count realtime subscription:",
          error,
        );
      }
    };

    setupRealtimeSubscription();

    // Cleanup subscription on unmount
    return () => {
      removeChannelSafe(subscriptionRef.current);
    };
  }, []);

  // Real-time updates for transactions
  useEffect(() => {
    let ordersSubscription = null;
    let agentOrdersSubscription = null;

    const setupTransactionsRealtime = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user) {
          // Subscribe to regular orders
          ordersSubscription = supabase
            .channel(uniqueTopic("home_orders_realtime"))
            .on(
              "postgres_changes",
              {
                event: "*",
                schema: "public",
                table: "orders",
                filter: `user_id=eq.${user.id}`,
              },
              (payload) => {
                if (payload.eventType === "DELETE") {
                  removeRecentTransaction(payload.old?.id);
                  return;
                }
                upsertRecentTransaction(payload.new, "regular");
              },
            )
            .subscribe();

          // Subscribe to sub-agent orders using the role/assignment, not a wallet.
          const normalizedRole = String(
            user.user_metadata?.role || user.app_metadata?.role || "",
          ).toLowerCase();
          if (
            normalizedRole === "agent" ||
            normalizedRole === "sub_agent" ||
            user.user_metadata?.super_agent_id
          ) {
            agentOrdersSubscription = supabase
              .channel(uniqueTopic("home_agent_orders_realtime"))
              .on(
                "postgres_changes",
                {
                  event: "*",
                  schema: "public",
                  table: "agent_orders",
                  filter: `agent_id=eq.${user.id}`,
                },
                (payload) => {
                  if (payload.eventType === "DELETE") {
                    removeRecentTransaction(payload.old?.id);
                    return;
                  }
                  upsertRecentTransaction(payload.new, "agent");
                },
              )
              .subscribe();
          }
        }
      } catch (error) {
        console.error(
          "Error setting up transactions realtime subscriptions:",
          error,
        );
      }
    };

    setupTransactionsRealtime();

    return () => {
      removeChannelSafe(ordersSubscription);
      removeChannelSafe(agentOrdersSubscription);
    };
  }, []);

  // Super-agent wallet balance for the hero card, kept live.
  //
  // NOT gated on the role. `super_agent_wallets` is keyed on `super_agent_id`
  // and its RLS is `super_agent_id = auth.uid()` with no role term, so a
  // sub-agent demoted from Super Agent still owns their row and the balance is
  // still theirs. This effect used to return early for every non-super-agent,
  // which is why a demoted account with a real balance saw "Your data hub"
  // instead of the number.
  //
  // The read itself decides: no row means `walletBalance` stays null and the
  // hero falls back to the non-wallet presentation below.
  useEffect(() => {
    let cancelled = false;
    // Keyed by user id: the channel needs the id in its filter, which is only
    // known after `getUser()` resolves. Registering the channel in a ref as
    // soon as it exists is what makes cleanup reliable - a plain closure
    // variable is still null if the effect is torn down during the awaits, and
    // the channel then leaks and collides with the next mount.
    const walletChannelRef = { current: null };

    const loadWallet = async () => {
      try {
        setLoadingWallet(true);
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user || cancelled) return;

        const { data, error } = await supabase
          .from("super_agent_wallets")
          .select("balance")
          .eq("super_agent_id", user.id)
          .maybeSingle();

        if (cancelled) return;
        if (error) {
          console.error("Wallet balance fetch error:", error);
        } else {
          setWalletBalance(Number(data?.balance || 0));
        }

        walletChannelRef.current = supabase
          .channel(uniqueTopic("home_wallet_balance_realtime"))
          .on(
            "postgres_changes",
            {
              // INSERT and DELETE, not just UPDATE. The first top-up CREATES
              // the row, so on an `UPDATE`-only subscription the hero would
              // never notice the wallet appearing - and a DELETE (row removed)
              // would leave a stale balance on screen.
              event: "*",
              schema: "public",
              table: "super_agent_wallets",
              filter: `super_agent_id=eq.${user.id}`,
            },
            (payload) => {
              if (payload.eventType === "DELETE") {
                setWalletBalance(null);
                return;
              }
              setWalletBalance(Number(payload.new?.balance || 0));
            },
          )
          .subscribe();
      } catch (error) {
        console.error("Wallet balance error:", error);
      } finally {
        if (!cancelled) setLoadingWallet(false);
      }
    };

    loadWallet();

    return () => {
      cancelled = true;
      removeChannelSafe(walletChannelRef.current);
    };
  }, [isSuperAgent]);

  // Auto-scroll ads effect
  useEffect(() => {
    if (ads.length > 1) {
      // Start auto-scrolling
      autoScrollIntervalRef.current = setInterval(() => {
        setCurrentAdIndex((prevIndex) => {
          const nextIndex = (prevIndex + 1) % ads.length;

          // Scroll to the next ad
          if (adsScrollViewRef.current) {
            adsScrollViewRef.current.scrollTo({
              x: nextIndex * 295, // 280px card width + 15px margin
              animated: true,
            });
          }

          return nextIndex;
        });
      }, 4000); // Change ad every 4 seconds
    }

    return () => {
      if (autoScrollIntervalRef.current) {
        clearInterval(autoScrollIntervalRef.current);
      }
    };
  }, [ads]);

  // Check ad visibility when ads are loaded
  useEffect(() => {
    if (ads.length > 0) {
      // Delay to ensure components are rendered
      setTimeout(() => {
        ads.forEach((ad) => {
          const checkVisibilityWithRetry = (retries = 3) => {
            const adRef = adRefs.current[ad.id];
            if (adRef && typeof adRef.measure === "function") {
              checkAdVisibility(ad.id, adRef);
            } else if (retries > 0) {
              setTimeout(() => checkVisibilityWithRetry(retries - 1), 200);
            }
          };
          checkVisibilityWithRetry();
        });
      }, 500);
    }
  }, [ads]);

  // Reset state when ads change
  useEffect(() => {
    setCurrentAdIndex(0);
    setViewedAds(new Set()); // Reset viewed ads when ads change
    adRefs.current = {}; // Clear ad refs when ads change
    if (adsScrollViewRef.current) {
      adsScrollViewRef.current.scrollTo({ x: 0, animated: false });
    }
  }, [ads]);

  const getCurrentUser = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    setUser(user);

    const normalizedRole = (
      user?.user_metadata?.role ||
      user?.app_metadata?.role ||
      ""
    )
      .toString()
      .trim()
      .toLowerCase();
    const isSuperAgentUser =
      normalizedRole === "superagent" || normalizedRole === "super_agent";
    setIsSuperAgent(isSuperAgentUser);
    setIsEnterpriseSuperAgent(
      !isSuperAgentUser ||
        String(
          user?.user_metadata?.super_agent_badge ||
            user?.app_metadata?.super_agent_badge ||
            "enterprise",
        ).toLowerCase() !== "pro",
    );

    // Check if user is a sub-agent using role and assignment metadata.
    if (user) {
      try {
        const agentStatus =
          normalizedRole === "agent" ||
          normalizedRole === "sub_agent" ||
          Boolean(
            user.user_metadata?.super_agent_id ||
            user.user_metadata?.superAgentId,
          );
        setIsAgent(agentStatus);

        // Fetch independent home data in parallel instead of serializing two
        // network requests before the home content can settle.
        await Promise.all([
          fetchRecentTransactions(agentStatus),
          fetchAds(agentStatus),
        ]);
      } catch (error) {
        console.error("Error checking agent status:", error);
        setIsAgent(false);
        // Fetch data even if agent check fails
        await Promise.all([fetchRecentTransactions(false), fetchAds(false)]);
      }
    } else {
      setIsAgent(false);
      await Promise.all([fetchRecentTransactions(false), fetchAds(false)]);
    }
  };

  const checkAgentStatus = async ({
    refreshTransactions = true,
    refreshAds = true,
  } = {}) => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const normalizedRole = (
          user?.user_metadata?.role ||
          user?.app_metadata?.role ||
          ""
        )
          .toString()
          .trim()
          .toLowerCase();
        const isSuperAgentUser =
          normalizedRole === "superagent" || normalizedRole === "super_agent";
        setIsSuperAgent(isSuperAgentUser);
        setIsEnterpriseSuperAgent(
          !isSuperAgentUser ||
            String(
              user?.user_metadata?.super_agent_badge ||
                user?.app_metadata?.super_agent_badge ||
                "enterprise",
            ).toLowerCase() !== "pro",
        );

        const agentStatus =
          normalizedRole === "agent" ||
          normalizedRole === "sub_agent" ||
          Boolean(
            user.user_metadata?.super_agent_id ||
            user.user_metadata?.superAgentId,
          );
        setIsAgent(agentStatus);

        if (refreshTransactions) {
          fetchRecentTransactions(agentStatus);
        }
        if (refreshAds) {
          fetchAds(agentStatus);
        }
      }
    } catch (error) {
      console.error("Error checking agent status:", error);
      setIsAgent(false);
      if (refreshTransactions) {
        fetchRecentTransactions(false);
      }
      if (refreshAds) {
        fetchAds(false);
      }
    }
  };

  const fetchUnreadNotifications = async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        const { data, error } = await supabase
          .from("notifications")
          .select("id")
          .eq("user_id", user.id)
          .eq("read", false);

        if (error) {
          console.error("Error fetching unread notifications:", error);
        } else {
          setUnreadCount(data?.length || 0);
        }
      }
    } catch (error) {
      console.error("Error:", error);
    }
  };

  const normalizeTransaction = (transaction, orderType) => ({
    ...transaction,
    orderType,
    ...(orderType === "agent" && {
      displayName: transaction.recipient_name,
      displayPhone: transaction.recipient_phone,
    }),
  });

  const upsertRecentTransaction = (transaction, orderType) => {
    if (!transaction) return;
    const normalized = normalizeTransaction(transaction, orderType);
    setTransactions((prev) => {
      const next = [
        normalized,
        ...prev.filter((item) => item.id !== normalized.id),
      ];
      return next
        .sort(
          (a, b) =>
            new Date(b.created_at || 0).getTime() -
            new Date(a.created_at || 0).getTime(),
        )
        .slice(0, 5);
    });
  };

  const removeRecentTransaction = (transactionId) => {
    if (!transactionId) return;
    setTransactions((prev) => prev.filter((item) => item.id !== transactionId));
  };

  // Retries a held sub-agent order from the activity list. The window check, the
  // invoke and the error unwrapping all live in lib/heldOrderReorder.js so this
  // screen, the Receipt, History and the Held Orders screen cannot drift.
  // Re-reads the list on success so the row's status and the wallet balance both
  // reflect the new order.
  const handleReorderHeldOrder = async (transaction) => {
    setReorderingId(transaction.id);
    try {
      const result = await reorderHeldOrder(transaction);
      if (!result.ok) {
        showError("Reorder Failed", result.message);
        return;
      }
      showSuccess("Order Reordered", "The package was sent to Jehucal.");
      checkAgentStatus({ refreshTransactions: true, refreshAds: false });
    } finally {
      setReorderingId(null);
    }
  };

  const fetchRecentTransactions = async (agentStatus = isAgent) => {
    try {
      setLoadingTransactions(true);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        let data, error;

        if (agentStatus) {
          // Fetch from agent_orders for agents
          const result = await supabase
            .from("agent_orders")
            .select("*")
            .eq("agent_id", user.id)
            .order("created_at", { ascending: false })
            .limit(5);
          data = result.data;
          error = result.error;
        } else {
          // Fetch from regular orders for regular users
          const result = await supabase
            .from("orders")
            .select("*")
            .eq("user_id", user.id)
            .order("created_at", { ascending: false })
            .limit(5);
          data = result.data;
          error = result.error;
        }

        if (error) {
          console.error("Error fetching transactions:", error);
        } else {
          // Normalize transactions to include orderType and display fields
          let normalizedTransactions = (data || []).map((transaction) => ({
            ...transaction,
            orderType: agentStatus ? "agent" : "regular",
            ...(agentStatus && {
              displayName: transaction.recipient_name,
              displayPhone: transaction.recipient_phone,
            }),
          }));

          // A super agent's OWN recent activity never contained their sub-agents'
          // held orders, because both branches above select by `agent_id` or
          // `user_id` - i.e. orders the super agent placed themselves. Held rows
          // live on `agent_orders` under `super_agent_id`, so a super agent
          // whose wallet had run dry saw no sign of the order that needed
          // reordering anywhere on Home. Pull those in so the reorder affordance
          // has something to act on.
          //
          // Only `held` rows, and only for a super agent: a non-super-agent must
          // never see rows they cannot reorder (the server 403s them), and this
          // keeps the Home list to the same five recent entries rather than
          // growing it with someone else's backlog.
          if (isSuperAgent) {
            const heldResult = await supabase
              .from("agent_orders")
              .select("*")
              .eq("super_agent_id", user.id)
              .eq("status", "held")
              .order("created_at", { ascending: false })
              .limit(5);

            if (heldResult.error) {
              // Non-fatal: the primary list is already loaded, and losing the
              // held rows must not blank the whole activity section.
              console.error(
                "Error fetching held agent orders:",
                heldResult.error,
              );
            } else {
              const heldRows = (heldResult.data || []).map((transaction) => ({
                ...transaction,
                orderType: "agent",
                isSubAgentTransaction: true,
                displayName: transaction.recipient_name,
                displayPhone: transaction.recipient_phone,
              }));

              // A row can satisfy both filters only in theory, but the
              // `orderType`-`id` key used in the list would collide if it did,
              // so de-duplicate before merging rather than trusting that.
              const seen = new Set(
                normalizedTransactions.map((item) => `agent-${item.id}`),
              );
              const heldOnly = heldRows.filter(
                (item) => !seen.has(`agent-${item.id}`),
              );

              normalizedTransactions = [...heldOnly, ...normalizedTransactions]
                .sort(
                  (a, b) =>
                    new Date(b.created_at || 0).getTime() -
                    new Date(a.created_at || 0).getTime(),
                )
                .slice(0, 5);
            }
          }

          setTransactions(normalizedTransactions);
        }
      }
    } catch (error) {
      console.error("Error:", error);
    } finally {
      setLoadingTransactions(false);
    }
  };

  const fetchAds = async (agentStatus = isAgent) => {
    try {
      setLoadingAds(true);
      // Always fetch from ads table for both agents and regular users
      const result = await supabase
        .from("ads")
        .select("*")
        .eq("is_active", true)
        .order("display_order", { ascending: false })
        .order("priority", { ascending: false })
        .limit(10);
      const data = result.data;
      const error = result.error;

      if (error) {
        console.error("Error fetching ads:", error);
      } else {
        setAds(data || []);
      }
    } catch (error) {
      console.error("Error:", error);
    } finally {
      setLoadingAds(false);
    }
  };

  const updateAdClick = async (adId) => {
    try {
      const { data, error: selectError } = await supabase
        .from("ads")
        .select("click_count")
        .eq("id", adId)
        .single();
      if (selectError) {
        console.error("Error selecting click count:", selectError);
        return;
      }
      const { error: updateError } = await supabase
        .from("ads")
        .update({ click_count: (data.click_count || 0) + 1 })
        .eq("id", adId);
      if (updateError) {
        console.error("Error updating click count:", updateError);
      } else {
      }
    } catch (error) {
      console.error("Error:", error);
    }
  };

  const updateAdImpression = async (adId) => {
    try {
      const { data, error: selectError } = await supabase
        .from("ads")
        .select("impression_count")
        .eq("id", adId)
        .single();
      if (selectError) {
        console.error("Error selecting impression count:", selectError);
        return;
      }
      const { error: updateError } = await supabase
        .from("ads")
        .update({ impression_count: (data.impression_count || 0) + 1 })
        .eq("id", adId);
      if (updateError) {
        console.error("Error updating impression count:", updateError);
      }
    } catch (error) {
      console.error("Error:", error);
    }
  };

  // Check if ad is in viewport and update impression
  const checkAdVisibility = async (adId, adRef) => {
    if (!adRef || viewedAds.has(adId) || typeof adRef.measure !== "function")
      return;

    try {
      adRef.measure((x, y, width, height, pageX, pageY) => {
        // Check if ad is visible in viewport (considering some buffer)
        const screenHeight = 800; // Approximate screen height
        const isVisible = pageY + height > 0 && pageY < screenHeight;

        if (isVisible && !viewedAds.has(adId)) {
          setViewedAds((prev) => new Set([...prev, adId]));
          updateAdImpression(adId);
        }
      });
    } catch (error) {
      // Silently handle measurement errors to avoid console spam
    }
  };

  // Handle scroll to check ad visibility
  const handleScroll = () => {
    ads.forEach((ad) => {
      const adRef = adRefs.current[ad.id];
      if (adRef) {
        checkAdVisibility(ad.id, adRef);
      }
    });
  };

  const renderRecentTransactionPlaceholders = () => (
    <View style={styles.skeletonList}>
      {[0, 1, 2].map((index) => (
        <Animated.View
          key={`transaction-placeholder-${index}`}
          style={[styles.skeletonRow, { opacity: transactionsSkeletonOpacity }]}
        >
          <View style={styles.skeletonMark} />
          <View style={styles.skeletonBody}>
            <View style={styles.skeletonLineWide} />
            <View style={styles.skeletonLineNarrow} />
          </View>
          <View style={styles.skeletonTail}>
            <View style={styles.skeletonLineAmount} />
            <View style={styles.skeletonLineTiny} />
          </View>
        </Animated.View>
      ))}
    </View>
  );

  const quickActions = [
    {
      key: "history",
      label: "Orders",
      icon: "receipt-outline",
      tint: c.mint,
      onPress: () => navigation.navigate("History"),
    },
    {
      key: "afa",
      label: "AFA Reg",
      icon: "shield-checkmark-outline",
      tint: c.sky,
      onPress: () => navigation.navigate("AfaRegistration"),
    },
    {
      key: "support",
      label: "Support",
      icon: "chatbubbles-outline",
      tint: c.amber,
      // `openWhatsApp` now reports a failure instead of swallowing it into a
      // console.warn, so a device with no WhatsApp installed tells the user
      // rather than appearing to do nothing when tapped.
      onPress: () =>
        openWhatsApp(
          SUPPORT_WHATSAPP,
          "Hi, I need help with the Mystiwan E-Business app",
        ).then((result) => {
          if (!result.ok) showError("Cannot Open WhatsApp", result.message);
        }),
    },
    {
      key: "settings",
      label: "Settings",
      icon: "options-outline",
      tint: c.textSecondary,
      onPress: () => navigation.navigate("Profile"),
    },
  ];

  const suiteItems = [
    {
      key: "analytics",
      label: "Analytics",
      icon: "stats-chart-outline",
      tint: c.sky,
      onPress: () => navigation.navigate("SuperAgentAnalytics"),
    },
    {
      key: "offers",
      label: "Offers",
      icon: "pricetags-outline",
      tint: c.mint,
      onPress: () => navigation.navigate("SuperAgentOffers"),
    },
    {
      key: "agents",
      label: "Agents",
      icon: "people-outline",
      tint: c.amber,
      onPress: () => navigation.navigate("SuperAgentAgents"),
    },
    ...(isEnterpriseSuperAgent
      ? [
          {
            key: "tiers",
            label: "Tiers",
            icon: "layers-outline",
            tint: c.mint,
            onPress: () => navigation.navigate("SuperAgentTierManagement"),
          },
          {
            key: "paystack",
            label: "Paystack",
            icon: "card-outline",
            tint: c.sky,
            onPress: () => navigation.navigate("SuperAgentPaystack"),
          },
        ]
      : []),
    {
      key: "topup",
      label: "Top Up",
      icon: "wallet-outline",
      tint: c.amber,
      onPress: () => navigation.navigate("WalletTopUp"),
    },
  ];

  const menuItems = [
    ...(isEnterpriseSuperAgent
      ? [
          {
            key: "orders",
            icon: "receipt-outline",
            label: "All Orders",
            tint: c.mint,
            onPress: () => navigation.navigate("History"),
          },
          {
            key: "tiers",
            icon: "layers-outline",
            label: "Tier Management",
            tint: c.mint,
            onPress: () => navigation.navigate("SuperAgentTierManagement"),
          },
          {
            key: "offers",
            icon: "pricetags-outline",
            label: "Offer Management",
            tint: c.mint,
            onPress: () => navigation.navigate("SuperAgentOffers"),
          },
          {
            key: "agents",
            icon: "people-outline",
            label: "Agents",
            tint: c.mint,
            onPress: () => navigation.navigate("SuperAgentAgents"),
          },
          {
            key: "analytics",
            icon: "stats-chart-outline",
            label: "Business Analytics",
            tint: c.mint,
            onPress: () => navigation.navigate("SuperAgentAnalytics"),
          },
          {
            key: "paystack",
            icon: "card-outline",
            label: "Paystack Sub-Account",
            tint: c.mint,
            onPress: () => navigation.navigate("SuperAgentPaystack"),
          },
        ]
      : []),
    {
      key: "afa",
      icon: "shield-checkmark-outline",
      label: "AFA Registration",
      tint: c.sky,
      onPress: () => navigation.navigate("AfaRegistration"),
    },
    {
      key: "topup",
      icon: "wallet-outline",
      label: "Wallet Top-up",
      tint: c.mint,
      onPress: () => navigation.navigate("WalletTopUp"),
    },
    {
      key: "settings",
      icon: "options-outline",
      label: "Settings",
      tint: c.mint,
      onPress: () => navigation.navigate("Profile"),
    },
    {
      key: "admin",
      icon: "logo-whatsapp",
      label: "Contact Admin",
      tint: c.mint,
      onPress: () =>
        openWhatsApp(
          ADMIN_WHATSAPP,
          "Hi Admin, I need help with my Super Agent account on the Mystiwan E-Business app.",
        ).then((result) => {
          if (!result.ok) showError("Cannot Open WhatsApp", result.message);
        }),
    },
  ];

  const displayName =
    user?.user_metadata?.full_name || user?.email?.split("@")[0] || "User";

  const greeting = (() => {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    return "Good evening";
  })();

  return (
    <View style={styles.root}>
      <StatusBar style={isDark ? "light" : "dark"} />
      <ScrollView
        vertical
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: dockPadding },
        ]}
      >
        {/* Ambient glow anchored behind the hero */}
        <View pointerEvents="none" style={styles.ambientGlow} />

        <SafeAreaView edges={["top"]} style={styles.safeArea}>
          {/* ---------- Top bar ---------- */}
          <Animated.View style={[styles.topBar, heroEntrance]}>
            <TouchableOpacity
              style={styles.identity}
              onPress={() => navigation.navigate("Profile")}
              activeOpacity={0.75}
            >
              <LinearGradient
                colors={[c.heroVia, c.heroTo]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.avatar}
              >
                <Text style={styles.avatarInitial}>
                  {displayName.charAt(0).toUpperCase()}
                </Text>
              </LinearGradient>

              <View style={styles.identityText}>
                <Text style={styles.greeting} numberOfLines={1}>
                  {greeting}
                </Text>
                <Text style={styles.displayName} numberOfLines={1}>
                  {displayName}
                </Text>
                {isSuperAgent ? (
                  <View
                    style={[
                      styles.roleBadge,
                      isProSuperAgent
                        ? styles.roleBadgePro
                        : styles.roleBadgeEnterprise,
                    ]}
                  >
                    <Ionicons
                      name={isProSuperAgent ? "flash" : "business"}
                      size={9}
                      color={isProSuperAgent ? c.amber : c.mint}
                    />
                    <Text
                      style={[
                        styles.roleBadgeText,
                        { color: isProSuperAgent ? c.amber : c.mint },
                      ]}
                    >
                      {isProSuperAgent ? "Pro Agent" : "Enterprise"}
                    </Text>
                  </View>
                ) : isAgent ? (
                  <View style={[styles.roleBadge, styles.roleBadgeAgent]}>
                    <Ionicons name="people" size={9} color={c.sky} />
                    <Text style={[styles.roleBadgeText, { color: c.sky }]}>
                      Agent
                    </Text>
                  </View>
                ) : null}
              </View>
            </TouchableOpacity>

            <View style={styles.topBarActions}>
              <TouchableOpacity
                style={styles.iconButton}
                onPress={() => navigation.navigate("Notifications")}
                activeOpacity={0.7}
              >
                <Ionicons
                  name="notifications-outline"
                  size={20}
                  color={c.textPrimary}
                />
                {unreadCount > 0 && (
                  <View style={styles.notificationBadge}>
                    <Text style={styles.badgeText}>
                      {unreadCount > 99 ? "99+" : unreadCount}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>

              {isSuperAgent ? (
                /* The bottom dock's centre button owns the overflow menu on
                   native, and the in-tree drawer never reliably received its
                   own open tap. Native therefore shows the profile button here
                   and reaches every destination through the dock instead. */
                Platform.OS === "web" ? (
                  <TouchableOpacity
                    style={styles.iconButton}
                    onPress={toggleMenu}
                    activeOpacity={0.7}
                    hitSlop={6}
                  >
                    <Ionicons
                      name="ellipsis-horizontal"
                      size={20}
                      color={c.textPrimary}
                    />
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={styles.iconButton}
                    onPress={() => navigation.navigate("Profile")}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name="person-outline"
                      size={20}
                      color={c.textPrimary}
                    />
                  </TouchableOpacity>
                )
              ) : (
                <TouchableOpacity
                  style={styles.iconButton}
                  onPress={() => navigation.navigate("Profile")}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name="person-outline"
                    size={20}
                    color={c.textPrimary}
                  />
                </TouchableOpacity>
              )}
            </View>
          </Animated.View>

          {/* ---------- Hero ---------- */}
          <Animated.View style={[styles.heroWrap, heroEntrance]}>
            <LinearGradient
              colors={[c.heroFrom, c.heroVia, c.heroTo]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.hero}
            >
              <View pointerEvents="none" style={styles.heroHalo} />
              <View pointerEvents="none" style={styles.heroArc} />

              <View style={styles.heroTopRow}>
                <View style={styles.heroLabelRow}>
                  <Ionicons
                    name={hasWallet ? "wallet" : "sparkles"}
                    size={13}
                    color={c.textSecondary}
                  />
                  <Text style={styles.heroLabel}>
                    {hasWallet ? "Available balance" : "Your data hub"}
                  </Text>
                </View>
                <View style={styles.heroPill}>
                  <View style={styles.heroPillDot} />
                  <Text style={styles.heroPillText}>
                    {hasWallet
                      ? isSuperAgent
                        ? isProSuperAgent
                          ? "Pro"
                          : "Enterprise"
                        : "Held"
                      : "Live"}
                  </Text>
                </View>
              </View>

              {hasWallet ? (
                <>
                  <Text style={styles.heroAmount}>
                    {loadingWallet && walletBalance === null
                      ? "Ghc —.—"
                      : formatGhc(walletBalance)}
                  </Text>
                  <Text style={styles.heroFootnote}>
                    {isSuperAgent
                      ? "Operational balance for agent orders"
                      : "Balance held from a previous Super Agent role"}
                  </Text>

                  <View style={styles.heroActions}>
                    <TouchableOpacity
                      style={styles.heroPrimaryAction}
                      onPress={() =>
                        navigation.navigate("Data", { network: "mtn" })
                      }
                      activeOpacity={0.85}
                    >
                      <Ionicons name="flash" size={15} color="#04231F" />
                      <Text style={styles.heroPrimaryText}>Buy Data</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.heroGhostAction}
                      onPress={() => navigation.navigate("WalletTopUp")}
                      activeOpacity={0.85}
                    >
                      <Ionicons name="add" size={16} color={c.mint} />
                      <Text style={styles.heroGhostText}>Top Up</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.heroTagline}>
                    {"Airtime, bundles and\ndata across all networks."}
                  </Text>
                  <View style={styles.heroActions}>
                    <TouchableOpacity
                      style={styles.heroPrimaryAction}
                      onPress={() =>
                        navigation.navigate("Data", { network: "mtn" })
                      }
                      activeOpacity={0.85}
                    >
                      <Ionicons name="flash" size={15} color="#04231F" />
                      <Text style={styles.heroPrimaryText}>Buy Data</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.heroGhostAction}
                      onPress={() => navigation.navigate("History")}
                      activeOpacity={0.85}
                    >
                      <Ionicons name="receipt" size={15} color={c.mint} />
                      <Text style={styles.heroGhostText}>My Orders</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </LinearGradient>
          </Animated.View>

          {/* ---------- Quick services ---------- */}
          <Animated.View style={quickEntrance}>
            <View style={styles.quickGrid}>
              {quickActions.map((action) => (
                <TouchableOpacity
                  key={action.key}
                  style={styles.quickTile}
                  onPress={action.onPress}
                  activeOpacity={0.75}
                >
                  <View
                    style={[
                      styles.quickIcon,
                      { borderColor: `${action.tint}33` },
                    ]}
                  >
                    <Ionicons
                      name={action.icon}
                      size={19}
                      color={action.tint}
                    />
                  </View>
                  <Text style={styles.quickLabel} numberOfLines={1}>
                    {action.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </Animated.View>

          {/* ---------- Business suite (super agents) ---------- */}
          {isSuperAgent ? (
            <Animated.View style={[styles.section, suiteEntrance]}>
              <SectionHead
                styles={styles}
                c={c}
                eyebrow="Manage"
                title="Business Suite"
                action="Analytics"
                onAction={() => navigation.navigate("SuperAgentAnalytics")}
              />
              <View style={styles.suiteGrid}>
                {suiteItems.map((item) => (
                  <TouchableOpacity
                    key={item.key}
                    style={styles.suiteTile}
                    onPress={item.onPress}
                    activeOpacity={0.75}
                  >
                    <View
                      style={[
                        styles.suiteIcon,
                        { backgroundColor: `${item.tint}1A` },
                      ]}
                    >
                      <Ionicons name={item.icon} size={18} color={item.tint} />
                    </View>
                    <Text style={styles.suiteLabel} numberOfLines={1}>
                      {item.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </Animated.View>
          ) : null}

          {/* ---------- Networks ---------- */}
          <Animated.View style={[styles.section, networkEntrance]}>
            <SectionHead
              styles={styles}
              c={c}
              eyebrow="Buy"
              title="Choose a network"
              action="Browse"
              onAction={() => navigation.navigate("Data")}
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.networkScrollContent}
            >
              {networkCards.map((card) => (
                <TouchableOpacity
                  key={card.key}
                  style={styles.networkCardTouchable}
                  onPress={() =>
                    navigation.navigate("Data", { network: card.key })
                  }
                  activeOpacity={0.88}
                >
                  <ImageBackground
                    source={card.image}
                    style={styles.networkCard}
                    imageStyle={styles.networkImage}
                    resizeMode="cover"
                  >
                    {/* Scrim dims the network photo so the white copy and the
                        brand accent stay legible.

                        No `locations` here on purpose: the Android native
                        gradient has historically been unreliable with 3+ stops
                        when a locations array is also supplied, and a failed
                        stop makes the whole overlay drop out - the dim then
                        only exists on web. Two evenly-spaced stops render
                        identically on both platforms.

                        8-digit rgba() hex is also avoided; plain rgba() with
                        explicit alpha is the form the Android parser
                        accepts consistently. */}
                    <LinearGradient
                      colors={[`${c.scrim}`, `${c.scrim}`]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 0, y: 1 }}
                      style={styles.networkScrim}
                    />

                    <View style={styles.networkCardContent}>
                      {/* Tag only - the old bordered pill + badge pair was
                          two competing chips for one idea. */}
                      <View style={styles.networkTagRow}>
                        <View
                          style={[
                            styles.networkDot,
                            { backgroundColor: card.accent },
                          ]}
                        />
                        <Text
                          style={[
                            styles.networkTagText,
                            { color: card.accent },
                          ]}
                        >
                          {card.tag}
                        </Text>
                      </View>

                      <View>
                        <Text style={styles.networkName}>{card.name}</Text>
                        <Text style={styles.networkTitle} numberOfLines={2}>
                          {card.desc}
                        </Text>
                        <Text style={styles.networkSubtitle}>{card.sub}</Text>

                        <View style={styles.networkActionRow}>
                          <Text
                            style={[
                              styles.networkActionText,
                              { color: card.accent },
                            ]}
                          >
                            Browse bundles
                          </Text>
                          <View
                            style={[
                              styles.networkActionIcon,
                              {
                                backgroundColor: card.accent,
                                borderColor: card.accent,
                              },
                            ]}
                          >
                            <Ionicons
                              name="arrow-forward"
                              size={13}
                              color="#04231F"
                            />
                          </View>
                        </View>
                      </View>
                    </View>
                  </ImageBackground>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </Animated.View>

          {/* ---------- Recent activity ---------- */}
          <Animated.View style={[styles.section, activityEntrance]}>
            <SectionHead
              styles={styles}
              c={c}
              eyebrow="Latest"
              title="Recent activity"
              action="View all"
              onAction={() => navigation.navigate("History")}
            />

            <View style={styles.activityCard}>
              {loadingTransactions ? (
                renderRecentTransactionPlaceholders()
              ) : transactions.length === 0 ? (
                <View style={styles.emptyState}>
                  <View style={styles.emptyGlyph}>
                    <Ionicons
                      name="receipt-outline"
                      size={26}
                      color={c.textMuted}
                    />
                  </View>
                  <Text style={styles.emptyTitle}>No activity yet</Text>
                  <Text style={styles.emptyMessage}>
                    Your purchases will appear here once you buy data.
                  </Text>
                  <TouchableOpacity
                    style={styles.emptyCta}
                    onPress={() => navigation.navigate("Data")}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.emptyCtaText}>Browse bundles</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                transactions.map((transaction, index) => {
                  const tone = statusTone(transaction.status, tones);
                  // Derived from the row id; see src/lib/receiptNumber.js for
                  // why it is not a stored column.
                  const receipt = splitReceiptNumber(transaction);
                  // Only offered to a super agent (the server 403s everyone
                  // else) and only inside the 24h window. The row still renders
                  // as a tap target when the window has closed - hiding the row
                  // would hide the fact that an order died holding real customer
                  // money, which is the opposite of what this list is for.
                  const canReorder = canReorderHeldOrders(isSuperAgent);
                  const showReorder =
                    canReorder && isReorderableHeldOrder(transaction);
                  const reorderElapsed = showReorder
                    ? isHeldWindowElapsed(transaction, Date.now())
                    : false;
                  const reorderBusy = reorderingId === transaction.id;
                  return (
                    <TouchableOpacity
                      key={transaction.id}
                      style={styles.activityRow}
                      activeOpacity={0.7}
                      onPress={() =>
                        navigation.navigate("Receipt", { transaction })
                      }
                    >
                      <View
                        style={[
                          styles.activityMarker,
                          index === transactions.length - 1 &&
                            styles.activityMarkerLast,
                        ]}
                      />
                      <View style={styles.activityBody}>
                        <Text style={styles.activityTitle} numberOfLines={1}>
                          {transaction.offer_title || "Data purchase"}
                        </Text>
                        <Text style={styles.activityMeta} numberOfLines={1}>
                          {transaction.network
                            ? `${String(transaction.network).toUpperCase()} · `
                            : ""}
                          {transaction.data_amount || "Bundle"}
                        </Text>
                        {receipt ? (
                          <View style={styles.receiptTag}>
                            <Ionicons
                              name="pricetag-outline"
                              size={10}
                              color={c.textSecondary}
                            />
                            <Text style={styles.receiptTagText}>
                              {receipt.prefix}
                              {receipt.number}
                            </Text>
                          </View>
                        ) : null}
                      </View>

                      <View style={styles.activityTail}>
                        <Text style={styles.activityAmount}>
                          {transaction.amount
                            ? `-${formatGhc(transaction.amount)}`
                            : "N/A"}
                        </Text>
                        {tone ? (
                          <View
                            style={[
                              styles.statusPill,
                              { backgroundColor: tone.bg },
                            ]}
                          >
                            <Text
                              style={[
                                styles.statusPillText,
                                { color: tone.color },
                              ]}
                            >
                              {tone.label}
                            </Text>
                          </View>
                        ) : (
                          <Text style={styles.activityTime}>
                            {relativeTime(transaction.created_at) || "—"}
                          </Text>
                        )}

                        {showReorder ? (
                          <TouchableOpacity
                            style={[
                              styles.reorderButton,
                              reorderElapsed && styles.reorderButtonClosed,
                            ]}
                            // Stop propagation so the retry does not also
                            // navigate to the Receipt - the row is a
                            // TouchableOpacity, so without this one tap fires
                            // both handlers and the user lands on a page they
                            // did not ask for while the retry runs.
                            onPress={(event) => {
                              if (event?.stopPropagation) {
                                event.stopPropagation();
                              }
                              handleReorderHeldOrder(transaction);
                            }}
                            disabled={reorderBusy || reorderElapsed}
                            activeOpacity={0.85}
                            accessibilityRole="button"
                            accessibilityLabel={
                              reorderElapsed
                                ? "Reorder window closed"
                                : "Reorder this held order"
                            }
                          >
                            <Ionicons
                              name="refresh"
                              size={11}
                              color={reorderElapsed ? c.textMuted : c.onAccent}
                            />
                            <Text
                              style={[
                                styles.reorderButtonText,
                                reorderElapsed &&
                                  styles.reorderButtonTextClosed,
                              ]}
                            >
                              {reorderElapsed
                                ? "Closed"
                                : reorderBusy
                                  ? "Retrying…"
                                  : "Reorder"}
                            </Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    </TouchableOpacity>
                  );
                })
              )}
            </View>
          </Animated.View>

          {/* ---------- Promotions ---------- */}
          <Animated.View style={[styles.section, promoEntrance]}>
            <SectionHead
              styles={styles}
              c={c}
              eyebrow="Discover"
              title="Offers & promos"
            />

            <ScrollView
              ref={adsScrollViewRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.adsScrollView}
              contentContainerStyle={styles.adsScrollContent}
              bounces={false}
              onScroll={handleScroll}
              onScrollBeginDrag={() => {
                if (autoScrollIntervalRef.current) {
                  clearInterval(autoScrollIntervalRef.current);
                }
              }}
              onScrollEndDrag={() => {
                if (ads.length > 1) {
                  autoScrollIntervalRef.current = setInterval(() => {
                    setCurrentAdIndex((prevIndex) => {
                      const nextIndex = (prevIndex + 1) % (ads.length + 1);
                      if (adsScrollViewRef.current) {
                        adsScrollViewRef.current.scrollTo({
                          x: nextIndex * 295,
                          animated: true,
                        });
                      }
                      return nextIndex;
                    });
                  }, 4000);
                }
              }}
              onMomentumScrollEnd={(event) => {
                const scrollPosition = event.nativeEvent.contentOffset.x;
                const newIndex = Math.round(scrollPosition / 295);
                if (
                  newIndex !== currentAdIndex &&
                  newIndex >= 0 &&
                  newIndex < ads.length + 1
                ) {
                  setCurrentAdIndex(newIndex);
                  if (newIndex > 0 && ads[newIndex - 1]) {
                    updateAdImpression(ads[newIndex - 1].id);
                  }
                }
              }}
              scrollEventThrottle={16}
            >
              {/* Static WhatsApp promo card (always first) */}
              <TouchableOpacity
                key="whatsapp-inapp-ad"
                style={styles.adCard}
                activeOpacity={0.9}
                onPress={() =>
                  openWhatsApp(
                    SUPPORT_WHATSAPP,
                    "Hi, I want to advertise my business on your app",
                  ).then((result) => {
                    if (!result.ok) {
                      showError("Cannot Open WhatsApp", result.message);
                    }
                  })
                }
              >
                <LinearGradient
                  colors={["#0B3B33", "#00A88F"]}
                  start={{ x: 0, y: 1 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.adCardFill}
                >
                  <View style={styles.adBadge}>
                    <Ionicons name="megaphone" size={10} color="#04231F" />
                    <Text style={styles.adBadgeText}>Promo</Text>
                  </View>
                  <Text style={styles.adTitle}>
                    Advertise your business here
                  </Text>
                  <Text style={styles.adDescription}>
                    Reach thousands of users instantly.
                  </Text>
                  <View style={styles.adActionRow}>
                    <Text style={styles.adActionText}>Contact us</Text>
                    <Ionicons name="arrow-forward" size={13} color={c.mint} />
                  </View>
                </LinearGradient>
              </TouchableOpacity>

              {loadingAds
                ? [0, 1].map((index) => (
                    <View key={`ad-skeleton-${index}`} style={styles.adCard}>
                      <Animated.View
                        style={[
                          styles.adCardFill,
                          { opacity: transactionsSkeletonOpacity },
                        ]}
                      />
                    </View>
                  ))
                : null}

              {ads.map((ad, index) => {
                const AdComponent = ad.image_url
                  ? ImageBackground
                  : TouchableOpacity;
                const adProps = ad.image_url
                  ? { source: { uri: ad.image_url }, resizeMode: "cover" }
                  : {};
                return (
                  <AdComponent
                    key={ad.id || index}
                    ref={(ref) => (adRefs.current[ad.id] = ref)}
                    style={styles.adCard}
                    {...adProps}
                    onLayout={() => {
                      // Check visibility when ad is laid out
                      const checkVisibilityWithRetry = (retries = 3) => {
                        const adRef = adRefs.current[ad.id];
                        if (adRef && typeof adRef.measure === "function") {
                          setTimeout(
                            () => checkAdVisibility(ad.id, adRef),
                            100,
                          );
                        } else if (retries > 0) {
                          setTimeout(
                            () => checkVisibilityWithRetry(retries - 1),
                            200,
                          );
                        }
                      };
                      checkVisibilityWithRetry();
                    }}
                    onPress={async () => {
                      await updateAdClick(ad.id);
                      if (ad?.website_url) {
                        Linking.openURL(ad.website_url);
                      } else if (ad?.action_url) {
                        if (ad.action_url.startsWith("http")) {
                          Linking.openURL(ad.action_url);
                        } else {
                          switch (ad.action_url) {
                            case "data":
                              navigation.navigate("Data");
                              break;
                            case "payments":
                              showSuccess(
                                "Payments",
                                "Multiple payment options available!",
                              );
                              break;
                            case "airtime":
                              showSuccess(
                                "Airtime",
                                "Airtime top-up coming soon!",
                              );
                              break;
                            case "shop":
                              showSuccess(
                                "Shopping",
                                "Online shopping coming soon!",
                              );
                              break;
                            case "business":
                              showSuccess(
                                "Business",
                                "Contact us for business solutions!",
                              );
                              break;
                            case "signup":
                              showSuccess(
                                "Welcome!",
                                "Enjoy your free data bonus!",
                              );
                              break;
                            default:
                              showSuccess("Ad", ad.action_text || "Learn More");
                          }
                        }
                      } else {
                        showSuccess("Ad", ad.action_text || "Learn More");
                      }
                    }}
                  >
                    <LinearGradient
                      colors={[`${c.adScrim}`, `${c.adScrim}`]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 0, y: 1 }}
                      style={styles.adCardFill}
                    >
                      <Text style={styles.adTitle}>{ad.title}</Text>
                      {ad.description ? (
                        <Text style={styles.adDescription} numberOfLines={3}>
                          {ad.description}
                        </Text>
                      ) : null}
                      <View style={styles.adActionRow}>
                        <Text style={styles.adActionText}>
                          {ad.action_text || "Learn More"}
                        </Text>
                        <Ionicons
                          name="arrow-forward"
                          size={13}
                          color={c.mint}
                        />
                      </View>
                    </LinearGradient>
                  </AdComponent>
                );
              })}

              <View style={{ width: 8 }} />
            </ScrollView>

            {ads.length > 0 ? (
              <View style={styles.adIndicators}>
                {[{ id: "whatsapp-inapp-ad" }, ...ads].map((_, index) => (
                  <TouchableOpacity
                    key={index}
                    style={[
                      styles.adIndicator,
                      index === currentAdIndex && styles.adIndicatorActive,
                    ]}
                    onPress={() => {
                      setCurrentAdIndex(index);
                      if (adsScrollViewRef.current) {
                        if (index === ads.length) {
                          adsScrollViewRef.current.scrollToEnd({
                            animated: true,
                          });
                        } else {
                          adsScrollViewRef.current.scrollTo({
                            x: index * 295,
                            animated: true,
                          });
                        }
                      }
                    }}
                  />
                ))}
              </View>
            ) : null}
          </Animated.View>

          {/* ---------- Footer ---------- */}
          <View style={styles.footer}>
            <View style={styles.footerMark}>
              <Ionicons name="shield-checkmark" size={13} color={c.mint} />
            </View>
            <Text style={styles.footerText}>
              Powered by Mystiwan E-Business
            </Text>
            <Text style={styles.footerSubText}>
              Secure &amp; reliable transactions
            </Text>
          </View>
        </SafeAreaView>
      </ScrollView>

      {/* ---------- Overflow drawer ---------- */}
      {/* Full-height edge drawer, not a floating card: it is opaque, spans
          top to bottom, and carries no drop shadow. There is deliberately no
          dimmed backdrop - the page stays readable behind it and the panel is
          dismissed with the close button or by picking a destination. */}
      {isSuperAgent && menuMounted && Platform.OS === "web" ? (
        // `box-none` so the host never captures a touch on the page behind it -
        // only the panel itself is interactive.
        <View
          pointerEvents="box-none"
          style={[styles.menuOverlay, styles.menuOverlayPassThrough]}
        >
          <Animated.View
            style={[
              styles.menuDrawer,
              drawerStyle,
              menuOpen ? null : styles.menuDrawerHidden,
            ]}
          >
            <SafeAreaView edges={["top", "bottom"]} style={styles.menuSafeArea}>
              <View style={styles.menuHeader}>
                <Text style={styles.menuTitle}>Super Agent Menu</Text>
                <TouchableOpacity
                  onPress={() => setMenuOpen(false)}
                  hitSlop={10}
                  activeOpacity={0.7}
                >
                  <Ionicons name="close" size={18} color={c.textMuted} />
                </TouchableOpacity>
              </View>

              <ScrollView
                style={styles.menuScroll}
                showsVerticalScrollIndicator={false}
              >
                {menuItems.map((item) => (
                  <TouchableOpacity
                    key={`${item.key}-${item.label}`}
                    style={styles.menuItem}
                    onPress={() => {
                      setMenuOpen(false);
                      item.onPress();
                    }}
                    activeOpacity={0.7}
                  >
                    <View
                      style={[
                        styles.menuIcon,
                        { backgroundColor: `${item.tint}1A` },
                      ]}
                    >
                      <Ionicons name={item.icon} size={16} color={item.tint} />
                    </View>
                    <Text style={styles.menuItemText}>{item.label}</Text>
                    <Ionicons
                      name="chevron-forward"
                      size={14}
                      color={c.textMuted}
                    />
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </SafeAreaView>
          </Animated.View>
        </View>
      ) : null}
    </View>
  );
}

// Cross-platform elevation. `boxShadow` keeps the web build from flattening
// the cards the way `shadow*` props do under react-native-web. Takes the
// palette so the shadow colour is a token rather than hardcoded black - pure
// black shadows read fine on a near-black canvas but muddy on white.
const shadow = (elevation, shadowOpacity = 0.3, tone = "#000000") =>
  Platform.select({
    ios: {
      shadowColor: tone,
      shadowOffset: { width: 0, height: elevation },
      shadowOpacity,
      shadowRadius: elevation * 1.6,
    },
    android: { elevation },
    default: {
      // Web wants one composite value; the hex tone plus a hex alpha is the
      // only form react-native-web accepts here.
      boxShadow: `${tone}${Math.round(shadowOpacity * 255)
        .toString(16)
        .padStart(2, "0")} 0px ${elevation}px ${elevation * 1.8}px`,
    },
  });

// One stylesheet instance per colour scheme, rebuilt only when the scheme
// flips. Keeps every style lookup below a plain `styles.x` reference.
const useStyles = (c) => useMemo(() => buildStyles(c), [c]);

// Stylesheet is a function of the palette: `c` is the light or dark token
// set from useTheme(). Building it per scheme is cheaper than threading
// dynamic styles through 40+ call sites, and keeps this file declarative.
const buildStyles = (c) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: c.canvas,
      // The parked drawer sits past the right edge; without this the root
      // can scroll horizontally on web and flash a sliver of the panel.
      overflow: "hidden",
    },
    scrollContent: {
      // Replaced per-render with the dock-aware value; see `dockPadding` in the
      // component. Zero here so the static style alone never adds dead space.
      paddingBottom: 0,
    },
    safeArea: {
      flex: 1,
    },
    ambientGlow: {
      position: "absolute",
      top: -190,
      left: -110,
      width: 460,
      height: 460,
      borderRadius: 230,
      backgroundColor: c.heroGlow,
      opacity: 0.16,
    },

    /* ---------- Top bar ---------- */
    topBar: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingTop: 10,
      paddingBottom: 18,
    },
    identity: {
      flexDirection: "row",
      alignItems: "center",
      flex: 1,
      marginRight: 12,
    },
    avatar: {
      width: 46,
      height: 46,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.18)",
    },
    avatarInitial: {
      fontFamily: fonts.displayBold,
      fontSize: 20,
      color: "#04231F",
    },
    identityText: {
      flex: 1,
      marginLeft: 12,
    },
    greeting: {
      fontFamily: fonts.body,
      fontSize: 11,
      color: c.textMuted,
      letterSpacing: 0.4,
      textTransform: "uppercase",
    },
    displayName: {
      fontFamily: fonts.display,
      fontSize: 19,
      color: c.textPrimary,
      marginTop: 2,
    },
    roleBadge: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 4,
      borderWidth: 1,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
      marginTop: 5,
    },
    roleBadgeEnterprise: {
      borderColor: "rgba(92,240,200,0.45)",
      backgroundColor: "rgba(92,240,200,0.10)",
    },
    roleBadgePro: {
      borderColor: "rgba(245,196,81,0.5)",
      backgroundColor: "rgba(245,196,81,0.12)",
    },
    roleBadgeAgent: {
      borderColor: "rgba(111,200,245,0.45)",
      backgroundColor: "rgba(111,200,245,0.10)",
    },
    roleBadgeText: {
      fontFamily: fonts.bodyBold,
      fontSize: 9,
      letterSpacing: 0.5,
    },
    topBarActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    iconButton: {
      width: 42,
      height: 42,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    notificationBadge: {
      position: "absolute",
      top: 6,
      right: 6,
      backgroundColor: c.rose,
      borderRadius: 8,
      minWidth: 16,
      height: 16,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 2,
      borderColor: c.canvas,
    },
    badgeText: {
      fontFamily: fonts.bodyBold,
      color: "#1A0500",
      fontSize: 8,
    },

    /* ---------- Hero ---------- */
    heroWrap: {
      paddingHorizontal: 20,
    },
    hero: {
      borderRadius: 28,
      padding: 22,
      overflow: "hidden",
      ...shadow(10, 0.4, c.shadow),
    },
    heroHalo: {
      position: "absolute",
      top: -80,
      right: -60,
      width: 240,
      height: 240,
      borderRadius: 120,
      backgroundColor: "rgba(255,255,255,0.14)",
    },
    heroArc: {
      position: "absolute",
      bottom: -120,
      left: -40,
      width: 220,
      height: 220,
      borderRadius: 110,
      borderWidth: 34,
      borderColor: "rgba(255,255,255,0.06)",
    },
    heroTopRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    heroLabelRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    heroLabel: {
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      color: c.textSecondary,
      letterSpacing: 0.3,
    },
    heroPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      backgroundColor: "rgba(4,35,31,0.32)",
      borderRadius: 999,
      paddingHorizontal: 9,
      paddingVertical: 4,
    },
    heroPillDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
      backgroundColor: c.mint,
    },
    heroPillText: {
      fontFamily: fonts.bodyBold,
      fontSize: 9,
      color: c.mint,
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },
    heroAmount: {
      fontFamily: fonts.displayBold,
      fontSize: 34,
      color: "#FFFFFF",
      marginTop: 14,
      letterSpacing: -0.5,
    },
    heroTagline: {
      fontFamily: fonts.display,
      fontSize: 24,
      lineHeight: 31,
      color: "#FFFFFF",
      marginTop: 12,
    },
    heroFootnote: {
      fontFamily: fonts.body,
      fontSize: 12,
      color: c.textSecondary,
      marginTop: 6,
    },
    heroActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      marginTop: 20,
    },
    heroPrimaryAction: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: c.mint,
      borderRadius: 999,
      paddingHorizontal: 18,
      paddingVertical: 11,
    },
    heroPrimaryText: {
      fontFamily: fonts.bodyBold,
      fontSize: 13,
      color: "#04231F",
    },
    heroGhostAction: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.32)",
      borderRadius: 999,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    heroGhostText: {
      fontFamily: fonts.bodySemi,
      fontSize: 13,
      color: "#FFFFFF",
    },

    /* ---------- Quick services ---------- */
    quickGrid: {
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 20,
      marginTop: 18,
    },
    quickTile: {
      flex: 1,
      alignItems: "center",
      paddingVertical: 14,
      borderRadius: 20,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    quickIcon: {
      width: 38,
      height: 38,
      borderRadius: 13,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
    },
    quickLabel: {
      fontFamily: fonts.bodySemi,
      fontSize: 11,
      color: c.textSecondary,
      marginTop: 8,
    },

    /* ---------- Sections ---------- */
    section: {
      marginTop: 30,
    },
    sectionHead: {
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      marginBottom: 14,
    },
    sectionHeadText: {
      flex: 1,
    },
    sectionEyebrow: {
      fontFamily: fonts.bodySemi,
      fontSize: 10,
      color: c.mintDim,
      letterSpacing: 1.4,
      textTransform: "uppercase",
    },
    sectionTitle: {
      fontFamily: fonts.display,
      fontSize: 22,
      color: c.textPrimary,
      marginTop: 3,
    },
    sectionAction: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      paddingBottom: 3,
    },
    sectionActionText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      color: c.mint,
    },

    /* ---------- Business suite ---------- */
    suiteGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 10,
      paddingHorizontal: 20,
    },
    suiteTile: {
      // 30.5% + 2 gaps of 10 fits 3-up on every phone width (a 3x 31.5% row plus
      // gaps overflows the container and collapses to 2 columns on ~360dp
      // screens). Fixed fraction rather than `flex` so a 4-item Pro row wraps
      // as 3 + 1 instead of stretching one lonely tile.
      width: "30.5%",
      alignItems: "center",
      paddingVertical: 16,
      borderRadius: 20,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    suiteIcon: {
      width: 38,
      height: 38,
      borderRadius: 13,
      alignItems: "center",
      justifyContent: "center",
    },
    suiteLabel: {
      fontFamily: fonts.bodySemi,
      fontSize: 11,
      color: c.textSecondary,
      marginTop: 9,
    },

    /* ---------- Networks ---------- */
    networkScrollContent: {
      paddingHorizontal: 20,
    },
    networkCardTouchable: {
      marginRight: 14,
    },
    networkCard: {
      width: 214,
      height: 216,
      borderRadius: 24,
      overflow: "hidden",
      justifyContent: "space-between",
      // Solid base under the scrim. If the gradient ever fails to paint on a
      // given platform the photo still reads as a dimmed card instead of
      // blowing out to full brightness with unreadable copy on top of it.
      backgroundColor: c.canvas,
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.10)",
      ...shadow(6, 0.35, c.shadow),
    },
    networkImage: {
      borderRadius: 24,
    },
    networkScrim: {
      // Spelled out rather than ...StyleSheet.absoluteFillObject. absoluteFill
      // resolves against the nearest positioned ancestor, and inside
      // ImageBackground on Android that is not reliably the card - the scrim
      // collapses to zero height and the dim silently disappears. Explicit
      // insets only need the card to establish the bounds, which it does via
      // its fixed width/height.
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    },
    networkCardContent: {
      flex: 1,
      padding: 16,
      justifyContent: "space-between",
    },
    // Single accent chip in the corner. Replaces the previous
    // pill + bordered-badge pair, which competed for attention.
    networkTagRow: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 6,
      backgroundColor: c.scrim,
      borderWidth: 1,
      borderColor: "rgba(255,255,255,0.12)",
      paddingHorizontal: 9,
      paddingVertical: 5,
      borderRadius: 999,
    },
    networkDot: {
      width: 5,
      height: 5,
      borderRadius: 3,
    },
    networkTagText: {
      fontFamily: fonts.bodyBold,
      fontSize: 9,
      letterSpacing: 0.5,
      textTransform: "uppercase",
    },
    // Network name leads the card now; the marketing line sits beneath it.
    networkName: {
      fontFamily: fonts.bodyBlack,
      fontSize: 22,
      lineHeight: 26,
      letterSpacing: -0.3,
      color: "#FFFFFF",
    },
    networkTitle: {
      // Body sans, not the display serif. The card titles sit on top of busy
      // network photography, and a decorative face loses legibility there while
      // also reading as inconsistent next to every other title on the page.
      fontFamily: fonts.bodySemi,
      fontSize: 13,
      lineHeight: 18,
      color: "#FFFFFF",
      marginTop: 3,
    },
    networkSubtitle: {
      fontFamily: fonts.body,
      fontSize: 11.5,
      color: c.textSecondary,
      marginTop: 2,
    },
    networkActionRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 14,
    },
    networkActionText: {
      fontFamily: fonts.bodyBold,
      fontSize: 12,
      letterSpacing: 0.2,
    },
    networkActionIcon: {
      width: 28,
      height: 28,
      borderRadius: 14,
      borderWidth: 1,
      alignItems: "center",
      justifyContent: "center",
    },

    /* ---------- Activity ---------- */
    activityCard: {
      marginHorizontal: 20,
      backgroundColor: c.surface,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: c.hairline,
      paddingVertical: 6,
    },
    activityRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    activityMarker: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.mintDim,
      marginRight: 13,
    },
    activityMarkerLast: {
      backgroundColor: c.textMuted,
    },
    activityBody: {
      flex: 1,
      marginRight: 10,
    },
    activityTitle: {
      fontFamily: fonts.bodySemi,
      fontSize: 14,
      color: c.textPrimary,
    },
    activityMeta: {
      fontFamily: fonts.body,
      fontSize: 11,
      color: c.textMuted,
      marginTop: 3,
    },
    // Receipt number line. Kept as a pill so it reads as a reference to quote
    // rather than as part of the order's identity (title above).
    //
    // textSecondary, not textMuted: the app-wide `textMuted` measures 3.85:1
    // on this surface in dark mode, under the 4.5:1 needed for 10px text. That
    // deficit is pre-existing and app-wide (see theming-system.md), so rather
    // than quietly widen the global token from one screen, this new element
    // uses the next token up and passes at 7.07:1 dark / 5.62:1 light.
    receiptTag: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      alignSelf: "flex-start",
      marginTop: 5,
      paddingHorizontal: 7,
      paddingVertical: 3,
      borderRadius: 8,
      backgroundColor: c.surfaceHover,
    },
    receiptTagText: {
      fontFamily: fonts.bodySemi,
      fontSize: 10,
      color: c.textSecondary,
      letterSpacing: 0.3,
    },
    activityTail: {
      alignItems: "flex-end",
    },
    // Retry affordance for a held sub-agent order. Sits under the amount +
    // status pill in the tail so the row's right-hand column stays the
    // money/status summary and the action is clearly secondary to it.
    reorderButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginTop: 6,
      paddingHorizontal: 9,
      paddingVertical: 5,
      borderRadius: 999,
      backgroundColor: c.mint,
    },
    // The disabled state is a grey surface, not a dimmed mint: at reduced
    // opacity the mint fill still reads as the enabled colour on a dark canvas.
    reorderButtonClosed: { backgroundColor: c.surfaceHover },
    reorderButtonText: {
      fontFamily: fonts.bodyBold,
      fontSize: 10.5,
      color: c.onAccent,
    },
    reorderButtonTextClosed: { color: c.textMuted },
    activityAmount: {
      fontFamily: fonts.bodyBold,
      fontSize: 14,
      color: c.textPrimary,
    },
    activityTime: {
      fontFamily: fonts.body,
      fontSize: 10,
      color: c.textMuted,
      marginTop: 4,
    },
    statusPill: {
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 2,
      marginTop: 5,
    },
    statusPillText: {
      fontFamily: fonts.bodyBold,
      fontSize: 9,
      letterSpacing: 0.3,
    },

    /* ---------- Skeletons ---------- */
    skeletonList: {
      paddingVertical: 8,
    },
    skeletonRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    skeletonMark: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.surfaceHover,
      marginRight: 13,
    },
    skeletonBody: {
      flex: 1,
    },
    skeletonLineWide: {
      height: 11,
      width: "68%",
      borderRadius: 6,
      backgroundColor: c.surfaceHover,
    },
    skeletonLineNarrow: {
      height: 9,
      width: "42%",
      borderRadius: 5,
      backgroundColor: c.surfaceHover,
      marginTop: 8,
    },
    skeletonTail: {
      alignItems: "flex-end",
    },
    skeletonLineAmount: {
      height: 11,
      width: 62,
      borderRadius: 6,
      backgroundColor: c.surfaceHover,
    },
    skeletonLineTiny: {
      height: 8,
      width: 44,
      borderRadius: 4,
      backgroundColor: c.surfaceHover,
      marginTop: 8,
    },

    /* ---------- Empty state ---------- */
    emptyState: {
      alignItems: "center",
      paddingVertical: 34,
      paddingHorizontal: 30,
    },
    emptyGlyph: {
      width: 58,
      height: 58,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.surfaceHover,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    emptyTitle: {
      fontFamily: fonts.display,
      fontSize: 17,
      color: c.textPrimary,
      marginTop: 14,
    },
    emptyMessage: {
      fontFamily: fonts.body,
      fontSize: 12,
      lineHeight: 18,
      color: c.textMuted,
      textAlign: "center",
      marginTop: 6,
    },
    emptyCta: {
      marginTop: 16,
      borderWidth: 1,
      borderColor: c.hairlineStrong,
      borderRadius: 999,
      paddingHorizontal: 18,
      paddingVertical: 9,
    },
    emptyCtaText: {
      fontFamily: fonts.bodySemi,
      fontSize: 12,
      color: c.mint,
    },

    /* ---------- Ads ---------- */
    adsScrollView: {
      overflow: "visible",
    },
    adsScrollContent: {
      paddingHorizontal: 20,
      paddingVertical: 2,
    },
    adCard: {
      width: 280,
      height: 168,
      borderRadius: 24,
      overflow: "hidden",
      marginRight: 15,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.hairline,
    },
    adCardFill: {
      flex: 1,
      justifyContent: "center",
      padding: 18,
    },
    adBadge: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 4,
      backgroundColor: c.mint,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 3,
      marginBottom: 10,
    },
    adBadgeText: {
      fontFamily: fonts.bodyBold,
      fontSize: 9,
      color: "#04231F",
      letterSpacing: 0.4,
      textTransform: "uppercase",
    },
    adTitle: {
      fontFamily: fonts.display,
      fontSize: 19,
      color: "#FFFFFF",
    },
    adDescription: {
      fontFamily: fonts.body,
      fontSize: 12,
      lineHeight: 17,
      color: c.textSecondary,
      marginTop: 5,
    },
    adActionRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      marginTop: 12,
    },
    adActionText: {
      fontFamily: fonts.bodyBold,
      fontSize: 12,
      color: c.mint,
    },
    adIndicators: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingHorizontal: 20,
      marginTop: 12,
    },
    adIndicator: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: c.surfaceHover,
    },
    adIndicatorActive: {
      width: 18,
      backgroundColor: c.mint,
    },

    /* ---------- Footer ---------- */
    footer: {
      alignItems: "center",
      paddingTop: 40,
      paddingBottom: 44,
      marginTop: 32,
      borderTopWidth: 1,
      borderTopColor: c.hairline,
    },
    footerMark: {
      width: 30,
      height: 30,
      borderRadius: 11,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(92,240,200,0.10)",
      borderWidth: 1,
      borderColor: c.hairlineStrong,
    },
    footerText: {
      fontFamily: fonts.display,
      fontSize: 14,
      color: c.textSecondary,
      marginTop: 12,
    },
    footerSubText: {
      fontFamily: fonts.body,
      fontSize: 10,
      color: c.textMuted,
      marginTop: 3,
    },

    /* ---------- Overflow drawer ---------- */
    // Host is a zero-padding absolute overlay so it neither consumes layout
    // space nor clips the panel, but the drawer itself is anchored to the
    // right edge and full height.
    menuOverlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 30,
    },
    // The host is present only while the drawer is opening, open, or playing
    // its exit slide, but it still spans the whole screen. `box-none` keeps it
    // transparent to touches so the page underneath - including the button
    // that opened it - stays live while the slide is in flight. It is applied
    // in both the prop and the style because the `pointerEvents` prop is
    // deprecated (and ignored) under the new architecture.
    menuOverlayPassThrough: {
      pointerEvents: "box-none",
    },
    // Belt and braces for the exit slide: the panel is on screen but closing,
    // so it should not be pressable until the next open.
    menuDrawerHidden: {
      pointerEvents: "none",
    },
    menuDrawer: {
      position: "absolute",
      top: 0,
      right: 0,
      bottom: 0,
      width: DRAWER_WIDTH,
      backgroundColor: c.canvasRaised,
      borderLeftWidth: 1,
      borderLeftColor: c.hairlineStrong,
    },
    menuSafeArea: {
      flex: 1,
    },
    menuHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingTop: 10,
      paddingBottom: 14,
    },
    menuTitle: {
      fontFamily: fonts.display,
      fontSize: 17,
      color: c.textPrimary,
    },
    menuScroll: {
      flex: 1,
    },
    menuItem: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 18,
      paddingVertical: 14,
      borderTopWidth: 1,
      borderTopColor: c.hairline,
    },
    menuIcon: {
      width: 32,
      height: 32,
      borderRadius: 11,
      alignItems: "center",
      justifyContent: "center",
      marginRight: 11,
    },
    menuItemText: {
      flex: 1,
      fontFamily: fonts.bodyMedium,
      fontSize: 13,
      color: c.textPrimary,
    },
  });
