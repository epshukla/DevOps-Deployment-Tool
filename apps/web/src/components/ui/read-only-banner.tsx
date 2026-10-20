/** Shown above sections a viewer can see but not change. */
export function ReadOnlyBanner({ children }: { readonly children?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-outline-variant bg-surface-container px-3 py-2 text-xs text-on-surface-variant">
      <span aria-hidden="true" className="material-symbols-outlined text-[16px]">visibility</span>
      {children ?? "You have the viewer role — this is read-only."}
    </div>
  );
}
