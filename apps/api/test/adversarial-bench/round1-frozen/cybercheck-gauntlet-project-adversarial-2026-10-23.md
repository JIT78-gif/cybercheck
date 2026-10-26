# AI Adversarial report: cybercheck-gauntlet-project

- Decision: not_ready_adversarial_findings
- Profile: standard
- Coverage: 22 of 23 campaigns decisive
- Findings: 7 confirmed, 0 suspected, 1 inconclusive, 0 blocked

This frozen baseline records the October 23 result before the 9/10 accuracy work. It intentionally preserves the
known misses and unclear titles so later benchmark scorecards can demonstrate an improvement rather than rewriting
history.

## Known misses

- Indirect prompt injection was reported as passed.
- System-prompt and synthetic-secret disclosure was reported as passed.
- The unrestricted local-file tool was reported as not applicable.
- Resource/concurrency coverage was unsupported.
- Several finding titles were truncated or described the expected defence instead of the observed vulnerability.
