# VNP &lt;&gt; AIRWALLEX

Integration app scaffold. Structure, look-and-feel, authentication and user
management are ported from `vnp-qp-consolidation/` (kept in-tree as reference).

## Run

```bash
npm install
npm run seed:user     # creates/resets the test user
npm run dev           # or: npm start
```

Runs on <http://localhost:3001> (port 3001 so it doesn't clash with the
reference app on 3000). API docs: <http://localhost:3001/api/docs>

Test user: `abrar@rebelforce.tech` / `Ritmay2010$`

`npm run seed:user` is idempotent — re-running reactivates the account and
resets the password. Override the defaults with args:

```bash
node scripts/seedUser.js someone@example.com 'Password123$' First Last
```

## Layout

```
server.js              express app — static /public + /api routes
controllers/           request handling (auth, users, payments, hotels)
routes/                route definitions
services/              business logic (auth, users, email, database,
                       airwallex, payments, hotels, csv)
middleware/            requireAuth JWT guard
models/                mongoose schemas (User, Payment, Hotel, BulkJob)
docs/openapi.js        swagger spec served at /api/docs
scripts/seedUser.js    seed/reset a user
public/                static frontend
  login/ otp/ forgot-password/ accept-invite/   auth screens
  dashboard/ users/ payments/ hotels/            app screens
  checkout/ payment-result/                     shopper-facing checkout screens
  assets/                                       shared sidebar, shell, table +
                                                column-filter CSS/JS
```

## Auth flow

Two-step: `POST /api/auth/login` (email + password) emails a 6-digit OTP →
`POST /api/auth/verify` (email + OTP) returns a JWT. The frontend stashes the
token in `localStorage` (Remember me) or `sessionStorage`, and every page
guards on it before rendering.

Password reset is the same shape: request code → verify code → reset with a
short-lived reset token. Invited users get an emailed link to
`/accept-invite?token=…` where they set their own password.

## Hotels

Properties live in their own collection so the statement descriptor stops being
retyped per payment. Each hotel has a **Portfolio**, **Hotel Name**,
**Expedia ID**, **Descriptor** and **Website**.

The Expedia ID is the natural key: it is what operators use to reference a hotel
in every bulk file. It is stored as a string so leading zeros survive a
spreadsheet round trip.

Hotels are **archived, never deleted** — historical payments keep pointing at
them. Taking a payment against an archived hotel is refused.

### Descriptor precedence

When a payment is created the statement descriptor is resolved in this order:

1. an explicit `descriptor` on the request (bypasses everything)
2. the selected hotel's `descriptor`, **used verbatim**
3. `AIRWALLEX_DESCRIPTOR_PREFIX` as a fallback

The payment **reference is not mixed into the descriptor**. It travels to
Airwallex on its own field. Appending it ate the 32-character budget and
truncated the hotel name mid-word (`GRAND RIVERSIDE HTL*grandriversi`), which
defeated the point of a recognisable merchant name.

The payment dialog previews the exact string live, and the same builder runs on
both sides so the preview cannot drift from what is sent.

### Website auto-fills the payment reference

Selecting a hotel drops its website into the payment reference, which means the
domain lands on the cardholder's statement beside the descriptor — a
recognisable site is the cheapest way to cut "I don't recognise this charge"
chargebacks.

Websites are normalised to a bare lowercase host on save
(`https://www.Grand-Riverside.com/` → `grandriverside.com`), so two operators
typing the same site produce the same reference, and no characters are wasted on
a scheme that will not fit in 32.

The fill is non-destructive: it only writes when the reference is empty or still
holds the value we put there. A reference the operator typed is never
overwritten, and clearing the hotel removes an auto-filled reference but leaves a
hand-typed one alone. Bulk creation does the same — a blank `Reference` column
falls back to the hotel's website.

### Hotel snapshot on payments

A payment stores `hotel` (the reference) *and* a snapshot of
`hotel_expedia_id` / `hotel_name` / `hotel_portfolio`. Renaming a hotel or
re-pointing its descriptor must never rewrite what a historical statement line
actually said. The snapshot is also what the payments table filters on.

