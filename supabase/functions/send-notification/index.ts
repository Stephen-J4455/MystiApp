import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Helper function to convert to base64url encoding (required for JWT)
function base64urlEncode(data: string | Uint8Array): string {
  let base64;
  if (typeof data === "string") {
    // Encode string to base64
    base64 = btoa(unescape(encodeURIComponent(data)));
  } else {
    // Encode Uint8Array to base64
    base64 = btoa(String.fromCharCode(...data));
  }
  // Convert to base64url: replace +/= with -_
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Helper function to get FCM V1 access token using service account
async function getFCMAccessToken(serviceAccount: any): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiry = now + 3600; // 1 hour from now

  // Create JWT header
  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  // Create JWT claim set
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    exp: expiry,
    iat: now,
  };

  console.log("JWT claim set issuer:", serviceAccount.client_email);

  // Encode header and claim set using base64url
  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedClaimSet = base64urlEncode(JSON.stringify(claimSet));
  const signatureInput = `${encodedHeader}.${encodedClaimSet}`;

  // Import private key for signing
  // Handle escaped newlines from environment variable storage
  let privateKey = serviceAccount.private_key;
  if (!privateKey) {
    throw new Error("Service account private_key is missing");
  }

  // Replace escaped newlines with actual newlines
  privateKey = privateKey.replace(/\\n/g, "\n");

  const keyData = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");

  if (!keyData || keyData.length < 100) {
    throw new Error(
      `Private key appears invalid or too short: ${keyData.length} chars`,
    );
  }

  // Use Web Crypto API to sign
  try {
    const binaryKey = Uint8Array.from(atob(keyData), (c) => c.charCodeAt(0));
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      binaryKey.buffer,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["sign"],
    );

    const encoder = new TextEncoder();
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      encoder.encode(signatureInput),
    );

    // Encode signature using base64url
    const encodedSignature = base64urlEncode(new Uint8Array(signature));
    const jwt = `${signatureInput}.${encodedSignature}`;

    // Debug: log JWT structure (not the full token for security)
    console.log("JWT header (decoded check):", encodedHeader);
    console.log("JWT parts count:", jwt.split(".").length);
    console.log("JWT total length:", jwt.length);

    // Exchange JWT for access token
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      console.error("OAuth token exchange failed:", tokenData);
      console.error("OAuth error description:", tokenData.error_description);
      throw new Error(
        `Failed to get access token: ${JSON.stringify(tokenData)}`,
      );
    }

    return tokenData.access_token;
  } catch (keyError) {
    console.error("Key import/signing error:", keyError);
    throw new Error(`Failed to process private key: ${keyError.message}`);
  }
}

