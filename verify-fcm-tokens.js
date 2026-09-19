/**
 * FCM Token Verification Script
 * Run this to check if push tokens are being registered correctly
 * 
 * Usage: Add this code to your app (e.g., in a debug screen or ProfileScreen)
 */

import { supabase } from './src/lib/supabase';
import { registerForPushNotifications, savePushToken } from './src/services/notifications';
import { Alert, Platform } from 'react-native';

export async function verifyPushTokens() {
    console.log('=== Push Token Verification Start ===');
    console.log('Platform:', Platform.OS);

    try {
        // 1. Check if user is logged in
        const { data: { user }, error: userError } = await supabase.auth.getUser();

        if (userError || !user) {
            console.error('❌ User not logged in:', userError?.message);
            Alert.alert('Error', 'Please log in first');
            return;
        }

        console.log('✅ User authenticated:', user.email);
        console.log('   User ID:', user.id);

        // 2. Try to register for push notifications
        console.log('\n--- Attempting Token Registration ---');
        const token = await registerForPushNotifications();

        if (!token) {
            console.log('❌ No token received');
            console.log('   Possible reasons:');
            console.log('   - Running in Expo Go (FCM not supported)');
            console.log('   - Permissions denied');
            console.log('   - Not a physical device');
            Alert.alert('Token Registration Failed', 'Check console for details');
            return;
        }

        console.log('✅ Token obtained successfully');
        console.log('   Token preview:', token.substring(0, 50) + '...');
        console.log('   Token length:', token.length);
        console.log('   Token type:', token.startsWith('ExponentPushToken') ? 'Expo' : 'FCM');

        // 3. Save token to database
        console.log('\n--- Saving Token to Database ---');
        await savePushToken(token, user.id);
        console.log('✅ Save token function called');

        // Wait a bit for the save to complete
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 4. Verify tokens in database
        console.log('\n--- Checking Database ---');
        const { data: tokens, error: dbError } = await supabase
            .from('user_push_tokens')
            .select('*')
            .eq('user_id', user.id);

        if (dbError) {
            console.error('❌ Database query error:', dbError.message);
            Alert.alert('Database Error', dbError.message);
            return;
        }

        if (!tokens || tokens.length === 0) {
            console.log('❌ No tokens found in database');
            console.log('   This might be due to:');
            console.log('   - RLS policies blocking access');
            console.log('   - Insert/upsert failed silently');
            console.log('   - Wrong table permissions');

            // Try to check with service role (if available)
            Alert.alert('No Tokens Found', 'Tokens may not be saving to database. Check RLS policies.');
            return;
        }

        console.log('✅ Tokens found in database:', tokens.length);
        tokens.forEach((t, index) => {
            console.log(`\n   Token #${index + 1}:`);
            console.log('   - ID:', t.id);
            console.log('   - Platform:', t.platform);
            console.log('   - Token Type:', t.token_type);
            console.log('   - Token Preview:', t.push_token.substring(0, 40) + '...');
            console.log('   - Created:', new Date(t.created_at).toLocaleString());
            console.log('   - Updated:', new Date(t.updated_at).toLocaleString());
        });

        // 5. Check if current token matches database
        const currentTokenInDb = tokens.find(t => t.push_token === token);
        if (currentTokenInDb) {
            console.log('\n✅ Current token is in database');
        } else {
            console.log('\n⚠️  Current token is NOT in database');
            console.log('    Token may not have saved properly');
        }

        // 6. Summary
        console.log('\n=== Verification Summary ===');
        console.log('User:', user.email);
        console.log('Platform:', Platform.OS);
        console.log('Token Type:', token.startsWith('ExponentPushToken') ? 'Expo' : 'FCM');
        console.log('Tokens in DB:', tokens.length);
        console.log('Current Token Saved:', currentTokenInDb ? 'YES' : 'NO');
        console.log('=== Verification Complete ===');

        // Show result to user
        Alert.alert(
            'Verification Complete',
            `✅ User: ${user.email}\n` +
            `✅ Platform: ${Platform.OS}\n` +
            `✅ Token Type: ${token.startsWith('ExponentPushToken') ? 'Expo' : 'FCM'}\n` +
            `✅ Tokens in Database: ${tokens.length}\n` +
            `${currentTokenInDb ? '✅' : '⚠️'} Current Token: ${currentTokenInDb ? 'Saved' : 'Not Found'}`
        );

        return {
            success: true,
            user: user.email,
            platform: Platform.OS,
            tokenType: token.startsWith('ExponentPushToken') ? 'Expo' : 'FCM',
            tokensInDb: tokens.length,
            currentTokenSaved: !!currentTokenInDb
        };

    } catch (error) {
        console.error('❌ Verification error:', error);
        Alert.alert('Verification Error', error.message);
        return { success: false, error: error.message };
    }
}

// Example: Add to ProfileScreen or a debug menu
export function addVerificationButton() {
    return (
        <TouchableOpacity
            style={{
                backgroundColor: '#007AFF',
                padding: 15,
                borderRadius: 8,
                marginVertical: 10,
            }}
            onPress={verifyPushTokens}
        >
            <Text style={{ color: 'white', textAlign: 'center', fontWeight: 'bold' }}>
                Verify Push Tokens
            </Text>
        </TouchableOpacity>
    );
}
