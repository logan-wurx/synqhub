import { createContext, useContext, type ReactNode } from "react";

export type SizeVariant = "default" | "compact";

const LADDER = {
  // 4px pad + 28px item = 36px outer.
  default: { segmentPad: "p-1", segmentItem: "h-7", gap: "gap-1.5", icon: 15, text: "text-[13px]" },
  // 2px pad + 24px item = 28px outer.
  compact: { segmentPad: "p-0.5", segmentItem: "h-6", gap: "gap-1", icon: 13, text: "text-[12px]" },
} as const;

const SizeContext = createContext<SizeVariant>("default");

export function SizeProvider({ size, children }: { size: SizeVariant; children: ReactNode }) {
  return <SizeContext.Provider value={size}>{children}</SizeContext.Provider>;
}

export function useSize() {
  return LADDER[useContext(SizeContext)];
}
