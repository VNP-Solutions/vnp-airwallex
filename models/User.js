const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 12;

const userSchema = new mongoose.Schema(
    {
        email: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            lowercase: true,
            match: [/^\S+@\S+\.\S+$/, 'Invalid email format'],
        },
        first_name: {
            type: String,
            required: true,
            trim: true,
        },
        last_name: {
            type: String,
            required: true,
            trim: true,
        },
        password: {
            type: String,
            // Pending invited users don't have a password until they accept;
            // every other state must have one.
            required: function requirePassword() {
                return this.status !== 'pending';
            },
            select: false,
        },
        status: {
            type: String,
            enum: ['active', 'pending', 'revoked'],
            default: 'active',
            index: true,
        },
        invited_by: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        invite_token: {
            type: String,
            select: false,
            index: true,
        },
        invite_expires_at: {
            type: Date,
            select: false,
        },
        invite_accepted_at: {
            type: Date,
        },
        otp_hash: {
            type: String,
            select: false,
        },
        otp_expires_at: {
            type: Date,
            select: false,
        },
        reset_otp_hash: {
            type: String,
            select: false,
        },
        reset_otp_expires_at: {
            type: Date,
            select: false,
        },
    },
    { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

userSchema.pre('save', async function hashPasswordOnSave() {
    if (!this.isModified('password')) return;
    this.password = await bcrypt.hash(this.password, BCRYPT_ROUNDS);
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
    return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toJSON = function toJSON() {
    const obj = this.toObject({ versionKey: false });
    delete obj.password;
    delete obj.otp_hash;
    delete obj.otp_expires_at;
    delete obj.reset_otp_hash;
    delete obj.reset_otp_expires_at;
    delete obj.invite_token;
    delete obj.invite_expires_at;
    return obj;
};

module.exports = mongoose.model('User', userSchema);