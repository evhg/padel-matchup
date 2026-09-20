/** Who a claimant says they are at the club. Pure, so the claim form can offer the same four words. */
export const CLAIM_ROLES = ["owner", "manager", "staff", "coach"] as const;
export type ClaimRole = (typeof CLAIM_ROLES)[number];