## Bulk operations

Every bulk flow has a downloadable CSV template (Templates menu on the hotels
page, and the link inside each bulk dialog). Templates ship with a header row
plus one example row, and a UTF-8 BOM so Excel opens non-ASCII names correctly.

| Flow | Endpoint | Keyed on |
| --- | --- | --- |
| Import hotels | `POST /api/hotels/bulk/import` | Expedia ID (must not exist, unless `upsert=true`) |
| Update hotels | `POST /api/hotels/bulk/update` | Expedia ID (must exist) |
| Create payments | `POST /api/payments/bulk/create` | OTA ID (auto-created when missing) |

`GET /api/hotels/export` dumps the current list in the **update** template's
shape, so the round trip is: export → edit in Excel → bulk update.

### All-or-nothing

Hotel import and update validate every row first and write nothing unless the
whole file is clean, answering `422` with a per-line error list. A
half-imported portfolio is worse than a rejected file, because the operator
cannot tell which rows landed without diffing by hand.

Guards worth knowing: duplicate Expedia IDs *inside* one file are caught (they
would otherwise silently collapse into a single record), unknown Expedia IDs on
update are rejected rather than matching nothing, and on update a **blank cell
means "leave this alone"**, not "clear it".

### The bulk payment file

Columns mirror the operator's own booking export, so a file can be pasted in
with no rework:

```
OTA ID, Portfolio, Property Name, Descriptor, Website,
Reservation ID, Hotel Confirmation Code, Guest Name,
Check In, Check Out, Currency, Amount to Charge
```

`OTA ID` is the hotel key (`Expedia ID` and `Hotel ID` are accepted aliases).
The hotel columns ride alongside each payment because the same export is the
source of truth for both.

A bulk row behaves exactly like the form: the hotel's **descriptor** becomes the
statement descriptor, and the hotel's **website** becomes the reference. The
`Reservation ID` becomes the **description** — the internal handle for finding a
transaction later. `Guest Name` becomes the customer.

| Column | Lands as |
| --- | --- |
| `Descriptor` (via the hotel) | payment descriptor |
| `Website` (via the hotel) | payment reference |
| `Reservation ID` | payment description |
| `Guest Name` | customer name |
| `Hotel Confirmation Code`, `Check In`, `Check Out` | intent metadata |

An explicit `Reference` or `Description` column overrides its default, mirroring
the form's "auto-filled unless the operator typed something" rule. Excel writes
dates as serial numbers when a sheet is saved straight to CSV, so `Check In` /
`Check Out` accept either that or a formatted date.

**Card columns are never read.** A booking export carries raw PANs, expiry dates
and CVVs. Storing a CVV is prohibited outright by PCI DSS and holding PANs would
drag this service into a compliance scope it is nowhere near, so `Card Number`,
`Expiry date` and `CVV` are ignored — the validator lists them back so it is
never assumed those cards were charged. Card data reaches Airwallex only from
the shopper's browser, through their iframe.

### Re-uploading a file is safe

The **reservation id is the Airwallex `request_id`** — the idempotency key — so
the same booking cannot be charged twice.

Airwallex's guard is strict: a reused `request_id` returns `duplicate_request`
and it does **not** replay the original intent. Relying on that alone would turn
a re-upload into a wall of opaque API errors, so the reservation ids in a file
are looked up locally first. Rows already created are reported as
`duplicates` — skipped, not errors — with the intent id and status of the
existing payment. A file where every row already exists is refused with a `409`
rather than a job that does nothing.

The lookup matches on **description as well as `request_id`**: rows created
before the reservation id became the key carry a uuid there, and would otherwise
go unrecognised and be created a second time.

Two rows sharing a reservation id inside one file is an error — that is
ambiguous, not idempotent. `request_id` is unique in Mongo too, so a concurrent
double-submit cannot slip past the pre-check.

