require('dotenv').config();

const express = require('express');
const path = require('path');
const swaggerUi = require('swagger-ui-express');

const { connectDatabase } = require('./services/database');
const userRoutes = require('./routes/userRoutes');
const authRoutes = require('./routes/authRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const hotelRoutes = require('./routes/hotelRoutes');
const financeRoutes = require('./routes/financeRoutes');
const batchRoutes = require('./routes/batchRoutes');
const openapiSpec = require('./docs/openapi');
const { failStaleBatches } = require('./services/paymentService');
const { failStaleRuns } = require('./services/paymentRunner');
const airwallex = require('./services/airwallexService');

const app = express();
const PORT = process.env.PORT || 3000;

// Keep the untouched request bytes around: Airwallex signs the raw webhook
// body, and a re-serialised object will not reproduce their HMAC.
app.use(
    express.json({
        verify: (req, res, buf) => {
            req.rawBody = buf;
        },
    })
);
app.use(express.static(path.join(__dirname, 'public')));

// API Documentation
app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openapiSpec, {
        customSiteTitle: 'VNP <> AIRWALLEX API Docs',
    })
);
app.get('/api/docs.json', (req, res) => res.json(openapiSpec));

app.use('/api/users', userRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/hotels', hotelRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/batches', batchRoutes);

app.use((err, req, res, next) => {
    console.error(err);
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || 'Internal server error' });
});

async function start() {
    try {
        await connectDatabase();

        // Bulk jobs run in-process, so anything left mid-flight by the previous
        // process is dead. Fail it now rather than letting a poller wait forever.
        await failStaleBatches();
        await failStaleRuns();

        // Say out loud which Airwallex account this process is wired to. Two
        // incidents have come from a process quietly holding the wrong one.
        const cfg = airwallex.describeMode();
        const banner = cfg.mode === 'live' ? 'LIVE' : 'SANDBOX';
        console.log(
            `Airwallex: ${banner}  ${cfg.base_url}  client ${cfg.client_id_hint}…  sdk=${cfg.sdk_env}` +
                (cfg.explicit ? '' : '  (inferred — set AIRWALLEX_MODE to be explicit)')
        );
        if (cfg.mode === 'live') {
            console.log('  ** LIVE MODE — payments created here charge real cards **');
        }

        app.listen(PORT, () => {
            console.log(`Server running at http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

start();
