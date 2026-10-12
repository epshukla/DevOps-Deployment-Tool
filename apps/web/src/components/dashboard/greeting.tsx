"use client";

import { useSyncExternalStore } from "react";

function subscribeNever(): () => void {
  return () => {};
}

function greetingForHour(hour: number): string {
  if (hour < 5) return "Burning the midnight oil";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Greets by the viewer's local time. The server renders in UTC, so it uses a
 * neutral greeting and the client swaps in the real one after hydration.
 */
export function Greeting({ name }: { readonly name: string }) {
  const greeting = useSyncExternalStore(
    subscribeNever,
    () => greetingForHour(new Date().getHours()),
    () => "Welcome back",
  );
  return (
    <>
      {greeting}, {name}
    </>
  );
}
