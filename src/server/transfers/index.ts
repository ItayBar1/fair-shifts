// Consensual transfer of a published seat before it starts (decisions 108-109, 149, 163),
// and the manager's decision on a transfer that needs one (decision 178).
// One module per stage of the flow (decision 239); this file is its public API.
export type { TransferData } from "./types";
export {
  offerTransfer,
  respondTransfer,
  withdrawTransfer,
  closeTransfersForDuty,
} from "./offer";
export { reviewTransfer, decideTransfer } from "./review";
export { projectRequests } from "./projection";
