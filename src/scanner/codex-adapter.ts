import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  analyzeUserSentiment,
  detectInterrupt,
  detectLazinessViolations,
  detectReasoningLoops,
  detectSelfAdmittedFailures,
} from './claude-adapter';
import type {
  DiscoveredSessionLog,
  MessageUsage,
  ParsedAssistantMessage,
  ParsedSessionLog,
  ParsedThinkingBlock,
  ParsedToolCall,
  ParsedToolResult,
  ParsedUserMessage,
  SessionLogAdapter,
  ToolCategory,
} from './types';

// ---------------------------------------------------------------------------
// Raw JSONL line shapes (Codex rollout format)
// ---------------------------------------------------------------------------

interface RawCodexEntry {
  timestamp?: string;
  type: string;
  payload?: Record<string, unknown> | null;
}

interface SessionMetaPayload {
  id?: string;
  timestamp?: string;
  cwd?: string;
  cli_version?: string;
  originator?: string;
  model_provider?: string;
  git?: { branch?: string; commit_hash?: string; repository_url?: string };
}

interface TurnContextPayload {
  turn_id?: string;
  cwd?: string;
  model?: string;
  effort?: string;
}

interface UserMessageEvent {
  type?: 'user_message';
  message?: string;
}

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface TokenCountEvent {
  type?: 'token_count';
  info?: {
    last_token_usage?: TokenUsage;
    total_token_usage?: TokenUsage;
    model_context_window?: number;
  } | null;
}

interface ExecCommandEndEvent {
  type?: 'exec_command_end';
  call_id?: string;
  command?: unknown[];
  cwd?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  aggregated_output?: string;
}

interface MessageContentBlock {
  type: string;
  text?: string;
}

interface ResponseMessagePayload {
  type?: 'message';
  role?: string;
  content?: MessageContentBlock[];
  phase?: string;
}

interface ResponseReasoningPayload {
  type?: 'reasoning';
  summary?: unknown[];
  content?: unknown;
  encrypted_content?: string;
}

interface ResponseFunctionCallPayload {
  type?: 'function_call';
  name?: string;
  arguments?: string;
  call_id?: string;
}

interface ResponseFunctionCallOutputPayload {
  type?: 'function_call_output';
  call_id?: string;
  output?: string;
}

interface ResponseCustomToolCallPayload {
  type?: 'custom_tool_call';
  name?: string;
  input?: string;
  call_id?: string;
}

interface ResponseCustomToolCallOutputPayload {
  type?: 'custom_tool_call_output';
  call_id?: string;
  output?: string;
}

interface ResponseWebSearchCallPayload {
  type?: 'web_search_call';
  call_id?: string;
  query?: string;
  action?: unknown;
}

// ---------------------------------------------------------------------------
// Command classification (Codex-specific: exec_command + apply_patch)
// ---------------------------------------------------------------------------

const BUILD_PATTERNS = [
  /\bnpm\s+run\s+build\b/i,
  /\btsc\b/,
  /\bmake\b/,
  /\bcargo\s+build\b/,
  /\bgo\s+build\b/,
  /\bgradlew?\s+build\b/,
  /\bmvn\s+(compile|package|install)\b/,
  /\bdotnet\s+build\b/,
  /\byarn\s+build\b/,
  /\bpnpm\s+build\b/,
  /\bnpm\s+run\s+compile\b/i,
  /\bwebpack\b/,
  /\bvite\s+build\b/,
  /\besbuild\b/,
  /\brollup\b/,
  /\bbun\s+run\s+build\b/i,
];

const TEST_PATTERNS = [
  /\bnpm\s+test\b/i,
  /\bnpm\s+run\s+test\b/i,
  /\bjest\b/,
  /\bpytest\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bvitest\b/,
  /\bmocha\b/,
  /\bava\b/,
  /\byarn\s+test\b/i,
  /\bpnpm\s+test\b/i,
  /\bnpx\s+jest\b/,
  /\bpython\s+-m\s+pytest\b/,
  /\bpython\s+-m\s+unittest\b/,
  /\bdotnet\s+test\b/,
  /\bgradlew?\s+test\b/,
  /\bmvn\s+test\b/,
  /\bbun\s+test\b/i,
];

