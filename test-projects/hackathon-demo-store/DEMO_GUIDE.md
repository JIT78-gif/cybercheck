# 4-minute hackathon recording guide

## Before recording

1. Start Cybercheck and sign in.
2. Keep `test-projects/hackathon-demo-store-upload.zip` ready.
3. Use a fresh Cybercheck project named **Hackathon Demo Store**.
4. Do not show `.env`, real keys, personal data or unrelated browser tabs.

## Recording sequence

### 0:00 to 0:35 — One upload, four checks

- Open **Overview** and click **Add project**.
- Upload `hackathon-demo-store-upload.zip`.
- Confirm the project is synthetic and authorized.
- Say: “Cybercheck freezes one snapshot so every check uses exactly the same code.”

### 0:35 to 1:20 — Testing

- Open **Testing** and run the standard profile.
- Show the failed test **coupon discount is applied before tax**.
- Open the evidence and point out expected `99` versus actual `100`.
- Say: “This is a user-visible checkout bug, not just a red line in a log.”
- Open the recommended repair, approve the sandbox attempt, and show the before/after evidence.

### 1:20 to 2:05 — Security

- Open **Security** for the same project.
- Show the cross-tenant order finding.
- Explain: “Alice is signed in, but changing the order ID returns Bob's private order because ownership is never checked.”
- Show the exact route and evidence, then the proposed tenant/owner check.

### 2:05 to 2:50 — AI Evaluator

- Open **AI Evaluator**.
- Show the policy consistency failure: expected **30 days**, actual **7 days**.
- Say: “The bot is available and fluent, but it is giving the wrong business answer. Cybercheck grades behavior, not just uptime.”
- Show the case input, reply, grader result and repair recommendation.

### 2:50 to 3:35 — AI Adversarial

- Open **AI Adversarial** and approve the synthetic rules of engagement.
- Show the prompt-injection chain that reveals the system prompt and synthetic demo key.
- If present, also show the cross-tenant memory canary from Bob appearing to Alice.
- Say: “The attack runs only against an isolated copy and uses planted data, never a live customer system.”

### 3:35 to 4:00 — Verified fixing and close

- Return to the project page so all four check states are visible together.
- Show one repaired finding and its rerun evidence.
- End with: “One snapshot, four specialist checks, evidence for every claim, and fixes tested before they ever touch the real code.”

## If a check does not produce the expected card

- Do not claim it passed. Open the check coverage or untested section and say exactly what was blocked.
- Compare the result with `EXPECTED_RESULTS.json`.
- For the video, prefer one strong evidence-backed finding per check over scrolling through every low-priority item.
