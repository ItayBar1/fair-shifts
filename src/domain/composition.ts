import type { DutySlot, Requirements } from "./types";

/** A role and its quota in one duty instance. */
export interface RoleQuota {
  name: string;
  count: number;
  requirements?: Requirements;
}
/** Who holds a slot in a proposal, and the personal extra (such as a call-up) of that seat. */
export interface Seat {
  slotId: string;
  soldierId: string | null;
  extraPoints: string;
}
export type Recomposed =
  | { ok: true; slots: DutySlot[]; seats: Seat[] }
  | {
      ok: false;
      reason: "occupied_reduction";
      /** Occupied seats of roles whose new quota cannot hold them all. */
      occupied: (Seat & { role: string })[];
    }
  | { ok: false; reason: "invalid_release"; slotIds: string[] };

/**
 * Reshapes an instance's slots to new role quotas. Slots keep their id and
 * occupant when their role remains; occupied slots are kept before vacant ones.
 * With `overflow: "reject"` an occupied slot is dropped only when it is named
 * in `release`, so reducing a quota never removes an assignment implicitly.
 * With `overflow: "drop"` surplus occupied slots are dropped and the caller
 * must show the removal before it is saved.
 */
export function recompose(
  slots: DutySlot[],
  seats: Seat[],
  roles: RoleQuota[],
  options: {
    release?: string[];
    overflow: "reject" | "drop";
    newId: () => string;
  }
): Recomposed {
  const release = new Set(options.release ?? []);
  const seatOf = (slotId: string): Seat =>
    seats.find((seat) => seat.slotId === slotId) ?? {
      slotId,
      soldierId: null,
      extraPoints: "0",
    };
  const unknown = [...release].filter(
    (slotId) =>
      !slots.some((slot) => slot.id === slotId && seatOf(slotId).soldierId)
  );
  if (unknown.length)
    return { ok: false, reason: "invalid_release", slotIds: unknown };
  const overflow: (Seat & { role: string })[] = [];
  const nextSlots: DutySlot[] = [];
  for (const role of roles) {
    const existing = slots.filter(
      (slot) => slot.role === role.name && !release.has(slot.id)
    );
    const occupied = existing.filter((slot) => seatOf(slot.id).soldierId);
    const vacant = existing.filter((slot) => !seatOf(slot.id).soldierId);
    if (occupied.length > role.count)
      overflow.push(
        ...occupied
          .slice(options.overflow === "drop" ? role.count : 0)
          .map((slot) => ({ ...seatOf(slot.id), role: role.name }))
      );
    const kept = new Set(
      [...occupied, ...vacant].slice(0, role.count).map((slot) => slot.id)
    );
    nextSlots.push(
      ...existing
        .filter((slot) => kept.has(slot.id))
        .map((slot) => ({ ...slot, requirements: role.requirements })),
      ...Array.from({ length: role.count - kept.size }, () => ({
        id: options.newId(),
        role: role.name,
        requirements: role.requirements,
      }))
    );
  }
  const removedRoles = slots.filter(
    (slot) =>
      !roles.some((role) => role.name === slot.role) &&
      !release.has(slot.id) &&
      seatOf(slot.id).soldierId
  );
  overflow.push(
    ...removedRoles.map((slot) => ({ ...seatOf(slot.id), role: slot.role }))
  );
  if (options.overflow === "reject" && overflow.length)
    return { ok: false, reason: "occupied_reduction", occupied: overflow };
  return {
    ok: true,
    slots: nextSlots,
    seats: nextSlots.map((slot) => seatOf(slot.id)),
  };
}
