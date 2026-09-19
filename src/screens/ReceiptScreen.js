import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  StatusBar,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import colors from "../components/theme";

export default function ReceiptScreen({ navigation, route }) {
  const { transaction } = route.params;
  const isAgentOrder = transaction.orderType === "agent";

  const formatDate = (dateString) => {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getStatusColor = (status) => {
    switch (status?.toLowerCase()) {
      case "completed":
      case "success":
        return "#27ae60"; // Green for completed
      case "processing":
        return "#3498db"; // Blue for processing
      case "pending":
        return "#f39c12"; // Orange for pending
      case "failed":
      case "cancelled":
        return "#e74c3c"; // Red for failed/cancelled
      default:
        return colors.primary;
    }
  };

  const getStatusText = (status) => {
    if (!status) return "Unknown";
    return status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
  };

  return (
    <View style={styles.container}>
      <StatusBar
        translucent
        backgroundColor="transparent"
        barStyle="dark-content"
      />

      {/* Floating Back Button */}
      <TouchableOpacity
        style={styles.floatingBackButton}
        onPress={() => navigation.goBack()}
      >
        <View style={styles.backButtonCircle}>
          <Ionicons name="arrow-back" size={24} color={colors.primary} />
        </View>
      </TouchableOpacity>

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.contentHeader}>
          <Text style={styles.screenTitle}>Transaction Receipt</Text>
        </View>
        {/* Receipt Header */}
        <View style={styles.receiptHeader}>
          <View style={styles.receiptIcon}>
            <Ionicons name="receipt" size={40} color={colors.primary} />
          </View>
          <Text style={styles.receiptTitle}>
            {isAgentOrder ? "Agent Purchase Receipt" : "Purchase Receipt"}
          </Text>
          {isAgentOrder && (
            <View style={styles.agentBadge}>
              <Ionicons name="shield-checkmark" size={14} color="#fff" />
              <Text style={styles.agentBadgeText}>AGENT</Text>
            </View>
          )}
          <Text style={styles.transactionId}>ID: {transaction.id}</Text>
        </View>

        {/* Status Badge */}
        <View style={styles.statusContainer}>
          <View
            style={[
              styles.statusBadge,
              { backgroundColor: getStatusColor(transaction.status) },
            ]}
          >
            <Text style={styles.statusText}>
              {getStatusText(transaction.status)}
            </Text>
          </View>
        </View>

        {/* Transaction Details */}
        <View style={styles.detailsCard}>
          <Text style={styles.sectionTitle}>Transaction Details</Text>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Service</Text>
            <Text style={styles.detailValue}>
              {isAgentOrder
                ? `Agent Service - ${transaction.displayName || "Customer"}`
                : transaction.offer_title || "Data Bundle Purchase"}
            </Text>
          </View>

          {transaction.network && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Network</Text>
              <Text style={styles.detailValue}>
                {transaction.network.toUpperCase()}
              </Text>
            </View>
          )}

          {!isAgentOrder && transaction.data_amount && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Data Amount</Text>
              <Text style={styles.detailValue}>{transaction.data_amount}</Text>
            </View>
          )}

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Amount</Text>
            <Text style={[styles.detailValue, styles.amount]}>
              Ghc {transaction.amount || "0.00"}
            </Text>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Date & Time</Text>
            <Text style={styles.detailValue}>
              {formatDate(transaction.created_at)}
            </Text>
          </View>

          {transaction.payment_reference && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Reference</Text>
              <Text style={styles.detailValue}>
                {transaction.payment_reference}
              </Text>
            </View>
          )}

          {transaction.paystack_transaction_id && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Payment ID</Text>
              <Text style={styles.detailValue}>
                {transaction.paystack_transaction_id}
              </Text>
            </View>
          )}
        </View>

        {/* Customer Information */}
        <View style={styles.detailsCard}>
          <Text style={styles.sectionTitle}>
            {isAgentOrder ? "Recipient Information" : "Customer Information"}
          </Text>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Name</Text>
            <Text style={styles.detailValue}>
              {isAgentOrder
                ? transaction.displayName || "N/A"
                : transaction.user_name || "N/A"}
            </Text>
          </View>

          {!isAgentOrder && transaction.user_email && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Email</Text>
              <Text style={styles.detailValue}>{transaction.user_email}</Text>
            </View>
          )}

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Phone</Text>
            <Text style={styles.detailValue}>
              {isAgentOrder
                ? transaction.displayPhone || "N/A"
                : transaction.phone || "N/A"}
            </Text>
          </View>

          {transaction.country_code && (
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Country</Text>
              <Text style={styles.detailValue}>{transaction.country_code}</Text>
            </View>
          )}
        </View>

        {/* Payment Information */}
        {(transaction.bank || transaction.channel) && (
          <View style={styles.detailsCard}>
            <Text style={styles.sectionTitle}>Payment Information</Text>

            {transaction.bank && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Bank</Text>
                <Text style={styles.detailValue}>{transaction.bank}</Text>
              </View>
            )}

            {transaction.channel && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Channel</Text>
                <Text style={styles.detailValue}>{transaction.channel}</Text>
              </View>
            )}

            {transaction.paid_at && (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Paid At</Text>
                <Text style={styles.detailValue}>
                  {formatDate(transaction.paid_at)}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Thank you for using Mystiwan-E-Business</Text>
          <Text style={styles.footerSubText}>
            For support, contact our customer service
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.white,
  },
  floatingBackButton: {
    position: "absolute",
    top: 50,
    left: 20,
    zIndex: 10,
  },
  backButtonCircle: {
    width: 45,
    height: 45,
    borderRadius: 23,
    backgroundColor: "rgba(255, 255, 255, 0.9)",
    justifyContent: "center",
    alignItems: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
  },
  contentHeader: {
    paddingHorizontal: 20,
    marginTop: 110, // Accounts for floating back button
    marginBottom: 10,
  },
  screenTitle: {
    fontSize: 28,
    fontWeight: "bold",
    color: colors.dark,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 20,
    backgroundColor: colors.light,
    borderBottomWidth: 1,
    borderBottomColor: colors.tint,
  },
  backButton: {
    padding: 5,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: colors.primary,
  },
  content: {
    flex: 1,
    padding: 10,
  },
  receiptHeader: {
    alignItems: "center",
    backgroundColor: "#fff",
    padding: 30,
    borderRadius: 15,
    marginBottom: 15,
    elevation: 3,
  },
  receiptIcon: {
    marginBottom: 10,
  },
  receiptTitle: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.primary,
    marginBottom: 5,
  },
  transactionId: {
    fontSize: 14,
    color: colors.secondary,
  },
  statusContainer: {
    alignItems: "center",
    marginBottom: 15,
  },
  statusBadge: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
  },
  statusText: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "bold",
  },
  detailsCard: {
    backgroundColor: "#fff",
    borderRadius: 15,
    padding: 20,
    marginBottom: 15,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "bold",
    color: colors.primary,
    marginBottom: 15,
    borderBottomWidth: 1,
    borderBottomColor: colors.tint,
    paddingBottom: 10,
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f8f9fa",
  },
  detailLabel: {
    fontSize: 14,
    color: colors.secondary,
    fontWeight: "500",
  },
  detailValue: {
    fontSize: 14,
    color: colors.primary,
    fontWeight: "600",
    textAlign: "right",
    flex: 1,
    marginLeft: 10,
  },
  amount: {
    fontSize: 16,
    color: "#e74c3c",
    fontWeight: "bold",
  },
  footer: {
    alignItems: "center",
    backgroundColor: colors.primary,
    padding: 25,
    borderRadius: 15,
    marginTop: 10,
    marginBottom: 20,
  },
  footerText: {
    fontSize: 16,
    fontWeight: "bold",
    color: colors.light,
    textAlign: "center",
  },
  footerSubText: {
    fontSize: 12,
    color: colors.tint,
    marginTop: 5,
    textAlign: "center",
  },
  agentBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#27ae60",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
    marginTop: 5,
  },
  agentBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "bold",
    marginLeft: 4,
  },
});
