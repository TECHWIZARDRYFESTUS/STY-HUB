# Stationary Hub

A runnable full-stack starter for a stationery, document-processing, printing and T-shirt business.

## Included working modules
- Responsive operator dashboard with navigation for daily workflows
- Separate `/login`, `/register` and `/dashboard` pages
- Customer registration and visit tracking
- Secure sign-in and separate administrator, staff and customer workspaces
- Admin-managed staff accounts and per-role API permissions
- Customer print-file requests, T-shirt quote approval, document uploads and private history
- Staff print-job queue with step-by-step production statuses and T-shirt quoting/production workflow
- Customer-visible job timelines with staff-written progress updates for print, document and T-shirt jobs
- Plain-text document editor with a paper-like workspace, editing controls and Word (.docx) export
- Optional WhatsApp completion messages, sent only with explicit customer consent
- Loyalty discounts based on completed visits
- Service catalogue and configurable prices
- Multi-line quotations, order totals and printable receipts
- Cash, mobile-money, card and bank-transfer payment recording (manual bookkeeping only)
- Product inventory and stock movements
- Shop machine register for administrators and staff
- Low-stock indicators and inventory alerts
- Expense recording and daily/monthly cash summaries
- Document upload and editable job workflow
- Document text extraction for TXT and DOCX; PDF extraction when `pypdf` is installed
- AI assignment drafting and coaching through OpenAI (requires an API key)
- T-shirt order, quote, production status and design download workflow
- Dashboard, order register and activity log
- SQLite database and audit log

## Requirements
- Python 3.13.15 for the Render deployment (local development supports Python 3.11+)
- Optional: OpenAI API key for AI-assisted editing
- Dependencies are listed in `requirements.txt`

## Run locally (Windows PowerShell)
```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```
Open http://127.0.0.1:8000/login. Customer registration is at `/register`; after signing in, the dashboard is at `/dashboard`.

The app creates `printbiz.db` automatically and seeds example services/products on first run. On a fresh local database, it also creates this starter administrator:

- Email: `admin@smartprint.local`
- Password: `Admin123!ChangeMe`

This starter account is created only when using the default local database, secure cookies are disabled, and no administrator exists. It does not change existing accounts or apply to deployment databases. The password is a public local-development default; do not use it on a public deployment.

Set a long, random `SESSION_SECRET` in `.env` before using persistent sessions. `SESSION_COOKIE_SECURE=false` is for local HTTP only; set it to `true` behind HTTPS. Admins can create staff accounts. Customers can self-register from the sign-in page.

To reset the administrator password or change the admin login email locally, activate the project's virtual environment and run:

```powershell
python -m app.reset_admin
```

New passwords are stored as bcrypt hashes; existing PBKDF2 hashes remain supported so existing accounts can still sign in. Use passwords of at least 12 characters and no more than 72 UTF-8 bytes.

On Render, run the same command in the service Shell after the reset command has been deployed. Enter the current admin email and new password twice; password input is hidden. To change the login email too, run `python -m app.reset_admin --new-email new-address@example.com`. Passwords remain one-way hashed and must never be committed or sent in chat.

If the Render plan does not include Shell access, use the one-time web recovery instead:

1. Deploy the latest application code.
2. Generate a private token locally with `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
3. In the Render service's **Environment** settings, add `ADMIN_RESET_TOKEN` with that token and wait for the service to redeploy.
4. Open `https://<your-service>.onrender.com/admin-recovery` and enter the token, current admin email, and a new password. The new email is optional.
5. After success, remove `ADMIN_RESET_TOKEN` from Render's Environment settings. The token can only be used once; its fingerprint is recorded in the database.

The recovery page and endpoint are disabled unless a token of at least 32 bytes is configured. Do not share the token or password. If this deployed service has no existing administrator account, this recovery flow cannot create one.

Administrators can update service unit prices in **Services & pricing**, and product cost/selling prices in **Inventory**. T-shirt prices are quoted per customer order.
Administrators can add shop machines in **Machines**; staff can view the register. Staff and administrators can post customer-visible progress notes from the print, document and T-shirt job lists.

## Optional AI setup
Set `OPENAI_API_KEY` privately in `.env` for local development or in the Render service Environment settings. The Render Blueprint prompts for this secret and uses `OPENAI_MODEL` (`gpt-4.1-mini` by default). Never commit the key or put it in frontend JavaScript.

