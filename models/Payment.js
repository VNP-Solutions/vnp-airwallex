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
        merchant_order_id: { type: String, required: true, unique: true },

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

        /** Set when the row came from a bulk file, for traceability. */
        bulk_job: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'BulkJob',
            index: true,
        },

        customer: {
            name: String,
            email: String,
            phone: String,
        },

        payment_method_type: String,
        card_brand: String,
        card_last4: String,

        metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

        last_error: {
            code: String,
            message: String,
            occurred_at: Date,
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
