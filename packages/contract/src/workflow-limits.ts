// Contract §15: the limits a workflow (recipe) definition and run keep to.
export const WORKFLOW_LIMITS = {
  nameChars: 120,
  descriptionChars: 500,
  labelChars: 80,
  maxNodes: 30,
  maxEdges: 100,
  maxInputs: 10,
  inputLabelChars: 80,
  inputMaxChars: 4 * 1024,
  /** All start inputs of a run together. */
  startInputsBytes: 16 * 1024,
  /** The authored instruction template. */
  instructionBytes: 32 * 1024,
  questionBytes: 2 * 1024,
  branchTextChars: 200,
  maxBranchRules: 8,
  /** The final rendered, dispatched payload (wrappers, quoting, consumed results included), UTF-8 bytes. */
  payloadBytes: 32 * 1024,
  definitionBytes: 256 * 1024,
  maxDefinitions: 200,
  maxVersionsPerDefinition: 20,
  maxRetries: 2,
  /** Logical attempts per node = retries + 1. */
  maxAttemptsPerNode: 3,
  /** Σ over agent nodes of (retries + 1); the executor's own step limit. */
  maxSteps: 30,
  maxRemapsPerNode: 2,
  /** 7.7c: how often the person may renew a coding node whose dispatch was held back 20 times (does not spend retries). */
  maxRenewalsPerNode: 3,
  /** Stored sanitized output per attempt (the verdict is parsed from the complete reply before this cut). */
  outputBytes: 32 * 1024,
  /**
   * 7.7c: the longest eligible reply a verdict is read from (the whole reply, never a prefix). A coding agent's reply over
   * this fails its step "answer too long to read a verdict".
   */
  verdictInputBytes: 256 * 1024,
  verdictReasonChars: 500,
  /** Control history kept per run; older records fold into counters (journaled transitions are kept). */
  controlHistoryRecords: 200,
  /** Per run, kept free for Stop and obligation evidence. */
  protectedBytes: 64 * 1024,
  /** Consecutive refused dispatch generations after which a node waits as "Hermes unavailable". */
  refusedPause: 5,
  /** Timer for that wait, in minutes (a readiness change wakes it sooner). */
  refusedRetryMinutes: 10,
  /** Refused generations of one attempt after which only the person can continue (v8.3). */
  refusedLifetime: 20,
  /** Planner commands per pass are bounded by the node count. */
  commandsPerPass: 30,
} as const
