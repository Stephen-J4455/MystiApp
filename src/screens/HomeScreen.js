import React, { useState, useEffect, useRef } from "react";
import {
  TouchableOpacity,
  Text,
  View,
  Image,
  ScrollView,
  Linking,
  ImageBackground,
  Animated,
  StyleSheet,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import colors from "../components/theme";

export default function HomeScreen({ navigation }) {
  const [user, setUser] = useState(null);
  const [isAgent, setIsAgent] = useState(false);
  const [isSuperAgent, setIsSuperAgent] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [transactions, setTransactions] = useState([]);
  const [loadingTransactions, setLoadingTransactions] = useState(true);
  const [agentBalance, setAgentBalance] = useState(0);
  const [ads, setAds] = useState([]);
  const [loadingAds, setLoadingAds] = useState(true);
  const [currentAdIndex, setCurrentAdIndex] = useState(0);
  const [viewedAds, setViewedAds] = useState(new Set()); // Track viewed ads for impressions
  const [menuOpen, setMenuOpen] = useState(false);
  const adsScrollViewRef = useRef(null);
  const autoScrollIntervalRef = useRef(null);
  const adRefs = useRef({}); // Refs for each ad component
  const { showSuccess } = useNotification();
  const transactionsSkeletonOpacity = useRef(new Animated.Value(0.6)).current;

  const networkCards = [
    {
      key: "mtn",
      name: "MTN",
      desc: "Super Fast Data",
      sub: "5G Ready",
      tag: "Best Value",
      accent: colors.warning,
      image: require("../../assets/mtn.jpg"),
    },
    {
      key: "telecel",
      name: "Telecel",
      desc: "Voice & Bundles",
      sub: "Flexible Plans",
      tag: "Popular",
      accent: colors.success,
      image: require("../../assets/telecel.jpg"),
    },
    {
      key: "airteltigo",
      name: "AirtelTigo",
      desc: "Stay Connected",
      sub: "Daily Deals",
      tag: "Hot",
      accent: colors.primary,
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
            .channel("notification_count_realtime")
            .on(
              "postgres_changes",
              {
                event: "INSERT",
                schema: "public",
                table: "notifications",
                filter: `user_id=eq.${user.id}`,
              },
              (payload) => {
                console.log("New notification inserted:", payload);
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
                console.log("Notification updated:", payload);
                // Handle read status changes
                if (payload.old.read !== payload.new.read) {
                  console.log(
                    "Read status changed from",
                    payload.old.read,
                    "to",
                    payload.new.read,
                  );
                  if (payload.new.read) {
                    // Marked as read - decrement count
                    console.log("Decrementing unread count");
                    setUnreadCount((prev) => Math.max(0, prev - 1));
                  } else {
                    // Marked as unread - increment count
                    console.log("Incrementing unread count");
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
                console.log("Notification deleted:", payload);
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
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current);
      }
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
            .channel("home_orders_realtime")
            .on(
              "postgres_changes",
              {
                event: "*",
                schema: "public",
                table: "orders",
                filter: `user_id=eq.${user.id}`,
              },
              (payload) => {
                console.log("New order added:", payload);
                if (payload.eventType === "DELETE") {
                  removeRecentTransaction(payload.old?.id);
                  return;
                }
                upsertRecentTransaction(payload.new, "regular");
              },
            )
            .subscribe();

          // Subscribe to agent orders if user is agent
          const { data: wallet } = await supabase
            .from("agent_wallet")
            .select("*")
            .eq("agent_id", user.id)
            .single();

          if (wallet) {
            agentOrdersSubscription = supabase
              .channel("home_agent_orders_realtime")
              .on(
                "postgres_changes",
                {
                  event: "*",
                  schema: "public",
                  table: "agent_orders",
                  filter: `agent_id=eq.${user.id}`,
                },
                (payload) => {
                  console.log("Agent order changed:", payload);
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
      if (ordersSubscription) {
        supabase.removeChannel(ordersSubscription);
      }
      if (agentOrdersSubscription) {
        supabase.removeChannel(agentOrdersSubscription);
      }
    };
  }, []);

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

    // Check if user is an agent
    if (user) {
      try {
        const { data: wallet, error } = await supabase
          .from("agent_wallet")
          .select("*")
          .eq("agent_id", user.id)
          .single();

        const walletExists = !error && wallet !== null;
        const agentStatus =
          normalizedRole === "agent" || (walletExists && !isSuperAgentUser);
        setIsAgent(agentStatus);
        if (agentStatus && wallet) {
          setAgentBalance(wallet.balance || 0);
        }

        // Fetch data after determining agent status
        fetchRecentTransactions(agentStatus);
        fetchAds(agentStatus);
      } catch (error) {
        console.error("Error checking agent status:", error);
        setIsAgent(false);
        // Fetch data even if agent check fails
        fetchRecentTransactions(false);
        fetchAds(false);
      }
    } else {
      setIsAgent(false);
      fetchRecentTransactions(false);
      fetchAds(false);
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

        const { data: wallet, error } = await supabase
          .from("agent_wallet")
          .select("*")
          .eq("agent_id", user.id)
          .single();

        const walletExists = !error && wallet !== null;
        const agentStatus =
          normalizedRole === "agent" || (walletExists && !isSuperAgentUser);
        setIsAgent(agentStatus);
        if (agentStatus && wallet) {
          setAgentBalance(wallet.balance || 0);
        }

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
          const normalizedTransactions = (data || []).map((transaction) => ({
            ...transaction,
            orderType: agentStatus ? "agent" : "regular",
            ...(agentStatus && {
              displayName: transaction.recipient_name,
              displayPhone: transaction.recipient_phone,
            }),
          }));
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
    console.log("Updating click for ad", adId);
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
      console.log("Current click count:", data.click_count);
      const { error: updateError } = await supabase
        .from("ads")
        .update({ click_count: (data.click_count || 0) + 1 })
        .eq("id", adId);
      if (updateError) {
        console.error("Error updating click count:", updateError);
      } else {
        console.log("Click count updated successfully");
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
      console.log(`Ad visibility check failed for ad ${adId}:`, error.message);
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
    <View style={styles.placeholderList}>
      {[0, 1, 2].map((index) => (
        <Animated.View
          key={`transaction-placeholder-${index}`}
          style={[
            styles.transactionPlaceholder,
            { opacity: transactionsSkeletonOpacity },
          ]}
        >
          <View style={styles.placeholderLeft}>
            <View style={styles.placeholderLine} />
            <View style={styles.placeholderLineShort} />
          </View>
          <View style={styles.placeholderRight}>
            <View style={styles.placeholderAmount} />
            <View style={styles.placeholderDate} />
          </View>
        </Animated.View>
      ))}
    </View>
  );

  return (
    <SafeAreaProvider style={{ flex: 1, backgroundColor: colors.white }}>
      <ScrollView vertical showsVerticalScrollIndicator={false}>
        <SafeAreaView style={styles.safeArea}>
          <StatusBar style="dark" translucent backgroundColor="transparent" />

          {/* Header Section */}
          <View style={styles.headerSection}>
            <TouchableOpacity
              style={styles.profileContainer}
              onPress={() => navigation.navigate("Profile")}
            >
              <View style={styles.avatarContainer}>
                <Ionicons name="person" size={24} color={colors.white} />
              </View>
              {user && (
                <View style={styles.userInfo}>
                  <Text style={styles.welcomeText}>Welcome back,</Text>
                  <View style={styles.usernameContainer}>
                    <Text style={styles.usernameText}>
                      {user.user_metadata?.full_name ||
                        user.email?.split("@")[0] ||
                        "User"}
                    </Text>
                  </View>
                </View>
              )}
            </TouchableOpacity>
            <View style={styles.headerActions}>
              <TouchableOpacity
                style={styles.notificationContainer}
                onPress={() => navigation.navigate("Notifications")}
              >
                <View style={styles.iconCircle}>
                  <Ionicons
                    name="notifications"
                    size={24}
                    color={colors.primary}
                  />
                  {unreadCount > 0 && (
                    <View style={styles.notificationBadge}>
                      <Text style={styles.badgeText}>
                        {unreadCount > 99 ? "99+" : unreadCount}
                      </Text>
                    </View>
                  )}
                </View>
              </TouchableOpacity>

              {isSuperAgent && (
                <TouchableOpacity
                  style={styles.menuButton}
                  onPress={() => setMenuOpen((prev) => !prev)}
                >
                  <Ionicons name="menu" size={28} color={colors.primary} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {isSuperAgent && menuOpen && (
            <View style={styles.superAgentMenuOverlay}>
              <TouchableOpacity
                style={styles.superAgentMenuBackdrop}
                activeOpacity={1}
                onPress={() => setMenuOpen(false)}
              />
              <View style={styles.superAgentMenuCard}>
                <Text style={styles.superAgentMenuTitle}>Super Agent Menu</Text>

                <TouchableOpacity
                  style={styles.superAgentMenuItem}
                  onPress={() => {
                    setMenuOpen(false);
                    navigation.navigate("SuperAgentTierManagement");
                  }}
                >
                  <Ionicons name="layers" size={18} color={colors.primary} />
                  <Text style={styles.superAgentMenuText}>Tier Management</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.superAgentMenuItem}
                  onPress={() => {
                    setMenuOpen(false);
                    navigation.navigate("SuperAgentOffers");
                  }}
                >
                  <Ionicons name="business" size={18} color={colors.primary} />
                  <Text style={styles.superAgentMenuText}>
                    Offer Management
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.superAgentMenuItem}
                  onPress={() => {
                    setMenuOpen(false);
                    navigation.navigate("SuperAgentAgents");
                  }}
                >
                  <Ionicons name="people" size={18} color={colors.primary} />
                  <Text style={styles.superAgentMenuText}>Assigned Agents</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.superAgentMenuItem}
                  onPress={() => {
                    setMenuOpen(false);
                    navigation.navigate("SuperAgentAgents");
                  }}
                >
                  <Ionicons
                    name="person-add"
                    size={18}
                    color={colors.primary}
                  />
                  <Text style={styles.superAgentMenuText}>
                    Create Sub-Agent
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.superAgentMenuItem}
                  onPress={() => {
                    setMenuOpen(false);
                    navigation.navigate("History");
                  }}
                >
                  <Ionicons name="receipt" size={18} color={colors.primary} />
                  <Text style={styles.superAgentMenuText}>Orders</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.superAgentMenuItem}
                  onPress={() => {
                    setMenuOpen(false);
                    navigation.navigate("History");
                  }}
                >
                  <Ionicons name="wallet" size={18} color={colors.primary} />
                  <Text style={styles.superAgentMenuText}>
                    Wallet / Transactions
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.superAgentMenuItem}
                  onPress={() => {
                    setMenuOpen(false);
                    showSuccess(
                      "Coming Soon",
                      "AFA Registration feature will be available soon!",
                    );
                  }}
                >
                  <Ionicons
                    name="person-add"
                    size={18}
                    color={colors.primary}
                  />
                  <Text style={styles.superAgentMenuText}>AFA</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.superAgentMenuItem}
                  onPress={() => {
                    setMenuOpen(false);
                    navigation.navigate("Profile");
                  }}
                >
                  <Ionicons name="settings" size={18} color={colors.primary} />
                  <Text style={styles.superAgentMenuText}>Settings</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.superAgentMenuItem}
                  onPress={() => {
                    setMenuOpen(false);
                    const message =
                      "Hi, I need help with the Mystiwan E-Business app";
                    const whatsappUrl = `https://wa.me/233532973455?text=${encodeURIComponent(
                      message,
                    )}`;
                    Linking.openURL(whatsappUrl);
                  }}
                >
                  <Ionicons
                    name="help-circle-outline"
                    size={18}
                    color={colors.primary}
                  />
                  <Text style={styles.superAgentMenuText}>Help</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Agent Business Snapshot (if agent) */}
          {isAgent && (
            <View style={styles.agentSnapshot}>
              <View style={styles.snapshotHeader}>
                <View style={styles.agentTag}>
                  <Ionicons
                    name="shield-checkmark"
                    size={12}
                    color={colors.white}
                  />
                  <Text style={styles.agentTagText}>Verified Agent</Text>
                </View>
                <TouchableOpacity
                  onPress={() => navigation.navigate("WalletTopUp")}
                >
                  <Text style={styles.topUpLink}>Top Up Wallet</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.snapshotContent}>
                <View style={styles.snapshotItem}>
                  <Text style={styles.snapshotLabel}>Wallet Balance</Text>
                  <Text style={styles.snapshotValue}>
                    Ghc {agentBalance.toFixed(2)}
                  </Text>
                  {/* Note: Balance update would need to be fetched/passed properly, 
                      for now using placeholder or if I find where balance is stored I will update */}
                </View>
                <View style={styles.divider} />
                <TouchableOpacity
                  style={styles.snapshotItem}
                  onPress={() => navigation.navigate("History")}
                >
                  <Text style={styles.snapshotLabel}>Today's Orders</Text>
                  <Text style={styles.snapshotValue}>
                    {
                      transactions.filter(
                        (t) =>
                          new Date(t.created_at).toDateString() ===
                          new Date().toDateString(),
                      ).length
                    }
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* Ads Section */}
          {ads.length > 0 ? (
            <React.Fragment>
              <ScrollView
                ref={adsScrollViewRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.adsScrollView}
                contentContainerStyle={{
                  ...styles.adsScrollContent,
                  paddingHorizontal: 30,
                  paddingVertical: 15,
                }}
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
                            x: nextIndex * 280,
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
                {/* Static WhatsApp Ad Card (always first) */}
                <TouchableOpacity
                  key="whatsapp-inapp-ad"
                  style={[
                    styles.individualAdCard,
                    { backgroundColor: colors.primary },
                  ]}
                  onPress={() => {
                    const whatsappUrl = `https://wa.me/233532973455?text=${encodeURIComponent(
                      "Hi, I want to advertise my business on your app",
                    )}`;
                    Linking.openURL(whatsappUrl);
                  }}
                >
                  <View style={styles.adOverlay}>
                    <Text style={[styles.adTitle, { fontSize: 20 }]}>
                      Advertise your business here
                    </Text>
                    <Text style={[styles.adDescription, { fontSize: 14 }]}>
                      Reach thousands of users instantly. Tap to contact us on
                      WhatsApp!
                    </Text>
                    <Text
                      style={[
                        styles.adActionText,
                        {
                          color: colors.light,
                          fontWeight: "bold",
                          fontSize: 16,
                        },
                      ]}
                    >
                      Contact via WhatsApp
                    </Text>
                  </View>
                </TouchableOpacity>
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
                      style={styles.individualAdCard}
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
                                showSuccess(
                                  "Ad",
                                  ad.action_text || "Learn More",
                                );
                            }
                          }
                        } else {
                          showSuccess("Ad", ad.action_text || "Learn More");
                        }
                      }}
                    >
                      <View style={styles.adOverlay}>
                        <Text style={styles.adTitle}>{ad.title}</Text>
                        {ad.description && (
                          <Text style={styles.adDescription}>
                            {ad.description}
                          </Text>
                        )}
                        <Text style={styles.adActionText}>
                          {ad.action_text || "Learn More"}
                        </Text>
                      </View>
                    </AdComponent>
                  );
                })}
                {/* Spacer to allow scrolling to last card */}
                <View style={{ width: 20 }} />
              </ScrollView>
              {/* Ad Indicators */}
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
                        // For the last item, scroll to end to ensure it's fully visible
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
            </React.Fragment>
          ) : (
            <View style={styles.centeredAdContainer}>
              <TouchableOpacity
                key="whatsapp-inapp-ad"
                style={[
                  styles.individualAdCard,
                  { backgroundColor: colors.primary },
                ]}
                onPress={() => {
                  const whatsappUrl = `https://wa.me/233532973455?text=${encodeURIComponent(
                    "Hi, I want to advertise my business on your app",
                  )}`;
                  Linking.openURL(whatsappUrl);
                }}
              >
                <View style={styles.adOverlay}>
                  <Text style={[styles.adTitle, { fontSize: 20 }]}>
                    Advertise your business here
                  </Text>
                  <Text style={[styles.adDescription, { fontSize: 14 }]}>
                    Reach thousands of users instantly. Tap to contact us on
                    WhatsApp!
                  </Text>
                  <Text
                    style={[
                      styles.adActionText,
                      { color: colors.light, fontWeight: "bold", fontSize: 16 },
                    ]}
                  >
                    Contact via WhatsApp
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          )}

          {/* Quick Actions Section */}
          <Text style={styles.header}>Quick Services</Text>
          <View style={styles.quickActions}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => navigation.navigate("History")}
            >
              <Ionicons name="receipt" size={24} color={colors.primary} />
              <Text style={styles.actionText}>History</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => {
                const message =
                  "Hi, I need help with the Mystiwan E-Business app";
                const whatsappUrl = `https://wa.me/233532973455?text=${encodeURIComponent(
                  message,
                )}`;
                Linking.openURL(whatsappUrl);
              }}
            >
              <Ionicons
                name="chatbubble-ellipses"
                size={24}
                color={colors.primary}
              />
              <Text style={styles.actionText}>Support</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => {
                showSuccess(
                  "Coming Soon",
                  "AFA Registration feature will be available soon!",
                );
              }}
            >
              <Ionicons name="person-add" size={24} color={colors.primary} />
              <Text style={styles.actionText}>AFA Reg</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={() => navigation.navigate("Profile")}
            >
              <Ionicons name="settings" size={24} color={colors.primary} />
              <Text style={styles.actionText}>Settings</Text>
            </TouchableOpacity>
          </View>

          {/*Network Card Section */}
          <Text style={styles.header}>Mobile Networks</Text>
          <View style={styles.networkContainer}>
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
                  activeOpacity={0.9}
                >
                  <ImageBackground
                    source={card.image}
                    style={styles.networkCard}
                    imageStyle={styles.networkImage}
                    resizeMode="cover"
                  >
                    <View style={styles.networkCardShade} />
                    <View style={styles.networkCardContent}>
                      <View style={styles.networkCardTopRow}>
                        <View style={styles.networkPill}>
                          <View
                            style={[
                              styles.networkDot,
                              { backgroundColor: card.accent },
                            ]}
                          />
                          <Text style={styles.networkPillText}>
                            {card.name}
                          </Text>
                        </View>
                        <View style={styles.networkBadge}>
                          <Ionicons
                            name="flash"
                            size={12}
                            color={colors.white}
                          />
                          <Text style={styles.networkBadgeText}>
                            {card.tag}
                          </Text>
                        </View>
                      </View>
                      <View style={styles.networkCardBottom}>
                        <Text style={styles.networkTitle}>{card.desc}</Text>
                        <Text style={styles.networkSubtitle}>{card.sub}</Text>
                        <View style={styles.networkActionRow}>
                          <Text style={styles.networkActionText}>Buy Data</Text>
                          <View style={styles.networkActionIcon}>
                            <Ionicons
                              name="arrow-forward"
                              size={12}
                              color={colors.white}
                            />
                          </View>
                        </View>
                      </View>
                    </View>
                  </ImageBackground>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          {/* transaction history section */}
          <Text style={styles.header}>Recent Transactions</Text>
          <View style={styles.historyContainer}>
            {loadingTransactions ? (
              renderRecentTransactionPlaceholders()
            ) : transactions.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Ionicons name="receipt" size={48} color={colors.tint} />
                <Text style={styles.emptyTitle}>No Transactions</Text>
                <Text style={styles.emptyMessage}>
                  Your transaction history will appear here
                </Text>
              </View>
            ) : (
              transactions.map((transaction) => (
                <TouchableOpacity
                  key={transaction.id}
                  style={styles.transactionItem}
                  onPress={() =>
                    navigation.navigate("Receipt", { transaction })
                  }
                >
                  <View style={styles.transactionLeft}>
                    <Text style={styles.transactionTitle}>
                      {transaction.offer_title || "Purchase"}
                    </Text>
                    <Text style={styles.transactionDesc}>
                      {transaction.network
                        ? `${transaction.network.toUpperCase()} - `
                        : ""}
                      {transaction.data_amount || "Data Bundle"}
                    </Text>
                  </View>
                  <View style={styles.transactionRight}>
                    <Text
                      style={[
                        styles.transactionAmount,
                        transaction.status?.toLowerCase() === "completed" &&
                          styles.transactionAmountCompleted,
                        transaction.status?.toLowerCase() === "processing" &&
                          styles.transactionAmountProcessing,
                        transaction.status?.toLowerCase() === "pending" &&
                          styles.transactionAmountPending,
                      ]}
                    >
                      -
                      {transaction.amount ? `Ghc ${transaction.amount}` : "N/A"}
                    </Text>
                    <Text style={styles.transactionDate}>
                      {transaction.created_at
                        ? new Date(transaction.created_at).toLocaleDateString()
                        : "N/A"}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))
            )}
          </View>

          {/* Footer */}
          <View style={styles.footer}>
            <Text style={styles.footerText}>Powered by Mysiwan-E-Business</Text>
            <Text style={styles.footerSubText}>
              Secure & Reliable Transactions
            </Text>
          </View>
        </SafeAreaView>
      </ScrollView>
    </SafeAreaProvider>
  );
}

