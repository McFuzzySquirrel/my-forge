// ─── Forge Console JSON contract ──────────────────────────────────────────────
//
// These are the wire types the console server emits and the browser client
// consumes. The client keeps an identical copy under dashboard/types.ts; keep
// the two in sync.

export interface AuditEvent {
  timestamp: string;
  action: string;
  runId?: string;
  taskId?: string;
  phaseId?: string;
  note?: string;
  durationMs?: number;
  artifactId?: string;
  reductionPercent?: number;
  outputFiles?: string[];
}

export interface ServiceTaskSnapshot {
  taskId: string;
  status: string;
  logicalAttempt?: number;
  startedAt?: string;
  completedAt?: string;
}

export interface ServiceRunSnapshot {
  runId: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
  /** Which runner accepted the submission; absent on older snapshots. */
  hostExecution?: boolean;
  tasks: ServiceTaskSnapshot[];
}

export interface ManifestTask {
  id: string;
  title: string;
  description: string;
  ownerAgent?: string;
  dependencies: string[];
  expectedOutputs: string[];
  validationCommands: string[];
  approvalRequired: boolean;
  sourceLines?: string[];
  inputs?: string[];
  produces?: string;
  timeoutMs?: number;
  contract?: {
    version: 1;
    kind: "implementation" | "human-review";
    requirements: string[];
    acceptanceCriteria: string[];
    constraints: string[];
    references: string[];
    reviewFile?: string;
  };
}

export interface ManifestPhase {
  id: string;
  title: string;
  description: string;
  feature?: string;
  ownerAgents: string[];
  dependencies: string[];
  approvalRequired: boolean;
  tasks: ManifestTask[];
}

export interface ExecutionManifest {
  version: string;
  generatedAt: string;
  granularity?: string;
  sourceLayout?: string;
  repoRoot: string;
  harnessRoot: string;
  prdPath: string;
  progressPath: string;
  auditPath: string;
  validationCommands: string[];
  approvalGates: { preflight: boolean; betweenPhases: boolean };
  phases: ManifestPhase[];
  warnings: string[];
  reconciliation?: { previousGeneratedAt?: string; preservedTaskIds: string[]; newTaskIds: string[]; removedTaskIds: string[]; changedTaskIds: string[] };
}

export interface RunCounts {
  pending: number;
  running: number;
  complete: number;
  failed: number;
  skipped: number;
}

export interface RunSummary {
  runId: string;
  status: string;
  startedAt: string | null;
  lastUpdatedAt: string | null;
  completedDurationMs: number;
  currentPhase: string | null;
  currentPhaseTitle: string | null;
  counts: RunCounts;
  total: number;
  blockers: string[];
  /** Executor bound at submission; null when the snapshot does not report one. */
  hostExecution: boolean | null;
}

export interface ManifestSummary {
  version: string;
  generatedAt: string;
  granularity?: string;
  phases: number;
  tasks: number;
  reconciliation?: {
    preservedTaskIds: string[];
    newTaskIds: string[];
    removedTaskIds: string[];
    changedTaskIds: string[];
  };
}

