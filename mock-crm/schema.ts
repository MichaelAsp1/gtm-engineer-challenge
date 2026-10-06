export type Account = {
  id: string;
  name: string;
  domain?: string;
  industry?: string;
  employeeCount?: number;
  ownerId?: string;
  stage: "prospect" | "evaluation" | "mvp" | "customer" | "closed_lost";
  createdAt: string;
  updatedAt: string;
  lastContactAt?: string;
  nextStep?: string;
  opportunityAmount?: number;
  closeDate?: string;
  icpTier?: string;
};

export type Contact = {
  id: string;
  accountId: string;
  name: string;
  email: string;
  title?: string;
  persona?: string;
  lastContactedAt?: string;
};

export type Activity =
  | {
      id: string;
      accountId: string;
      type: "email";
      direction: "inbound" | "outbound";
      timestamp: string;
      contactId?: string;
      subject?: string;
    }
  | {
      id: string;
      accountId: string;
      type: "meeting";
      timestamp: string;
      contactIds: string[];
      outcome?: "positive" | "neutral" | "negative";
    }
  | {
      id: string;
      accountId: string;
      type: "stage_change";
      timestamp: string;
      from?: string;
      to: string;
    }
  | {
      id: string;
      accountId: string;
      type: "note";
      timestamp: string;
      text: string;
    };

export type Opportunity = {
  id: string;
  accountId: string;
  name?: string;
  stage: string;
  value?: number;
  openedAt?: string;
  closeDate?: string;
  lastStageChangeAt?: string;
  nextStep?: string;
  ownerId?: string;
  status?: string;
};

export type Task = {
  id: string;
  accountId: string;
  contactId?: string;
  ownerId: string;
  title?: string;
  description?: string;
  dueDate?: string;
  completed: boolean;
  createdAt: string;
};
