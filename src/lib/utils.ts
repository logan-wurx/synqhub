import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** 1000 -> "1 kHz", 500 -> "500 Hz". */
export const hzText = (hz: number | null | undefined) => (hz == null ? "—" : hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`);
