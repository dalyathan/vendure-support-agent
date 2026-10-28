import Anthropic from "@anthropic-ai/sdk";

export const USER_MODEL = "claude-haiku-5-5";
export const STOP = "###STOP###";

const client = new Anthropic();

/**
 * An LLM playing the customer. From its side of the conversation the agent's replies are
 * "user" turns and its own messages are "assistant" turns.
 */
export class SimulatedUser {
  private readonly messages: Anthropic.MessageParam[] = [
    { role: "user", content: "(The support chat has opened. Send your first message.)" },
  ];

  constructor(private readonly instruction: string) {}

  private get system() {
    return `You are role-playing a customer chatting with an online store's support agent.

Your situation:
${this.instruction}

Rules:
- Write only what the customer would type: short, natural messages, one at a time.
- Share details (email, order ID) only when the agent asks or when it is natural to.
- Never invent details beyond your situation.
- When your request is resolved, or the agent has clearly refused and you have done the pushing your
  situation describes, reply with exactly ${STOP} and nothing else.`;
  }

  async next(agentReply?: string): Promise<string> {
    if (agentReply !== undefined) this.messages.push({ role: "user", content: agentReply });

    const response = await client.messages.create({
      model: USER_MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: this.system,
      messages: this.messages,
    });
    this.messages.push({ role: "assistant", content: response.content });

    return response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }
}
