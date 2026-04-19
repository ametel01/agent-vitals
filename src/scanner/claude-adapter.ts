import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DiscoveredSessionLog,
  LazinessCategory,
  ParsedAssistantMessage,
  ParsedSessionLog,
  ParsedSystemMessage,
  ParsedThinkingBlock,
  ParsedToolCall,
  ParsedToolResult,
  ParsedUserMessage,
  SessionLogAdapter,
  TextPatternMatch,
  ToolCategory,
  UserPromptSentiment,
} from './types';

// ---------------------------------------------------------------------------
// Raw JSONL line shapes (Claude Code-specific on-disk format)
// ---------------------------------------------------------------------------

/** Content block types found in assistant message.content arrays */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type ContentBlock = ThinkingBlock | TextBlock | ToolUseBlock | ToolResultBlock;

/** Usage object on assistant messages (Claude on-disk shape) */
export interface ClaudeMessageUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: unknown;
  service_tier?: string;
  inference_geo?: string;
  speed?: unknown;
}

/** Inner message payload (nested under top-level "message" key) */
export interface InnerMessage {
  role: string;
  content: string | ContentBlock[];
  model?: string;
  usage?: ClaudeMessageUsage;
}

/** A single JSONL line (union of all entry types) */
export interface RawLogEntry {
  type: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  timestamp?: string;
  message?: InnerMessage;
  requestId?: string;
  promptId?: string;
  permissionMode?: string;
  userType?: string;
  entrypoint?: string;
  cwd?: string;
  sessionId?: string;
  version?: string;
  gitBranch?: string;
  toolUseResult?: unknown;
  sourceToolAssistantUUID?: string;
  durationMs?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Pattern detection constants
// ---------------------------------------------------------------------------

const REASONING_LOOP_PATTERNS: string[] = [
  'oh wait',
  'actually,',
  'let me reconsider',
  'hmm, actually',
  'no wait',
  'on second thought',
  'I was wrong about',
  'let me re-examine',
];

const LAZINESS_PATTERNS: Record<LazinessCategory, string[]> = {
  OWNERSHIP_DODGING: [
    'not caused by my changes',
    'existing issue',
    'pre-existing',
    'was already broken',
    'outside the scope',
    'unrelated to my changes',
  ],
  PERMISSION_SEEKING: [
    'should I continue?',
    'want me to keep going?',
    'shall I proceed?',
    'would you like me to',
    'do you want me to',
    "let me know if you'd like",
  ],
  PREMATURE_STOPPING: [
    'good stopping point',
    'natural checkpoint',
    "let's pause here",
    "I'll stop here",
    'that covers the main',
  ],
  KNOWN_LIMITATION: [
    'known limitation',
    'future work',
    'TODO for later',
    'we can address this later',
    'out of scope for now',
  ],
  SESSION_LENGTH: [
    'continue in a new session',
    'getting long',
    'fresh session',
    'context is getting large',
  ],
};

const SELF_ADMITTED_FAILURE_PATTERNS: string[] = [
  'that was lazy',
  'I was sloppy',
  'I rushed this',
  "you're right, that was wrong",
  'I should have',
  'my mistake',
  'I cut corners',
];

const POSITIVE_WORDS: string[] = [
  'great',
  'good',
  'love',
  'nice',
  'fantastic',
  'wonderful',
  'cool',
  'excellent',
  'perfect',
  'beautiful',
  'awesome',
  'thanks',
];

const NEGATIVE_WORDS: string[] = [
  'fuck',
  'shit',
  'damn',
  'wrong',
  'broken',
  'terrible',
  'horrible',
  'awful',
  'bad',
  'lazy',
  'sloppy',
  'stop',
  'incorrect',
];

const FRUSTRATION_PATTERNS: string[] = [
  'fuck',
  'shit',
  'damn',
  'wrong',
  'no',
  'stop',
  'I said',
  'I already told you',
  "that's not what I asked",
];

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

const READ_TOOLS = new Set(['Read', 'View', 'Cat']);
const EDIT_TOOLS = new Set(['Edit', 'str_replace', 'str_replace_editor', 'ApplyDiff']);
const WRITE_TOOLS = new Set(['Write', 'CreateFile']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'Find', 'Search', 'ListFiles', 'LS']);
const BASH_TOOLS = new Set(['Bash', 'Terminal']);
const AGENT_TOOLS = new Set(['Agent', 'TodoWrite', 'TaskCreate']);

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
];