export interface Summary {
  authoring: import("../authoring-state.ts").AuthoringState;
  authoringReady: boolean;
  authoringBlocker?: string;
  authoringNextStage?: import("../authoring-config.ts").AuthoringStage;
  /**
   * Per-stage authoring detail including the plain-language cause of any
   * staleness, so the UI can name the changed input instead of only reporting
   * that authoring is "not ready".
   */
  authoringStages: import("../authoring-state.ts").AuthoringStageDetail[];
  /** Progress of the team → skills → manifest re-derivation chain. */
  rederive: RederiveProgress | null;
  repoRoot: string;
  repoName: string;
  harness: string | null;
  hasIdea: boolean;
  hasPrd: boolean;
  hasVision: boolean;
  hasFeatures: boolean;
  hasTeam: boolean;
  hasManifest: boolean;
  manifest: ManifestSummary | null;
  run: RunSummary | null;
  live: boolean;
  logExists: boolean;
  defaultTimeoutMs: number | null;
  /** Auto-commit after each completed task (engine-config; default on). */
  autoCommit: boolean;
  /** Stream harness CLI activity into docs/engine-run.log (engine-config; default off). */
  logHarnessActivity: boolean;
  /** Execute local harness CLIs on the host with full OS permissions. */
  hostExecution: boolean;
  /** Max agents to run in parallel (engine-config; 0 or absent means engine default). */
  concurrency: number;
  /** Auto runs the full ready workflow; manual runs only the selected task set. */
  executionMode: ExecutionMode;
  /** How the current manual task set was selected. */
  selectionScope: SelectionScope | null;
  /** Explicit task ids to run when executionMode is "manual". */
  selectedTaskIds: string[];
  /** Convenience count for UI labels. */
  selectedTaskCount: number;
  /** Most recent background job associated with this repo, if any. */
  job: BackgroundJob | null;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  phaseId: string;
  phaseTitle: string;
  ownerAgent: string | null;
  effectiveModel: string | null;
  effectiveFallbackModel: string | null;
  status: string;
  attempt: number;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  outputFiles: string[];
  errorMessage: string | null;
  artifactId: string | null;
  inputs: string[];
  produces: string | null;
  dependencies: string[];
  expectedOutputs: string[];
  validationCommands: string[];
  timeoutMs: number | null;
  approvalRequired: boolean;
  contractKind?: "implementation" | "human-review";
  requirements: string[];
  acceptanceCriteria: string[];
  constraints: string[];
  references: string[];
  reviewFile?: string;
  /** Checks reported as not run by this task or, for human reviews, by any upstream dependency. */
  validationGaps: string[];
  /**
   * Prerequisites that are not yet complete or skipped, using the engine's own
   * dispatch rule (direct dependencies plus transitive phase dependencies). A
   * human-review task with a non-empty list is not reviewable yet, so the Tasks
   * view must not offer its approval action.
   */
  unmetPrerequisites: string[];
}

export interface ArtifactMeta {
  artifactId: string;
  type: string;
  category: string;
  taskId: string;
  producedBy: string;
  status: string;
  summary: string;
  confidence?: number;
  createdAt: string;
  filesChanged: string[];
  inputs: string[];
  validationLimitations?: string[];
}

export interface ArtifactIndex {
  artifacts: ArtifactMeta[];
  types: string[];
}

export interface DocEntry {
  id: string;
  kind: string;
  title: string;
  relPath: string;
  exists: boolean;
}

export interface DocsIndex {
  entries: DocEntry[];
}

export interface AgentInfo {
  name: string;
  description: string;
  model?: string;
  modelFallback?: string;
  path: string;
  relPath: string;
  expertise: string[];
  collaboration: string[];
  constraints: string[];
  modelOverride?: string;
  modelFallbackOverride?: string;
}

export interface ModelInventory {
  models: Array<{ id: string; provider?: string; capabilities?: Record<string, unknown> }>;
  last_verified?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  relPath: string;
  /** Whether the skill was bootstrapped from the forge templates ("forge") or generated for the project ("project"). */
  category: "forge" | "project";
}

export interface TeamIndex {
  harnessRoot: string | null;
  agents: AgentInfo[];
  skills: SkillInfo[];
}

export interface Actions {
  canRun: boolean;
  canResume: boolean;
  canPause: boolean;
  canStop: boolean;
  failedTasks: string[];
}

export interface ProjectInfo {
  path: string;
  name: string;
  harness?: string;
  createdAt?: string;
  lastOpenedAt?: string;
  stage: string;
  job?: BackgroundJob | null;
}

export interface ProjectsIndex {
  projects: ProjectInfo[];
  current: string | null;
}

