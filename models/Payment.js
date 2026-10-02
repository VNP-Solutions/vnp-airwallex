const mongoose = require('mongoose');

/**
 * Local mirror of an Airwallex Payment Intent.
 *
 * Airwallex is the source of truth for `status` / `captured_amount`; this
 * record exists so we keep a durable payment history of our own that
 * survives the 2-year Payment Intent retention window, and so the history
 * page can be queried/filtered without hitting their API.
 */
const eventSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        status: String,
        source: {
            type: String,
            enum: ['webhook', 'sync', 'local'],
            default: 'local',
        },
        occurred_at: { type: Date, default: Date.now },
        event_id: String,
    },
    { _id: false }
);

const paymentSchema = new mongoose.Schema(
    {
        payment_intent_id: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        /**
         * Idempotency key sent to Airwallex — the reservation id for bulk rows,
         * a uuid otherwise. Unique so a concurrent double-submit cannot slip
         * two intents past the pre-check.
         */
        request_id: { type: String, required: true, unique: true },

        /**
         * Unguessable handle used in the shopper's return URL and by the
         * unauthenticated status endpoint.
         *
         * Kept separate from merchant_order_id on purpose: that id is now
         * operator-chosen and therefore predictable (ORD-1001, ORD-1002…).
         * Using it as the public key would let anyone walk the sequence and
         * read every payment's amount, hotel and outcome.
         */
        public_token: {
            type: String,
            required: true,
            unique: true,
            index: true,
            default: () => require('crypto').randomBytes(16).toString('base64url'),
        },
        /**
         * Our own order reference — the reservation id, in practice.
         *
         * Indexed but deliberately NOT unique: a booking that failed is tried
         * again under the same order id, because it is the same booking. What
         * stops a second charge is the application rule (only a settled payment
         * reserves an id) plus request_id, which is unique and is the
         * idempotency key Airwallex itself enforces.
         */
        merchant_order_id: { type: String, required: true, index: true },

        amount: { type: Number, required: true, min: 0 },
        currency: { type: String, required: true, uppercase: true },
        captured_amount: { type: Number, default: 0 },

        // Dynamic statement descriptor sent to Airwallex (max 32 chars).
        descriptor: { type: String, maxlength: 32 },

        status: {
            type: String,
            default: 'REQUIRES_PAYMENT_METHOD',
            index: true,
        },

        checkout_mode: {
            type: String,
            // 'hosted_page' is retained only so historical records stay valid —
            // every new payment uses the embedded drop-in.
            enum: ['hosted_page', 'embedded_elements'],
            default: 'embedded_elements',
        },

        reference: { type: String, trim: true },
        description: { type: String, trim: true },

        /**
         * The property this payment was taken for.
         *
         * The reference is kept alongside a snapshot of the fields that
         * identify the hotel at the time of payment. Renaming a hotel or
         * re-pointing its descriptor later must not rewrite what a historical
         * statement line actually said.
         */
        hotel: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Hotel',
            index: true,
        },
        hotel_expedia_id: { type: String, trim: true, index: true },
        hotel_name: { type: String, trim: true },
        hotel_portfolio: { type: String, trim: true, index: true },

        /** The uploaded file this payment came from. */
        batch: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Batch',
            index: true,
        },

        /**
         * The batch's file name, denormalised.
         *
         * The payments table filters on it: an ObjectId is unreadable in a
         * filter list, and a batch's name never changes after upload.
         */
        batch_name: { type: String, index: true },

        /**
         * Virtual-card credentials used to pay this reservation, encrypted at
         * rest (AES-256-GCM, see services/cardVault.js).
         *
         * These are the operator's own virtual cards, not a shopper's, and are
         * stored under the operator's PCI sign-off. Only last4 and brand are
         * held in clear — enough to identify a card in the UI without exposing
         * it. Nothing here is ever logged or returned by the list endpoints.
         */
        card: {
            pan: { type: String, select: false },
            expiry: { type: String, select: false },
            cvv: { type: String, select: false },
            last4: String,
            brand: String,
            cardholder_name: String,
            /** Cleared once the payment succeeds — see clearCardData(). */
            purged_at: Date,
        },

        /** Name on the card and on the Airwallex customer record. */
        customer_label: String,

        customer: {
            name: String,
            email: String,
            phone: String,
        },

        payment_method_type: String,
        card_brand: String,
        card_last4: String,

        /**
         * Outcome of the most recent attempt.
         *
         * A decline does NOT move the intent to FAILED — Airwallex leaves it at
         * REQUIRES_PAYMENT_METHOD so the shopper can retry, and records the
         * failure on latest_payment_attempt instead. Without mirroring that, a
         * declined payment is indistinguishable from one nobody has tried yet.
         */
        last_attempt_status: { type: String, index: true },
        last_attempt_id: String,
        attempt_count: { type: Number, default: 0 },

        metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

        last_error: {
            code: String,
            message: String,
            occurred_at: Date,
        },

        /**
         * Recent exchanges with Airwallex, for debugging. Capped and redacted —
         * see recordExchange() in airwallexService. Never contains card data:
         * a PAN only ever travels from the shopper's browser to Airwallex.
         */
        api_log: {
            type: [
                new mongoose.Schema(
                    {
                        at: { type: Date, default: Date.now },
                        method: String,
                        path: String,
                        status: Number,
                        duration_ms: Number,
                        request: mongoose.Schema.Types.Mixed,
                        response: mongoose.Schema.Types.Mixed,
                        error: String,
                    },
                    { _id: false }
                ),
            ],
            default: [],
        },

        events: { type: [eventSchema], default: [] },

        created_by: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            index: true,
        },

        // Mirrors of the Airwallex timestamps, distinct from our own.
        intent_created_at: Date,
        intent_updated_at: Date,
        last_synced_at: Date,
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

paymentSchema.index({ created_at: -1 });
paymentSchema.index({ reference: 1 });

// Statuses that will never change again — sync/webhooks can stop chasing them.
const TERMINAL_STATUSES = ['SUCCEEDED', 'CANCELLED', 'EXPIRED', 'FAILED'];

paymentSchema.methods.isTerminal = function isTerminal() {
    return TERMINAL_STATUSES.includes(this.status);
};

paymentSchema.statics.TERMINAL_STATUSES = TERMINAL_STATUSES;

module.exports = mongoose.model('Payment', paymentSchema);