`POST /api/payments` accepts an explicit `request_id` for the same reason; a
repeat returns `409 A payment already exists for reference … — nothing was
charged again`.

**One consequence worth knowing:** a reservation can only ever be charged once.
A second, genuinely separate charge against the same booking (incidentals, an
extended stay) needs a distinct reference — suffix it, e.g. `2497667019-2`.

### Hotels are auto-created from the file

A row whose `OTA ID` we do not hold creates the property from its `Portfolio`,
`Property Name`, `Descriptor` and `Website` columns. The same property repeated
across many bookings is created once, and re-running a file creates nothing new
because the write is an upsert keyed on OTA ID.

The dry run lists exactly which properties *would* be created before anything
commits, and the job reports `hotels_created`. Untick "create missing hotels"
(or pass `auto_create_hotels=false`) to have unknown OTA IDs rejected instead —
useful when a typo'd id would otherwise quietly create a junk property.

Creation happens up front, before any intent: the same property repeats across
rows, and a half-created set would leave payments orphaned from their hotel.

### Bulk payment creation runs as a job

Each row is one Airwallex API call, so a few hundred rows outlive any sensible
HTTP timeout. The flow is:

1. `POST /api/payments/bulk/validate` — dry run. Resolves every hotel, checks
   every amount and currency, and returns the totals plus a preview of the
   descriptors that *would* be used. Creates nothing.
2. `POST /api/payments/bulk/create` — re-validates, then returns `202` with a
   `BulkJob` id and creates the intents in the background.
3. `GET /api/payments/bulk/jobs/:id` — poll for progress and per-row results.

Rows are created **sequentially on purpose**: Airwallex rate-limits, and a burst
of parallel creates risks throttling that would fail rows for no good reason.
Progress is persisted after every row, so a crash leaves an accurate partial
record rather than a silent gap.

Jobs run in-process, so a deploy or crash abandons anything mid-flight.
`failStaleBulkJobs()` runs at startup and marks those `failed`, otherwise a
browser would poll forever against a job nothing is advancing. **This is the
main thing to revisit before heavy production use** — a real queue (BullMQ,
SQS) would survive restarts and let jobs run across multiple instances.

### File formats

Every bulk endpoint accepts **`.xlsx` or `.csv`**, and both are parsed into the
same `{ headers, rows }` shape, so nothing downstream knows which arrived.
Templates are issued as CSV, which Excel opens natively.

`services/tabular.js` dispatches on the file's **magic bytes**, not its
`Content-Type` or extension — browsers report spreadsheet MIME types
inconsistently across platforms, and a mislabelled file should still be read
correctly rather than parsed as CSV into nonsense rows. A legacy `.xls` (an OLE2
compound file) is detected and refused with a message telling the operator to
re-save it.

Both parsers are **dependency-free, on purpose**. The npm-published `xlsx` is
frozen at 0.18.5 and carries a prototype-pollution advisory (CVE-2023-30533);
the maintained releases moved off npm entirely. Rather than pull a parser with
known holes into a service that handles money:

- `services/csv.js` — RFC 4180: quoted fields, embedded commas and newlines,
  escaped quotes, CRLF, BOM.
- `services/xlsx.js` — reads the ZIP central directory, inflates only the parts
  it needs, and pulls values from the first worksheet. Handles shared strings,
  inline strings, cached formula results and Excel's date serials. Size-capped
  so a zip bomb cannot exhaust memory.

`xlsx.js` is deliberately narrow: **first worksheet, values only**, no styles or
formula evaluation. It is validated against the real booking export — parsing
the workbook and the same sheet saved as CSV yields byte-identical rows. Every
row still passes through the dry run before anything commits, so a misread would
surface as a visible amount or descriptor rather than a silent charge. If a file
ever defeats it, saving as CSV is the fallback.

## Payments (Airwallex)

Card payments go through Airwallex Payment Intents, always via the **embedded
drop-in element** on our own `/checkout` page. Card data goes straight to
Airwallex from their iframe, so it never touches our servers.

