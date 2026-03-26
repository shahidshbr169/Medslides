# MedSlides — AGENTS.md
# Full-stack PPT marketplace at medslides.in
# Optimized for Antigravity IDE with Claude Opus Agent

---

## PROJECT OVERVIEW

Build "MedSlides" — a platform where medical students browse, preview,
and purchase PowerPoint presentations. Hosted at medslides.in.

**Live Domain:** https://medslides.in
**Backend:** Deploy on Render (free tier)
**Goal:** Users can preview a few slides, pay via Razorpay, then download the full PPT.

---

## TECH STACK

| Layer       | Tool                              |
|-------------|-----------------------------------|
| Frontend    | Vanilla HTML + CSS + JS           |
| Backend     | Node.js + Express                 |
| Database    | Supabase (PostgreSQL)             |
| Auth        | Supabase Auth (email/password)    |
| Storage     | Supabase Storage (2 buckets)      |
| Payments    | Razorpay                          |
| Hosting FE  | InfinityFree (medslides.in)       |
| Hosting BE  | Render (free tier)                |

---

## AGENT RULES — READ BEFORE EVERY TASK

1. **Never expose `ppt_path` or signed URLs in public API responses**
2. **Always verify Razorpay HMAC signature server-side before recording purchase**
3. **Always check purchase exists in DB before generating any download URL**
4. **Signed URLs must expire in 120 seconds maximum**
5. **Supabase SERVICE KEY only in backend `.env` — never in frontend**
6. **Supabase ANON KEY is safe for frontend JS**
7. **All secrets go in `.env` — never hardcoded**
8. **CORS must allow only `https://medslides.in` and `http://localhost` in production**
9. **Generate all files completely — no placeholders or TODOs**
10. **After each task, list what was built and what the next agent task should be**

---

## PROJECT STRUCTURE

```
medslides/
├── backend/
│   ├── index.js
│   ├── routes/
│   │   ├── products.js
│   │   ├── payment.js
│   │   ├── download.js
│   │   └── admin.js
│   ├── middleware/
│   │   └── verifyUser.js
│   ├── .env.example
│   └── package.json
│
└── frontend/
    ├── index.html
    ├── product.html
    ├── login.html
    ├── register.html
    ├── dashboard.html
    ├── admin.html
    ├── css/
    │   └── style.css
    └── js/
        ├── config.js
        ├── auth.js
        ├── main.js
        ├── product.js
        ├── payment.js
        └── admin.js
```

---

## DESIGN SYSTEM

```css
/* Use these CSS variables everywhere */
--color-bg:        #0B1F3A;   /* deep navy */
--color-surface:   #112240;   /* card background */
--color-accent:    #00BFA6;   /* teal accent */
--color-text:      #E8EEF4;   /* primary text */
--color-muted:     #8899AA;   /* secondary text */
--color-border:    #1E3A5F;   /* borders */
--color-danger:    #FF5A5F;   /* errors */
--font-main:       'DM Sans', sans-serif;
--font-display:    'Playfair Display', serif;
--radius:          12px;
--shadow:          0 4px 24px rgba(0,0,0,0.3);
```

**Google Fonts to import:**
```html
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet">
```

**UI Rules:**
- Dark navy background throughout
- Cards with subtle border and hover lift effect
- Teal accent for all CTAs and highlights
- Mobile-first, fully responsive
- Smooth transitions (0.2s ease) on all interactive elements
- Subject badges as small colored pills

---

## SUPABASE SCHEMA

Run this SQL in the Supabase SQL Editor:

```sql
-- Products table
create table products (
  id uuid default gen_random_uuid() primary key,
  title text not null,
  description text,
  price integer not null,
  subject text,
  total_slides integer,
  ppt_path text not null,
  preview_paths text[] not null,
  thumbnail text,
  created_at timestamptz default now()
);

-- Purchases table
create table purchases (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  product_id uuid references products(id) not null,
  razorpay_order_id text,
  razorpay_payment_id text,
  amount integer,
  purchased_at timestamptz default now()
);

-- Enable RLS
alter table products enable row level security;
alter table purchases enable row level security;

-- Policies
create policy "Anyone can view products"
  on products for select using (true);

create policy "Users can view own purchases"
  on purchases for select using (auth.uid() = user_id);

create policy "Backend can insert purchases"
  on purchases for insert with check (true);
```

