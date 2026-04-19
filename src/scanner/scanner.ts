import chalk from 'chalk';
import type { VitalsDB } from '../db/database';
import type {
  DiscoveredSessionLog,
  ParsedSessionLog,
  SessionLogAdapter,
  SessionProvider,
} from './types';

// Signature-to-content correlation factor from the original analysis (r=0.97)
const SIGNATURE_TO_CONTENT_RATIO = 4.26;

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type SourceFilter = SessionProvider | 'all';

export interface ScanOptions {
  force?: boolean;
  verbose?: boolean;
  /** Which registered adapter(s) to run. Defaults to running every registered adapter. */
  source?: SourceFilter;
}

export interface ScanResult {
  scanned: number;
  skipped: number;
  errors: number;
}

export class Scanner {
  private db: VitalsDB;
  private adapters: SessionLogAdapter[];

  constructor(db: VitalsDB, adapters: SessionLogAdapter[]) {
    this.db = db;
    this.adapters = adapters;
  }

  scan(options: ScanOptions = {}): ScanResult {
    const source = options.source ?? 'all';
    const selected =
      source === 'all' ? this.adapters : this.adapters.filter((a) => a.provider === source);

    if (selected.length === 0) {
      if (options.verbose) {
        console.log(chalk.yellow(`No registered adapters match source "${source}"`));
      }
      return { scanned: 0, skipped: 0, errors: 0 };
    }

    let scanned = 0;
    let skipped = 0;
    let errors = 0;

    for (const adapter of selected) {
      const discovered = adapter.discover();
      if (options.verbose) {
        console.log(
          chalk.gray(`Found ${discovered.length} ${adapter.provider} session log file(s)`),
        );
      }

      for (const entry of discovered) {
        if (!options.force) {
          const existing = this.db.getSessionSourceMeta(entry.sessionId);
          if (
            existing &&
            existing.source_mtime_ms === entry.mtimeMs &&
            existing.source_size_bytes === entry.sizeBytes
          ) {
            skipped++;
            continue;
          }
        }

        try {
          if (options.verbose) {
            console.log(chalk.gray(`  Scanning: ${entry.filePath}`));
          }
          const parsed = adapter.parse(entry.filePath);
          this.ingestParsedSession(parsed, entry);
          scanned++;
        } catch (err: unknown) {
          if (options.verbose) {
            console.log(chalk.red(`  Error scanning ${entry.filePath}: ${getErrorMessage(err)}`));
          }
          errors++;
        }
      }
    }

    return { scanned, skipped, errors };
  }

