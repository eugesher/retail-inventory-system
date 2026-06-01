export interface IAssignStaffRoleCommand {
  staffUserId: string;
  roleNames: string[];
  actorId?: string | null;
  correlationId?: string | null;
}
