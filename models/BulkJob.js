const mongoose = require('mongoose');

/**
 * Progress record for a long-running bulk operation.
 *
 * Bulk payment creation makes one Airwallex API call per row, so a 200-row file
 * takes far longer than a request should stay open. The work runs in the
 * background and the browser polls this record instead.
 */
const rowResultSchema = new mongoose.Schema(
    {
        line: Number,
        ok: Boolean,
        expedia_id: String,
        reference: String,
        payment_intent_id: String,
        merchant_order_id: String,
        checkout_url: String,
        error: String,
    },
    { _id: false }
);

const bulkJobSchema = new mongoose.Schema(
    {
        type: {
            type: String,
            enum: ['payments_create'],
            required: true,
        },
        status: {
            type: String,
            enum: ['queued', 'running', 'completed', 'failed'],
            default: 'queued',
            index: true,
        },
        total: { type: Number, default: 0 },
        processed: { type: Number, default: 0 },
        succeeded: { type: Number, default: 0 },
        failed: { type: Number, default: 0 },
        /** Properties auto-created from the file before the intents were made. */
        hotels_created: { type: Number, default: 0 },
        results: { type: [rowResultSchema], default: [] },
        error: String,
        created_by: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            index: true,
        },
        started_at: Date,
        finished_at: Date,
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

bulkJobSchema.index({ created_at: -1 });

module.exports = mongoose.model('BulkJob', bulkJobSchema);
