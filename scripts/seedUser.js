/**
 * Seed (or reset) a single active user.
 *
 *   npm run seed:user
 *   node scripts/seedUser.js someone@example.com 'Password123$' First Last
 *
 * Re-running is safe: an existing account is reactivated and its password reset.
 */
require('dotenv').config();

const { connectDatabase, disconnectDatabase } = require('../services/database');
const User = require('../models/User');

const DEFAULTS = {
    email: 'abrar@rebelforce.tech',
    password: 'Ritmay2010$',
    first_name: 'Abrar',
    last_name: 'Rebelforce',
};

async function main() {
    const [email, password, first_name, last_name] = process.argv.slice(2);
    const spec = {
        email: (email || DEFAULTS.email).toLowerCase(),
        password: password || DEFAULTS.password,
        first_name: first_name || DEFAULTS.first_name,
        last_name: last_name || DEFAULTS.last_name,
    };

    await connectDatabase();

    let user = await User.findOne({ email: spec.email });
    if (user) {
        user.first_name = spec.first_name;
        user.last_name = spec.last_name;
        user.password = spec.password;
        user.status = 'active';
        user.invite_token = undefined;
        user.invite_expires_at = undefined;
        await user.save();
        console.log(`Updated existing user ${user.email} (${user._id})`);
    } else {
        user = await User.create({ ...spec, status: 'active' });
        console.log(`Created user ${user.email} (${user._id})`);
    }

    await disconnectDatabase();
}

main().catch(async (err) => {
    console.error(err);
    await disconnectDatabase().catch(() => {});
    process.exit(1);
});