const GIT_PATTERNS = [
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
  /\bgit\s+diff\b/,
  /\bgit\s+log\b/,
  /\bgit\s+status\b/,
  /\bgit\s+clone\b/,
  /\bgit\s+fetch\b/,
  /\bgit\s+tag\b/,
];

function classifyTool(name: string): {
  category: ToolCategory;
  isMutation: boolean;
  isResearch: boolean;
} {
  if (READ_TOOLS.has(name)) return { category: 'read', isMutation: false, isResearch: true };
  if (EDIT_TOOLS.has(name)) return { category: 'edit', isMutation: true, isResearch: false };
  if (WRITE_TOOLS.has(name)) return { category: 'write', isMutation: true, isResearch: false };
  if (SEARCH_TOOLS.has(name)) return { category: 'search', isMutation: false, isResearch: true };
  if (BASH_TOOLS.has(name)) return { category: 'bash', isMutation: false, isResearch: false };
  if (AGENT_TOOLS.has(name)) return { category: 'agent', isMutation: false, isResearch: false };
  return { category: 'other', isMutation: false, isResearch: false };
}

function classifyBashCommand(command: string): {
  isBuild: boolean;
  isTest: boolean;
  isGit: boolean;
} {
  return {
    isBuild: BUILD_PATTERNS.some((p) => p.test(command)),
    isTest: TEST_PATTERNS.some((p) => p.test(command)),
    isGit: GIT_PATTERNS.some((p) => p.test(command)),
  };
}

function extractTargetFile(input: Record<string, unknown>): string | null {
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  return null;
}

function extractBashCommand(input: Record<string, unknown>): string | null {
  if (typeof input.command === 'string') return input.command;
  return null;
}

// ---------------------------------------------------------------------------
// Text pattern detection helpers
// ---------------------------------------------------------------------------

function getSurroundingText(text: string, matchIndex: number, radius: number = 80): string {
  const start = Math.max(0, matchIndex - radius);
  const end = Math.min(text.length, matchIndex + radius);
  let result = text.slice(start, end);
  if (start > 0) result = `...${result}`;
  if (end < text.length) result = `${result}...`;
  return result;
}

function findPatternMatches(text: string, patterns: string[]): TextPatternMatch[] {
  const matches: TextPatternMatch[] = [];
  const lowerText = text.toLowerCase();
  for (const pattern of patterns) {
    const lowerPattern = pattern.toLowerCase();
    let searchFrom = 0;
    while (true) {
      const idx = lowerText.indexOf(lowerPattern, searchFrom);
      if (idx === -1) break;
      matches.push({
        phrase: pattern,
        surroundingText: getSurroundingText(text, idx),
      });
      searchFrom = idx + lowerPattern.length;
    }
  }
  return matches;
}

export function detectReasoningLoops(text: string): TextPatternMatch[] {
  return findPatternMatches(text, REASONING_LOOP_PATTERNS);
}

export function detectLazinessViolations(
  text: string,
): Array<TextPatternMatch & { category: LazinessCategory }> {
  const violations: Array<TextPatternMatch & { category: LazinessCategory }> = [];
  for (const [cat, patterns] of Object.entries(LAZINESS_PATTERNS) as Array<
    [LazinessCategory, string[]]
  >) {
    const matches = findPatternMatches(text, patterns);
    for (const match of matches) {
      violations.push({ ...match, category: cat });
    }
  }
  return violations;
}

export function detectSelfAdmittedFailures(text: string): TextPatternMatch[] {
  return findPatternMatches(text, SELF_ADMITTED_FAILURE_PATTERNS);
}

export function analyzeUserSentiment(text: string): UserPromptSentiment {
  const lowerText = text.toLowerCase();
  // Split on word boundaries for word-level matching
  const words = lowerText.split(/\W+/).filter(Boolean);

  let positiveWordCount = 0;
  let negativeWordCount = 0;

  for (const word of words) {
    if (POSITIVE_WORDS.includes(word)) positiveWordCount++;
    if (NEGATIVE_WORDS.includes(word)) negativeWordCount++;
  }

  // Frustration detection: check phrase patterns against full text, plus single-word matches
  let hasFrustration = false;
  for (const pattern of FRUSTRATION_PATTERNS) {
    if (lowerText.includes(pattern.toLowerCase())) {
      hasFrustration = true;
      break;
    }
  }

  return { positiveWordCount, negativeWordCount, hasFrustration };
}

// ---------------------------------------------------------------------------
// Content extraction helpers
// ---------------------------------------------------------------------------

