import { Switch as Base } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onCheckedChange,
  className,
  disabled,
  ...aria
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
}) {
  return (
    <Base.Root
      checked={checked}
      disabled={disabled}
      onCheckedChange={(c) => onCheckedChange(c)}
      {...aria}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full bg-white/[0.08] p-[3px] ring-1 ring-white/[0.08] transition-colors duration-300 ease-fluid data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
        "data-[checked]:bg-primary data-[checked]:ring-primary/40 data-[checked]:shadow-[0_0_14px_-2px_var(--primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className,
      )}
    >
      <Base.Thumb className="block size-4 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.45)] transition-transform duration-300 ease-[cubic-bezier(.32,.72,0,1)] data-[checked]:translate-x-4" />
    </Base.Root>
  );
}
