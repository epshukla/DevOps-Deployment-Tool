"use client";

import { createContext, useContext } from "react";

export interface NotificationData {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly metadata: Record<string, unknown> | null;
  readonly is_read: boolean;
  readonly created_at: string;
}

export interface OrgSummary {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: string;
}

export interface UserContextValue {
  readonly userId: string | null;
  readonly avatarUrl: string | null;
  readonly displayName: string;
  readonly notifications: readonly NotificationData[];
  readonly unreadCount: number;
  readonly orgs: readonly OrgSummary[];
  readonly activeOrgId: string | null;
}

const UserContext = createContext<UserContextValue>({
  userId: null,
  avatarUrl: null,
  displayName: "User",
  notifications: [],
  unreadCount: 0,
  orgs: [],
  activeOrgId: null,
});

export function useUser() {
  return useContext(UserContext);
}

export function UserProvider({
  children,
  ...value
}: UserContextValue & { readonly children: React.ReactNode }) {
  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}
