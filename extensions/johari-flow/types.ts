/**
 * Shared types for the Johari flow state machine.
 *
 * Phase graph (gated):
 *   idle -> intent -> research -> design -> review -> approved -> execute -> report -> done
 *
 * Hard gates apply while the flow is pre-approval (`intent`, `research`, `design`,
 * `review`): destructive shell commands are blocked, and during `intent` file
 * writes and sub-agent dispatch are blocked outright. `approved` itself carries no
 * gate; it is the state that unlocks execution.
 */

export type Phase =
	| "idle"
	| "intent"
	| "research"
	| "design"
	| "review"
	| "approved"
	| "execute"
	| "report"
	| "done";

export const PHASES: Phase[] = [
	"idle",
	"intent",
	"research",
	"design",
	"review",
	"approved",
	"execute",
	"report",
	"done",
];

/** Legal forward edges of the state machine. */
export const EDGES: Record<Phase, Phase[]> = {
	idle: ["intent"],
	intent: ["research", "idle"],
	research: ["design", "intent", "idle"],
	design: ["review", "research", "idle"],
	review: ["approved", "design", "idle"],
	approved: ["execute", "review", "design", "idle"],
	execute: ["report", "approved", "research", "design", "idle"],
	report: ["done", "execute", "design"],
	done: ["idle"],
};

export interface Approval {
	optionId: string;
	label: string;
	at: string;
}

export interface Artifact {
	kind: "intent" | "research" | "design" | "decision" | "report";
	title: string;
	/** Free-form one-line takeaway, so the state stays readable without the HTML. */
	takeaway?: string;
	path?: string;
	at: string;
}

export interface DecisionRecord {
	question: string;
	answer: string;
	options: string[];
	at: string;
}

export interface Transition {
	from: Phase;
	to: Phase;
	reason: string;
	at: string;
}

export interface FlowState {
	phase: Phase;
	/** Verbatim words from the user. Never paraphrased by the agent. */
	goal: string;
	/** Set only after the user confirmed the intent page. */
	intentConfirmed: boolean;
	approval?: Approval;
	artifacts: Artifact[];
	decisions: DecisionRecord[];
	history: Transition[];
	startedAt: string;
	updatedAt: string;
	/** Counter so every rendered page gets a stable, sortable filename. */
	pageSeq: number;
	/** Sub-agent dispatches recorded during ④ 交叉评审 (evidence, not a gate). */
	dispatches: number;
}

export function initialState(goal = ""): FlowState {
	const now = new Date().toISOString();
	return {
		phase: goal ? "intent" : "idle",
		goal,
		intentConfirmed: false,
		artifacts: [],
		decisions: [],
		history: goal
			? [{ from: "idle", to: "intent", reason: "flow started", at: now }]
			: [],
		startedAt: now,
		updatedAt: now,
		pageSeq: 0,
		dispatches: 0,
	};
}

export function isActive(state: FlowState): boolean {
	return state.phase !== "idle" && state.phase !== "done";
}

/** Phases in which the orchestrator is still shaping the plan, not the code. */
export function isPreApproval(state: FlowState): boolean {
	return (
		state.phase === "intent" ||
		state.phase === "research" ||
		state.phase === "design" ||
		state.phase === "review"
	);
}