**Storage Buckets (create in Supabase dashboard):**
- `previews` → Public bucket
- `ppts` → Private bucket (no public access ever)

---

## ENVIRONMENT VARIABLES

**backend/.env.example:**
```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key
RAZORPAY_KEY_ID=rzp_live_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=your_razorpay_secret
ADMIN_PASSWORD=choose_strong_password_here
PORT=3000
FRONTEND_URL=https://medslides.in
```

**frontend/js/config.js:**
```js
// SAFE to expose — these are public keys
const CONFIG = {
  SUPABASE_URL: "https://your-project.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-key",
  API_BASE: "https://your-render-app.onrender.com"
};
```

---

## BACKEND IMPLEMENTATION

### package.json
```json
{
  "name": "medslides-backend",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": { "start": "node index.js", "dev": "nodemon index.js" },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "razorpay": "^2.9.2",
    "multer": "^1.4.5-lts.1",
    "@supabase/supabase-js": "^2.39.0"
  }
}
```

### index.js
- Express app
- CORS for `FRONTEND_URL` and `http://localhost`
- `express.json()` middleware
- Mount: `/api/products`, `/api/payment`, `/api/download`, `/api/admin`
- `GET /` → `{ status: "ok", service: "MedSlides API" }`

### middleware/verifyUser.js
- Extract `Bearer token` from `Authorization` header
- Verify with `supabaseAdmin.auth.getUser(token)`
- Attach `req.user` → return 401 if invalid

### routes/products.js
```
GET /api/products
  → Return all products
  → Fields: id, title, description, price, subject, total_slides, thumbnail, preview_paths
  → NEVER return ppt_path

GET /api/products/:id
  → Return single product (same fields, no ppt_path)
```

### routes/payment.js
```
POST /api/payment/create-order
  Body: { productId, userId }
  1. Verify product exists in Supabase
  2. Check user hasn't already purchased
  3. Create Razorpay order: { amount, currency: "INR", receipt: uuid }
  4. Return: { orderId, amount, currency, keyId }

POST /api/payment/verify
  Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, productId, userId }
  1. Verify HMAC SHA256:
     const body = razorpay_order_id + "|" + razorpay_payment_id
     const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
                            .update(body).digest('hex')
     if (expected !== razorpay_signature) return 400
  2. Insert into purchases table
  3. Return: { success: true }
```

### routes/download.js
```
POST /api/download
  Headers: Authorization: Bearer <supabase_jwt>
  Body: { productId }
  1. Verify JWT → get user (use verifyUser middleware)
  2. Query purchases: does user_id + product_id row exist?
  3. If not → return 403 { error: "Purchase not found" }
  4. Get ppt_path from products table
  5. Generate signed URL (120s expiry):
     supabaseAdmin.storage.from('ppts').createSignedUrl(ppt_path, 120)
  6. Return: { signedUrl }

GET /api/download/check/:productId
  Headers: Authorization: Bearer <supabase_jwt>
  1. Verify JWT
  2. Check if purchase exists for user + product
  3. Return: { purchased: true/false }
```

### routes/admin.js
```
Middleware: check req.headers.authorization === process.env.ADMIN_PASSWORD

POST /api/admin/product
  Multipart form fields:
    title, description, price, subject, total_slides
    pptFile (single .pptx file)
    previewImages (up to 5 image files)
  1. Generate uuid for this product
  2. Upload pptFile → 'ppts' bucket at: products/{uuid}/{originalname}
  3. Upload each preview → 'previews' bucket at: previews/{uuid}/{index}.jpg
  4. Insert product row with all paths
  5. Return: { success: true, productId }

DELETE /api/admin/product/:id
  1. Get product row to find file paths
  2. Delete ppt from 'ppts' bucket
  3. Delete previews from 'previews' bucket
  4. Delete product row
  5. Return: { success: true }

GET /api/admin/products
  → Return all products including ppt_path (admin only)
```

---

