# Web Password Reset

This folder contains the web-based password reset functionality for Mystiwan E-Business.

## Files

- **reset-password.html** - Universal password reset page that works for both mobile and desktop users
- **styles.css** - Styling for the password reset page

## Features

✅ **Universal Design** - Works on both mobile and desktop browsers  
✅ **Mobile App Integration** - Offers option to open in mobile app (if installed)  
✅ **Secure** - Uses Supabase authentication tokens  
✅ **Responsive** - Beautiful UI on all screen sizes  
✅ **User-Friendly** - Clear instructions and error messages

## Setup

See the main documentation file: `../WEB_PASSWORD_RESET_SETUP.md`

## Deployment

This folder needs to be hosted on a publicly accessible URL:

- **GitHub Pages** (recommended for free hosting)
- **Vercel**
- **Netlify**
- **Cloudflare Pages**
- Any static hosting service

## Usage

Users will be redirected to `reset-password.html` when they click the password reset link in their email.

The page automatically:

1. Extracts the reset tokens from the URL
2. Verifies the tokens with Supabase
3. Shows appropriate options (mobile app or web form)
4. Handles the password update
5. Redirects back to the app or shows success message

## Customization

You can customize:

- Colors in `styles.css` (CSS variables)
- Logo image path in `reset-password.html`
- Success/error messages
- Redirect behavior after successful reset

See `WEB_PASSWORD_RESET_SETUP.md` for detailed customization instructions.
