# ExpressData Data Sales App

A comprehensive React Native app for selling data bundles for MTN, Telecel, and AirtelTigo networks in Ghana, with user authentication powered by Supabase.

## Paystack Payment Integration Setup

The app now includes Paystack payment integration for secure data bundle purchases. Follow these steps to complete the setup:

### 1. Install Paystack SDK

The app uses WebView for Paystack integration, so no additional SDK installation is required beyond the standard React Native WebView (which comes with Expo).

### 2. Configure Paystack Keys

1. Sign up for a Paystack account at [paystack.com](https://paystack.com)
2. Get your public key from the Paystack dashboard
3. Update `src/lib/config.js`:

```javascript
export const PAYSTACK_PUBLIC_KEY = "pk_test_your_actual_paystack_public_key";
```

### 3. Deploy Supabase Edge Function

The app uses a Supabase Edge Function to verify payments and create orders. Deploy it using:

```bash
supabase functions deploy verify-payment
```

### 4. Set Environment Variables in Supabase

In your Supabase dashboard, go to Edge Functions > Environment Variables and add:

```
PAYSTACK_SECRET_KEY=sk_test_your_actual_paystack_secret_key
```

### 5. Database Setup

Ensure your Supabase database has the following tables with RLS policies:

- `offers` table for data bundles
- `orders` table for transaction records
- `notifications` table for user notifications

### 6. Test the Integration

1. Run the app: `npm start`
2. Create an account or log in
3. Select a network and data bundle
4. Click "Purchase" - Paystack payment WebView should appear
5. Complete payment with test card details
6. Verify order creation and receipt display

## Features

- User authentication (Login/Signup) with Supabase
- User profile management with editable full name and phone number
- Notifications system with read/unread status
- Select network (MTN, Telecel, AirtelTigo, Vodafone) with data bundle purchasing
- Choose from various data bundles with detailed pricing
- **Purchase options**: "For Myself" (displays user's phone) or "For Someone Else" (enter recipient phone)
- Secure Paystack payment integration with WebView
- Automatic order creation upon successful payment
- Transaction receipts with detailed order information
- Transaction history

## Installation

1. Install dependencies:

   ```
   npm install
   ```

2. Set up Supabase:
   - Create a new project at [supabase.com](https://supabase.com)
   - Go to Settings > API
   - Copy your project URL and anon key
   - Update `src/lib/supabase.js` with your credentials:

     ```javascript
     const supabaseUrl = "YOUR_SUPABASE_URL";
     const supabaseAnonKey = "YOUR_SUPABASE_ANON_KEY";
     ```

3. Start the app:
   ```bash
   npm start
   ```

## Usage

- **First Time**: Create an account or sign in
- Select a network from the available options
- **Choose purchase type**: Select "For Myself" (shows your phone number) or "For Someone Else" (enter recipient phone)
- Choose a data bundle from the list
- Click the "Purchase" button to initiate secure payment
- Complete payment through Paystack
- View transaction receipt and history

## Technologies

- React Native
- Expo
- React Navigation
- Supabase (Authentication)
- Expo Vector Icons

## Project Structure

```
src/
├── components/
│   └── theme.js          # Color theme
├── lib/
│   └── supabase.js       # Supabase client configuration
└── screens/
    ├── LoginScreen.js    # Login screen
    ├── SignupScreen.js   # Signup screen
    └── HomeScreen.js     # Main app screen
```

## Future Enhancements

- Real payment integration (Paystack, mobile money)
- Real-time bundle updates from network APIs
- Push notifications
- User profile management
- Admin dashboard for managing bundles