## FRONTEND IMPLEMENTATION

### frontend/js/auth.js
```js
// Initialize Supabase client using CONFIG
// Functions to export:
// - getSession() → returns current session or null
// - getUser() → returns current user or null  
// - logout() → signs out and redirects to login.html
// - getAuthHeader() → returns { Authorization: "Bearer <token>" }
// On every page: update navbar based on auth state
// Protect dashboard.html → redirect to login if not authed
```

### frontend/index.html (Homepage)
**Sections:**
1. Navbar: Logo left, nav links right (Home, Login, Register, Dashboard)
   - If logged in: show user email + Logout instead of Login/Register
2. Hero: Big headline using Playfair Display font, subheadline, CTA button
3. Subject filter bar: All | Anatomy | Physiology | Pharmacology | Pathology | Biochemistry | Microbiology
4. Product grid: fetch `GET /api/products`, render cards
   - Card: thumbnail image, subject badge (colored by subject), title, slide count, price in ₹, "Preview & Buy" button
   - Filter buttons filter cards client-side by subject
5. Footer: © 2025 MedSlides.in | All rights reserved

### frontend/product.html (Product Detail Page)
**Flow:**
1. Read `?id=` from URL params
2. Fetch `GET /api/products/:id`
3. Show: title, subject badge, description, total slides, price
4. Preview strip: horizontal scrollable row of preview images
   - Label: "Free Preview — First X Slides"
5. Locked card: blurred placeholder image + lock icon + "🔒 X more slides — Purchase to unlock"
6. "Buy Now — ₹XXX" button
7. On Buy Now:
   - If not logged in → redirect to `login.html?redirect=product.html?id=PRODUCT_ID`
   - If logged in → call `POST /api/payment/create-order`
   - Open Razorpay modal
   - On payment success → call `POST /api/payment/verify`
   - On verified → hide Buy button, show Download button
8. On page load if logged in → call `GET /api/download/check/:id`
   - If purchased → show Download button directly
9. Download button → `POST /api/download` → open signedUrl in new tab

### frontend/login.html
- Email + password form
- `supabase.auth.signInWithPassword({ email, password })`
- On success: redirect to `dashboard.html` or to `redirect` param if present
- Error messages shown inline
- Link to register.html

### frontend/register.html
- Full name, email, password, confirm password
- `supabase.auth.signUp({ email, password })`
- On success: show "Please check your email to confirm your account"
- Link to login.html

### frontend/dashboard.html
- Redirect to login if not authenticated
- Header: "My Purchases"
- Fetch purchases:
  `supabase.from('purchases').select('*, products(id, title, thumbnail, subject, total_slides)').eq('user_id', user.id)`
- Render purchased PPT cards with Download button
- Download button → `POST /api/download` → open signed URL

### frontend/admin.html
- On load: `prompt("Enter admin password")` → store in memory
- If wrong/empty → show "Access Denied" and hide the form
- Upload form: Title, Description, Price (₹), Subject (dropdown), Total Slides, PPT file input, Preview images (multiple, max 5), Submit button
- Products list: fetch `GET /api/admin/products`, show each with title + Delete button
- All requests include `Authorization: <admin_password>` header

---

## RAZORPAY CHECKOUT INTEGRATION

Include in product.html:
```html
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
```

Razorpay options object:
```js
const options = {
  key: keyId,
  amount: amount,
  currency: "INR",
  name: "MedSlides",
  description: productTitle,
  image: "https://medslides.in/favicon.ico",
  order_id: orderId,
  prefill: { email: user.email },
  theme: { color: "#00BFA6" },
  modal: { ondismiss: () => { /* re-enable buy button */ } },
  handler: function(response) {
    verifyPayment(response.razorpay_payment_id, response.razorpay_order_id, response.razorpay_signature)
  }
};
const rzp = new Razorpay(options);
rzp.open();
```

---

## AGENT TASKS — EXECUTE IN THIS ORDER

### TASK 1 — Project Scaffold
Create the full directory structure. Create all empty files.
Create `backend/package.json`, `backend/.env.example`, `frontend/js/config.js`.
Install all npm dependencies.
**Done when:** All files exist, `npm install` succeeds.