  private ingestParsedSession(parsed: ParsedSessionLog, discovered: DiscoveredSessionLog) {
    const filePath = discovered.filePath;
    const projectPath = parsed.metadata.projectPath || this.extractProjectPath(filePath);
    const projectName = parsed.metadata.projectName || this.extractProjectName(projectPath);
    const sessionId = parsed.metadata.sessionId || discovered.sessionId;

    // Collect human prompts from user messages
    const humanPrompts = parsed.userMessages.filter((m) => m.isHumanPrompt);

    // Collect all tool results from user messages that have them
    const allToolResults = parsed.userMessages.flatMap((m) =>
      m.toolResults.map((tr) => ({
        ...tr,
        messageUuid: m.uuid,
        timestamp: m.timestamp,
      })),
    );

    // Build a global sequence counter for tool calls
    let seqNum = 0;

    const ingestAll = this.db.db.transaction(() => {
      // Delete any prior rows for this session (idempotent reingest)
      this.db.deleteSessionData(sessionId);

      // Insert session
      this.db.insertSession({
        id: sessionId,
        project_path: projectPath,
        project_name: projectName,
        started_at: parsed.metadata.startedAt || undefined,
        ended_at: parsed.metadata.endedAt || undefined,
        model: parsed.metadata.model || undefined,
        version: parsed.metadata.version || undefined,
        cwd: parsed.metadata.cwd || undefined,
        git_branch: parsed.metadata.gitBranch || undefined,
        total_messages: parsed.totalMessages,
        total_user_prompts: humanPrompts.length,
        total_tool_calls: parsed.totalToolCalls,
        source_path: filePath,
        source_mtime_ms: discovered.mtimeMs,
        source_size_bytes: discovered.sizeBytes,
        provider: discovered.provider,
      });

      // Insert user prompts
      for (const up of humanPrompts) {
        this.db.insertUserPrompt({
          session_id: sessionId,
          message_uuid: up.uuid || undefined,
          timestamp: up.timestamp || undefined,
          content_text: up.contentText?.substring(0, 10000),
          content_length: up.contentLength,
          word_count: up.wordCount,
          has_frustration: up.sentiment.hasFrustration,
          positive_word_count: up.sentiment.positiveWordCount,
          negative_word_count: up.sentiment.negativeWordCount,
          is_interrupt: up.isInterrupt,
        });
      }

      // Insert assistant messages with their nested data
      for (const am of parsed.assistantMessages) {
        const msgId = this.db.insertMessage({
          session_id: sessionId,
          uuid: am.uuid || undefined,
          parent_uuid: am.parentUuid || undefined,
          type: 'assistant',
          role: 'assistant',
          timestamp: am.timestamp || undefined,
          model: am.model || undefined,
          content_text: am.textContent?.substring(0, 10000),
          content_length: am.textContentLength,
          is_sidechain: am.isSidechain,
          request_id: am.requestId || undefined,
          input_tokens: am.usage?.input_tokens,
          output_tokens: am.usage?.output_tokens,
          cache_creation_tokens: am.usage?.cache_creation_input_tokens,
          cache_read_tokens: am.usage?.cache_read_input_tokens,
        });

        // Insert thinking blocks
        for (const tb of am.thinkingBlocks) {
          const estimatedDepth =
            tb.estimatedDepth ??
            (tb.isRedacted
              ? Math.round(tb.signatureLength * SIGNATURE_TO_CONTENT_RATIO)
              : tb.contentLength);

          this.db.insertThinkingBlock({
            session_id: sessionId,
            message_id: msgId,
            message_uuid: am.uuid || undefined,
            is_redacted: tb.isRedacted,
            content_length: tb.contentLength,
            signature_length: tb.signatureLength,
            estimated_depth: estimatedDepth,
            timestamp: am.timestamp || undefined,
          });
        }

        // Insert tool calls from this assistant message
        for (const tc of am.toolCalls) {
          seqNum++;
          this.db.insertToolCall({
            session_id: sessionId,
            message_id: msgId,
            message_uuid: am.uuid || undefined,
            tool_call_id: tc.toolUseId || undefined,
            tool_name: tc.toolName,
            tool_input_json: JSON.stringify(tc.input),
            target_file: tc.targetFile || undefined,
            timestamp: am.timestamp || undefined,
            sequence_num: seqNum,
            category: tc.category,
            is_mutation: tc.isMutation,
            is_research: tc.isResearch,
            bash_command: tc.bashCommand || undefined,
            bash_is_build: tc.bashIsBuild,
            bash_is_test: tc.bashIsTest,
            bash_is_git: tc.bashIsGit,
            bash_success: null, // determined from tool results below
          });
        }

        // Insert laziness violations from this message
        for (const lv of am.lazinessViolations) {
          this.db.insertLazinessViolation({
            session_id: sessionId,
            message_uuid: am.uuid || undefined,
            timestamp: am.timestamp || undefined,
            category: lv.category,
            matched_phrase: lv.phrase,
            surrounding_text: lv.surroundingText,
          });
        }

        // Insert reasoning loops from this message
        for (const rl of am.reasoningLoops) {
          this.db.insertReasoningLoop({
            session_id: sessionId,
            message_uuid: am.uuid || undefined,
            timestamp: am.timestamp || undefined,
            matched_phrase: rl.phrase,
            surrounding_text: rl.surroundingText,
          });
        }

        // Insert self-admitted failures from this message
        for (const sf of am.selfAdmittedFailures) {
          this.db.insertSelfAdmittedFailure({
            session_id: sessionId,
            message_uuid: am.uuid || undefined,
            timestamp: am.timestamp || undefined,
            matched_phrase: sf.phrase,
            surrounding_text: sf.surroundingText,
          });
        }
      }

      // Insert tool results
      for (const tr of allToolResults) {
        this.db.insertToolResult({
          session_id: sessionId,
          tool_use_id: tr.toolUseId,
          message_uuid: tr.messageUuid || undefined,
          content_text: tr.content?.substring(0, 5000),
          content_length: tr.contentLength,
          is_error: tr.isError,
          timestamp: tr.timestamp || undefined,
        });
      }

      // Update bash success from tool results via tool_call_id join
      this.db.updateBashSuccessForSession(sessionId);
    });

    ingestAll();
  }

  private extractProjectPath(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    const projIdx = parts.indexOf('projects');
    if (projIdx >= 0 && projIdx + 1 < parts.length) {
      return parts[projIdx + 1];
    }
    return 'unknown';
  }

  private extractProjectName(projectPath: string): string {
    const parts = projectPath.split('--');
    return parts[parts.length - 1] || projectPath;
  }
}