export interface LogsResponse {
  lines: string[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  content: string;
}

export type ControlAction = "run" | "resume" | "pause" | "stop" | "replay" | "draft-prd" | "draft-existing-prd" | "draft-team" | "draft-skills" | "rederive" | "compile-manifest" | "feature-prd" | "feature-increment" | "feature-increment-continue";

import type { RederiveProgress } from "../rederive-state.ts";
export type { RederiveProgress, RederiveStep, RederiveStepId, RederiveStepStatus } from "../rederive-state.ts";

export type ExecutionMode = "auto" | "manual";
export type SelectionScope = "single" | "range" | "list";

export type BackgroundJobType =
  | "create-project"
  | "bootstrap"
  | "feature-prd"
  | "feature-increment"
  | "draft-prd"
  | "draft-existing-prd"
  | "draft-team"
  | "draft-skills"
  | "rederive"
  | "compile-manifest"
  | "engine-run"
  | "engine-resume"
  | "engine-replay";

export type BackgroundJobStatus = "running" | "complete" | "failed" | "paused";

export interface BackgroundJob {
  id: string;
  type: BackgroundJobType;
  repoPath: string;
  pid?: number;
  taskId?: string;
  logPath?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  resultPath?: string;
  status: BackgroundJobStatus;
  message: string;
  run?: boolean;
  autoDraft?: boolean;
}

export interface ControlResult {
  ok: boolean;
  message: string;
  pid?: number;
  job?: BackgroundJob;
}

export interface TimeoutUpdateResult {
  ok: boolean;
  message: string;
  taskId?: string;
  affected?: number;
}

export interface CreateProjectRequest {
  authoringConfig?: import("../authoring-config.ts").AuthoringConfig;
  name: string;
  description?: string;
  harness?: string;
  visibility?: string;
  parentDir?: string;
  idea: string;
  autoDraft?: boolean;
  /** Max agents to run in parallel (0 means engine default). */
  concurrency?: number;
  /** Source document to import as docs/requirements-source.md for feature authoring. */
  prdPath?: string;
  /** Server-side paths of research/seed docs to copy into the new repo's docs/research/. */
  researchPaths?: string[];
}

export interface UploadResult {
  ok: boolean;
  path?: string;
  name?: string;
  message?: string;
}

export interface LaunchCliResult {
  ok: boolean;
  launched?: boolean;
  cli?: string;
  command?: string;
  message?: string;
}

export interface CreateProjectResult {
  ok: boolean;
  message: string;
  repoDir?: string;
  logFile?: string;
  pid?: number;
  job?: BackgroundJob;
}

export interface SelectResult {
  ok: boolean;
  repoRoot?: string;
  message?: string;
}

export interface OpenResult {
  ok: boolean;
  message?: string;
}

export interface RuntimeContainerSnapshot {
  name: string;
  service: string;
  state: string;
  health?: string;
}

export interface RuntimeAdminState {
  project: string;
  initialized: boolean;
  status: "not-initialized" | "stopped" | "running" | "degraded";
  containers: RuntimeContainerSnapshot[];
  missingServices: string[];
  diagnostics: string[];
  repositories: Array<{ id: string; path: string }>;
  hostRunnerEnabledRepositoryIds: string[];
  hostRunnerStatus: "disabled" | "running" | "stopped";
  harnessGrants: Record<string, string[]>;
  startOptions: { hostTools: boolean; postgresPort?: number } | null;
  restartRequired: boolean;
}

/** The executor for one run. The saved project value is only a default. */
export type Executor = "worker" | "host";

export interface RunnerReadiness {
  repositoryId: string | null;
  registered: boolean;
  capabilityEnabled: boolean;
  hostRunnerStatus: "disabled" | "running" | "stopped";
  available: boolean;
  blocker: string | null;
}

export type RuntimeAdminAction =
  | { action: "start"; hostTools: boolean; postgresPort?: number }
  | { action: "stop"; confirmed: boolean }
  | { action: "restart"; confirmed: boolean; hostTools: boolean; postgresPort?: number }
  | { action: "reset"; confirmed: boolean }
  | { action: "backup"; output: string }
  | { action: "restore"; from: string; confirmed: boolean; allowGitDrift: boolean }
  | { action: "rotate-tokens"; confirmed: boolean }
  | { action: "repo-add"; path: string; id?: string }
  | { action: "repo-remove"; id: string; confirmed: boolean }
  | { action: "harness-grant"; harness: string; variable: string; value: string }
  | { action: "harness-revoke"; harness: string; variable?: string; confirmed: boolean };

export interface RuntimeAdminActionResult {
  ok: boolean;
  message: string;
  restartRequired: boolean;
}
