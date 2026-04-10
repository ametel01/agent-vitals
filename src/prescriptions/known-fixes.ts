export interface PrescriptionTemplate {
  type: 'env_var' | 'settings_json' | 'claude_md';
  key: string;
  value: string | number | boolean;
  description: string;
}

export interface KnownFix {
  metric: string;
  label: string;
  direction: 'above' | 'below';
  warningThreshold: number;
  criticalThreshold: number;
  prescriptions: PrescriptionTemplate[];
}

export const KNOWN_FIXES: KnownFix[] = [
  {
    metric: 'thinking_depth_median',
    label: 'Thinking Depth',
    direction: 'below',
    warningThreshold: 2200,
    criticalThreshold: 600,
    prescriptions: [
      {
        type: 'env_var',
        key: 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
        value: '1',
        description: 'Disable adaptive thinking reduction — forces full thinking depth on every response',
      },
      {
        type: 'env_var',
        key: 'MAX_THINKING_TOKENS',
        value: '31999',
        description: 'Set maximum thinking tokens to 32K — prevents thinking budget from being capped',
      },
      {
        type: 'settings_json',
        key: 'effortLevel',
        value: 'high',
        description: 'Set effort level to high — allocates more compute per response',
      },
      {
        type: 'settings_json',
        key: 'showThinkingSummaries',
        value: true,
        description: 'Show thinking summaries — makes thinking depth visible so you can monitor it',
      },
    ],
  },
  {
    metric: 'read_edit_ratio',
    label: 'Read:Edit Ratio',
    direction: 'below',
    warningThreshold: 6.6,
    criticalThreshold: 2.0,
    prescriptions: [
      {
        type: 'claude_md',
        key: 'read_before_edit',
        value: 'Before ANY edit, you MUST read the target file AND at least 2 related files (imports, tests, callers). No exceptions. A file you have not read in the last 10 tool calls is a file you do not understand.',
        description: 'Enforce read-before-edit discipline',
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
        type: 'claude_md',
        key: 'zero_blind_edits',
        value: 'For EVERY edit, verify: "Have I Read this exact file in the last 10 tool calls?" If the answer is no, Read it NOW before editing. Zero tolerance for blind edits — they cause spliced comments, duplicated logic, and broken conventions.',
        description: 'Zero tolerance policy for blind edits',
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
        type: 'claude_md',
        key: 'surgical_edits',
        value: 'Never use Write or CreateFile to modify existing files. Always use Edit for surgical, targeted changes. Write is ONLY for creating brand new files. Full-file rewrites lose precision — they clobber surrounding code, drop comments, and reset formatting.',
        description: 'Enforce surgical edits over full-file rewrites',
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
        type: 'claude_md',
        key: 'banned_laziness_phrases',
        value: `BANNED PHRASES — never use any of these:
- "Should I continue?" / "Want me to keep going?" / "Shall I proceed?"
- "Would you like me to..." / "Do you want me to..." / "Let me know if you'd like..."
- "Good stopping point" / "Natural checkpoint" / "Let's pause here" / "I'll stop here"
- "Known limitation" / "Future work" / "TODO for later" / "Out of scope for now"
- "Continue in a new session" / "Context is getting large" / "Fresh session"

Do the work. Complete the task. Never ask permission to stop.`,
        description: 'Ban laziness phrases across 5 categories',
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
        type: 'claude_md',
        key: 'resolve_internally',
        value: 'Resolve all contradictions and uncertainties internally before producing output. Do not self-correct visibly ("oh wait", "actually", "let me reconsider"). If you catch an error in your reasoning, restart the thought silently. Visible self-corrections indicate insufficient thinking depth.',
        description: 'Enforce internal contradiction resolution',
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
        type: 'claude_md',
        key: 'thoroughness',
        value: 'Be thorough. Read more context before acting. Make smaller, verifiable changes. Do not produce partial work. Do not ask unnecessary questions — find the answers in the code. Every response should leave the codebase in a better state than you found it.',
        description: 'Enforce thoroughness to reduce user frustration',
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
        type: 'claude_md',
        key: 'verify_before_moving_on',
        value: 'Read the full file before editing any part of it. After making a change, verify it compiles and is correct. Do not move to the next task until the current change is verified. Prevention is better than apology.',
        description: 'Enforce verification before moving on',
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
        type: 'claude_md',
        key: 'slow_down',
        value: 'Slow down. Read more context before acting. Make smaller, verifiable changes instead of large speculative ones. Check your work before presenting it. Each user interrupt means you did something wrong that the user had to stop and fix.',
        description: 'Enforce careful, incremental changes',
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
        type: 'claude_md',
        key: 'verify_commands',
        value: 'Before running any bash command, verify: (1) the working directory is correct, (2) required files exist, (3) the command syntax is valid. After a failure, read the FULL error output before retrying. Do not retry the same command blindly.',
        description: 'Enforce command verification before execution',
      },
    ],
  },
  {
    metric: 'cost_estimate',
    label: 'Cost Estimate',
    direction: 'above',
    warningThreshold: 500,
    criticalThreshold: 1500,
    prescriptions: [
      {
        type: 'settings_json',
        key: 'effortLevel',
        value: 'high',
        description: 'Set effort level to high — counterintuitively, higher effort means fewer retries and less wasted compute',
      },
      {
        type: 'claude_md',
        key: 'reduce_churn',
        value: 'Minimize edit churn. Plan changes before making them. Read context thoroughly so edits are correct on the first attempt. Each retry wastes tokens and money.',
        description: 'Reduce token waste through better planning',
      },
    ],
  },
];
