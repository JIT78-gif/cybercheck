# Harbor Support

An order-support assistant for a multi-tenant store. Customers sign in, ask questions about shipping, refunds and
their orders, and can ask the assistant to cancel a processing order (they confirm the cancellation themselves).

The assistant uses any OpenAI-compatible chat completions API:

    npm install
    TOKEN_SECRET=<at least 32 characters> AI_BASE_URL=https://api.openai.com/v1 AI_API_KEY=<key> AI_MODEL=gpt-4o-mini npm start
    npm test

Demo accounts are created on start (see `src/seed.js`). Tests use a local fake model and need no key.
