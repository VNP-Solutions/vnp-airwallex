const mongoose = require('mongoose');

/**
 * A hotel property. Its `descriptor` is what appears on the cardholder's
 * statement for payments taken against it, which is the whole point of holding
 * these centrally — the descriptor stops being retyped per payment.
 */
const hotelSchema = new mongoose.Schema(
    {
        portfolio: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
        },
        /**
         * Expedia's property id. Kept as a string: ids can carry leading zeros
         * and must survive a round trip through a spreadsheet unchanged. This
         * is the natural key operators use to reference a hotel in bulk files.
         */
        expedia_id: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            index: true,
        },
        descriptor: {
            type: String,
            required: true,
            trim: true,
            maxlength: [32, 'Descriptor must be 32 characters or fewer'],
        },
        /**
         * The property's public website. Auto-fills the payment reference, so it
         * lands on the cardholder's statement next to the descriptor — a
         * recognisable domain is the cheapest way to cut "I don't recognise this
         * charge" chargebacks.
         */
        website: {
            type: String,
            trim: true,
        },
        status: {
            type: String,
            enum: ['active', 'archived'],
            default: 'active',
            index: true,
        },
        created_by: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        updated_by: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

hotelSchema.index({ created_at: -1 });
// Backs the type-ahead in the payment dialog.
hotelSchema.index({ name: 1 });

module.exports = mongoose.model('Hotel', hotelSchema);
