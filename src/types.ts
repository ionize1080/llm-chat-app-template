/**
 * Type definitions for the LLM chat application.
 */

export interface Env {
  /**
   * Binding for the Workers AI API.
   */
  AI: Ai;

  /**
   * Binding for static assets.
   */
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

/**
 * Represents a chat message.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Parameters for the Workers AI `run` method. Some models expect chat
 * `messages` while others take an `input` array. Both variants also accept a
 * `max_tokens` limit.
 */
export type AiRunParams =
  | { messages: ChatMessage[]; max_tokens: number }
  | { input: ChatMessage[]; max_tokens: number };
