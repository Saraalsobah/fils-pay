import { ConflictError } from "../lib/errors.js";

/** An operator on one side of a credit's two-person control. */
export interface CreditActor {
  adminUserId: string;
  displayName: string;
}

/**
 * Two-person control: the operator who approves a credit must not be the one who requested it.
 *
 * Identity is the admin user ID. It used to compare display names, on the claim that "display
 * names are unique per admin" (migration 0060 comment). They are not: admin_users.display_name
 * has no UNIQUE constraint, and it is editable. So (a) two different operators who share a name
 * could never approve each other's credits, and (b) the requester's name is a snapshot taken
 * when the request was raised, so renaming yourself afterwards made you look like a
 * different person and you could approve your own credit.
 */
export function assertDistinctApprover(requester: CreditActor, approver: CreditActor): void {
  if (approver.adminUserId === requester.adminUserId) {
    throw new ConflictError("self_approval_forbidden");
  }
}
