const mongoose = require('mongoose');

/**
 * An uploaded payment file and everything that happened to it.
 *
 * Supersedes BulkJob: a batch is the durable record of a file — its rows, the
 * intents created from it, and any automated payment run — so it can be managed
 * and, if the upload was wrong, deleted along with every intent it produced.
 */
const rowResultSchema = new mongoose.Schema(
    {
        line: Number,
        ok: Boolean,
        ota_id: String,
        reservation_id: String,
        payment_intent_id: String,
        merchant_order_id: String,
        error: String,
    },
    { _id: false }
);

const batchSchema = new mongoose.Schema(
    {
        file_name: { type: String, required: true },
        file_size: Number,

        status: {
            type: String,
            enum: ['creating', 'ready', 'paying', 'completed', 'failed'],
            default: 'creating',
            index: true,
        },

        // Intent creation
        total_rows: { type: Number, default: 0 },
        processed: { type: Number, default: 0 },
        succeeded: { type: Number, default: 0 },
        failed: { type: Number, default: 0 },
        hotels_created: { type: Number, default: 0 },
        results: { type: [rowResultSchema], default: [] },

        /**
         * Progress of the automated payment run. Separate from creation: a
         * batch is created once but can be paid across several attempts, with
         * failed rows retried.
         */
        pay_run: {
            status: {
                type: String,
                enum: ['idle', 'running', 'completed', 'failed', 'cancelled'],
                default: 'idle',
            },
            headless: { type: Boolean, default: true },
            total: { type: Number, default: 0 },
            processed: { type: Number, default: 0 },
            succeeded: { type: Number, default: 0 },
            failed: { type: Number, default: 0 },
            current: String,
            error: String,
            started_at: Date,
            finished_at: Date,
        },

        error: String,
        created_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
        started_at: Date,
        finished_at: Date,
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

batchSchema.index({ created_at: -1 });

module.exports = mongoose.model('Batch', batchSchema);
