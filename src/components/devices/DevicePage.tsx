// Mouse and keyboard pages. Detection is live; settings arrive in the next phases, so the page
// says what is coming and how it stays safe.
import { Check, CircleDashed, Usb } from "@phosphor-icons/react";
import type { Connected } from "@/lib/backend";
import { Card, CardHeader, DetailRows, Eyebrow } from "@/components/ui/matte";
import { PlugIn, deviceKeyboard, deviceMouse } from "@/components/ui/brand";

interface Plan {
  title: string;
  device: string;
  match: Connected["kind"];
  how: string;
  features: string[];
  safety: string[];
}

export const PLANS: Record<"mouse" | "keyboard", Plan> = {
  mouse: {
    title: "Mouse",
    device: "Logitech PRO X 2 DEX",
    match: "mouse",
    how: "Uses OpenMouse's open-source Logitech driver, tested on the Superlight 2. Settings are written to the mouse itself, so they stick after a restart.",
    features: ["DPI steps, with a big readout", "Polling rate", "Lift-off distance", "Battery and firmware", "Onboard profiles"],
    safety: ["Never touches firmware", "Backs up your profiles first", "Checks every change after writing it"],
  },
  keyboard: {
    title: "Keyboard",
    device: "ROG Falchion Ace HFX ZywOo",
    match: "keyboard",
    how: "Learned from what ASUS's own Gear Link sends, one setting at a time. Armoury Crate stays exactly as it is.",
    features: ["Actuation point per key, in 0.1 mm steps", "Rapid trigger press and release", "Deadzones", "Speed Tap", "Lighting and key remaps"],
    safety: ["Only sends what ASUS's own tool sends", "Never touches firmware", "Backs up your settings first"],
  },
};

export function DevicePage({ kind, devices }: { kind: "mouse" | "keyboard"; devices: Connected[] }) {
  const plan = PLANS[kind];
  const found = devices.filter((d) => d.kind === plan.match);
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-8 pb-[120px] pt-7 [&>*]:shrink-0">
      <header className="flex items-center gap-6">
        <div className="min-w-0 flex-1">
          <Eyebrow>{found.length ? "Connected" : "Not connected"}</Eyebrow>
          <h1 className="mt-3 text-[34px] font-semibold leading-[1.05] tracking-[-0.035em] text-high">{plan.title}</h1>
          <p className="mt-2 text-[13.5px] text-medium">{plan.device}</p>
        </div>
        <img
          src={kind === "keyboard" ? deviceKeyboard : deviceMouse}
          alt=""
          draggable={false}
          className="pointer-events-none -my-6 h-[168px] shrink-0 select-none object-contain"
        />
      </header>

      <div className="grid grid-cols-2 gap-5">
        <Card>
          <CardHeader title="Connection" hint="Just looking, nothing is sent to it" />
          <div className="px-5 pb-4 pt-3">
            {found.length === 0 ? (
              <div className="flex items-center gap-4 py-1">
                <PlugIn kind={kind} className="h-[96px] w-[128px] shrink-0" />
                <p className="flex items-center gap-2 text-[13.5px] text-medium">
                  <CircleDashed size={16} weight="light" /> Plug it in and it shows up here.
                </p>
              </div>
            ) : (
              found.map((d) => (
                <div key={d.pid} className="mb-1">
                  <div className="flex items-center gap-2.5 py-2 text-[14px] text-high">
                    <Usb size={16} weight="light" className="text-primary" />
                    {d.reported ?? d.name}
                    <span className="ml-auto size-2 rounded-full bg-live" />
                  </div>
                  <DetailRows
                    rows={[
                      ["Connected by", d.connection],
                      ["USB ID", <span className="tabular">{`${d.vid}:${d.pid}`}</span>],
                    ]}
                  />
                </div>
              ))
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="How it works" />
          <p className="px-5 pb-5 pt-3 text-[13.5px] leading-relaxed text-medium">{plan.how}</p>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-5">
        <Card>
          <CardHeader title="Coming next" />
          <ul className="px-5 pb-5 pt-3">
            {plan.features.map((f) => (
              <li key={f} className="flex items-center gap-3 py-2 text-[13.5px] text-high">
                <span className="size-1.5 rounded-full bg-white/25" />
                {f}
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader title="Safety" />
          <ul className="px-5 pb-5 pt-3">
            {plan.safety.map((f) => (
              <li key={f} className="flex items-center gap-3 py-2 text-[13.5px] text-high">
                <Check size={16} weight="light" className="text-primary" />
                {f}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
