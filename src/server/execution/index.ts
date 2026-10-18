// Execution periods of a seat in a duty that started (decision 183): who actually covered
// which part, the value of each part, and the path each change takes to the balances.
// One module per stage (decision 239); this file is its public API.
export type { Change, ExecutionPlanOptions } from "./model";
export { ACTIVE as ACTIVE_EXECUTION } from "./model";
export {
  fixedAllocationInput,
  segmentApprovalKey,
  handoverInput,
  parseHandover,
} from "./inputs";
export type { FixedAllocation } from "./inputs";
export { seatSegments, handoverSegments, seatOf } from "./seats";
export { planExecution, executionView } from "./plan";
export type { ExecutionPlan } from "./plan";
export { commitExecution } from "./commit";
export { previewExecution, applyExecution } from "./actions";
