import React, { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { useNotification } from "../contexts/NotificationContext";
import { isSuperAgent } from "../lib/superAgent";
import colors from "../components/theme";

export default function SuperAgentTransactionsScreen({ navigation }) {
  const { showError } = useNotification();
  const [loading, setLoading] = useState(true);
  const [transactions, setTransactions] = useState([]);

  useEffect(() => { let mounted = true;
    (async () => {
      try {
        const { data: { user }, error: e } = await supabase.auth.getUser();
        if (e || !user) { navigation.replace("Login"); return; }
        if (!isSuperAgent(user)) { navigation.replace("Home"); return; }
        const { data: s, error: se } = await supabase
          .from("super_agent_paystack").select("subaccount_code")
          .eq("super_agent_id", user.id).maybeSingle();
        if (se || !s?.subaccount_code) setTransactions([]);
        else {
          const c = s.subaccount_code;
          const { data: tu, error: e1 } = await supabase
            .from("wallet_topups").select("*")
            .eq("paystack_subaccount_code", c)
            .order("created_at", { ascending: false }).limit(100);
          const { data: od, error: e2 } = await supabase
            .from("agent_orders").select("*")
            .eq("paystack_subaccount_code", c)
            .order("created_at", { ascending: false }).limit(100);
          const a = [];
          (tu||[]).forEach(t => a.push({ ...t, source: "wallet_topup",
            amountDisplay: "Ghc " + ((t.amount||0)/100).toFixed(2),
            statusColor: t.status==="success" ? colors.success : t.status==="pending" ? colors.warning : colors.danger }));
          (od||[]).forEach(o => a.push({ ...o, source: "data_purchase",
            amountDisplay: "Ghc " + ((o.amount||0)/100).toFixed(2),
            statusColor: o.status==="completed" ? colors.success : o.status==="pending" ? colors.warning : colors.danger }));
          a.sort((x,y) => new Date(y.created_at) - new Date(x.created_at));
          setTransactions(a);
        }
      } catch(err) { console.error(err); showError("Error", "Failed to load transactions."); }
      finally { if(mounted) setLoading(false); } })();
    return () => { mounted = false; };
  }, [navigation, showError]);

  const fmt = d => { try { return new Date(d).toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}) } catch { return d }; };

  if(loading) return(<SafeAreaView style={styles.safeArea}><View style={styles.loadingContainer}><ActivityIndicator size="large" color={colors.primary}/><Text style={styles.loadingText}>Loading...</Text></View></SafeAreaView>);

  return(
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity onPress={()=>navigation.goBack()} style={styles.backButton}><Ionicons name="arrow-back" size={24} color={colors.primary}/></TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.title}>Transactions</Text>
          <Text style={styles.subtitle}>{transactions.length} transaction{transactions.length!==1?"s":""} found</Text>
        </View>
      </View>
      {transactions.length===0?(
        <View style={styles.emptyContainer}>
          <Ionicons name="receipt-outline" size={64} color={colors.border}/>
          <Text style={styles.emptyTitle}>No Transactions Yet</Text>
          <Text style={styles.emptyText}>Transactions routed through your Paystack sub-account will appear here.</Text>
        </View>
      ):(
        <ScrollView contentContainerStyle={styles.content}>
          {transactions.map((tx,i)=>(
            <View key={i} style={styles.txCard}>
              <View style={styles.txHeader}>
                <View style={styles.txIconWrap}>
                  <Ionicons name={tx.source==="wallet_topup"?"wallet":"phone-portrait"} size={22} color={colors.primary}/>
                </View>
                <View style={styles.txMeta}>
                  <Text style={styles.txType}>{tx.source==="wallet_topup"?"Wallet Top-up":"Data Purchase"}</Text>
                  <Text style={styles.txDate}>{fmt(tx.created_at)}</Text>
                </View>
                <View style={[styles.txStatus,{backgroundColor:tx.statusColor}]}>
                  <Text style={styles.txStatusText}>{tx.status.toUpperCase()}</Text>
                </View>
              </View>
              <View style={styles.txBody}>
                <View style={styles.txInfoRow}>
                  <Text style={styles.txInfoLabel}>Reference</Text>
                  <Text style={styles.txInfoValue} numberOfLines={1}>{tx.reference||tx.id?.toString().slice(0,12)}</Text>
                </View>
                <View style={styles.txInfoRow}>
                  <Text style={styles.txInfoLabel}>Amount</Text>
                  <Text style={styles.txInfoValueBold}>{tx.amountDisplay}</Text>
                </View>
                {tx.paystack_transaction_id&&<View style={styles.txInfoRow}>
                  <Text style={styles.txInfoLabel}>Paystack TX ID</Text>
                  <Text style={styles.txInfoValue} numberOfLines={1}>{tx.paystack_transaction_id}</Text>
                </View>}
                {tx.channel&&<View style={styles.txInfoRow}>
                  <Text style={styles.txInfoLabel}>Channel</Text>
                  <Text style={styles.txInfoValue}>{tx.channel}</Text>
                </View>}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea:{flex:1,backgroundColor:colors.light},
  loadingContainer:{flex:1,justifyContent:"center",alignItems:"center",backgroundColor:colors.light},
  loadingText:{marginTop:12,color:colors.dark,fontSize:16,fontWeight:"600"},
  header:{flexDirection:"row",alignItems:"center",paddingHorizontal:16,paddingTop:18,paddingBottom:12,backgroundColor:colors.white,borderBottomWidth:1,borderBottomColor:colors.border,gap:10},
  headerCenter:{flex:1},
  backButton:{width:40,height:40,borderRadius:20,backgroundColor:colors.light,justifyContent:"center",alignItems:"center"},
  title:{fontSize:20,fontWeight:"800",color:colors.dark},
  subtitle:{fontSize:12,color:colors.border,marginTop:2},
  emptyContainer:{flex:1,justifyContent:"center",alignItems:"center",padding:40,gap:12},
  emptyTitle:{fontSize:20,fontWeight:"700",color:colors.dark},
  emptyText:{fontSize:14,color:colors.border,textAlign:"center",lineHeight:22},
  content:{padding:16,gap:12,paddingBottom:40},
  txCard:{backgroundColor:colors.white,borderRadius:14,padding:14,shadowColor:"#000",shadowOffset:{width:0,height:1},shadowOpacity:0.06,shadowRadius:4,elevation:2},
  txHeader:{flexDirection:"row",alignItems:"center",gap:10,marginBottom:12},
  txIconWrap:{width:38,height:38,borderRadius:10,backgroundColor:colors.light,justifyContent:"center",alignItems:"center"},
  txMeta:{flex:1},
  txType:{fontSize:14,fontWeight:"700",color:colors.dark},
  txDate:{fontSize:12,color:colors.border,marginTop:2},
  txStatus:{paddingHorizontal:10,paddingVertical:4,borderRadius:8},
  txStatusText:{fontSize:11,fontWeight:"700",color:"#fff",textTransform:"uppercase"},
  txBody:{borderTopWidth:1,borderTopColor:colors.light,paddingTop:10},
  txInfoRow:{flexDirection:"row",justifyContent:"space-between",alignItems:"center",paddingVertical:3},
  txInfoLabel:{fontSize:12,color:colors.border},
  txInfoValue:{fontSize:12,color:colors.dark,fontWeight:"500",flex:1,textAlign:"right"},
  txInfoValueBold:{fontSize:14,color:colors.primary,fontWeight:"700",flex:1,textAlign:"right"}
});
