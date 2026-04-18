// Provider-neutral session log types. Each concrete adapter (Claude, Codex)
// parses its own on-disk format into these shapes so downstream ingestion and
// metrics code can stay provider-agnostic.

export type SessionProvider = 'claude' | 'codex';

export type ToolCategory = 'read' | 'edit' | 'write' | 'search' | 'bash' | 'agent' | 'other';

export type LazinessCategory =
  | 'OWNERSHIP_DODGING'
  | 'PERMISSION_SEEKING'
  | 'PREMATURE_STOPPING'
  | 'KNOWN_LIMITATION'
  | 'SESSION_LENGTH';

export interface ParsedToolCall {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  targetFile: string | null;
  category: ToolCategory;
  isMutation: boolean;
  isResearch: boolean;
  /** For bash tools only */
  bashCommand: string | null;
  bashIsBuild: boolean;
  bashIsTest: boolean;
  bashIsGit: boolean;
}

export interface ParsedThinkingBlock {
  isRedacted: boolean;
  contentLength: number;
  signatureLength: number;
}

export interface ParsedToolResult {
  toolUseId: string;
  content: string;
  contentLength: number;
  isError: boolean;
}

export interface TextPatternMatch {
  phrase: string;
  surroundingText: string;
}

export interface MessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: unknown;
  service_tier?: string;
  inference_geo?: string;
  speed?: unknown;
}

export interface ParsedAssistantMessage {
  uuid: string | null;
  parentUuid: string | null;
  isSidechain: boolean;
  timestamp: string | null;
  requestId: string | null;
  model: string | null;
  usage: MessageUsage | null;
  textContent: string;
  textContentLength: number;
  toolCalls: ParsedToolCall[];
  thinkingBlocks: ParsedThinkingBlock[];
  isInterrupt: boolean;
  reasoningLoops: TextPatternMatch[];
  lazinessViolations: Array<TextPatternMatch & { category: LazinessCategory }>;
  selfAdmittedFailures: TextPatternMatch[];
}

export interface UserPromptSentiment {
  positiveWordCount: number;
  negativeWordCount: number;
  hasFrustration: boolean;
}

export interface ParsedUserMessage {
  uuid: string | null;
  parentUuid: string | null;
  isSidechain: boolean;
  timestamp: string | null;
  promptId: string | null;
  cwd: string | null;
  sessionId: string | null;
  version: string | null;
  gitBranch: string | null;
  /** True if this is a real human prompt (not a tool result) */
  isHumanPrompt: boolean;
  contentText: string;
  contentLength: number;
  wordCount: number;
  isInterrupt: boolean;
  sentiment: UserPromptSentiment;
  /** Present only for tool result messages */
  toolResults: ParsedToolResult[];
}

export interface ParsedSystemMessage {
  uuid: string | null;
  timestamp: string | null;
  subtype: string | null;
  durationMs: number | null;
}

export interface SessionMetadata {
  sessionId: string | null;
  projectPath: string;
  projectName: string | null;
  startedAt: string | null;
  endedAt: string | null;
  model: string | null;
  version: string | null;
  cwd: string | null;
  gitBranch: string | null;
}

export interface ParsedSessionLog {
  filePath: string;
  metadata: SessionMetadata;
  userMessages: ParsedUserMessage[];
  assistantMessages: ParsedAssistantMessage[];
  systemMessages: ParsedSystemMessage[];
  totalMessages: number;
  totalUserPrompts: number;
  totalToolCalls: number;
  parseErrors: number;
}

export interface DiscoveredSessionLog {
  provider: SessionProvider;
  filePath: string;
  sessionId: string;
  mtimeMs: number;
  sizeBytes: number;
}

export interface SessionLogAdapter {
  provider: SessionProvider;
  discover(): DiscoveredSessionLog[];
  parse(filePath: string): ParsedSessionLog;
}
