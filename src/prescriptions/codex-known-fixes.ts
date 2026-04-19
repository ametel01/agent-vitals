import type { KnownFix, PrescriptionTemplate } from './known-fixes';

export const CODEX_BASELINE: PrescriptionTemplate[] = [
  {
    type: 'codex_rules',
    key: '~/.codex/rules/read-before-edit.rules',
    value:
      'For every code edit, read the target file and at least one related caller, test, or type definition before using apply_patch.',
    description: 'Baseline read-before-edit rule',
  },
  {
    type: 'codex_rules',
    key: '~/.codex/rules/verify-shell.rules',
    value:
      'Before shell commands, verify cwd and command syntax. After a failure, read the full error and change approach instead of retrying.',
    description: 'Baseline shell verification rule',
  },
  {
    type: 'project_instructions',
    key: 'AGENTS.md',
    value:
      'Finish all requested parts before stopping. Validate results before reporting completion.',
    description: 'Baseline task-completion instruction',
  },
];

export const CODEX_KNOWN_FIXES: KnownFix[] = [
  {
    metric: 'read_edit_ratio',
    label: 'Read:Edit Ratio',
    direction: 'below',
    warningThreshold: 6.6,
    criticalThreshold: 2.0,
    prescriptions: [
      {
        type: 'project_instructions',
        key: 'AGENTS.md',
        value:
          'Before patching code, inspect the target file, its direct callers, and relevant tests. Use rg/git/sed reads first, then make the smallest viable patch.',
        description: 'Add read-before-edit workflow to project instructions',
      },
      {
        type: 'codex_rules',
        key: '~/.codex/rules/read-before-edit.rules',
        value:
          'For every code edit, read the target file and at least one related caller, test, or type definition before using apply_patch.',
        description: 'Require target and related-file reads before patching',
      },
    ],
  },
  {
    metric: 'research_mutation_ratio',
    label: 'Research:Mutation Ratio',
    direction: 'below',
    warningThreshold: 8.7,
    criticalThreshold: 2.8,
    prescriptions: [
      {
        type: 'project_instructions',
        key: 'AGENTS.md',
        value:
          'Research broadly before mutating: search usages with rg, inspect related modules, and identify tests before editing. Prefer under-editing to speculative rewrites.',
        description: 'Add broad-research workflow to project instructions',
      },
    ],
  },
  {
    metric: 'blind_edit_rate',
    label: 'Blind Edit Rate',
    direction: 'above',
    warningThreshold: 6.2,
    criticalThreshold: 33.7,
    prescriptions: [
      {
        type: 'codex_rules',
        key: '~/.codex/rules/no-blind-patches.rules',
        value:
          'Do not call apply_patch for a file unless that exact file was read during the current turn. If context may be stale, re-read before patching.',
        description: 'Block blind patches by requiring a recent read',
      },
    ],
  },
  {
    metric: 'write_vs_edit_pct',
    label: 'Write vs Edit %',
    direction: 'above',
    warningThreshold: 4.9,
    criticalThreshold: 11.1,
    prescriptions: [
      {
        type: 'codex_rules',
        key: '~/.codex/rules/surgical-edits.rules',
        value:
          'Prefer apply_patch with minimal hunks. Avoid whole-file rewrites unless creating a new file or replacing generated output.',
        description: 'Prefer small patches over rewrites',
      },
    ],
  },
  {
    metric: 'bash_success_rate',
    label: 'Bash Success Rate',
    direction: 'below',
    warningThreshold: 90,
    criticalThreshold: 80,
    prescriptions: [
      {
        type: 'codex_rules',
        key: '~/.codex/rules/verify-shell.rules',
        value:
          'Before shell commands, verify cwd and command syntax. After a failure, read the full error and change approach instead of retrying the same command.',
        description: 'Require cwd, syntax, and full-error verification for shell commands',
      },
    ],
  },
  {
    metric: 'edit_churn_rate',
    label: 'Edit Churn Rate',
    direction: 'above',
    warningThreshold: 50,
    criticalThreshold: 200,
    prescriptions: [
      {
        type: 'codex_rules',
        key: '~/.codex/rules/small-verified-patches.rules',
        value:
          'Use smaller patches and verify after each change. If the same file needs a third edit, stop, re-read it fully, and make a fresh plan.',
        description: 'Reduce edit churn with smaller verified patches',
      },
    ],
  },
  {
    metric: 'first_tool_read_pct',
    label: 'First Tool = Read %',
    direction: 'below',
    warningThreshold: 40,
    criticalThreshold: 15,
    prescriptions: [
      {
        type: 'codex_rules',
        key: '~/.codex/rules/read-first.rules',
        value:
          'Start coding tasks with repository inspection: rg, git status/diff, sed, or ls. Do not begin with apply_patch unless the user supplied the complete target content.',
        description: 'Start turns with context gathering',
      },
    ],
  },
  {
    metric: 'reasoning_loops_per_1k',
    label: 'Reasoning Loops',
    direction: 'above',
    warningThreshold: 8.2,
    criticalThreshold: 26.6,
    prescriptions: [
      {
        type: 'project_instructions',
        key: 'AGENTS.md',
        value:
          'Resolve uncertainty before answering. When you discover a contradiction, inspect more context and revise the plan silently instead of narrating visible self-correction.',
        description: 'Add internal contradiction-resolution rule',
      },
    ],
  },
  {
    metric: 'laziness_total',
    label: 'Laziness Violations',
    direction: 'above',
    warningThreshold: 3,
    criticalThreshold: 10,
    prescriptions: [
      {
        type: 'project_instructions',
        key: 'AGENTS.md',
        value:
          'Complete the requested task end to end. Do not ask to stop, label unfinished work as future work, or dodge ownership of failures observed during verification.',
        description: 'Add ownership and completion rule',
      },
    ],
  },
  {
    metric: 'self_admitted_failures_per_1k',
    label: 'Self-Admitted Failures',
    direction: 'above',
    warningThreshold: 0.1,
    criticalThreshold: 0.5,
    prescriptions: [
      {
        type: 'codex_rules',
        key: '~/.codex/rules/verify-before-final.rules',
        value:
          'Before final response, run the narrowest relevant validation or explicitly state why it could not be run. Do not apologize for avoidable verification gaps.',
        description: 'Require validation before final response',
      },
    ],
  },
  {
    metric: 'user_interrupts_per_1k',
    label: 'User Interrupts',
    direction: 'above',
    warningThreshold: 0.9,
    criticalThreshold: 11.4,
    prescriptions: [
      {
        type: 'codex_rules',
        key: '~/.codex/rules/incremental-work.rules',
        value:
          'Make incremental, reversible changes. State assumptions briefly, verify before continuing, and avoid large speculative edits that force user interruption.',
        description: 'Favor incremental verified work',
      },
    ],
  },
  {
    metric: 'frustration_rate',
    label: 'Frustration Rate',
    direction: 'above',
    warningThreshold: 5.8,
    criticalThreshold: 9.8,
    prescriptions: [
      {
        type: 'project_instructions',
        key: 'AGENTS.md',
        value:
          'Prioritize correctness over speed. Read enough context, keep edits scoped, and validate results before reporting completion.',
        description: 'Add correctness-first project instruction',
      },
    ],
  },
  {
    metric: 'sentiment_ratio',
    label: 'Sentiment Ratio',
    direction: 'below',
    warningThreshold: 4.4,
    criticalThreshold: 3.0,
    prescriptions: [
      {
        type: 'codex_rules',
        key: '~/.codex/rules/quality-first.rules',
        value:
          'Optimize for correct, verified changes over fast responses. Prefer additional reading and validation to speculative implementation.',
        description: 'Emphasize correctness over speed',
      },
    ],
  },
  {
    metric: 'session_autonomy_median',
    label: 'Session Autonomy',
    direction: 'below',
    warningThreshold: 10,
    criticalThreshold: 3,
    prescriptions: [
      {
        type: 'codex_config_toml',
        key: '~/.codex/config.toml',
        value: 'approval_policy = "on-failure"',
        description:
          'Consider reducing approval friction for trusted workspaces so Codex can verify and iterate autonomously',
      },
      {
        type: 'project_instructions',
        key: 'AGENTS.md',
        value:
          'When a command or test fails, debug independently: inspect the error, read relevant code, make one targeted fix, and re-run validation before asking for help.',
        description: 'Add autonomous debugging workflow',
      },
    ],
  },
  {
    metric: 'prompts_per_session',
    label: 'Prompts Per Session',
    direction: 'below',
    warningThreshold: 35.9,
    criticalThreshold: 27.9,
    prescriptions: [
      {
        type: 'project_instructions',
        key: 'AGENTS.md',
        value:
          'Finish all requested parts before stopping. Summarize completed work, validation, and remaining risks only after the implementation is actually handled.',
        description: 'Improve task completion and session continuity',
      },
    ],
  },
  {
    metric: 'token_efficiency',
    label: 'Token Efficiency',
    direction: 'above',
    warningThreshold: 2500,
    criticalThreshold: 5000,
    prescriptions: [
      {
        type: 'codex_rules',
        key: '~/.codex/rules/token-efficient-work.rules',
        value:
          'Reduce retry loops by reading context before edits, batching related reads, and validating after each patch rather than narrating speculative fixes.',
        description: 'Reduce output tokens per successful edit',
      },
    ],
  },
  {
    metric: 'session_length_minutes',
    label: 'Session Length',
    direction: 'below',
    warningThreshold: 10,
    criticalThreshold: 3,
    prescriptions: [
      {
        type: 'project_instructions',
        key: 'AGENTS.md',
        value:
          'Keep working until the requested outcome is complete or a concrete blocker is proven. Do not stop after partial analysis when implementation is feasible.',
        description: 'Encourage longer complete work sessions',
      },
    ],
  },
];