const styles = {
  safeArea: {
    flex: 1,
    backgroundColor: colors.white,
  },
  headerSection: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 20,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  profileContainer: {
    flexDirection: "row",
    alignItems: "center",
  },
  avatarContainer: {
    width: 45,
    height: 45,
    borderRadius: 23,
    backgroundColor: colors.primary,
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  userInfo: {
    marginLeft: 12,
  },
  welcomeText: {
    fontSize: 12,
    color: colors.dark,
    opacity: 0.6,
    fontWeight: "500",
  },
  usernameText: {
    fontSize: 18,
    fontWeight: "700",
    color: colors.dark,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  iconCircle: {
    width: 45,
    height: 45,
    borderRadius: 23,
    backgroundColor: colors.light,
    justifyContent: "center",
    alignItems: "center",
    position: "relative",
  },
  menuButton: {
    width: 45,
    height: 45,
    borderRadius: 23,
    backgroundColor: colors.light,
    justifyContent: "center",
    alignItems: "center",
    elevation: 2,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  notificationBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    backgroundColor: colors.danger,
    borderRadius: 8,
    minWidth: 16,
    height: 16,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 2,
    borderColor: colors.white,
  },
  badgeText: {
    color: colors.white,
    fontSize: 8,
    fontWeight: "bold",
  },
  agentSnapshot: {
    marginHorizontal: 20,
    backgroundColor: colors.secondary,
    borderRadius: 24,
    padding: 20,
    elevation: 8,
    shadowColor: colors.secondary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    marginBottom: 20,
  },
  snapshotHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 15,
  },
  agentTag: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  agentTagText: {
    color: colors.white,
    fontSize: 10,
    fontWeight: "bold",
    marginLeft: 4,
  },
  topUpLink: {
    color: colors.white,
    fontSize: 12,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
  snapshotContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  snapshotItem: {
    flex: 1,
  },
  snapshotLabel: {
    color: colors.white,
    fontSize: 12,
    opacity: 0.8,
    marginBottom: 4,
  },
  snapshotValue: {
    color: colors.white,
    fontSize: 22,
    fontWeight: "bold",
  },
  divider: {
    width: 1,
    height: 40,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    marginHorizontal: 15,
  },
  superAgentMenuOverlay: {
    position: "absolute",
    top: 0,
    right: 0,
    left: 0,
    bottom: 0,
    zIndex: 20,
    justifyContent: "flex-start",
    alignItems: "flex-end",
  },
  superAgentMenuBackdrop: {
    position: "absolute",
    top: 0,
    right: 0,
    left: 0,
    bottom: 0,
    backgroundColor: "rgba(15, 23, 42, 0.18)",
  },
  superAgentMenuCard: {
    position: "relative",
    marginTop: 84,
    marginRight: 20,
    width: 260,
    backgroundColor: colors.white,
    borderRadius: 20,
    padding: 18,
    shadowColor: "#000",
    shadowOpacity: 0.14,
    shadowRadius: 18,
    elevation: 8,
  },
  superAgentMenuTitle: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: "800",
    marginBottom: 12,
  },
  superAgentMenuItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  superAgentMenuText: {
    color: colors.dark,
    fontSize: 14,
    fontWeight: "700",
  },
  superAgentAction: {
    marginHorizontal: 20,
    marginTop: 10,
    marginBottom: 18,
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  superAgentActionText: {
    color: colors.white,
    fontSize: 15,
    fontWeight: "800",
  },
  header: {
    fontSize: 20,
    fontWeight: "700",
    marginLeft: 20,
    marginTop: 20,
    marginBottom: 15,
    color: colors.dark,
  },
  quickActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    paddingHorizontal: 20,
  },
  actionButton: {
    backgroundColor: colors.white,
    padding: 16,
    borderRadius: 20,
    alignItems: "center",
    width: "23%",
    marginBottom: 15,
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
  },
  actionText: {
    fontSize: 10,
    fontWeight: "600",
    color: colors.dark,
    marginTop: 8,
    textAlign: "center",
  },
  networkContainer: {
    marginBottom: 20,
  },
  networkScrollContent: {
    paddingHorizontal: 20,
  },
  networkCardTouchable: {
    marginRight: 16,
    marginBottom: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 6,
  },
  networkCard: {
    width: 220,
    height: 220,
    borderRadius: 26,
    overflow: "hidden",
    justifyContent: "space-between",
    backgroundColor: colors.primary,
  },
  networkImage: {
    borderRadius: 26,
  },
  networkCardShade: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.35)",
  },
  networkCardContent: {
    flex: 1,
    padding: 16,
    justifyContent: "space-between",
  },
  networkCardTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  networkPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
  },
  networkDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  networkPillText: {
    color: colors.white,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  networkBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.45)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  networkBadgeText: {
    color: colors.white,
    fontSize: 10,
    fontWeight: "700",
    marginLeft: 4,
  },
  networkCardBottom: {
    backgroundColor: "rgba(0, 0, 0, 0.35)",
    padding: 14,
    borderRadius: 18,
  },
  networkTitle: {
    color: colors.white,
    fontSize: 16,
    fontWeight: "700",
  },
  networkSubtitle: {
    color: colors.white,
    fontSize: 12,
    opacity: 0.9,
    marginTop: 4,
  },
  networkActionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
  },
  networkActionText: {
    color: colors.white,
    fontSize: 12,
    fontWeight: "700",
  },
  networkActionIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignItems: "center",
    justifyContent: "center",
  },
  historyContainer: {
    marginHorizontal: 20,
    backgroundColor: colors.light,
    borderRadius: 24,
    padding: 10,
    marginBottom: 30,
  },
  placeholderList: {
    paddingVertical: 6,
  },
  transactionPlaceholder: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    backgroundColor: colors.white,
    borderRadius: 18,
    marginBottom: 10,
  },
  placeholderLeft: {
    flex: 1,
    marginRight: 12,
  },
  placeholderRight: {
    alignItems: "flex-end",
  },
  placeholderLine: {
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.border,
    width: "70%",
  },
  placeholderLineShort: {
    height: 10,
    borderRadius: 6,
    backgroundColor: colors.border,
    width: "45%",
    marginTop: 8,
  },
  placeholderAmount: {
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.border,
    width: 60,
  },
  placeholderDate: {
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.border,
    width: 50,
    marginTop: 8,
  },
  transactionItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    backgroundColor: colors.white,
    borderRadius: 18,
    marginBottom: 10,
    elevation: 2,
  },
  transactionLeft: {
    flex: 1,
  },
  transactionTitle: {
    fontWeight: "700",
    color: colors.dark,
    fontSize: 15,
  },
  transactionDesc: {
    fontSize: 12,
    color: colors.dark,
    opacity: 0.6,
    marginTop: 2,
  },
  transactionRight: {
    alignItems: "flex-end",
  },
  transactionAmount: {
    fontWeight: "bold",
    color: colors.danger,
    fontSize: 15,
  },
  transactionAmountCompleted: {
    color: colors.success,
  },
  transactionAmountProcessing: {
    color: colors.primary,
  },
  transactionAmountPending: {
    color: colors.warning,
  },
  transactionDate: {
    fontSize: 10,
    color: colors.dark,
    opacity: 0.4,
    marginTop: 4,
  },
  footer: {
    alignItems: "center",
    padding: 30,
    backgroundColor: colors.light,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
  },
  footerText: {
    fontSize: 14,
    fontWeight: "700",
    color: colors.primary,
  },
  footerSubText: {
    fontSize: 11,
    color: colors.dark,
    opacity: 0.5,
    marginTop: 4,
  },
  individualAdCard: {
    borderRadius: 24,
    width: 300,
    height: 180,
    marginRight: 15,
    overflow: "hidden",
    backgroundColor: colors.primary,
  },
  adOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.4)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  adTitle: {
    fontSize: 22,
    fontWeight: "bold",
    color: colors.white,
    textAlign: "center",
    marginBottom: 10,
  },
  adDescription: {
    fontSize: 14,
    color: colors.white,
    opacity: 0.9,
    textAlign: "center",
    marginBottom: 15,
    lineHeight: 20,
  },
  adActionText: {
    fontSize: 14,
    color: colors.white,
    fontWeight: "bold",
    textDecorationLine: "underline",
  },
  adIndicators: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 10,
    marginBottom: 10,
  },
  adIndicator: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
    marginHorizontal: 4,
  },
  adIndicatorActive: {
    backgroundColor: colors.primary,
    width: 15,
  },
  centeredAdContainer: {
    alignItems: "center",
    marginVertical: 20,
  },
  loadingContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
  },
  loadingText: {
    fontSize: 14,
    color: colors.secondary,
  },
  emptyContainer: {
    alignItems: "center",
    paddingVertical: 40,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "bold",
    color: colors.primary,
    marginTop: 10,
    marginBottom: 5,
  },
  emptyMessage: {
    fontSize: 12,
    color: colors.secondary,
    textAlign: "center",
  },
};
