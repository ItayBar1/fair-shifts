import { type Actor, type Workflow } from "../repository";
import { type TransferData } from "./types";

/** Soldiers see their own offers and offers addressed to them, without other candidates' outcomes or reasons. */
export function projectRequests(
  rows: Workflow[],
  actor: Actor,
  managing: boolean
) {
  const view = (row: Workflow): Record<string, unknown> => ({
    ...row.data,
    id: row.id,
    version: row.version,
    subjectId: row.subjectId,
  });
  return rows
    .filter((row) => row.kind === "request")
    .flatMap((row): Record<string, unknown>[] => {
      if (managing) return [view(row)];
      if (row.data.type !== "transfer")
        return row.subjectId === actor.soldierId ||
          row.data.accountId === actor.id
          ? [view(row)]
          : [];
      const data = row.data as TransferData;
      const shared = {
        id: row.id,
        version: row.version,
        type: data.type,
        dutyId: data.dutyId,
        dutyName: data.dutyName,
        role: data.role,
        assignmentId: data.assignmentId,
        fromSoldierId: data.fromSoldierId,
        points: data.points,
        createdAt: data.createdAt,
        closedAt: data.closedAt,
      };
      // The manager's decision and its reason reach both sides, never other candidates (decision 178).
      const decision = {
        decidedByName: data.decidedByName,
        decidedAt: data.decidedAt,
        decisionReason: data.decisionReason,
      };
      if (data.fromSoldierId === actor.soldierId)
        return [
          {
            ...shared,
            status: data.status,
            mailLimited: data.mailLimited,
            closedReason: data.closedReason,
            acceptedBy: data.acceptedBy,
            candidates: data.candidates,
            ...decision,
          },
        ];
      const mine = data.candidates.find(
        (item) => item.soldierId === actor.soldierId
      );
      if (!mine) return [];
      const accepted = data.acceptedBy === actor.soldierId;
      return [
        {
          ...shared,
          status:
            data.status === "awaiting_consent" && mine.status === "pending"
              ? "awaiting_consent"
              : accepted
                ? data.status
                : mine.status === "declined"
                  ? "declined"
                  : "closed",
          candidates: [mine],
          ...(accepted && {
            acceptedBy: data.acceptedBy,
            managerReasons: data.managerReasons,
            closedReason: data.closedReason,
            ...decision,
          }),
        },
      ];
    });
}
