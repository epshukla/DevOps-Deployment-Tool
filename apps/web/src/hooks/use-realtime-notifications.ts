"use client";

import { useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { RealtimeChannel } from "@supabase/supabase-js";

interface NotificationData {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly body: string;
  readonly metadata: Record<string, unknown> | null;
  readonly is_read: boolean;
  readonly created_at: string;
}

interface UseRealtimeNotificationsOptions {
  readonly userId: string;
  /** Active org; when set, broadcasts for that org are delivered too. */
  readonly orgId?: string | null;
  readonly initialNotifications: readonly NotificationData[];
  readonly initialUnreadCount: number;
}

export function useRealtimeNotifications({
  userId,
  orgId = null,
  initialNotifications,
  initialUnreadCount,
}: UseRealtimeNotificationsOptions) {
  const [notifications, setNotifications] =
    useState<readonly NotificationData[]>(initialNotifications);
  const [unreadCount, setUnreadCount] = useState(initialUnreadCount);
  const channelRef = useRef<RealtimeChannel | null>(null);

  useEffect(() => {
    const supabase = createClient();

    const onInsert = (payload: { new: Record<string, unknown> }) => {
      const row = payload.new as unknown as NotificationData & { org_id: string };
      // Producers fan broadcasts out per member, so every row we get is ours;
      // only show the active org's to match the server-rendered list
      if (orgId && row.org_id !== orgId) return;
      setNotifications((prev) => [row, ...prev]);
      if (!row.is_read) {
        setUnreadCount((prev) => prev + 1);
      }
    };

    const channel = supabase
      .channel(`notifications:${userId}:${orgId ?? "all"}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        onInsert,
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, orgId]);

  function markAsRead(ids: readonly string[]) {
    setNotifications((prev) =>
      prev.map((n) =>
        ids.includes(n.id) ? { ...n, is_read: true } : n,
      ),
    );
    setUnreadCount((prev) => Math.max(0, prev - ids.length));
  }

  function markAllRead() {
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setUnreadCount(0);
  }

  return { notifications, unreadCount, markAsRead, markAllRead };
}