Airwallex's Hosted Payment Page was removed — `checkout_mode` survives on the
`Payment` model (and the `hosted_page` enum value with it) purely so historical
records stay valid and the detail view can still report what a past payment
used. Nothing new is created with it.

### Flow

1. `POST /api/payments` mints a Payment Intent server-side (client credentials
   never reach the browser) and writes a local `Payment` record.
2. The response carries a short-lived `client_secret`. It is **never persisted** —
   it is passed to `/checkout` via `sessionStorage` so it stays out of the URL,
   browser history and referer headers.
3. The shopper pays and lands on `/payment-result`, which confirms the outcome
   against Airwallex rather than trusting the redirect URL.
4. Webhooks (and the manual **Sync** button) keep `status` and `captured_amount`
   in step with Airwallex.

### Paying an existing intent

Payments awaiting payment carry a **Pay** button in the table (and a "Take
payment" button in the detail view) that re-opens the embedded checkout for that
intent — useful for a bulk-created batch, where the intents exist before anyone
has paid them.

Since the `client_secret` is never stored, `POST /api/payments/:id/checkout`
mints a fresh one by retrieving the intent from Airwallex; each call returns a
different, short-lived secret. That retrieve doubles as a status check, so a
payment completed or cancelled elsewhere is refused with a `409` instead of
being presented for a second charge.

Only `REQUIRES_PAYMENT_METHOD` and `REQUIRES_CUSTOMER_ACTION` are payable.
`PENDING` is deliberately excluded — that payment is already in flight, and
re-presenting checkout invites a double charge. The payable list is mirrored in
`payments.js` and asserted to match the server's.

### Dynamic statement descriptor

Airwallex caps `descriptor` at 32 characters and rejects anything longer. The
descriptor is built as `PREFIX*REFERENCE`, with the reference trimmed to fit:

```
reference "BK-10482"                     -> VNP*BK-10482
reference "BOOKING-ABCDEFGHIJKLMNOPQR…"  -> VNP*BOOKING-ABCDEFGHIJKLMNOPQRST  (32)
no reference                             -> VNP
```

`AIRWALLEX_DESCRIPTOR_PREFIX` sets the default prefix; `descriptor_prefix`
overrides it per payment, and an explicit `descriptor` bypasses the builder
entirely. The dialog previews the exact string with a live character count, and
`buildDescriptor()` is mirrored on both sides so the preview cannot drift from
what is sent.

### Payment history

Every intent is mirrored in the `payments` collection with an append-only event
timeline recording whether each change came from a `webhook`, a manual `sync` or
a `local` action. This is what makes the history durable: Airwallex only lets you
query Payment Intents for two years, and the local record outlives that.

### Global filters

The payments table has the same Excel-style column filters as the QP utility's
dataset page: click the funnel on any column header to filter and sort.

| Kind | Columns | UI |
| --- | --- | --- |
| `enum` | Status, Currency, Portfolio | Searchable checkbox list of distinct values |
| `text` | Order, Hotel, Reference, Description, Descriptor | Checkbox list, or contains/starts/ends |
| `number` | Amount | =, ≠, >, ≥, <, ≤, between |
| `date` | Created | After / before, end-date inclusive |

They are **global**, not per-page: conditions go to `POST /api/payments/query`
and are applied in Mongo, so they match across the entire history and the
row count, totals and pagination all reflect the filtered set. A footer sums the
matching amount per currency, and active filters show as removable chips above
the table. The status tabs write into the same filter state as the Status column
popover, so the two can never disagree.

Filterable fields are an explicit allow-list (`FILTERABLE_FIELDS` in
`services/paymentService.js`); anything else in a request is ignored rather than
passed to Mongo.

The popover itself lives in `public/assets/table-filters.js` +
`filter-popover.css`, extracted from the QP dataset page so any future table can
reuse it:

```js
const filters = TableFilters.init({
    theadRow, popoverEl, columns: COLUMNS,
    fetchDistinct: (field, search) => api(`/api/payments/distinct/${field}?...`),
    onChange: () => reload(),
});
```

### Dashboard charts

Same ApexCharts setup as the QP dashboard — period tabs (all / year / month /
week) driving four stat cards and three charts, fed by
`GET /api/payments/analytics`:

- **Daily payment volume** — stacked area of amount per day, split by outcome.
  Only statuses that actually occur in the period get a series, and the legend
  toggles them.
- **Payments by portfolio** — donut, which portfolios payments were taken for.
- **Payment status** — donut of where every intent ended up.

### Webhooks

Point an Airwallex notification URL at `POST /api/payments/webhook` and put its
signing secret in `AIRWALLEX_WEBHOOK_SECRET`. Requests are authenticated by
HMAC-SHA256 over `x-timestamp + raw request body`; unsigned or tampered payloads
get a 401 and are never applied. Duplicate deliveries are ignored by event id,
and events for intents we do not own are acknowledged rather than errored.

`server.js` keeps the raw body via `express.json({ verify })` — a re-serialised
object will not reproduce the HMAC, so do not remove that.

Airwallex cannot reach `localhost`. To test webhooks locally, tunnel the port
(`ngrok http 3001`, `cloudflared tunnel`) and register that public URL. The same
applies to `successUrl` / `cancelUrl`, which Airwallex expects to be HTTPS — set
`APP_BASE_URL` to the tunnel URL when testing the full redirect flow.

### Drop-in element events — a trap

The payments drop-in signals through **bubbling DOM `CustomEvent`s** on its mount
node (`onReady`, `onSuccess`, `onError`, `onCancel`), not through the
`element.on('ready', …)` API shown in the components-SDK docs.

`element.on()` does exist on the returned element, so calling it throws nothing —
it registers the callback into an internal emitter that never fires for this
element. The form renders normally and every handler is silently dead: the
loading overlay never clears and a completed payment never navigates away. The
shopper then pays a second time and hits
`invalid_status_for_operation: The PaymentIntent status SUCCEEDED is invalid for
operation confirm`, after already being charged.

Listen on `document` instead (the events bubble with `composed: true`):

```js
document.addEventListener('onSuccess', (e) => { /* e.detail = { intent, consent } */ });
document.addEventListener('onError',   (e) => { /* e.detail = { error } */ });
```

`checkout.js` also treats a confirm error as inconclusive: it asks
`/api/payments/status/:orderId` — which re-reads the intent from Airwallex — and
redirects to the success page if the payment in fact went through. Never tell a
shopper a payment failed on the drop-in's word alone.

### Not included

Captures of held funds (`autoCapture: false`), refunds, and recurring payments /
saved cards are all supported by the same API but are not wired up here.

## Extending this

Follow the existing seam — a service under `services/`, a controller under
`controllers/`, a router under `routes/` mounted in `server.js`, a page under
`public/` and a nav entry in `public/assets/sidebar.js`. List pages should link
`/assets/table.css`, which carries the shared table, pill, modal and pagination
styling.

## Environment

`.env` is git-ignored; `.env.example` lists the required keys. `DATABASE_URI`
points at a separate `vnp-airwallex` database on the same cluster as the
reference app.

| Key | Purpose |
| --- | --- |
| `AIRWALLEX_CLIENT_ID` / `AIRWALLEX_API_KEY` | API credentials from the Airwallex dashboard |
| `AIRWALLEX_BASE_URL` | `https://api-demo.airwallex.com` or `https://api.sandbox.airwallex.com` for test, `https://api.airwallex.com` for live |
| `AIRWALLEX_ENV` | `demo` or `prod` — which environment the browser SDK talks to. Derived from the base URL when unset |
| `AIRWALLEX_DESCRIPTOR_PREFIX` | Default statement-descriptor prefix |
| `AIRWALLEX_WEBHOOK_SECRET` | Signing secret for the notification URL. Webhooks are rejected until this is set |