Deno.serve(async (req) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Parse request body first to check if it's for admin notifications
    const requestBody = await req.json();
    const {
      userId,
      title,
      message,
      type = "notification",
      sendToAdmins = false,
    } = requestBody;

    if (!title || !message) {
      throw new Error("Missing required fields: title, message");
    }

    if (!userId && !sendToAdmins) {
      throw new Error("Either userId or sendToAdmins must be provided");
    }

    // Use service role key for admin operations (for edge function to edge function calls)
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
        Deno.env.get("SUPABASE_ANON_KEY") ??
        "",
    );

    // Determine which table to query based on sendToAdmins flag
    const tableName = sendToAdmins ? "admin_push_tokens" : "user_push_tokens";
    const targetDescription = sendToAdmins ? "admins" : `user ${userId}`;

    console.log(`Sending notification to ${targetDescription}: ${title}`);

    // Get push tokens from appropriate table
    // Try with token_type column first, fallback without it
    let tokens = null;
    let tokenError = null;

    let query = supabaseClient
      .from(tableName)
      .select("push_token, platform, token_type, user_id");

    // If sending to specific user, filter by user_id
    if (!sendToAdmins && userId) {
      query = query.eq("user_id", userId);
    }

    const { data: tokensWithType, error: error1 } = await query;

    if (
      error1 &&
      (error1.message?.includes("token_type") || error1.code === "42703")
    ) {
      // Column doesn't exist, try without it
      console.log("token_type column not found, querying without it...");
      let fallbackQuery = supabaseClient
        .from(tableName)
        .select("push_token, platform, user_id");

      if (!sendToAdmins && userId) {
        fallbackQuery = fallbackQuery.eq("user_id", userId);
      }

      const { data: tokensWithoutType, error: error2 } = await fallbackQuery;

      tokens = tokensWithoutType;
      tokenError = error2;
    } else {
      tokens = tokensWithType;
      tokenError = error1;
    }

    if (tokenError) {
      console.error("Error fetching tokens:", tokenError);
      throw tokenError;
    }

    console.log(
      `Found ${tokens?.length || 0} token(s) for ${targetDescription}`,
    );

    if (!tokens || tokens.length === 0) {
      return new Response(
        JSON.stringify({
          success: false,
          message: `No push tokens found for ${targetDescription}`,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Send push notifications to all user's devices
    const expoMessages = [];
    const fcmMessages = [];

    tokens.forEach((tokenData) => {
      const token = tokenData.push_token;
      const platform = tokenData.platform?.toLowerCase();
      const tokenType =
        tokenData.token_type ||
        (token.startsWith("ExponentPushToken") ? "expo" : "fcm");

      console.log(
        `Processing token for platform: ${platform}, type: ${tokenType}`,
      );

      // Use token_type field to determine which service to use
      if (tokenType === "expo" || token.startsWith("ExponentPushToken")) {
        // Expo push token
        expoMessages.push({
          to: token,
          title,
          body: message,
          data: {
            type,
            userId,
            timestamp: new Date().toISOString(),
          },
          sound: "default",
          priority: "high",
        });
      } else if (tokenType === "fcm") {
        // FCM device token
        fcmMessages.push({
          token: token, // Changed from 'to' to 'token'
          notification: {
            title,
            body: message,
          },
          data: {
            type,
            userId,
            timestamp: new Date().toISOString(),
          },
          android: {
            priority: "high",
            notification: {
              sound: "default",
              channelId: "transactions",
            },
          },
        });
      }
    });

    let expoResult = null;
    if (expoMessages.length > 0) {
      console.log(`Sending ${expoMessages.length} Expo notification(s)...`);
      // Send to Expo push service
      const expoResponse = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(expoMessages),
      });
      expoResult = await expoResponse.json();
      console.log("Expo response:", expoResult);
    }

    let fcmResult = null;
    if (fcmMessages.length > 0) {
      // For FCM V1 API, we need service account credentials
      const fcmServiceAccountJson = Deno.env.get("FCM_SERVICE_ACCOUNT_JSON");
      const fcmProjectId = Deno.env.get("FCM_PROJECT_ID") || "mystiwan-97276";

      if (!fcmServiceAccountJson) {
        console.error("FCM_SERVICE_ACCOUNT_JSON not configured!");
        return new Response(
          JSON.stringify({
            success: false,
            error:
              "FCM not configured. Please set FCM_SERVICE_ACCOUNT_JSON in Supabase secrets.",
            help: "Get your service account JSON from Firebase Console → Project Settings → Service Accounts → Generate new private key",
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      console.log(
        `Sending ${fcmMessages.length} FCM notification(s) using V1 API...`,
      );

      try {
        // Parse service account - handle potential double-escaping
        let serviceAccountJson = fcmServiceAccountJson;

        // Log raw secret info for debugging
        console.log("Raw FCM secret length:", serviceAccountJson.length);
        console.log(
          "Raw FCM secret starts with:",
          serviceAccountJson.substring(0, 50),
        );

        // If the secret is double-stringified (starts with quotes), parse it first
        if (
          serviceAccountJson.startsWith('"') ||
          serviceAccountJson.startsWith("'")
        ) {
          console.log("Detected quoted JSON, parsing outer layer...");
          serviceAccountJson = JSON.parse(serviceAccountJson);
        }

        const serviceAccount =
          typeof serviceAccountJson === "string"
            ? JSON.parse(serviceAccountJson)
            : serviceAccountJson;

        // Log service account details for debugging (redacted)
        console.log(
          "Service account parsed - project_id:",
          serviceAccount.project_id,
        );
        console.log(
          "Service account client_email:",
          serviceAccount.client_email,
        );
        console.log("Private key present:", !!serviceAccount.private_key);
        console.log("Private key length:", serviceAccount.private_key?.length);
        console.log(
          "Private key starts with:",
          serviceAccount.private_key?.substring(0, 35),
        );
        console.log(
          "Private key contains escaped newlines:",
          serviceAccount.private_key?.includes("\\n"),
        );

        // Get OAuth access token
        console.log("Getting FCM access token...");
        const accessToken = await getFCMAccessToken(serviceAccount);
        console.log("Access token obtained");

        // Send to FCM V1 API
        const fcmResults = [];
        for (const msg of fcmMessages) {
          try {
            // FCM V1 message format
            const v1Message = {
              message: {
                token: msg.token,
                notification: {
                  title: msg.notification.title,
                  body: msg.notification.body,
                },
                data: {
                  type: msg.data.type,
                  userId: msg.data.userId,
                  timestamp: msg.data.timestamp,
                },
                android: {
                  priority: "high",
                  notification: {
                    sound: "default",
                    channel_id:
                      msg.android?.notification?.channelId || "default",
                  },
                },
              },
            };

            const fcmResponse = await fetch(
              `https://fcm.googleapis.com/v1/projects/${fcmProjectId}/messages:send`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify(v1Message),
              },
            );

            const result = await fcmResponse.json();
            console.log("FCM V1 response:", result);

            if (!fcmResponse.ok) {
              console.error("FCM V1 error:", result);
              fcmResults.push({
                success: false,
                error: result.error?.message || "Unknown error",
                details: result,
              });
            } else {
              fcmResults.push({ success: true, result });
            }
          } catch (fcmError) {
            console.error("FCM send error:", fcmError);
            fcmResults.push({ success: false, error: fcmError.message });
          }
        }
        fcmResult = fcmResults;
      } catch (authError) {
        console.error("FCM authentication error:", authError);
        return new Response(
          JSON.stringify({
            success: false,
            error: "FCM authentication failed",
            details: authError.message,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }

    // Also create in-app notification
    // Try with title and type first, fallback to just message
    let notificationError = null;

    if (sendToAdmins) {
      // For admin notifications, create notification for each admin
      const adminIds = tokens.map((t) => t.user_id || null).filter(Boolean);

      // Get unique admin user IDs
      const uniqueAdminIds = [...new Set(adminIds)];

      if (uniqueAdminIds.length === 0) {
        // If no user_id in tokens, get them from admin_push_tokens
        const { data: adminTokens } = await supabaseClient
          .from("admin_push_tokens")
          .select("user_id");

        uniqueAdminIds.push(
          ...new Set(adminTokens?.map((t) => t.user_id) || []),
        );
      }

      // Insert notification for each admin
      for (const adminId of uniqueAdminIds) {
        const { error: notifError } = await supabaseClient
          .from("notifications")
          .insert({
            user_id: adminId,
            title,
            message,
            type: type,
            read: false,
          });

        if (
          notifError &&
          (notifError.message?.includes("title") ||
            notifError.message?.includes("type") ||
            notifError.code === "42703")
        ) {
          // Columns don't exist, try with just message
          await supabaseClient.from("notifications").insert({
            user_id: adminId,
            message: `${title}: ${message}`,
            read: false,
          });
        }
      }
    } else {
      // For user notifications, create single notification
      const { error: notifError1 } = await supabaseClient
        .from("notifications")
        .insert({
          user_id: userId,
          title,
          message,
          type: type,
          read: false,
        });

      if (
        notifError1 &&
        (notifError1.message?.includes("title") ||
          notifError1.message?.includes("type") ||
          notifError1.code === "42703")
      ) {
        // Columns don't exist, try with just message
        console.log(
          "title/type columns not found, inserting with just message...",
        );
        const { error: error2 } = await supabaseClient
          .from("notifications")
          .insert({
            user_id: userId,
            message: `${title}: ${message}`,
            read: false,
          });
        notificationError = error2;
      } else {
        notificationError = notifError1;
      }

      if (notificationError) {
        console.error("Error creating in-app notification:", notificationError);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        expoResponse: expoResult,
        fcmResponse: fcmResult,
        expoTokensSent: expoMessages.length,
        fcmTokensSent: fcmMessages.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Error in send-notification function:", error);
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
