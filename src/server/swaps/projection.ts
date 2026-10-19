import { type Actor, type Workflow } from "../repository";
import { type SwapData } from "./types";

/**
 * The offerer sees every seat they offered; the other soldier sees only their own seats in
 * the offer. Exception reasons of one side never reach the other (decisions 163, 178).
 */
export function projectSwaps(
  rows: Workflow[],
  actor: Actor,
  managing: boolean
) {
  return rows
    .filter((row) => row.kind === "request" && row.data.type === "swap")
    .flatMap((row): Record<string, unknown>[] => {
      const data = row.data as SwapData;
      if (managing) return [{ ...data, id: row.id, version: row.version }];
      const reasonsFor = (soldierId?: string) =>
        (data.managerReasons ?? []).filter(
          (item) => !item.soldierId || item.soldierId === soldierId
        );
      const shared = {
        id: row.id,
        version: row.version,
        type: data.type,
        assignmentId: data.assignmentId,
        dutyId: data.dutyId,
        dutyName: data.dutyName,
        role: data.role,
        fromSoldierId: data.fromSoldierId,
        points: data.points,
        createdAt: data.createdAt,
        closedAt: data.closedAt,
      };
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
            acceptedAssignmentId: data.acceptedAssignmentId,
            candidates: data.candidates,
            managerReasons: reasonsFor(actor.soldierId),
            ...decision,
          },
        ];
      const mine = data.candidates.filter(
        (item) => item.soldierId === actor.soldierId
      );
      if (!mine.length) return [];
      const accepted = data.acceptedBy === actor.soldierId;
      const pending = mine.some((item) => item.status === "pending");
      return [
        {
          ...shared,
          status:
            data.status === "awaiting_consent" && pending
              ? "awaiting_consent"
              : accepted
                ? data.status
                : mine.some((item) => item.status === "declined")
                  ? "declined"
                  : "closed",
          candidates: mine,
          ...(accepted && {
            acceptedBy: data.acceptedBy,
            acceptedAssignmentId: data.acceptedAssignmentId,
            managerReasons: reasonsFor(actor.soldierId),
            closedReason: data.closedReason,
            ...decision,
          }),
        },
      ];
    });
}
