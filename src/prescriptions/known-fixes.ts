export interface PrescriptionTemplate {
  type: 'env_var' | 'settings_json' | 'claude_md' | 'permissions' | 'hook';
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
  // =========================================================================
  // THINKING DEPTH
  // =========================================================================
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
        description: 'Disable adaptive thinking — prevents the system from reducing thinking depth under load',
      },
      {
        type: 'env_var',
        key: 'MAX_THINKING_TOKENS',
        value: '31999',
        description: 'Max thinking tokens to 32K — prevents thinking budget from being silently capped',
      },
      {
        type: 'env_var',
        key: 'CLAUDE_CODE_MAX_THINKING_TOKENS',
        value: '31999',
        description: 'Alternate env var for max thinking tokens (some versions use this key)',
      },
      {
        type: 'settings_json',
        key: 'effortLevel',
        value: 'high',
        description: 'Effort level → high — allocates more compute per response',
      },
      {
        type: 'settings_json',
        key: 'showThinkingSummaries',
        value: true,
        description: 'Show thinking summaries — makes thinking depth visible for monitoring',
      },
      {
        type: 'claude_md',
        key: 'think_deeply',
        value: 'Think carefully and deeply before responding. For every task: (1) identify what could go wrong, (2) list your assumptions, (3) check what you haven\'t verified, (4) plan your approach before acting. Never rush to output.',
        description: 'Enforce deep thinking discipline',
      },
    ],
  },

  // =========================================================================
  // READ:EDIT RATIO
  // =========================================================================
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
      {
        type: 'permissions',
        key: 'allow_read_tools',
        value: 'Read,Glob,Grep',
        description: 'Auto-allow read tools — removes permission friction that discourages research',
      },
      {
        type: 'claude_md',
        key: 'research_first_workflow',
        value: `For every task, follow this workflow:
1. Read the target file(s) completely
2. Grep for the symbol/function being modified across the codebase
3. Read files that import or depend on the target
4. Read relevant test files
5. Only THEN make your edit
Never skip steps 1-4. The extra 30 seconds of reading prevents 10 minutes of debugging.`,
        description: 'Enforce research-first workflow',
      },
    ],
  },

  // =========================================================================
  // BLIND EDIT RATE
  // =========================================================================
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

  // =========================================================================
  // WRITE VS EDIT
  // =========================================================================
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

  // =========================================================================
  // LAZINESS
  // =========================================================================
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
- "Not caused by my changes" / "Existing issue" / "Pre-existing" / "Outside the scope"