### TASK 2 — Backend Core
Build `backend/index.js` and `backend/middleware/verifyUser.js`.
Initialize Supabase admin client, set up Express with CORS and JSON middleware.
Mount all route files (even if empty).
Add health check route.
**Done when:** `node index.js` runs without errors.

### TASK 3 — Products API
Build `backend/routes/products.js` fully.
Test: `GET /api/products` returns empty array (no DB yet).
**Done when:** Products routes respond correctly.

### TASK 4 — Payment API
Build `backend/routes/payment.js` fully.
Implement both `/create-order` and `/verify` with HMAC validation.
**Done when:** Both endpoints exist with correct logic.

### TASK 5 — Download API
Build `backend/routes/download.js` fully.
Implement purchase check and Supabase signed URL generation.
**Done when:** Download and check endpoints complete.

### TASK 6 — Admin API
Build `backend/routes/admin.js` fully with multer for file uploads.
**Done when:** Upload and delete product endpoints work.

### TASK 7 — Frontend CSS & Config
Build `frontend/css/style.css` with full design system (CSS variables, base styles, navbar, cards, buttons, forms, responsive grid).
Build `frontend/js/config.js` and `frontend/js/auth.js`.
**Done when:** CSS is complete and auth helper functions work.

### TASK 8 — Homepage
Build `frontend/index.html` and `frontend/js/main.js` fully.
Fetch and render product cards, subject filtering works.
**Done when:** Homepage renders product grid with working filter.

### TASK 9 — Product Page
Build `frontend/product.html` and `frontend/js/product.js`.
Preview images display, Razorpay checkout works, download unlocks after payment.
**Done when:** Full buy-to-download flow works end to end.

### TASK 10 — Auth Pages
Build `frontend/login.html` and `frontend/register.html`.
Supabase auth flow works, redirects work correctly.
**Done when:** User can register, confirm email, and log in.

### TASK 11 — Dashboard
Build `frontend/dashboard.html`.
Shows all purchases, download works from dashboard.
**Done when:** Logged-in user sees and can download their purchases.

### TASK 12 — Admin Panel
Build `frontend/admin.html` and `frontend/js/admin.js`.
Password protection, product upload with files, product delete.
**Done when:** Admin can upload a PPT with previews and delete it.

### TASK 13 — Final Polish
- Add loading spinners on all async actions
- Add error toast notifications
- Add empty states ("No products yet", "No purchases yet")
- Make sure all pages are mobile responsive
- Add `<meta>` tags for SEO on all pages
- Add favicon
**Done when:** App feels complete and production-ready.

---

## DEPLOYMENT CHECKLIST

After all tasks complete:

**Supabase:**
- [ ] Run SQL schema in SQL Editor
- [ ] Create `previews` bucket (public)
- [ ] Create `ppts` bucket (private)
- [ ] Copy Project URL and Service Role Key

**Render:**
- [ ] Push backend to GitHub
- [ ] Create new Web Service on Render pointing to `/backend`
- [ ] Add all `.env` variables in Render dashboard
- [ ] Copy live Render URL (e.g. `https://medslides-api.onrender.com`)

**Frontend:**
- [ ] Update `CONFIG.API_BASE` in `config.js` with Render URL
- [ ] Update `CONFIG.SUPABASE_URL` and `CONFIG.SUPABASE_ANON_KEY`
- [ ] Upload all files in `/frontend` to InfinityFree `htdocs/` folder

**Razorpay:**
- [ ] Complete KYC on Razorpay dashboard
- [ ] Switch from test keys to live keys in `.env`

---

## NOTES FOR AGENT

- InfinityFree only serves static files — ALL dynamic logic is in the Express backend on Render
- Render free tier sleeps after inactivity — first request may take ~30s (cold start)
- Supabase free tier pauses after 1 week of inactivity — log in to Supabase dashboard weekly
- Price is stored in **paise** (1 INR = 100 paise) — ₹199 = `19900`
- Always use `crypto` (built-in Node.js) for HMAC — do not use external crypto libraries
- Multer stores files in memory (`memoryStorage`) before uploading to Supabase — do not write to disk