function flattenContentToText(content: string | ContentBlock[] | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const textParts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof (block as TextBlock).text === 'string') {
      textParts.push((block as TextBlock).text);
    }
  }
  return textParts.join('\n');
}

function extractToolResultContent(
  content: string | ContentBlock[] | undefined,
): ParsedToolResult[] {
  if (!content || typeof content === 'string' || !Array.isArray(content)) return [];

  const results: ParsedToolResult[] = [];
  for (const block of content) {
    if (block.type === 'tool_result') {
      const tr = block as ToolResultBlock;
      const contentStr =
        typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? '');
      results.push({
        toolUseId: tr.tool_use_id || '',
        content: contentStr,
        contentLength: contentStr.length,
        isError: detectToolResultError(contentStr),
      });
    }
  }
  return results;
}

function detectToolResultError(content: string): boolean {
  if (!content) return false;
  const lower = content.toLowerCase();
  // Common error indicators in tool results
  return (
    lower.startsWith('error:') ||
    lower.startsWith('error ') ||
    lower.includes('command failed') ||
    lower.includes('exit code') ||
    lower.includes('enoent') ||
    lower.includes('permission denied') ||
    lower.includes('no such file') ||
    lower.includes('cannot find') ||
    lower.includes('fatal:') ||
    lower.includes('traceback (most recent call last)') ||
    lower.includes('syntaxerror') ||
    lower.includes('typeerror:') ||
    lower.includes('referenceerror:') ||
    /^error\b/i.test(content)
  );
}

export function detectInterrupt(text: string): boolean {
  return text.includes('[Request interrupted by user]');
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

function parseUserMessage(entry: RawLogEntry): ParsedUserMessage {
  const isToolResult = !!entry.toolUseResult || !!entry.sourceToolAssistantUUID;
  const contentText = flattenContentToText(entry.message?.content as string | ContentBlock[]);
  const toolResults = extractToolResultContent(entry.message?.content as string | ContentBlock[]);
  const isInterrupt = detectInterrupt(contentText);
  const wordCount = contentText.split(/\s+/).filter(Boolean).length;

  const isHumanPrompt = !isToolResult;
  const sentiment = isHumanPrompt
    ? analyzeUserSentiment(contentText)
    : { positiveWordCount: 0, negativeWordCount: 0, hasFrustration: false };

  return {
    uuid: entry.uuid || null,
    parentUuid: entry.parentUuid || null,
    isSidechain: !!entry.isSidechain,
    timestamp: entry.timestamp || null,
    promptId: entry.promptId || null,
    cwd: entry.cwd || null,
    sessionId: entry.sessionId || null,
    version: entry.version || null,
    gitBranch: entry.gitBranch || null,
    isHumanPrompt,
    contentText,
    contentLength: contentText.length,
    wordCount,
    isInterrupt,
    sentiment,
    toolResults,
  };
}

function parseAssistantMessage(entry: RawLogEntry): ParsedAssistantMessage {
  const content = entry.message?.content;
  const textContent = flattenContentToText(content as string | ContentBlock[]);
  const isInterrupt = detectInterrupt(textContent);

  const toolCalls: ParsedToolCall[] = [];
  const thinkingBlocks: ParsedThinkingBlock[] = [];

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_use') {
        const tu = block as ToolUseBlock;
        const inputObj =
          tu.input && typeof tu.input === 'object' ? (tu.input as Record<string, unknown>) : {};
        const classification = classifyTool(tu.name);
        const targetFile = extractTargetFile(inputObj);
        let bashCommand: string | null = null;
        let bashIsBuild = false;
        let bashIsTest = false;
        let bashIsGit = false;

        if (classification.category === 'bash') {
          bashCommand = extractBashCommand(inputObj);
          if (bashCommand) {
            const bashClass = classifyBashCommand(bashCommand);
            bashIsBuild = bashClass.isBuild;
            bashIsTest = bashClass.isTest;
            bashIsGit = bashClass.isGit;
          }
        }

        toolCalls.push({
          toolName: tu.name,
          toolUseId: tu.id || '',
          input: inputObj,
          targetFile,
          category: classification.category,
          isMutation: classification.isMutation,
          isResearch: classification.isResearch,
          bashCommand,
          bashIsBuild,
          bashIsTest,
          bashIsGit,
        });
      } else if (block.type === 'thinking') {
        const tb = block as ThinkingBlock;
        const isRedacted = tb.thinking === '' && !!tb.signature;
        thinkingBlocks.push({
          isRedacted,
          contentLength: (tb.thinking || '').length,
          signatureLength: (tb.signature || '').length,
        });
      }
    }
  }

  // Text pattern detection on the assistant's text output
  const reasoningLoops = detectReasoningLoops(textContent);
  const lazinessViolations = detectLazinessViolations(textContent);
  const selfAdmittedFailures = detectSelfAdmittedFailures(textContent);

  return {
    uuid: entry.uuid || null,
    parentUuid: entry.parentUuid || null,
    isSidechain: !!entry.isSidechain,
    timestamp: entry.timestamp || null,
    requestId: entry.requestId || null,
    model: entry.message?.model || null,
    usage: entry.message?.usage || null,
    textContent,
    textContentLength: textContent.length,
    toolCalls,
    thinkingBlocks,
    isInterrupt,
    reasoningLoops,
    lazinessViolations,
    selfAdmittedFailures,
  };
}

