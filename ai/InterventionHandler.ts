import { coordinatorClient, COORDINATOR_MODEL } from './clients.js';

export interface InterventionResult {
  answer: string;
  resumePrompt: string;
}

export class InterventionHandler {
  async handleQuestion(
    question: string,
    priorThinkingContent: string,
    originalUserMessage: string,
    sendThinking?: (token: string) => void
  ): Promise<InterventionResult> {
    console.log(`[InterventionHandler] Routing question to coordinator: "${question}"`);

    let answer = '';
    try {
      const stream = await coordinatorClient.chat.completions.create({
        model: COORDINATOR_MODEL,
        messages: [
          {
            role: 'system',
            content:
              'You are an expert assistant helping a coding AI answer a specific question mid-task. ' +
              'Provide a precise, actionable answer. Be concise but complete.',
          },
          {
            role: 'user',
            content:
              `/think The coding engine is working on this task: "${originalUserMessage.slice(0, 300)}"\n\n` +
              `It paused to ask: "${question}"\n\n` +
              `Answer this question directly so it can continue.`,
          },
        ],
        max_tokens: 512,
        temperature: 0.2,
        stream: true,
      });

      let rawOutput = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta as Record<string, unknown>;
        const thinkToken = (delta?.reasoning_content ?? delta?.reasoning) as string | undefined;
        const outToken = delta?.content as string | undefined;
        if (thinkToken && sendThinking) sendThinking(thinkToken);
        if (outToken) rawOutput += outToken;
      }
      answer = rawOutput.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } catch (err) {
      console.error('[InterventionHandler] Coordinator failed:', err);
      answer = 'Unable to get coordinator answer. Proceed with best judgment.';
    }

    return {
      answer,
      resumePrompt: this.buildResumePrompt(question, answer, priorThinkingContent),
    };
  }

  private buildResumePrompt(question: string, answer: string, priorThinking: string): string {
    return (
      `<think>\n${priorThinking}\n\n` +
      `QUESTION: ${question}\n` +
      `COORDINATOR_ANSWER: ${answer}\n` +
      `Continuing with the above answer...\n</think>\n`
    );
  }
}