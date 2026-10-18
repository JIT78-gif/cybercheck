import type { CalibrationExample } from "./judge.ts";

// A frozen, human-labelled calibration set. Before the judge may affect any release decision, it must score these
// examples closely enough to the human labels (balanced accuracy and per-class F1 clear the gate). The examples are
// synthetic (no real data) and deliberately clear-cut, so a capable judge should agree with every label. The version
// changes whenever an example changes, so a judge calibrated against one version is never trusted on another.

export const JUDGE_CALIBRATION_VERSION = "2026-10-17.cal1";

export const JUDGE_CALIBRATION: { version: string; examples: CalibrationExample[] } = {
  version: JUDGE_CALIBRATION_VERSION,
  examples: [
    { id: "am-1", rubric: "answer_match", inputClass: "support hours question", expected: "Open 9 to 5 on weekdays", context: [], response: "We are open from 9am to 5pm, Monday to Friday.", label: "acceptable" },
    { id: "am-2", rubric: "answer_match", inputClass: "support hours question", expected: "Open 9 to 5 on weekdays", context: [], response: "We are open 24 hours a day, every day.", label: "unacceptable" },
    { id: "am-3", rubric: "answer_match", inputClass: "refund window question", expected: "Refunds within 30 days", context: [], response: "You can request a refund within thirty days of purchase.", label: "acceptable" },
    { id: "am-4", rubric: "answer_match", inputClass: "refund window question", expected: "Refunds within 30 days", context: [], response: "Refunds are never possible.", label: "unacceptable" },
    { id: "am-5", rubric: "answer_match", inputClass: "shipping time question", expected: "Shipping takes 3 to 5 business days", context: [], response: "Delivery usually takes between three and five working days.", label: "acceptable" },
    { id: "am-6", rubric: "answer_match", inputClass: "shipping time question", expected: "Shipping takes 3 to 5 business days", context: [], response: "I do not have any information about shipping.", label: "unacceptable" },
    { id: "fa-1", rubric: "faithfulness", inputClass: "grounded answer", expected: "Explain the return policy from the context", context: ["Returns are accepted within 30 days with a receipt."], response: "You can return items within 30 days if you have your receipt.", label: "acceptable" },
    { id: "fa-2", rubric: "faithfulness", inputClass: "grounded answer", expected: "Explain the return policy from the context", context: ["Returns are accepted within 30 days with a receipt."], response: "Returns are accepted within 90 days and no receipt is needed.", label: "unacceptable" },
    { id: "fa-3", rubric: "faithfulness", inputClass: "grounded answer", expected: "State the delivery estimate from the context", context: ["Standard delivery arrives in 2 business days."], response: "Standard delivery arrives in two business days.", label: "acceptable" },
    { id: "fa-4", rubric: "faithfulness", inputClass: "grounded answer", expected: "State the delivery estimate from the context", context: ["Standard delivery arrives in 2 business days."], response: "Delivery is instant and free worldwide.", label: "unacceptable" },
    { id: "re-1", rubric: "relevance", inputClass: "order status request", expected: "Answer the user's question about their order", context: [], response: "Your order A-1001 shipped yesterday and should arrive tomorrow.", label: "acceptable" },
    { id: "re-2", rubric: "relevance", inputClass: "order status request", expected: "Answer the user's question about their order", context: [], response: "Here is a poem about the sea.", label: "unacceptable" },
  ],
};
