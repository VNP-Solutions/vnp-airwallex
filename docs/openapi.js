/**
 * OpenAPI 3.0 spec for the VNP <> Airwallex API.
 * Keep this in sync with the routes/controllers as new endpoints are added.
 */
module.exports = {
    openapi: '3.0.3',
    info: {
        title: 'VNP <> AIRWALLEX API',
        version: '0.1.0',
        description: 'API for the VNP <> Airwallex integration app.',
    },
    servers: [{ url: '/api', description: 'Current host' }],
    tags: [
        { name: 'Auth', description: 'Authentication endpoints' },
        { name: 'Users', description: 'User management endpoints' },
        { name: 'Payments', description: 'Airwallex payments and local payment history' },
        { name: 'Hotels', description: 'Properties, their statement descriptors, and bulk CSV import/update' },
    ],
    components: {
        securitySchemes: {
            bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'JWT',
            },
        },
        schemas: {
            User: {
                type: 'object',
                properties: {
                    _id: { type: 'string', example: '66501a3f5d2c8e0012abcd34' },
                    email: { type: 'string', format: 'email', example: 'jane@example.com' },
                    first_name: { type: 'string', example: 'Jane' },
                    last_name: { type: 'string', example: 'Doe' },
                    status: {
                        type: 'string',
                        enum: ['active', 'pending', 'revoked'],
                        example: 'active',
                    },
                    invited_by: { type: 'string', nullable: true },
                    invite_accepted_at: { type: 'string', format: 'date-time', nullable: true },
                    created_at: { type: 'string', format: 'date-time' },
                    updated_at: { type: 'string', format: 'date-time' },
                },
            },
            Payment: {
                type: 'object',
                description:
                    'Local mirror of an Airwallex Payment Intent. Airwallex owns status and captured_amount; everything else is ours.',
                properties: {
                    _id: { type: 'string' },
                    payment_intent_id: { type: 'string', example: 'int_sgpvlj8cshln5x35ae5' },
                    merchant_order_id: { type: 'string', example: 'vnp_1787577831000_a1b2c3d4' },
                    request_id: { type: 'string', format: 'uuid' },
                    amount: { type: 'number', example: 12.5 },
                    currency: { type: 'string', example: 'USD' },
                    captured_amount: { type: 'number', example: 0 },
                    descriptor: {
                        type: 'string',
                        maxLength: 32,
                        description: 'Dynamic statement descriptor shown on the card statement.',
                        example: 'VNP*BK-10482',
                    },
                    status: {
                        type: 'string',
                        enum: [
                            'REQUIRES_PAYMENT_METHOD',
                            'REQUIRES_CUSTOMER_ACTION',
                            'REQUIRES_CAPTURE',
                            'PENDING',
                            'SUCCEEDED',
                            'CANCELLED',
                            'EXPIRED',
                            'FAILED',
                        ],
                    },
                    checkout_mode: {
                        type: 'string',
                        enum: ['hosted_page', 'embedded_elements'],
                    },
                    reference: { type: 'string' },
                    description: { type: 'string' },
                    customer: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' },
                            email: { type: 'string', format: 'email' },
                            phone: { type: 'string' },
                        },
                    },
                    hotel: { type: 'string', description: 'Hotel id.' },
                    hotel_expedia_id: {
                        type: 'string',
                        description: 'Snapshot taken at payment time — renaming a hotel later never rewrites history.',
                    },
                    hotel_name: { type: 'string' },
                    hotel_portfolio: { type: 'string' },
                    bulk_job: { type: 'string', description: 'Set when the row came from a bulk file.' },
                    payment_method_type: { type: 'string', example: 'card' },
                    card_brand: { type: 'string', example: 'visa' },
                    card_last4: { type: 'string', example: '4242' },
                    events: {
                        type: 'array',
                        description: 'Local audit trail, newest last.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', example: 'payment_intent.succeeded' },
                                status: { type: 'string' },
                                source: { type: 'string', enum: ['webhook', 'sync', 'local'] },
                                occurred_at: { type: 'string', format: 'date-time' },
                                event_id: { type: 'string' },
                            },
                        },
                    },
                    last_synced_at: { type: 'string', format: 'date-time' },
                    created_at: { type: 'string', format: 'date-time' },
                    updated_at: { type: 'string', format: 'date-time' },
                },
            },
            Hotel: {
                type: 'object',
                properties: {
                    _id: { type: 'string' },
                    portfolio: { type: 'string', example: 'West Coast' },
                    name: { type: 'string', example: 'The Grand Riverside' },
                    expedia_id: {
                        type: 'string',
                        description: 'Natural key used to reference this hotel in bulk files. A string so leading zeros survive a spreadsheet round trip.',
                        example: '12345678',
                    },
                    descriptor: {
                        type: 'string',
                        maxLength: 32,
                        description: "Statement descriptor billed under this property. Becomes the prefix of each payment's descriptor.",
                        example: 'GRAND RIVERSIDE',
                    },
                    website: {
                        type: 'string',
                        description:
                            "Public website, normalised to a bare lowercase host (no scheme, no www., no trailing slash). Auto-fills the payment reference so it reaches the cardholder's statement.",
                        example: 'grandriverside.com',
                    },
                    status: { type: 'string', enum: ['active', 'archived'] },
                    created_at: { type: 'string', format: 'date-time' },
                    updated_at: { type: 'string', format: 'date-time' },
                },
            },
            BulkResult: {
                type: 'object',
                description:
                    'All-or-nothing outcome. When `applied` is false nothing was written and every problem row is listed.',
                properties: {
                    applied: { type: 'boolean' },
                    total: { type: 'integer' },
                    created: { type: 'integer' },
                    updated: { type: 'integer' },
                    matched: { type: 'integer' },
                    errors: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                line: { type: 'integer', description: 'Line number in the uploaded file.' },
                                error: { type: 'string' },
                            },
                        },
                    },
                },
            },
            BulkJob: {
                type: 'object',
                properties: {
                    _id: { type: 'string' },
                    type: { type: 'string', enum: ['payments_create'] },
                    status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed'] },
                    total: { type: 'integer' },
                    processed: { type: 'integer' },
                    succeeded: { type: 'integer' },
                    failed: { type: 'integer' },
                    error: { type: 'string' },
                    hotels_created: {
                        type: 'integer',
                        description: 'Properties auto-created from the file before the intents were made.',
                    },
                    results: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                line: { type: 'integer' },
                                ok: { type: 'boolean' },
                                expedia_id: { type: 'string' },
                                reference: { type: 'string' },
                                payment_intent_id: { type: 'string' },
                                merchant_order_id: { type: 'string' },
                                error: { type: 'string' },
                            },
                        },
                    },
                    created_at: { type: 'string', format: 'date-time' },
                    finished_at: { type: 'string', format: 'date-time' },
                },
            },
            CheckoutHandoff: {
                type: 'object',
                description:
                    'Everything the browser needs to open checkout. client_secret is short-lived and is never persisted server-side.',
                properties: {
                    intent_id: { type: 'string' },
                    client_secret: { type: 'string' },
                    currency: { type: 'string' },
                    amount: { type: 'number' },
                    env: { type: 'string', enum: ['demo', 'prod'] },
                    mode: { type: 'string', enum: ['hosted_page', 'embedded_elements'] },
                    successUrl: { type: 'string', format: 'uri' },
                    cancelUrl: { type: 'string', format: 'uri' },
                },
            },
            Error: {
                type: 'object',
                properties: { error: { type: 'string' } },
            },
        },
        responses: {
            Unauthorized: {
                description: 'Missing, invalid or expired token',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/Error' },
                    },
                },
            },
            BadRequest: {
                description: 'Validation error',
                content: {
                    'application/json': {
                        schema: { $ref: '#/components/schemas/Error' },
                    },
                },
            },
        },
    },
    paths: {
        '/auth/login': {
            post: {
                tags: ['Auth'],
                summary: 'Step 1 — email + password, emails a 6-digit OTP',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['email', 'password'],
                                properties: {
                                    email: { type: 'string', format: 'email' },
                                    password: { type: 'string', format: 'password' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'OTP sent',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        message: { type: 'string' },
                                        email: { type: 'string' },
                                        expires_at: { type: 'string', format: 'date-time' },
                                    },
                                },
                            },
                        },
                    },
                    400: { $ref: '#/components/responses/BadRequest' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/auth/verify': {
            post: {
                tags: ['Auth'],
                summary: 'Step 2 — verify the OTP and receive a JWT',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['email', 'otp'],
                                properties: {
                                    email: { type: 'string', format: 'email' },
                                    otp: { type: 'string', example: '048213' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Authenticated',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        userId: { type: 'string' },
                                        token: { type: 'string' },
                                        first_name: { type: 'string' },
                                        last_name: { type: 'string' },
                                        email: { type: 'string' },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/auth/forgot-password': {
            post: {
                tags: ['Auth'],
                summary: 'Request a password reset code',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['email'],
                                properties: { email: { type: 'string', format: 'email' } },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Reset code sent (if the account exists)' },
                    400: { $ref: '#/components/responses/BadRequest' },
                },
            },
        },
        '/auth/forgot-password/verify': {
            post: {
                tags: ['Auth'],
                summary: 'Verify a reset code and receive a short-lived reset token',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['email', 'otp'],
                                properties: {
                                    email: { type: 'string', format: 'email' },
                                    otp: { type: 'string' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Reset token issued',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: { reset_token: { type: 'string' } },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/auth/forgot-password/reset': {
            post: {
                tags: ['Auth'],
                summary: 'Set a new password using a reset token',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['reset_token', 'new_password'],
                                properties: {
                                    reset_token: { type: 'string' },
                                    new_password: { type: 'string', minLength: 8 },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Password updated' },
                    400: { $ref: '#/components/responses/BadRequest' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/payments': {
            get: {
                tags: ['Payments'],
                summary: 'List local payment history',
                security: [{ bearerAuth: [] }],
                parameters: [
                    {
                        name: 'q',
                        in: 'query',
                        description: 'Matches intent id, order id, reference, description, descriptor or customer.',
                        schema: { type: 'string' },
                    },
                    { name: 'status', in: 'query', schema: { type: 'string', example: 'SUCCEEDED' } },
                    {
                        name: 'checkout_mode',
                        in: 'query',
                        schema: { type: 'string', enum: ['hosted_page', 'embedded_elements'] },
                    },
                    { name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
                    { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 100 } },
                    { name: 'skip', in: 'query', schema: { type: 'integer', default: 0 } },
                ],
                responses: {
                    200: {
                        description: 'Paged payment history',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        items: { type: 'array', items: { $ref: '#/components/schemas/Payment' } },
                                        total: { type: 'integer' },
                                        limit: { type: 'integer' },
                                        skip: { type: 'integer' },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
            post: {
                tags: ['Payments'],
                summary: 'Create a Payment Intent and open checkout',
                description:
                    'Creates the intent at Airwallex, mirrors it locally, and returns everything the browser needs to launch either the Hosted Payment Page or the embedded drop-in element.',
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['amount', 'currency'],
                                properties: {
                                    amount: { type: 'number', example: 12.5 },
                                    currency: { type: 'string', example: 'USD' },
                                    reference: {
                                        type: 'string',
                                        description: 'Order reference; feeds the dynamic descriptor.',
                                        example: 'BK-10482',
                                    },
                                    description: { type: 'string', example: 'Hotel booking - 3 nights' },
                                    descriptor: {
                                        type: 'string',
                                        maxLength: 32,
                                        description:
                                            'Explicit statement descriptor. Omit to auto-build one from descriptor_prefix + reference.',
                                    },
                                    descriptor_prefix: {
                                        type: 'string',
                                        description: 'Overrides AIRWALLEX_DESCRIPTOR_PREFIX for this payment.',
                                    },
                                    hotel_id: {
                                        type: 'string',
                                        description: 'Select the hotel by id. Its descriptor becomes the statement descriptor prefix.',
                                    },
                                    expedia_id: {
                                        type: 'string',
                                        description: 'Alternative to hotel_id — select the hotel by its Expedia ID.',
                                    },
                                    checkout_mode: {
                                        type: 'string',
                                        enum: ['embedded_elements'],
                                        default: 'embedded_elements',
                                        description:
                                            'Always the embedded drop-in. hosted_page is retained on stored records for history only.',
                                    },
                                    customer: {
                                        type: 'object',
                                        properties: {
                                            name: { type: 'string' },
                                            email: { type: 'string', format: 'email' },
                                            phone: { type: 'string' },
                                        },
                                    },
                                    request_id: {
                                        type: 'string',
                                        maxLength: 64,
                                        description:
                                            'Idempotency key. Pass the reservation id to make the call safe to retry; omitted means a generated uuid. A reused key returns 409 and charges nothing.',
                                    },
                                    metadata: { type: 'object', additionalProperties: true },
                                },
                            },
                        },
                    },
                },
                responses: {
                    201: {
                        description: 'Intent created',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        payment: { $ref: '#/components/schemas/Payment' },
                                        checkout: { $ref: '#/components/schemas/CheckoutHandoff' },
                                    },
                                },
                            },
                        },
                    },
                    400: { $ref: '#/components/responses/BadRequest' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    409: { description: 'A payment already exists for this request_id — nothing charged' },
                    502: { description: 'Airwallex rejected or could not be reached' },
                },
            },
        },
        '/hotels': {
            get: {
                tags: ['Hotels'],
                summary: 'List hotels',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'q', in: 'query', schema: { type: 'string' } },
                    { name: 'limit', in: 'query', schema: { type: 'integer', default: 25, maximum: 200 } },
                    { name: 'skip', in: 'query', schema: { type: 'integer', default: 0 } },
                ],
                responses: {
                    200: {
                        description: 'Paged hotels',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        items: { type: 'array', items: { $ref: '#/components/schemas/Hotel' } },
                                        total: { type: 'integer' },
                                        limit: { type: 'integer' },
                                        skip: { type: 'integer' },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
            post: {
                tags: ['Hotels'],
                summary: 'Create a hotel',
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['portfolio', 'name', 'expedia_id', 'descriptor'],
                                properties: {
                                    portfolio: { type: 'string' },
                                    name: { type: 'string' },
                                    expedia_id: { type: 'string' },
                                    descriptor: { type: 'string', maxLength: 32 },
                                    website: { type: 'string', example: 'grandriverside.com' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    201: {
                        description: 'Created',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/Hotel' } } },
                    },
                    400: { $ref: '#/components/responses/BadRequest' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    409: { description: 'Expedia ID already in use' },
                },
            },
        },
        '/hotels/query': {
            post: {
                tags: ['Hotels'],
                summary: 'Filtered, sorted, paged hotels',
                description: 'Same global-filter contract as /payments/query.',
                security: [{ bearerAuth: [] }],
                requestBody: {
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    filters: { type: 'object', additionalProperties: true },
                                    sort: {
                                        type: 'object',
                                        properties: {
                                            key: { type: 'string' },
                                            dir: { type: 'string', enum: ['asc', 'desc'] },
                                        },
                                    },
                                    search: { type: 'string' },
                                    limit: { type: 'integer' },
                                    skip: { type: 'integer' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Matching hotels' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/hotels/search': {
            get: {
                tags: ['Hotels'],
                summary: 'Type-ahead for the hotel picker',
                description: 'Active hotels only unless include_archived is set.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'q', in: 'query', schema: { type: 'string' } },
                    { name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } },
                    { name: 'include_archived', in: 'query', schema: { type: 'boolean', default: false } },
                ],
                responses: {
                    200: {
                        description: 'Matching hotels',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        items: { type: 'array', items: { $ref: '#/components/schemas/Hotel' } },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/hotels/stats': {
            get: {
                tags: ['Hotels'],
                summary: 'Counts by status plus the number of portfolios',
                security: [{ bearerAuth: [] }],
                responses: {
                    200: { description: 'Totals' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/hotels/distinct/{field}': {
            get: {
                tags: ['Hotels'],
                summary: 'Distinct values for a filterable hotel field',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'field', in: 'path', required: true, schema: { type: 'string', example: 'portfolio' } },
                    { name: 'search', in: 'query', schema: { type: 'string' } },
                ],
                responses: {
                    200: { description: 'Distinct values' },
                    400: { description: 'Field is not filterable' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/hotels/templates/import': {
            get: {
                tags: ['Hotels'],
                summary: 'Download the bulk import CSV template',
                security: [{ bearerAuth: [] }],
                responses: {
                    200: {
                        description: 'CSV with headers Portfolio, Hotel Name, Expedia ID, Descriptor, Website plus one example row',
                        content: { 'text/csv': { schema: { type: 'string' } } },
                    },
                },
            },
        },
        '/hotels/templates/update': {
            get: {
                tags: ['Hotels'],
                summary: 'Download the bulk update CSV template',
                security: [{ bearerAuth: [] }],
                responses: {
                    200: {
                        description: 'CSV keyed on Expedia ID',
                        content: { 'text/csv': { schema: { type: 'string' } } },
                    },
                },
            },
        },
        '/hotels/export': {
            get: {
                tags: ['Hotels'],
                summary: 'Export hotels as CSV in the update template shape',
                description: 'Edit the export and feed it straight back into /hotels/bulk/update.',
                security: [{ bearerAuth: [] }],
                parameters: [{ name: 'q', in: 'query', schema: { type: 'string' } }],
                responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: { type: 'string' } } } } },
            },
        },
        '/hotels/bulk/import': {
            post: {
                tags: ['Hotels'],
                summary: 'Create hotels from a CSV',
                description:
                    'All-or-nothing: every row is validated first and nothing is written unless the whole file is clean. Set upsert=true to update rows whose Expedia ID already exists instead of reporting them as duplicates.',
                security: [{ bearerAuth: [] }],
                parameters: [{ name: 'upsert', in: 'query', schema: { type: 'boolean', default: false } }],
                requestBody: {
                    required: true,
                    description:
                        'The spreadsheet itself. .xlsx or .csv — the format is detected from the file\'s magic bytes, not the Content-Type.',
                    content: {
                        'text/csv': { schema: { type: 'string' } },
                        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
                            schema: { type: 'string', format: 'binary' },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Applied',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/BulkResult' } } },
                    },
                    422: {
                        description: 'Rejected — nothing written, every problem row listed',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/BulkResult' } } },
                    },
                    400: { $ref: '#/components/responses/BadRequest' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/hotels/bulk/update': {
            post: {
                tags: ['Hotels'],
                summary: 'Update hotels from a CSV, matched on Expedia ID',
                description:
                    'Only the columns present in the file are touched, so "Expedia ID,Descriptor" re-points descriptors and leaves names alone. A blank cell means "leave this alone", not "clear it". All-or-nothing, and every referenced Expedia ID must exist.',
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    description:
                        'The spreadsheet itself. .xlsx or .csv — the format is detected from the file\'s magic bytes, not the Content-Type.',
                    content: {
                        'text/csv': { schema: { type: 'string' } },
                        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
                            schema: { type: 'string', format: 'binary' },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Applied',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/BulkResult' } } },
                    },
                    422: {
                        description: 'Rejected — nothing written',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/BulkResult' } } },
                    },
                    400: { $ref: '#/components/responses/BadRequest' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/hotels/{id}': {
            get: {
                tags: ['Hotels'],
                summary: 'Get a hotel by id or Expedia ID',
                security: [{ bearerAuth: [] }],
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                responses: {
                    200: { description: 'The hotel', content: { 'application/json': { schema: { $ref: '#/components/schemas/Hotel' } } } },
                    404: { description: 'Not found' },
                },
            },
            patch: {
                tags: ['Hotels'],
                summary: 'Update a hotel',
                security: [{ bearerAuth: [] }],
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                requestBody: {
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    portfolio: { type: 'string' },
                                    name: { type: 'string' },
                                    expedia_id: { type: 'string' },
                                    descriptor: { type: 'string', maxLength: 32 },
                                    website: { type: 'string' },
                                    status: { type: 'string', enum: ['active', 'archived'] },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Updated' },
                    404: { description: 'Not found' },
                    409: { description: 'Expedia ID already in use' },
                },
            },
            delete: {
                tags: ['Hotels'],
                summary: 'Archive a hotel',
                description: 'Archived, never deleted — historical payments keep pointing at it.',
                security: [{ bearerAuth: [] }],
                parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
                responses: {
                    200: { description: 'Archived' },
                    404: { description: 'Not found' },
                },
            },
        },
        '/payments/bulk/template': {
            get: {
                tags: ['Payments'],
                summary: 'Download the bulk payment CSV template',
                security: [{ bearerAuth: [] }],
                responses: {
                    200: {
                        description:
                            'CSV mirroring the booking export: OTA ID, Portfolio, Property Name, Descriptor, Website, Reservation ID, Hotel Confirmation Code, Guest Name, Check In, Check Out, Currency, Amount to Charge.',
                        content: { 'text/csv': { schema: { type: 'string' } } },
                    },
                },
            },
        },
        '/payments/bulk/validate': {
            post: {
                tags: ['Payments'],
                summary: 'Dry-run a bulk payment file',
                description:
                    'Resolves every hotel and validates every row without creating anything. Returns the totals, a preview of the descriptors that would be used, the properties that would be auto-created, and any card columns that were ignored. Card Number / Expiry / CVV columns are never read or stored.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    {
                        name: 'auto_create_hotels',
                        in: 'query',
                        schema: { type: 'boolean', default: true },
                        description: 'Create properties the file references but we do not hold yet, from its Portfolio / Property Name / Descriptor / Website columns.',
                    },
                ],
                requestBody: {
                    required: true,
                    description: 'The spreadsheet itself — .xlsx or .csv.',
                    content: {
                        'text/csv': { schema: { type: 'string' } },
                        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
                            schema: { type: 'string', format: 'binary' },
                        },
                    },
                },
                responses: {
                    200: {
                        description:
                            'File is valid. `duplicates` lists rows already created on an earlier run — they are skipped, not errors.',
                    },
                    422: { description: 'File has problems — every bad row is listed' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/payments/bulk/create': {
            post: {
                tags: ['Payments'],
                summary: 'Create payment intents from a CSV',
                description:
                    'Validates the whole file first, then creates the intents in the background — one Airwallex call per row outlives any sensible request timeout. Returns a job to poll. Rows reference hotels by Expedia ID and bill under that hotel\'s descriptor.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    {
                        name: 'checkout_mode',
                        in: 'query',
                        schema: { type: 'string', enum: ['embedded_elements'], default: 'embedded_elements' },
                    },
                    {
                        name: 'auto_create_hotels',
                        in: 'query',
                        schema: { type: 'boolean', default: true },
                        description: 'Create missing properties from the file before the intents are made.',
                    },
                ],
                requestBody: {
                    required: true,
                    description: 'The spreadsheet itself — .xlsx or .csv.',
                    content: {
                        'text/csv': { schema: { type: 'string' } },
                        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
                            schema: { type: 'string', format: 'binary' },
                        },
                    },
                },
                responses: {
                    409: { description: 'Every row was already created on an earlier run' },
                    202: {
                        description: 'Job accepted',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/BulkJob' } } },
                    },
                    422: { description: 'File rejected — nothing created' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/payments/bulk/jobs': {
            get: {
                tags: ['Payments'],
                summary: 'Recent bulk creation jobs',
                security: [{ bearerAuth: [] }],
                parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 50 } }],
                responses: { 200: { description: 'Jobs' }, 401: { $ref: '#/components/responses/Unauthorized' } },
            },
        },
        '/payments/bulk/jobs/{jobId}': {
            get: {
                tags: ['Payments'],
                summary: 'Poll one bulk job for progress and per-row results',
                security: [{ bearerAuth: [] }],
                parameters: [{ name: 'jobId', in: 'path', required: true, schema: { type: 'string' } }],
                responses: {
                    200: {
                        description: 'Job state',
                        content: { 'application/json': { schema: { $ref: '#/components/schemas/BulkJob' } } },
                    },
                    404: { description: 'Not found' },
                },
            },
        },
        '/payments/query': {
            post: {
                tags: ['Payments'],
                summary: 'Filtered, sorted, paged payment history',
                description:
                    'Global filters: conditions are applied in Mongo so they span the whole history, not just the loaded page. Unknown fields are ignored rather than passed through.',
                security: [{ bearerAuth: [] }],
                requestBody: {
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    filters: {
                                        type: 'object',
                                        description:
                                            'Map of field -> condition. text/enum accept {op:in|contains|startswith|endswith|eq}; number accepts {op:eq|ne|gt|gte|lt|lte|between}; date accepts {after, before}.',
                                        example: {
                                            status: { op: 'in', value: ['SUCCEEDED'] },
                                            amount: { op: 'between', min: 10, max: 500 },
                                            created_at: { after: '2026-08-01' },
                                        },
                                    },
                                    sort: {
                                        type: 'object',
                                        properties: {
                                            key: { type: 'string', example: 'amount' },
                                            dir: { type: 'string', enum: ['asc', 'desc'] },
                                        },
                                    },
                                    search: { type: 'string' },
                                    limit: { type: 'integer', default: 25, maximum: 100 },
                                    skip: { type: 'integer', default: 0 },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'Matching payments plus totals for the whole filtered set',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        items: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/Payment' },
                                        },
                                        total: { type: 'integer' },
                                        limit: { type: 'integer' },
                                        skip: { type: 'integer' },
                                        totals: {
                                            type: 'array',
                                            description: 'Summed amounts per currency across every matching row.',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    currency: { type: 'string' },
                                                    amount: { type: 'number' },
                                                    captured: { type: 'number' },
                                                    count: { type: 'integer' },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/payments/distinct/{field}': {
            get: {
                tags: ['Payments'],
                summary: 'Distinct values for a filterable field',
                description:
                    'Populates the checkbox list in the column filter popover. Fields outside the filterable allow-list are rejected.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    {
                        name: 'field',
                        in: 'path',
                        required: true,
                        schema: { type: 'string', example: 'status' },
                    },
                    { name: 'search', in: 'query', schema: { type: 'string' } },
                    { name: 'limit', in: 'query', schema: { type: 'integer', default: 200, maximum: 500 } },
                ],
                responses: {
                    200: {
                        description: 'Distinct values',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        values: { type: 'array', items: { type: 'string' } },
                                        total: { type: 'integer' },
                                        shown: { type: 'integer' },
                                    },
                                },
                            },
                        },
                    },
                    400: { description: 'Field is not filterable' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/payments/analytics': {
            get: {
                tags: ['Payments'],
                summary: 'Chart data for the dashboard',
                security: [{ bearerAuth: [] }],
                parameters: [
                    {
                        name: 'period',
                        in: 'query',
                        schema: { type: 'string', enum: ['all', 'year', 'month', 'week'], default: 'all' },
                    },
                ],
                responses: {
                    200: {
                        description: 'Daily series plus donut breakdowns',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        period: { type: 'string' },
                                        daily_amounts: {
                                            type: 'array',
                                            description:
                                                'One row per day: { date, <STATUS>: amount, ... } — only statuses present in the period appear.',
                                            items: { type: 'object', additionalProperties: true },
                                        },
                                        by_checkout_mode: {
                                            type: 'object',
                                            additionalProperties: { type: 'integer' },
                                        },
                                        by_portfolio: {
                                            type: 'object',
                                            additionalProperties: { type: 'integer' },
                                        },
                                        by_status: {
                                            type: 'object',
                                            additionalProperties: { type: 'integer' },
                                        },
                                        by_currency: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    currency: { type: 'string' },
                                                    count: { type: 'integer' },
                                                    amount: { type: 'number' },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/payments/stats': {
            get: {
                tags: ['Payments'],
                summary: 'Aggregate payment counts and captured totals',
                security: [{ bearerAuth: [] }],
                parameters: [
                    {
                        name: 'period',
                        in: 'query',
                        schema: { type: 'string', enum: ['all', 'year', 'month', 'week'], default: 'all' },
                    },
                ],
                responses: {
                    200: {
                        description: 'Totals by status and captured amount per currency',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        total: { type: 'integer' },
                                        succeeded: { type: 'integer' },
                                        by_status: { type: 'object', additionalProperties: { type: 'integer' } },
                                        captured: {
                                            type: 'array',
                                            items: {
                                                type: 'object',
                                                properties: {
                                                    currency: { type: 'string' },
                                                    amount: { type: 'number' },
                                                    count: { type: 'integer' },
                                                },
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
        },
        '/payments/status/{orderId}': {
            get: {
                tags: ['Payments'],
                summary: 'Public status lookup for the post-checkout return page',
                description:
                    'Unauthenticated: the shopper returning from checkout has no session. Re-reads the intent from Airwallex and returns only display fields.',
                parameters: [
                    { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
                ],
                responses: {
                    200: {
                        description: 'Current payment status',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        merchant_order_id: { type: 'string' },
                                        status: { type: 'string' },
                                        amount: { type: 'number' },
                                        currency: { type: 'string' },
                                        captured_amount: { type: 'number' },
                                        descriptor: { type: 'string' },
                                        reference: { type: 'string' },
                                        description: { type: 'string' },
                                    },
                                },
                            },
                        },
                    },
                    404: { description: 'Not found' },
                },
            },
        },
        '/payments/webhook': {
            post: {
                tags: ['Payments'],
                summary: 'Airwallex webhook receiver',
                description:
                    'Authenticated by HMAC-SHA256 over `x-timestamp + raw body` using AIRWALLEX_WEBHOOK_SECRET, not by JWT. payment_intent.* events update status directly; payment_attempt.* and refund.* events trigger a re-read of the intent.',
                parameters: [
                    { name: 'x-timestamp', in: 'header', required: true, schema: { type: 'string' } },
                    { name: 'x-signature', in: 'header', required: true, schema: { type: 'string' } },
                ],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string' },
                                    name: { type: 'string', example: 'payment_intent.succeeded' },
                                    account_id: { type: 'string' },
                                    created_at: { type: 'string', format: 'date-time' },
                                    data: {
                                        type: 'object',
                                        properties: { object: { type: 'object' } },
                                    },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Acknowledged' },
                    401: { description: 'Invalid signature' },
                    500: { description: 'Processing failed - Airwallex will retry' },
                },
            },
        },
        '/payments/{id}': {
            get: {
                tags: ['Payments'],
                summary: 'Get one payment with its full event timeline',
                description: 'Accepts a payment_intent_id, merchant_order_id or local _id.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                ],
                responses: {
                    200: {
                        description: 'The payment',
                        content: {
                            'application/json': { schema: { $ref: '#/components/schemas/Payment' } },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    404: { description: 'Not found' },
                },
            },
        },
        '/payments/{id}/sync': {
            post: {
                tags: ['Payments'],
                summary: 'Re-read the intent from Airwallex and persist any change',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                ],
                responses: {
                    200: {
                        description: 'The refreshed payment',
                        content: {
                            'application/json': { schema: { $ref: '#/components/schemas/Payment' } },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    404: { description: 'Not found' },
                },
            },
        },
        '/payments/{id}/checkout': {
            post: {
                tags: ['Payments'],
                summary: 'Re-open checkout for a payment that has not been paid',
                description:
                    'Backs the Pay button in the payments table. The client_secret is never stored, so a fresh one is minted by retrieving the intent from Airwallex (each call returns a different, short-lived secret). That retrieve also re-checks the status, so a payment completed elsewhere is refused rather than charged twice. Only REQUIRES_PAYMENT_METHOD and REQUIRES_CUSTOMER_ACTION are payable — PENDING is excluded because the payment is already in flight.',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                ],
                responses: {
                    200: {
                        description: 'Checkout session',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        payment: { $ref: '#/components/schemas/Payment' },
                                        checkout: { $ref: '#/components/schemas/CheckoutHandoff' },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    404: { description: 'Not found' },
                    409: { description: 'Payment is not in a payable state' },
                    502: { description: 'Airwallex returned no checkout session' },
                },
            },
        },
        '/payments/{id}/cancel': {
            post: {
                tags: ['Payments'],
                summary: 'Cancel a payment that has not completed',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                ],
                requestBody: {
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                properties: { reason: { type: 'string', example: 'requested_by_customer' } },
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'The cancelled payment',
                        content: {
                            'application/json': { schema: { $ref: '#/components/schemas/Payment' } },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    404: { description: 'Not found' },
                    409: { description: 'Already in a terminal state' },
                },
            },
        },
        '/users': {
            get: {
                tags: ['Users'],
                summary: 'List users',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'q', in: 'query', schema: { type: 'string' } },
                    {
                        name: 'status',
                        in: 'query',
                        schema: { type: 'string', enum: ['active', 'pending', 'revoked'] },
                    },
                    {
                        name: 'sort',
                        in: 'query',
                        schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
                    },
                    { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
                    { name: 'skip', in: 'query', schema: { type: 'integer', default: 0 } },
                ],
                responses: {
                    200: {
                        description: 'Paged list of users',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        items: {
                                            type: 'array',
                                            items: { $ref: '#/components/schemas/User' },
                                        },
                                        total: { type: 'integer' },
                                        limit: { type: 'integer' },
                                        skip: { type: 'integer' },
                                    },
                                },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                },
            },
            post: {
                tags: ['Users'],
                summary: 'Create an active user directly (with a password)',
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['email', 'first_name', 'last_name', 'password'],
                                properties: {
                                    email: { type: 'string', format: 'email' },
                                    first_name: { type: 'string' },
                                    last_name: { type: 'string' },
                                    password: { type: 'string', minLength: 8 },
                                },
                            },
                        },
                    },
                },
                responses: {
                    201: {
                        description: 'Created',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/User' },
                            },
                        },
                    },
                    400: { $ref: '#/components/responses/BadRequest' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    409: { description: 'Email already in use' },
                },
            },
        },
        '/users/invite': {
            post: {
                tags: ['Users'],
                summary: 'Invite a user by email',
                security: [{ bearerAuth: [] }],
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['email', 'first_name', 'last_name'],
                                properties: {
                                    email: { type: 'string', format: 'email' },
                                    first_name: { type: 'string' },
                                    last_name: { type: 'string' },
                                },
                            },
                        },
                    },
                },
                responses: {
                    201: {
                        description: 'Invite created and emailed',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/User' },
                            },
                        },
                    },
                    400: { $ref: '#/components/responses/BadRequest' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    409: { description: 'Email already in use' },
                },
            },
        },
        '/users/invite/preview': {
            get: {
                tags: ['Users'],
                summary: 'Look up an invite by token without consuming it',
                parameters: [
                    {
                        name: 'token',
                        in: 'query',
                        required: true,
                        schema: { type: 'string' },
                    },
                ],
                responses: {
                    200: {
                        description: 'Invite is valid',
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'object',
                                    properties: {
                                        email: { type: 'string' },
                                        first_name: { type: 'string' },
                                        last_name: { type: 'string' },
                                    },
                                },
                            },
                        },
                    },
                    404: { description: 'Invalid invite link' },
                    410: { description: 'Invite expired' },
                },
            },
        },
        '/users/accept-invite': {
            post: {
                tags: ['Users'],
                summary: 'Accept an invite and set a password',
                requestBody: {
                    required: true,
                    content: {
                        'application/json': {
                            schema: {
                                type: 'object',
                                required: ['token', 'password'],
                                properties: {
                                    token: { type: 'string' },
                                    password: { type: 'string', minLength: 8 },
                                },
                            },
                        },
                    },
                },
                responses: {
                    200: { description: 'Invite accepted' },
                    400: { $ref: '#/components/responses/BadRequest' },
                    404: { description: 'Invalid invite link' },
                    410: { description: 'Invite expired' },
                },
            },
        },
        '/users/{id}': {
            get: {
                tags: ['Users'],
                summary: 'Get a user (own record only)',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                ],
                responses: {
                    200: {
                        description: 'The user',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/User' },
                            },
                        },
                    },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    403: { description: 'Forbidden' },
                    404: { description: 'Not found' },
                },
            },
            delete: {
                tags: ['Users'],
                summary: 'Revoke a user’s access',
                security: [{ bearerAuth: [] }],
                parameters: [
                    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
                ],
                responses: {
                    200: {
                        description: 'The revoked user',
                        content: {
                            'application/json': {
                                schema: { $ref: '#/components/schemas/User' },
                            },
                        },
                    },
                    400: { description: 'Cannot revoke your own access' },
                    401: { $ref: '#/components/responses/Unauthorized' },
                    404: { description: 'Not found' },
                },
            },
        },
    },
};