const GIT_MUTATION_PATTERNS = [
  /\bgit\s+commit\b/,
  /\bgit\s+push\b/,
  /\bgit\s+pull\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+checkout\b/,
  /\bgit\s+branch\b/,
  /\bgit\s+stash\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+add\b/,
  /\bgit\s+clone\b/,
  /\bgit\s+fetch\b/,
  /\bgit\s+tag\b/,
];

const GIT_READ_PATTERNS = [/\bgit\s+diff\b/, /\bgit\s+log\b/, /\bgit\s+status\b/, /\bgit\s+show\b/];

// Read-like commands: inspect one or more files/outputs without mutating
const READ_COMMAND_RE =
  /^(sed|cat|nl|head|tail|less|more|bat|view|awk\s+'\s*NR|od|hexdump|xxd|strings)\b/;

// Search-like commands
const SEARCH_COMMAND_RE = /^(rg|grep|egrep|fgrep|find|fd|locate|ls|glob)\b/;

// Mutation shell keywords — if any appear as the first token (outside a pipe),
// classify as bash+mutation regardless of other matches.
const MUTATION_COMMAND_RE =
  /^(rm|mv|cp|mkdir|touch|chmod|chown|ln|dd|install|tee|truncate|perl\s+-pi|sed\s+-i|npm\s+(install|uninstall|i|ci|add|remove)|yarn\s+(add|remove|install)|pnpm\s+(add|remove|install)|bun\s+(add|remove|install)|pip\s+install|cargo\s+(add|install|remove))\b/;

function firstCommand(cmd: string): string {
  const trimmed = cmd.trim();
  // Handle compound commands: take segment before first &&, ||, ;, or |
  const split = trimmed.split(/\s*(?:&&|\|\||;|\|)\s*/)[0] ?? trimmed;
  return split.trim();
}

type ClassifiedCommand = {
  category: ToolCategory;
  isMutation: boolean;
  isResearch: boolean;
  isBuild: boolean;
  isTest: boolean;
  isGit: boolean;
  targetFile: string | null;
};

function classifyShellCommand(rawCmd: string): ClassifiedCommand {
  const cmd = firstCommand(rawCmd);
  const isBuild = BUILD_PATTERNS.some((p) => p.test(rawCmd));
  const isTest = TEST_PATTERNS.some((p) => p.test(rawCmd));
  const isGitMut = GIT_MUTATION_PATTERNS.some((p) => p.test(rawCmd));
  const isGitRead = GIT_READ_PATTERNS.some((p) => p.test(rawCmd));
  const isGit = isGitMut || isGitRead;

  // Build and test commands are bash, not research/mutation-classified reads
  if (isBuild || isTest) {
    return {
      category: 'bash',
      isMutation: false,
      isResearch: false,
      isBuild,
      isTest,
      isGit,
      targetFile: null,
    };
  }

  // Obvious mutation commands
  if (MUTATION_COMMAND_RE.test(cmd) || /(?:^|\s)>\s*\S/.test(rawCmd) || isGitMut) {
    return {
      category: 'bash',
      isMutation: true,
      isResearch: false,
      isBuild: false,
      isTest: false,
      isGit,
      targetFile: null,
    };
  }

  // Read-like single-file inspection
  if (READ_COMMAND_RE.test(cmd)) {
    return {
      category: 'read',
      isMutation: false,
      isResearch: true,
      isBuild: false,
      isTest: false,
      isGit: false,
      targetFile: extractReadTarget(cmd),
    };
  }

  // Search-like commands
  if (SEARCH_COMMAND_RE.test(cmd)) {
    return {
      category: 'search',
      isMutation: false,
      isResearch: true,
      isBuild: false,
      isTest: false,
      isGit: false,
      targetFile: null,
    };
  }

  // Git-read (status/diff/log/show) counts as research but stays in bash category
  if (isGitRead) {
    return {
      category: 'bash',
      isMutation: false,
      isResearch: true,
      isBuild: false,
      isTest: false,
      isGit: true,
      targetFile: null,
    };
  }

  // Default: unknown shell command
  return {
    category: 'bash',
    isMutation: false,
    isResearch: false,
    isBuild: false,
    isTest: false,
    isGit,
    targetFile: null,
  };
}

/**
 * Best-effort target-file inference for simple read commands.
 * Examples:
 *   sed -n '1,120p' src/index.ts     -> src/index.ts
 *   nl -ba src/index.ts              -> src/index.ts
 *   cat package.json                 -> package.json
 *   head -n 20 foo.txt               -> foo.txt
 * Returns null when ambiguous.
 */
function extractReadTarget(cmd: string): string | null {
  // Reject shell compound / redirects / pipes
  if (/[<>|]/.test(cmd) || /\s&&\s|\s\|\|\s|;/.test(cmd)) return null;
  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  // The last token that looks like a path: contains "/" or "." and is not a flag
  for (let i = tokens.length - 1; i >= 1; i--) {
    const tok = tokens[i];
    if (tok.startsWith('-')) continue;
    // Drop surrounding quotes
    const unquoted = tok.replace(/^['"]|['"]$/g, '');
    if (/^'.*'$/.test(tok) || /^".*"$/.test(tok)) continue;
    if (unquoted.includes('/') || /\.[a-zA-Z0-9]+$/.test(unquoted)) {
      return unquoted;
    }
  }
  return null;
}

/**
 * Parse an apply_patch custom tool input and extract the first target file.
 * Handles the standard Codex patch envelope:
 *   *** Begin Patch
 *   *** Update File: path/to/file.ts
 *   *** Add File: path/to/file.ts
 *   *** Delete File: path/to/file.ts
 */
function extractPatchTargetFile(patchInput: string): string | null {
  const match = patchInput.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Function-call parsing helpers
// ---------------------------------------------------------------------------

function parseFunctionCallArgs(argsStr: string | undefined): Record<string, unknown> {
  if (!argsStr) return {};
  try {
    const parsed = JSON.parse(argsStr);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function classifyFunctionCall(
  payload: ResponseFunctionCallPayload,
): { input: Record<string, unknown>; tool: ParsedToolCall } | null {
  const name = payload.name || '';
  const input = parseFunctionCallArgs(payload.arguments);
  const callId = payload.call_id || '';

  if (name === 'exec_command') {
    const cmd = typeof input.cmd === 'string' ? input.cmd : '';
    const cls = classifyShellCommand(cmd);
    return {
      input,
      tool: {
        toolName: name,
        toolUseId: callId,
        input,
        targetFile: cls.targetFile,
        category: cls.category,
        isMutation: cls.isMutation,
        isResearch: cls.isResearch,
        bashCommand: cmd || null,
        bashIsBuild: cls.isBuild,
        bashIsTest: cls.isTest,
        bashIsGit: cls.isGit,
      },
    };
  }

  if (name === 'write_stdin') {
    // write_stdin feeds input to an existing shell session; treat as bash.
    return {
      input,
      tool: {
        toolName: name,
        toolUseId: callId,
        input,
        targetFile: null,
        category: 'bash',
        isMutation: false,
        isResearch: false,
        bashCommand: typeof input.input === 'string' ? input.input : null,
        bashIsBuild: false,
        bashIsTest: false,
        bashIsGit: false,
      },
    };
  }

  // Fallback for any other function_call
  return {
    input,
    tool: {
      toolName: name || 'unknown_function',
      toolUseId: callId,
      input,
      targetFile: null,
      category: 'other',
      isMutation: false,
      isResearch: false,
      bashCommand: null,
      bashIsBuild: false,
      bashIsTest: false,
      bashIsGit: false,
    },
  };
}

function classifyCustomToolCall(payload: ResponseCustomToolCallPayload): ParsedToolCall {
  const name = payload.name || '';
  const callId = payload.call_id || '';
  const inputStr = typeof payload.input === 'string' ? payload.input : '';

  if (name === 'apply_patch') {
    return {
      toolName: name,
      toolUseId: callId,
      input: { patch: inputStr },
      targetFile: extractPatchTargetFile(inputStr),
      category: 'edit',
      isMutation: true,
      isResearch: false,
      bashCommand: null,
      bashIsBuild: false,
      bashIsTest: false,
      bashIsGit: false,
    };
  }

  return {
    toolName: name || 'unknown_custom_tool',
    toolUseId: callId,
    input: { input: inputStr },
    targetFile: null,
    category: 'other',
    isMutation: false,
    isResearch: false,
    bashCommand: null,
    bashIsBuild: false,
    bashIsTest: false,
    bashIsGit: false,
  };
}

function classifyWebSearchCall(payload: ResponseWebSearchCallPayload): ParsedToolCall {
  return {
    toolName: 'web_search',
    toolUseId: payload.call_id || '',
    input: { query: payload.query ?? '', action: payload.action ?? null },
    targetFile: null,
    category: 'search',
    isMutation: false,
    isResearch: true,
    bashCommand: null,
    bashIsBuild: false,
    bashIsTest: false,
    bashIsGit: false,
  };
}

// ---------------------------------------------------------------------------
// Output parsing (tool results, exec exit codes)
// ---------------------------------------------------------------------------

/**
 * Parse the envelope returned by exec_command function_call_output.
 * Example:
 *   Chunk ID: f88341
 *   Wall time: 0.0000 seconds
 *   Process exited with code 0
 *   Original token count: 19
 *   Output:
 *   <actual output>
 */
function extractExecExitCode(output: string): number | null {
  const m = output.match(/Process exited with code (-?\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Parse custom_tool_call_output envelope (JSON with `output` + `metadata.exit_code`).
 */
function extractCustomToolExitCode(output: string): number | null {
  try {
    const parsed = JSON.parse(output) as {
      metadata?: { exit_code?: number };
    };
    const code = parsed?.metadata?.exit_code;
    return typeof code === 'number' ? code : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

function assignReasoningDepth(msg: ParsedAssistantMessage, usage: TokenUsage) {
  const depth = usage.reasoning_output_tokens;
  if (typeof depth !== 'number' || depth < 0) return;

  for (let i = msg.thinkingBlocks.length - 1; i >= 0; i--) {
    const block = msg.thinkingBlocks[i];
    if (block.estimatedDepth === undefined) {
      block.estimatedDepth = depth;
      return;
    }
  }
}

export function parseCodexSessionLog(filePath: string): ParsedSessionLog {
  const result: ParsedSessionLog = {
    filePath,
    metadata: {
      sessionId: null,
      projectPath: 'unknown',
      projectName: null,
      startedAt: null,
      endedAt: null,
      model: null,
      version: null,
      cwd: null,
      gitBranch: null,
    },
    userMessages: [],
    assistantMessages: [],
    systemMessages: [],
    totalMessages: 0,
    totalUserPrompts: 0,
    totalToolCalls: 0,
    parseErrors: 0,
  };

  let fileContent: string;
  try {
    fileContent = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return result;
  }

  const lines = fileContent.split('\n');

  // State maintained during the linear scan
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  // Map call_id -> exit_code (from exec_command_end events) used later to
  // resolve success/failure for function_call_output entries.
  const execExitCodes = new Map<string, number>();

  // Synthetic assistant message used to group tool calls/reasoning that arrive
  // without an accompanying assistant text message in the same "turn".
  let currentAssistant: ParsedAssistantMessage | null = null;
  let assistantResponseComplete = false;

  // The most recent token-count info that has not yet been attributed.
  let pendingTokenUsage: TokenUsage | null = null;

  function flushAssistant() {
    if (!currentAssistant) return;
    // Run pattern detection now that the message is finalized
    const text = currentAssistant.textContent;
    currentAssistant.reasoningLoops = detectReasoningLoops(text);
    currentAssistant.lazinessViolations = detectLazinessViolations(text);
    currentAssistant.selfAdmittedFailures = detectSelfAdmittedFailures(text);
    result.assistantMessages.push(currentAssistant);
    result.totalToolCalls += currentAssistant.toolCalls.length;
    currentAssistant = null;
    assistantResponseComplete = false;
  }

  function ensureAssistant(timestamp: string | null): ParsedAssistantMessage {
    if (currentAssistant) return currentAssistant;
    currentAssistant = {
      uuid: null,
      parentUuid: null,
      isSidechain: false,
      timestamp,
      requestId: null,
      model: result.metadata.model,
      usage: null,
      textContent: '',
      textContentLength: 0,
      toolCalls: [],
      thinkingBlocks: [],
      isInterrupt: false,
      reasoningLoops: [],
      lazinessViolations: [],
      selfAdmittedFailures: [],
    };
    assistantResponseComplete = false;
    return currentAssistant;
  }

  function ensureOpenAssistant(timestamp: string | null): ParsedAssistantMessage {
    if (assistantResponseComplete) flushAssistant();
    return ensureAssistant(timestamp);
  }

  function attachPendingUsageTo(msg: ParsedAssistantMessage) {
    if (!pendingTokenUsage) return;
    assignReasoningDepth(msg, pendingTokenUsage);
    if (!msg.usage) {
      const usage: MessageUsage = {
        input_tokens: pendingTokenUsage.input_tokens ?? 0,
        output_tokens: pendingTokenUsage.output_tokens ?? 0,
        cache_read_input_tokens: pendingTokenUsage.cached_input_tokens ?? 0,
      };
      msg.usage = usage;
    }
    pendingTokenUsage = null;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: RawCodexEntry;
    try {
      entry = JSON.parse(trimmed) as RawCodexEntry;
    } catch {
      result.parseErrors++;
      continue;
    }

    result.totalMessages++;

    if (entry.timestamp) {
      if (!firstTimestamp) firstTimestamp = entry.timestamp;
      lastTimestamp = entry.timestamp;
    }

    const type = entry.type;
    const payload = (entry.payload ?? {}) as Record<string, unknown>;

    if (type === 'session_meta') {
      const p = payload as SessionMetaPayload;
      if (p.id && !result.metadata.sessionId) result.metadata.sessionId = p.id;
      if (p.cwd) {
        result.metadata.cwd = p.cwd;
        result.metadata.projectPath = p.cwd;
        result.metadata.projectName = path.basename(p.cwd);
      }
      if (p.cli_version) result.metadata.version = p.cli_version;
      if (p.git?.branch) result.metadata.gitBranch = p.git.branch;
      continue;
    }

    if (type === 'turn_context') {
      const p = payload as TurnContextPayload;
      if (p.model && !result.metadata.model) result.metadata.model = p.model;
      if (p.cwd && !result.metadata.cwd) {
        result.metadata.cwd = p.cwd;
        result.metadata.projectPath = p.cwd;
        result.metadata.projectName = path.basename(p.cwd);
      }
      // Flush any in-progress assistant message at turn boundaries
      flushAssistant();
      continue;
    }

    if (type === 'event_msg') {
      const evType = (payload as { type?: string }).type;

      if (evType === 'user_message') {
        // Finalize any in-progress assistant response before the next user turn.
        flushAssistant();
        const p = payload as UserMessageEvent;
        const text = p.message ?? '';
        const wordCount = text.split(/\s+/).filter(Boolean).length;
        const sentiment = analyzeUserSentiment(text);
        const isInterrupt = detectInterrupt(text);
        result.userMessages.push({
          uuid: null,
          parentUuid: null,
          isSidechain: false,
          timestamp: entry.timestamp ?? null,
          promptId: null,
          cwd: result.metadata.cwd,
          sessionId: result.metadata.sessionId,
          version: result.metadata.version,
          gitBranch: result.metadata.gitBranch,
          isHumanPrompt: true,
          contentText: text,
          contentLength: text.length,
          wordCount,
          isInterrupt,
          sentiment,
          toolResults: [],
        });
        result.totalUserPrompts++;
        continue;
      }

      if (evType === 'exec_command_end') {
        const p = payload as ExecCommandEndEvent;
        if (p.call_id !== undefined && typeof p.exit_code === 'number') {
          execExitCodes.set(p.call_id, p.exit_code);
        }
        continue;
      }

      if (evType === 'token_count') {
        const p = payload as TokenCountEvent;
        if (p.info?.last_token_usage) {
          pendingTokenUsage = p.info.last_token_usage;
          // Try to attribute to whichever assistant message is currently open
          if (currentAssistant) {
            attachPendingUsageTo(currentAssistant);
            assistantResponseComplete = true;
          }
        }
        continue;
      }

      // Other event_msg types (agent_message, patch_apply_end, task_started,
      // task_complete, turn_aborted) are either duplicates of response_items
      // or UI chrome. Skipping them avoids double-counting text.
      continue;
    }

    if (type === 'response_item') {
      const pType = (payload as { type?: string }).type;

      if (pType === 'message') {
        const p = payload as ResponseMessagePayload;
        if (p.role === 'assistant') {
          const text = (p.content ?? [])
            .map((b) => (b.type === 'output_text' && typeof b.text === 'string' ? b.text : ''))
            .filter(Boolean)
            .join('\n');
          const msg = ensureOpenAssistant(entry.timestamp ?? null);
          msg.textContent = text;
          msg.textContentLength = text.length;
          msg.timestamp = entry.timestamp ?? msg.timestamp;
          attachPendingUsageTo(msg);
        }
        // role=developer/user are system injections — ignore for content counts.
        continue;
      }

      if (pType === 'reasoning') {
        const p = payload as ResponseReasoningPayload;
        const encrypted = typeof p.encrypted_content === 'string' ? p.encrypted_content : '';
        const visible =
          typeof p.content === 'string'
            ? p.content
            : Array.isArray(p.content)
              ? (p.content as unknown[])
                  .map((b) =>
                    typeof (b as { text?: string }).text === 'string'
                      ? (b as { text: string }).text
                      : '',
                  )
                  .join('')
              : '';
        const isRedacted = !visible && encrypted.length > 0;
        const block: ParsedThinkingBlock = {
          isRedacted,
          contentLength: visible.length,
          signatureLength: encrypted.length,
        };
        const msg = ensureOpenAssistant(entry.timestamp ?? null);
        msg.thinkingBlocks.push(block);
        continue;
      }

      if (pType === 'function_call') {
        const p = payload as ResponseFunctionCallPayload;
        const classified = classifyFunctionCall(p);
        if (!classified) continue;
        const msg = ensureOpenAssistant(entry.timestamp ?? null);
        msg.toolCalls.push(classified.tool);
        continue;
      }

      if (pType === 'custom_tool_call') {
        const tool = classifyCustomToolCall(payload as ResponseCustomToolCallPayload);
        const msg = ensureOpenAssistant(entry.timestamp ?? null);
        msg.toolCalls.push(tool);
        continue;
      }

      if (pType === 'web_search_call') {
        const tool = classifyWebSearchCall(payload as ResponseWebSearchCallPayload);
        const msg = ensureOpenAssistant(entry.timestamp ?? null);
        msg.toolCalls.push(tool);
        continue;
      }

      if (pType === 'function_call_output') {
        const p = payload as ResponseFunctionCallOutputPayload;
        const output = typeof p.output === 'string' ? p.output : '';
        const callId = p.call_id || '';
        const mappedExit = execExitCodes.get(callId);
        const parsedExit = mappedExit ?? extractExecExitCode(output);
        const isError = parsedExit === null ? false : parsedExit !== 0;
        pushToolResult(result, {
          toolUseId: callId,
          content: output,
          contentLength: output.length,
          isError,
          timestamp: entry.timestamp ?? null,
        });
        continue;
      }

      if (pType === 'custom_tool_call_output') {
        const p = payload as ResponseCustomToolCallOutputPayload;
        const output = typeof p.output === 'string' ? p.output : '';
        const callId = p.call_id || '';
        const exitCode = extractCustomToolExitCode(output);
        const isError = exitCode === null ? /error|failed/i.test(output) : exitCode !== 0;
        pushToolResult(result, {
          toolUseId: callId,
          content: output,
          contentLength: output.length,
          isError,
          timestamp: entry.timestamp ?? null,
        });
      }
    }

    // Unknown top-level type — ignore.
  }

  flushAssistant();

  // Fall back to file-derived session ID if still unset
  if (!result.metadata.sessionId) {
    result.metadata.sessionId = extractCodexSessionId(filePath);
  }
  result.metadata.startedAt = firstTimestamp;
  result.metadata.endedAt = lastTimestamp;

  return result;
}

/**
 * Wrap a tool result as a synthetic user message so it flows through the
 * scanner's existing ingestion path (which pulls tool results from user
 * messages) without special casing.
 */
function pushToolResult(
  result: ParsedSessionLog,
  tr: ParsedToolResult & { timestamp: string | null },
) {
  const synthetic: ParsedUserMessage = {
    uuid: null,
    parentUuid: null,
    isSidechain: false,
    timestamp: tr.timestamp,
    promptId: null,
    cwd: result.metadata.cwd,
    sessionId: result.metadata.sessionId,
    version: result.metadata.version,
    gitBranch: result.metadata.gitBranch,
    isHumanPrompt: false,
    contentText: '',
    contentLength: 0,
    wordCount: 0,
    isInterrupt: false,
    sentiment: { positiveWordCount: 0, negativeWordCount: 0, hasFrustration: false },
    toolResults: [
      {
        toolUseId: tr.toolUseId,
        content: tr.content,
        contentLength: tr.contentLength,
        isError: tr.isError,
      },
    ],
  };
  result.userMessages.push(synthetic);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const CODEX_SESSION_ID_RE =
  /rollout-[^-]+-[^-]+-[^-]+-[^-]+-[^-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function extractCodexSessionId(filePath: string): string | null {
  const match = filePath.match(CODEX_SESSION_ID_RE);
  if (match) return match[1];
  // Fallback: strip prefix and .jsonl
  const basename = path.basename(filePath, '.jsonl');
  const uuid = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return uuid ? uuid[1] : null;
}

function collectJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsonlFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(fullPath);
    }
  }
  return results;
}

interface CodexSessionCandidate {
  filePath: string;
  sessionId: string | null;
}

interface CodexThreadRow {
  id: string;
  rollout_path: string;
}

function normalizeRolloutPath(homeDir: string, rolloutPath: string): string {
  if (rolloutPath.startsWith('~/')) {
    return path.join(homeDir, rolloutPath.slice(2));
  }
  if (path.isAbsolute(rolloutPath)) return rolloutPath;
  if (rolloutPath.startsWith('sessions/')) {
    return path.join(homeDir, '.codex', rolloutPath);
  }
  return path.resolve(homeDir, rolloutPath);
}

function discoverCodexSessionCandidatesFromState(homeDir: string): CodexSessionCandidate[] {
  const statePath = path.join(homeDir, '.codex', 'state_5.sqlite');
  if (!fs.existsSync(statePath)) return [];

  let db: Database.Database | null = null;
  try {
    db = new Database(statePath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `
        SELECT id, rollout_path
        FROM threads
        WHERE rollout_path IS NOT NULL AND rollout_path != ''
        ORDER BY updated_at ASC
        `,
      )
      .all() as CodexThreadRow[];

    const seen = new Set<string>();
    const candidates: CodexSessionCandidate[] = [];
    for (const row of rows) {
      const filePath = normalizeRolloutPath(homeDir, row.rollout_path);
      if (seen.has(filePath) || !fs.existsSync(filePath)) continue;
      seen.add(filePath);
      candidates.push({ filePath, sessionId: row.id || extractCodexSessionId(filePath) });
    }
    return candidates;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function discoverCodexSessionCandidatesFromFiles(homeDir: string): CodexSessionCandidate[] {
  const codexSessionsDir = path.join(homeDir, '.codex', 'sessions');
  if (!fs.existsSync(codexSessionsDir)) return [];
  const files = collectJsonlFiles(codexSessionsDir).filter((f) =>
    /rollout-.*\.jsonl$/.test(path.basename(f)),
  );
  return files.map((filePath) => ({ filePath, sessionId: extractCodexSessionId(filePath) }));
}

function discoverCodexSessionCandidates(): CodexSessionCandidate[] {
  const homeDir = os.homedir();
  const fromState = discoverCodexSessionCandidatesFromState(homeDir);
  if (fromState.length > 0) return fromState;
  return discoverCodexSessionCandidatesFromFiles(homeDir);
}

export function discoverCodexSessionLogs(): string[] {
  return discoverCodexSessionCandidates().map((candidate) => candidate.filePath);
}

export class CodexAdapter implements SessionLogAdapter {
  readonly provider = 'codex' as const;

  discover(): DiscoveredSessionLog[] {
    const candidates = discoverCodexSessionCandidates();
    const discovered: DiscoveredSessionLog[] = [];
    for (const candidate of candidates) {
      const sessionId = candidate.sessionId || extractCodexSessionId(candidate.filePath);
      if (!sessionId) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(candidate.filePath);
      } catch {
        continue;
      }
      discovered.push({
        provider: this.provider,
        filePath: candidate.filePath,
        sessionId,
        mtimeMs: Math.floor(stat.mtimeMs),
        sizeBytes: stat.size,
      });
    }
    return discovered;
  }

  parse(filePath: string): ParsedSessionLog {
    return parseCodexSessionLog(filePath);
  }
}