Do the work. Complete the task. Never ask permission to stop. Never dodge ownership.`,
        description: 'Ban laziness phrases across all 5 categories',
      },
      {
        type: 'claude_md',
        key: 'ownership',
        value: 'Take full ownership of every task. If you break something, fix it. If a test fails after your change, the test failure IS your problem. Do not blame pre-existing issues unless you can prove it with evidence (git blame, test history).',
        description: 'Enforce full task ownership',
      },
    ],
  },

  // =========================================================================
  // REASONING LOOPS
  // =========================================================================
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
      {
        type: 'env_var',
        key: 'MAX_THINKING_TOKENS',
        value: '31999',
        description: 'Increase thinking budget — reasoning loops leak when thinking is too shallow',
      },
    ],
  },

  // =========================================================================
  // FRUSTRATION
  // =========================================================================
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
      {
        type: 'settings_json',
        key: 'effortLevel',
        value: 'high',
        description: 'Higher effort level reduces the errors that cause user frustration',
      },
    ],
  },

  // =========================================================================
  // SELF-ADMITTED FAILURES
  // =========================================================================
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

  // =========================================================================
  // USER INTERRUPTS
  // =========================================================================
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

  // =========================================================================
  // BASH SUCCESS
  // =========================================================================
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
        value: 'Before running any bash command, verify: (1) the working directory is correct, (2) required files exist, (3) the command syntax is valid for this OS. After a failure, read the FULL error output before retrying. Do not retry the same command blindly.',
        description: 'Enforce command verification before execution',
      },
      {
        type: 'permissions',
        key: 'allow_bash',
        value: 'Bash(*)',
        description: 'Auto-allow bash — removes permission prompts that break command chains and cause partial failures',
      },
    ],
  },

  // =========================================================================
  // COST
  // =========================================================================
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
        description: 'Higher effort = fewer retries = less wasted compute (counterintuitive but proven)',
      },
      {
        type: 'claude_md',
        key: 'reduce_churn',
        value: 'Minimize edit churn. Plan changes before making them. Read context thoroughly so edits are correct on the first attempt. Each retry wastes tokens and money.',
        description: 'Reduce token waste through better planning',
      },
      {
        type: 'env_var',
        key: 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
        value: '1',
        description: 'Stable thinking depth prevents thrashing cycles that waste tokens',
      },
    ],
  },

  // =========================================================================
  // SENTIMENT
  // =========================================================================
  {
    metric: 'sentiment_ratio',
    label: 'Sentiment Ratio',
    direction: 'below',
    warningThreshold: 4.4,
    criticalThreshold: 3.0,
    prescriptions: [
      {
        type: 'settings_json',
        key: 'effortLevel',
        value: 'high',
        description: 'Higher effort produces better results, which improves user satisfaction',
      },
      {
        type: 'claude_md',
        key: 'quality_first',
        value: 'Prioritize correctness over speed. Read before editing. Test after changing. A correct answer that takes 60 seconds is better than a wrong answer in 10 seconds that requires 5 minutes of correction.',
        description: 'Prioritize quality to restore user confidence',
      },
    ],
  },

  // =========================================================================
  // SESSION AUTONOMY
  // =========================================================================
  {
    metric: 'session_autonomy_median',
    label: 'Session Autonomy',
    direction: 'below',
    warningThreshold: 10,
    criticalThreshold: 3,
    prescriptions: [
      {
        type: 'permissions',
        key: 'allow_all_read_tools',
        value: 'Read,Glob,Grep,Bash(*)',
        description: 'Auto-allow tools — permission prompts interrupt autonomous work and require user intervention',
      },
      {
        type: 'claude_md',
        key: 'work_autonomously',
        value: 'Work through problems independently. When you encounter an error, debug it yourself: read the error, check the code, try a fix. Do not stop to ask the user unless you have exhausted your own investigation (3+ attempts, different approaches).',
        description: 'Encourage autonomous problem-solving',
      },
    ],
  },

  // =========================================================================
  // EDIT CHURN
  // =========================================================================
  {
    metric: 'edit_churn_rate',
    label: 'Edit Churn Rate',
    direction: 'above',
    warningThreshold: 50,
    criticalThreshold: 200,
    prescriptions: [
      {
        type: 'claude_md',
        key: 'plan_before_editing',
        value: 'Before editing ANY file, state your plan: what you will change, why, and what might break. Then read the file. Then edit. If you need to edit the same file more than twice, STOP — re-read it completely and rethink your approach.',
        description: 'Plan changes to eliminate trial-and-error editing',
      },
      {
        type: 'env_var',
        key: 'MAX_THINKING_TOKENS',
        value: '31999',
        description: 'More thinking budget = better planning = fewer edit retries',
      },
    ],
  },

  // =========================================================================
  // PROMPTS PER SESSION
  // =========================================================================
  {
    metric: 'prompts_per_session',
    label: 'Prompts Per Session',
    direction: 'below',
    warningThreshold: 35.9,
    criticalThreshold: 27.9,
    prescriptions: [
      {
        type: 'claude_md',
        key: 'complete_tasks_fully',
        value: 'Complete every task fully before stopping. Do not deliver partial results. If a task has multiple parts, work through all of them in sequence. Users give up on sessions (shorter sessions, fewer prompts) when they lose confidence in quality.',
        description: 'Complete tasks fully to maintain session engagement',
      },
      {
        type: 'settings_json',
        key: 'effortLevel',
        value: 'high',
        description: 'Higher effort quality keeps users engaged longer',
      },
    ],
  },

  // =========================================================================
  // SUBAGENT USAGE
  // =========================================================================
  {
    metric: 'subagent_pct',
    label: 'Sub-agent Usage',
    direction: 'above',
    warningThreshold: 30,
    criticalThreshold: 50,
    prescriptions: [
      {
        type: 'claude_md',
        key: 'limit_delegation',
        value: 'Do not delegate to sub-agents for tasks you can handle directly. Sub-agents are for genuinely parallel work (researching while building, testing while fixing). Excessive delegation often means the main agent is avoiding complex work.',
        description: 'Limit unnecessary sub-agent delegation',
      },
    ],
  },

  // =========================================================================
  // FIRST TOOL READ %
  // =========================================================================
  {
    metric: 'first_tool_read_pct',
    label: 'First Tool = Read %',
    direction: 'below',
    warningThreshold: 40,
    criticalThreshold: 15,
    prescriptions: [
      {
        type: 'claude_md',
        key: 'always_read_first',
        value: 'After receiving ANY user prompt, your FIRST tool call must be Read, Grep, or Glob — never Edit, Write, or Bash. Understand the context before acting. This is non-negotiable.',
        description: 'Enforce read-first response pattern',
      },
    ],
  },

  // =========================================================================
  // RESEARCH:MUTATION RATIO
  // =========================================================================
  {
    metric: 'research_mutation_ratio',
    label: 'Research:Mutation Ratio',
    direction: 'below',
    warningThreshold: 8.7,
    criticalThreshold: 2.8,
    prescriptions: [
      {
        type: 'claude_md',
        key: 'research_broadly',
        value: 'Before any code change, perform ALL of these research steps: (1) Read the target file, (2) Grep for the function/symbol across the codebase, (3) Glob for related files (tests, configs, types), (4) Read import chains. Research broadly, then change precisely.',
        description: 'Enforce broad research before narrow mutations',
      },
    ],
  },
];

/**
 * Settings that should always be recommended regardless of metrics.
 * These are baseline "good hygiene" settings.
 */
export const BASELINE_SETTINGS: PrescriptionTemplate[] = [
  {
    type: 'env_var',
    key: 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
    value: '1',
    description: 'Prevent adaptive thinking reduction — the #1 cause of quality degradation per stellaraccident\'s analysis',
  },
  {
    type: 'env_var',
    key: 'MAX_THINKING_TOKENS',
    value: '31999',
    description: 'Maximum thinking token budget — ensures deep reasoning on every response',
  },
  {
    type: 'settings_json',
    key: 'effortLevel',
    value: 'high',
    description: 'High effort level — more compute per response, fewer retries needed',
  },
  {
    type: 'settings_json',
    key: 'showThinkingSummaries',
    value: true,
    description: 'Visible thinking summaries — lets you monitor reasoning depth',
  },
  {
    type: 'permissions',
    key: 'allow_read_tools',
    value: 'Read,Glob,Grep',
    description: 'Auto-allow read tools — removes friction that discourages thorough research',
  },
];
