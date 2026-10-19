import { loadDomain } from "../repository";
import type { EligibilityReason, SpecificApproval } from "../../domain/types";
import { type ConsentStatus } from "../seat-requests";

type CandidateStatus = "pending" | "declined" | "accepted" | "closed";
type TransferStatus = ConsentStatus;
export type TransferData = {
  type: "transfer";
  status: TransferStatus;
  mailLimited?: boolean;
  assignmentId: string;
  dutyId: string;
  slotId: string;
  dutyName: string;
  role: string;
  dutyRulesVersion: number;
  fromSoldierId: string;
  points: number;
  extraPoints?: string;
  candidates: {
    soldierId: string;
    status: CandidateStatus;
    decidedAt?: string;
  }[];
  createdAt: string;
  acceptedBy?: string;
  acceptedAt?: string;
  managerReasons?: EligibilityReason[];
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: string;
  decisionReason?: string;
  approvals?: SpecificApproval[];
  resultAssignmentId?: string;
  closedAt?: string;
  closedReason?: string;
};
export type Domain = Awaited<ReturnType<typeof loadDomain>>;