The Document Studio supports creating an assignment draft from a customer brief and coaching/revising text in the editor. When you request an AI action, the relevant brief and document text are sent to the configured OpenAI service. AI actions replace and save the current editor text automatically; after Undo, click **Save changes** to persist the restored version. A configured key is required. Without one, the app clearly reports that AI is unavailable rather than returning a fake demo result. Always verify facts and citations and follow the course's AI-use policy; the assistant does not invent references.

## Optional WhatsApp completion messages

The app always records completion in the customer's portal. To also send a WhatsApp message:

1. Set up a Meta WhatsApp Business Cloud API phone number and create/approve a **utility** message template named `printbiz_job_completed` in the configured language.
2. The template body must include three text placeholders in this order: customer name (`{{1}}`), job type (`{{2}}`), and job number (`{{3}}`). For example: `Hi {{1}}, your {{2}} job #{{3}} is complete and ready for collection. Thank you for choosing us.`
3. Configure `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, and `WHATSAPP_API_VERSION` in the deployment environment. The API version must be a currently supported Meta Graph API version. Optionally set `WHATSAPP_TEMPLATE_NAME` and `WHATSAPP_TEMPLATE_LANGUAGE` if your approved template uses different values.
4. Customers must explicitly opt in to WhatsApp updates during registration (or when staff creates their customer profile), and their phone number must use international `+` format.

On Render, set the three credentials/version variables in the service's Environment settings; the Blueprint intentionally does not store secrets. A missing configuration, missing consent, or failed delivery does not block job completion: the customer still sees the in-app update, and staff/admins can inspect the delivery result in the job timeline and activity log. Never commit or share the access token.

## Deploy to Render

The project is prepared as a Render Blueprint in `render.yaml`. Before deploying:

1. Push the project to a GitHub repository. Keep `.env`, the local database, and uploaded files out of Git; `.gitignore` excludes them.
2. In Render, select **New → Blueprint**, connect the repository, and apply the `stationary-hub` service from `render.yaml`.
3. The Blueprint pins Python to the tested version in `.python-version`, runs `pip install -r requirements.txt`, starts Uvicorn on Render's `$PORT`, and checks `/api/health`.
4. The service uses a Starter web plan and a persistent disk mounted at `/var/data`. SQLite and uploaded files are stored there. Keep this service to one instance; multiple instances must not share this SQLite database.
5. In the Render service's **Environment** settings, add `OPENAI_API_KEY` if you want live AI. Add the WhatsApp Cloud API variables only if you have the Meta phone number, approved template, and customer consent configured. Secrets are not stored in the Blueprint or repository. The app starts without optional integrations, but those features will report unavailable until configured.
6. During Blueprint setup, provide `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` in Render's private Environment prompts. The app creates the admin only when the database has no administrator; the password is stored as a hash. The password must be at least 12 characters and no more than 72 UTF-8 bytes. These values are not stored in the repository. You can enter the same credentials as local, but the local default password is public in the source and is unsafe for an internet-facing service; use a unique private password instead.
7. After the first deploy succeeds, open your Render service URL followed by `/login` and sign in with the credentials you entered in Render. Then remove `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` from Render's Environment settings; removing them will not change the stored account. If you prefer Shell setup, run `python -m app.create_admin` instead. Customers can register at `/register`; administrators can create staff accounts.

The Blueprint generates `SESSION_SECRET` and enables secure cookies for HTTPS. Configure backups for `/var/data`; persistent disks are not a substitute for backups. Check the service's `/api/health` endpoint after deploy and verify sign-in, customer registration, and a test job before using real customer data.

## Feature boundaries and production requirements
The current app includes role-checked admin, staff and customer panels, but is not yet a complete production platform. It does not yet include supplier or employee management, OCR for scanned files, document conversion, AI image generation, printer control, automated backup/restore, or tax configuration. Customer email/phone ownership is not verified. Monthly and daily cash summaries are not full profit-and-loss statements: cost of goods, tax and other overhead are not included.

Before using with real customer data or money, deploy behind HTTPS, configure backup/restore procedures, a privacy and retention policy, malware scanning for uploads, tested database migrations, automated tests, account verification and required integrations. Payment methods in the app are labels for manual payment recording; the app does not charge MTN/Airtel Money, cards or bank accounts.
