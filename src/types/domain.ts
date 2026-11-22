export type ExpertiseArea =
  | "finance"
  | "healthcare"
  | "data analysis"
  | "operations";

export type TaskPriority = "low" | "normal" | "high";

export type TaskState =
  | "DRAFT"
  | "ROUTING"
  | "ASSIGNED"
  | "IN_PROGRESS"
  | "UNRESOLVED"
  | "RECOVERY_NEEDED"
  | "COMPLETED";

export type SimMode = "realistic" | "fast" | "slow" | "hang" | "no_match";

export type AttemptStatus =
  | "pending"
  | "matched"
  | "no_match"
  | "stale_ignored"
  | "cancelled"
  | "interrupted_by_restart";

export type ActorType = "system" | "operator" | "contributor";

export type EventType =
  | "TASK_CREATED"
  | "ROUTING_STARTED"
  | "ROUTING_MATCHED"
  | "ROUTING_NO_MATCH"
  | "STALE_ROUTING_IGNORED"
  | "INTERRUPTED_BY_RESTART"
  | "OPERATOR_INTERVENED"
  | "ASSIGNMENT_ACCEPTED"
  | "ASSIGNMENT_DECLINED"
  | "ASSIGNMENT_FAILED"
  | "TASK_RECOVERED"
  | "TASK_COMPLETED";

export interface Contributor {
  id: string;
  name: string;
  areas: ExpertiseArea[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  area: ExpertiseArea;
  priority: TaskPriority;
  state: TaskState;
  assignee_id: string | null;
  routing_epoch: number;
  created_at: number;
  updated_at: number;
}

export interface RoutingAttempt {
  id: string;
  task_id: string;
  epoch: number;
  status: AttemptStatus;
  candidate_contributor_id: string | null;
  late_candidate_contributor_id: string | null;
  late_arrived_at: number | null;
  sim_mode: SimMode;
  started_at: number;
  completed_at: number | null;
}

export interface EventLog {
  seq: number;
  id: string;
  task_id: string;
  epoch: number | null;
  event_type: EventType;
  actor: ActorType;
  summary: string;
  payload_json: string | null;
  created_at: number;
}