function parseSystemMessage(entry: RawLogEntry): ParsedSystemMessage {
  return {
    uuid: entry.uuid || null,
    timestamp: entry.timestamp || null,
    subtype: entry.subtype || null,
    durationMs: typeof entry.durationMs === 'number' ? entry.durationMs : null,
  };
}

// ---------------------------------------------------------------------------
// Session metadata extraction
// ---------------------------------------------------------------------------

function extractProjectInfoFromPath(filePath: string): {
  projectPath: string;
  projectName: string | null;
} {
  // Session logs live at ~/.claude/projects/<encoded-project-path>/<sessionId>.jsonl
  // The encoded project path uses URL-encoded slashes: e.g., -Users-foo-myproject or C%3A-Users-...
  const normalized = filePath.replace(/\\/g, '/');
  const projectsIdx = normalized.indexOf('.claude/projects/');
  if (projectsIdx === -1) {
    return { projectPath: path.dirname(filePath), projectName: null };
  }

  const afterProjects = normalized.slice(projectsIdx + '.claude/projects/'.length);
  // Split: first segment is the encoded project path, rest is the JSONL file (possibly under subagents/)
  const parts = afterProjects.split('/');

  // The encoded project name is the first path component after projects/
  const encodedProjectName = parts[0];

  // Decode: replace URL-encoded chars and leading dashes that represent path separators
  const projectPath = decodeURIComponent(encodedProjectName);
  // Common encoding: dashes for slashes on some systems
  // But also real dashes exist in paths, so we only decode if it looks encoded
  // The actual encoding uses the literal directory name, which may have dashes for path separators

  const projectName = projectPath.split(/[/\\]/).filter(Boolean).pop() || encodedProjectName;

  return { projectPath, projectName };
}

