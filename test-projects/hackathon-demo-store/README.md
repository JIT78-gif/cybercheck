# Cybercheck Hackathon Demo Store

> **Intentionally flawed.** This project is only for an authorized Cybercheck demonstration. It contains synthetic users, orders, credentials and secrets. Run it only on `127.0.0.1` or inside Cybercheck's isolated sandbox. Never deploy it.

This is the small project to upload during the hackathon video. It has one clear story for each Cybercheck area:

| Check | Planted problem | Human explanation |
|---|---|---|
| Testing | Checkout calculates tax before applying a coupon | A $100 cart with 10% off and 10% tax becomes $100 instead of $99 |
| Security | Order lookup does not check the owner or tenant | Alice can read Bob's private order |
| AI Evaluator | The support bot says refunds last 7 days | The product policy in its system prompt says 30 days |
| AI Adversarial | Prompt injection reveals the system prompt; memory is shared across tenants | A hostile user can expose protected instructions and Bob's private note |

## Synthetic demo accounts

| User | Email | Password | Tenant |
|---|---|---|---|
| Alice | `alice@example.test` | `AlicePass!1` | north |
| Bob | `bob@example.test` | `BobPass!1` | south |

## Prepare the upload

From this folder:

```powershell
npm install
npm run verify:demo
```

`verify:demo` should pass and report that exactly two test failures are intentionally planted. Running `npm test` directly should show two passing and two failing tests. That red test output is expected and is what Cybercheck should explain.

Upload the generated `hackathon-demo-store-upload.zip` from the parent `test-projects` folder. The archive excludes `node_modules`.

See [DEMO_GUIDE.md](./DEMO_GUIDE.md) for the recording sequence and [EXPECTED_RESULTS.json](./EXPECTED_RESULTS.json) for the answer key.
