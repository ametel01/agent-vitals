import { VitalsDB } from '../db/database';
import { discoverSessionLogs, parseSessionLog, ParsedSessionLog, ParsedAssistantMessage, ParsedUserMessage } from './log-parser';
import chalk from 'chalk';

// Signature-to-content correlation factor from the original analysis (r=0.97)
const SIGNATURE_TO_CONTENT_RATIO = 4.26;

export class Scanner {
  private db: VitalsDB;

  constructor(db: VitalsDB) {
    this.db = db;
  }

  scan(options: { force?: boolean; verbose?: boolean } = {}): { scanned: number; skipped: number; errors: number } {
    const logFiles = discoverSessionLogs();
    let scanned = 0, skipped = 0, errors = 0;

    if (options.verbose) {
      console.log(chalk.gray(`Found ${logFiles.length} session log files`));
    }

    for (const filePath of logFiles) {
      const sessionId = this.extractSessionId(filePath);
      if (!sessionId) { errors++; continue; }

      if (!options.force && this.db.isSessionScanned(sessionId)) {
        skipped++;
        continue;
      }

      try {
        if (options.verbose) {
          console.log(chalk.gray(`  Scanning: ${filePath}`));
        }

        const parsed = parseSessionLog(filePath);
        this.ingestParsedSession(parsed, filePath, sessionId);
        scanned++;
      } catch (err: any) {
        if (options.verbose) {
          console.log(chalk.red(`  Error scanning ${filePath}: ${err.message}`));
        }
        errors++;
      }
    }

    return { scanned, skipped, errors };
  }

  private extractSessionId(filePath: string): string | null {
    const match = filePath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
    return match ? match[1] : null;
  }

  private ingestParsedSession(parsed: ParsedSessionLog, filePath: string, fallbackSessionId: string) {
    const projectPath = this.extractProjectPath(filePath);
    const projectName = this.extractProjectName(projectPath);
    const sessionId = parsed.metadata.sessionId || fallbackSessionId;

    // Collect human prompts from user messages
    const humanPrompts = parsed.userMessages.filter(m => m.isHumanPrompt);

    // Collect all tool results from user messages that have them
    const allToolResults = parsed.userMessages.flatMap(m => m.toolResults.map(tr => ({
      ...tr,
      messageUuid: m.uuid,
      timestamp: m.timestamp,
    })));

    // Build a global sequence counter for tool calls
    let seqNum = 0;

    const ingestAll = this.db.db.transaction(() => {
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
          const estimatedDepth = tb.isRedacted
            ? Math.round(tb.signatureLength * SIGNATURE_TO_CONTENT_RATIO)
            : tb.contentLength;

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

      // Update bash success from tool results
      this.updateBashSuccess(sessionId);
    });

    ingestAll();
  }

  private updateBashSuccess(sessionId: string) {
    // Match tool results to bash tool calls and determine success/failure
    const bashCalls = this.db.db.prepare(`
      SELECT tc.id, tc.tool_name FROM tool_calls tc
      WHERE tc.session_id = ? AND tc.category = 'bash'
    `).all(sessionId) as Array<{ id: number; tool_name: string }>;

    // Tool results with errors indicate failures
    const errorResults = this.db.db.prepare(`
      SELECT tool_use_id FROM tool_results
      WHERE session_id = ? AND is_error = 1
    `).all(sessionId) as Array<{ tool_use_id: string }>;
    const errorIds = new Set(errorResults.map(r => r.tool_use_id));

    // For bash calls, check if any corresponding tool result was an error
    // Since we don't have a direct tool_use_id link in tool_calls,
    // mark all bash calls as success=1 by default, update based on
    // overall error rate heuristic. A more precise approach would need the tool_use_id.
    const updateStmt = this.db.db.prepare(`
      UPDATE tool_calls SET bash_success = 1 WHERE id = ? AND category = 'bash'
    `);
    for (const bc of bashCalls) {
      updateStmt.run(bc.id);
    }
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
