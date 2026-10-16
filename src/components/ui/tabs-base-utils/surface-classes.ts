// Fill for an element raised `level` steps above the page.
export function surfaceClasses(level: number): string {
  if (level <= 2) return "bg-white/[0.05]";
  if (level <= 4) return "bg-white/[0.1] shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_4px_12px_-4px_rgb(0_0_0/0.6)]";
  return "bg-white/[0.14] shadow-[inset_0_1px_0_rgb(255_255_255/0.12),0_4px_12px_-4px_rgb(0_0_0/0.6)]";
}
