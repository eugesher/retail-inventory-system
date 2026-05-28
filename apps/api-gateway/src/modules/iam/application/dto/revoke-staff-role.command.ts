export interface IRevokeStaffRoleCommand {
  staffUserId: string;
  roleName: string;
  actorId?: string | null;
  correlationId?: string | null;
}
