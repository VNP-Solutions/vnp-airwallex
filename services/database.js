const mongoose = require('mongoose');

async function connectDatabase() {
    const uri = process.env.DATABASE_URI;
    if (!uri) {
        throw new Error('DATABASE_URI is not set');
    }

    await mongoose.connect(uri);
    console.log('MongoDB connected');

    mongoose.connection.on('error', (err) => {
        console.error('MongoDB connection error:', err);
    });

    mongoose.connection.on('disconnected', () => {
        console.warn('MongoDB disconnected');
    });
}

async function disconnectDatabase() {
    await mongoose.disconnect();
}

module.exports = { connectDatabase, disconnectDatabase };