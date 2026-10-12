"use client";

import { createContext, useContext, useMemo, useState } from "react";

interface NavContextValue {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}

const NavContext = createContext<NavContextValue>({
  open: false,
  setOpen: () => {},
});

/** Mobile navigation drawer state, shared by the top bar and the sidebar. */
export function NavProvider({ children }: { readonly children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <NavContext.Provider value={value}>{children}</NavContext.Provider>;
}

export function useNav() {
  return useContext(NavContext);
}