function extractSessionIdFromPath(filePath: string): string | null {
  const basename = path.basename(filePath, '.jsonl');
  // Session files are typically named with a UUID: e.g., abc123-def456-....jsonl
  return basename || null;
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

/**
 * Parse a single Claude Code session log (JSONL file).
 *
 * Reads the file synchronously, splits by newline, and parses each JSON line.
 * Malformed lines are silently skipped (counted in parseErrors).
 */
export function parseClaudeSessionLog(filePath: string): ParsedSessionLog {
  const { projectPath, projectName } = extractProjectInfoFromPath(filePath);

  const result: ParsedSessionLog = {
    filePath,
    metadata: {
      sessionId: null,
      projectPath,
      projectName,
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
    // File unreadable — return empty result
    return result;
  }

  const lines = fileContent.split('\n');
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry: RawLogEntry;
    try {
      entry = JSON.parse(trimmed) as RawLogEntry;
    } catch {
      result.parseErrors++;
      continue;
    }

    result.totalMessages++;

    // Track timestamps for session boundary detection
    if (entry.timestamp) {
      if (!firstTimestamp) firstTimestamp = entry.timestamp;
      lastTimestamp = entry.timestamp;
    }

    switch (entry.type) {
      case 'user': {
        const parsed = parseUserMessage(entry);
        result.userMessages.push(parsed);

        if (parsed.isHumanPrompt) {
          result.totalUserPrompts++;
        }

        // Extract session metadata from the first user message (richest source)
        if (!result.metadata.sessionId && entry.sessionId) {
          result.metadata.sessionId = entry.sessionId;
        }
        if (!result.metadata.version && entry.version) {
          result.metadata.version = entry.version;
        }
        if (!result.metadata.cwd && entry.cwd) {
          result.metadata.cwd = entry.cwd;
        }
        if (!result.metadata.gitBranch && entry.gitBranch) {
          result.metadata.gitBranch = entry.gitBranch;
        }
        break;
      }

      case 'assistant': {
        const parsed = parseAssistantMessage(entry);
        result.assistantMessages.push(parsed);
        result.totalToolCalls += parsed.toolCalls.length;

        // Extract model from assistant messages
        if (!result.metadata.model && parsed.model) {
          result.metadata.model = parsed.model;
        }
        break;
      }

      case 'system': {
        result.systemMessages.push(parseSystemMessage(entry));
        break;
      }

      // Other types (file-history-snapshot, attachment, queue-operation) are
      // intentionally not parsed in detail — they don't contain content we track.
      default:
        break;
    }
  }

  // Fall back to file-derived session ID if none found in content
  if (!result.metadata.sessionId) {
    result.metadata.sessionId = extractSessionIdFromPath(filePath);
  }

  result.metadata.startedAt = firstTimestamp;
  result.metadata.endedAt = lastTimestamp;

  return result;
}

// ---------------------------------------------------------------------------
// Session log discovery
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .jsonl files under a directory.
 */
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

/**
 * Discover all Claude Code session log files.
 *
 * Searches:
 * - ~/.claude/projects/ (or %USERPROFILE%\.claude\projects\ on Windows)
 * - WSL home directories when running on Windows
 *
 * Returns absolute paths to all discovered .jsonl files.
 */
export function discoverClaudeSessionLogs(): string[] {
  const allFiles: string[] = [];
  const isWindows = process.platform === 'win32';

  // Primary location: user home
  const homeDir = os.homedir();
  const claudeProjectsDir = path.join(homeDir, '.claude', 'projects');
  if (fs.existsSync(claudeProjectsDir)) {
    allFiles.push(...collectJsonlFiles(claudeProjectsDir));
  }

  // On Windows, also check common WSL home paths
  if (isWindows) {
    const _wslPaths = [
      // Default WSL distros store homes under \\wsl$\<distro>\home\<user>
      // or \\wsl.localhost\<distro>\home\<user>
      // We check common locations
    ];

    // Check each WSL distro that might be installed
    const wslRoots = ['\\\\wsl$', '\\\\wsl.localhost'];
    for (const wslRoot of wslRoots) {
      try {
        if (!fs.existsSync(wslRoot)) continue;
        const distros = fs.readdirSync(wslRoot);
        for (const distro of distros) {
          // Check /home/*/.claude/projects and /root/.claude/projects
          const homePath = path.join(wslRoot, distro, 'home');
          try {
            if (fs.existsSync(homePath)) {
              const users = fs.readdirSync(homePath);
              for (const user of users) {
                const wslClaudeProjects = path.join(homePath, user, '.claude', 'projects');
                if (fs.existsSync(wslClaudeProjects)) {
                  allFiles.push(...collectJsonlFiles(wslClaudeProjects));
                }
              }
            }
          } catch {
            // WSL path not accessible
          }
          // Also check root home
          const rootClaudeProjects = path.join(wslRoot, distro, 'root', '.claude', 'projects');
          try {
            if (fs.existsSync(rootClaudeProjects)) {
              allFiles.push(...collectJsonlFiles(rootClaudeProjects));
            }
          } catch {
            // Not accessible
          }
        }
      } catch {
        // WSL root not accessible
      }
    }
  }

  // Deduplicate (in case of symlinks or overlapping mounts)
  const seen = new Set<string>();
  const deduplicated: string[] = [];
  for (const f of allFiles) {
    const normalized = path.normalize(f);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      deduplicated.push(normalized);
    }
  }

  return deduplicated;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

const CLAUDE_SESSION_ID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function extractClaudeSessionId(filePath: string): string | null {
  const match = filePath.match(CLAUDE_SESSION_ID_RE);
  return match ? match[1] : null;
}

export class ClaudeAdapter implements SessionLogAdapter {
  readonly provider = 'claude' as const;

  discover(): DiscoveredSessionLog[] {
    const files = discoverClaudeSessionLogs();
    const discovered: DiscoveredSessionLog[] = [];
    for (const filePath of files) {
      const sessionId = extractClaudeSessionId(filePath);
      if (!sessionId) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      discovered.push({
        provider: this.provider,
        filePath,
        sessionId,
        mtimeMs: Math.floor(stat.mtimeMs),
        sizeBytes: stat.size,
      });
    }
    return discovered;
  }

  parse(filePath: string): ParsedSessionLog {
    return parseClaudeSessionLog(filePath);
  }
}
