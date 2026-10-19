// A card beside the speed in the Sensitivity console (the polling rate, lift-off): its title and what it does on the
// left, the value it is set to large on the right, the control under them in the room that is left.
import { createContext, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** True inside the console's right column: a control there brings its own card (see LiftOffLevels). */
export const InConsoleCard = createContext(false);

export function ConsoleCard({ title, hint, figure, tip, children }: { title: string; hint: string; figure: ReactNode; tip?: string; children: ReactNode }) {
  return (
    <section aria-label={title} title={tip} className="tile flex min-w-0 flex-1 flex-col rounded-card px-8 pb-6 pt-6 max-sm:px-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[18px] font-semibold tracking-[-0.02em] text-high">{title}</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-medium">{hint}</p>
        </div>
        {figure}
      </div>
      <div className="flex flex-1 flex-col justify-center pt-4">{children}</div>
    </section>
  );
}

/** The value in a card's corner: the figure large, its unit small beside it ("8K Hz", "1.2 mm"). */
export function CardFigure({ children, unit, className }: { children: ReactNode; unit?: string; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-baseline gap-1.5", className)}>
      <span className="display-num tabular text-[40px] leading-none tracking-[-0.05em] text-high">{children}</span>
      {unit && <span className="text-[16px] font-medium text-medium">{unit}</span>}
    </span>
  );
}
