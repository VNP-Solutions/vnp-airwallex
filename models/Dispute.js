const mongoose = require('mongoose');

/**
 * A dispute raised against one of our payments, mirrored locally.
 *
 * Airwallex is the authority on a dispute's state, but a copy here is what lets
 * the team work them without logging in there: it carries the hotel and the
 * reservation alongside the case, which Airwallex knows nothing about, and it
 * survives their two-year retention window.
 */
const disputeSchema = new mongoose.Schema(
    {
        /** Airwallex's dispute id, e.g. dst_sgpvqr98hhndtshvxyd. */
        dispute_id: { type: String, required: true, unique: true, index: true },

        // ---- the charge it was raised against ----
        payment_intent_id: { type: String, index: true },
        payment_attempt_id: String,
        merchant_order_id: { type: String, index: true },
        /** Our own payment record, when we hold one. */
        payment: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', index: true },

        // ---- denormalised so the table can show and filter it without a join ----
        hotel: { type: mongoose.Schema.Types.ObjectId, ref: 'Hotel', index: true },
        hotel_name: String,
        hotel_expedia_id: { type: String, index: true },
        hotel_portfolio: { type: String, index: true },
        /** The reservation id, as carried on the payment's description. */
        reservation_id: { type: String, index: true },
        batch_name: { type: String, index: true },

        // ---- the dispute itself ----
        amount: Number,
        currency: String,
        /** RFI, PRE_CHARGEBACK, CHARGEBACK, PRE_ARBITRATION, ARBITRATION. */
        stage: { type: String, index: true },
        /**
         * REQUIRES_RESPONSE, CHALLENGED, ACCEPTED, REVERSED, WON, LOST,
         * PENDING_CLOSURE, EXPIRED, PENDING_DECISION.
         */
        status: { type: String, index: true },
        mode: String,
        transaction_type: String,
        payment_method_type: String,
        card_brand: String,
        customer_name: String,
        acquirer_reference_number: String,

        reason: {
            type: { type: String, index: true },
            original_code: String,
            description: String,
        },

        /** When a response is due. The thing the team actually works from. */
        due_at: { type: Date, index: true },
        dispute_created_at: { type: Date, index: true },
        dispute_updated_at: Date,

        issuer_comment: String,
        issuer_documents: [mongoose.Schema.Types.Mixed],
        accept_details: [mongoose.Schema.Types.Mixed],
        challenge_details: [mongoose.Schema.Types.Mixed],
        refunds: [mongoose.Schema.Types.Mixed],
        ai_dispute_automation: mongoose.Schema.Types.Mixed,
        metadata: mongoose.Schema.Types.Mixed,

        /** The untouched payload, so nothing Airwallex sends is lost. */
        raw: mongoose.Schema.Types.Mixed,

        /**
         * Evidence we have uploaded for this dispute: the file_id Airwallex
         * returned, plus enough to show it in a list afterwards.
         */
        evidence_files: [
            {
                file_id: String,
                filename: String,
                size: Number,
                content_type: String,
                /** Which evidence slot it was cited under on the challenge. */
                category: String,
                uploaded_at: { type: Date, default: Date.now },
                uploaded_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
            },
        ],

        /** What we sent and what came back, for the same reason payments keep one. */
        api_log: [mongoose.Schema.Types.Mixed],

        last_synced_at: Date,
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// The list is worked by what is due soonest.
disputeSchema.index({ status: 1, due_at: 1 });

module.exports = mongoose.models.Dispute || mongoose.model('Dispute', disputeSchema);
