# Health Interviews — Firestore Live Final

Static (no build). Deploy on Vercel:

- Framework Preset: Other
- Build Command: (leave empty)
- Output Directory: (leave empty)

## Firebase
- Uses **Firebase Auth** + **Cloud Firestore** (real‑time).
- Firebase config is inside `app.js` (object `FIREBASE_CONFIG`).
- Firestore rules are in `firestore.rules`.

## Daily limit guard (to prevent freezing)
- **Hard limit (fixed in code): 50,000**
- **Warning/lock adds (fixed in code): 48,000**
  - عند 48,000 يتم إيقاف: **إضافة مرشح جديد + إضافة مستخدم جديد**
  - عند 50,000 يتم قفل النظام مؤقتًا تلقائيًا
  - يظهر **بنر مع عدّاد وقت** حتى العودة (حسب نهاية اليوم)



## Vercel Firebase Config (Recommended)

Add these Environment Variables in Vercel (Project → Settings → Environment Variables):

- FIREBASE_API_KEY
- FIREBASE_AUTH_DOMAIN
- FIREBASE_PROJECT_ID
- FIREBASE_STORAGE_BUCKET
- FIREBASE_MESSAGING_SENDER_ID
- FIREBASE_APP_ID
- FIREBASE_MEASUREMENT_ID (optional)

Then redeploy. The app loads config from `/api/firebase-config`.

## Firestore Rules

Use `firestore.rules` in Firebase Console → Firestore Database → Rules.
