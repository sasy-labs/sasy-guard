// Demo only: a "sasy-demo" provider whose single model, claude-mock, is the
// scripted mock Anthropic endpoint that `make pi-guard-demo` serves. It replays
// a fixed list of tool calls (a real model refuses the dangerous ones), so the
// guard can be watched blocking them in a real pi session.
//
//   SASY_DEMO_MODEL_URL=http://127.0.0.1:<port> pi \
//     -e plugins/pi-sasy-guard -e plugins/pi-sasy-guard/demo/mock-model.ts \
//     --model sasy-demo/claude-mock
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  const baseUrl = process.env.SASY_DEMO_MODEL_URL;
  if (!baseUrl) return;
  pi.registerProvider("sasy-demo", {
    baseUrl,
    apiKey: "sk-mock-not-used",
    api: "anthropic-messages",
    models: [
      {
        id: "claude-mock",
        name: "Scripted mock (sasy-guard demo)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      },
    ],
  });
}
