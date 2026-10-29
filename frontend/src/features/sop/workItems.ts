export type WorkItem = {
  id: string;
  organizationId: string;
  workflowId: string;
  moduleId: string;
  name: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export const workItemsKey = (org: string) => ["work-items", org];
