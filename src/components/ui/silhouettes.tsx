// Line drawings for a device that has no picture: the same style as the brand kit's MouseOutline, one for
// each class of shape (see src/lib/device-shape.ts). All share the accent for the one live detail.
import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { ShapeClass } from "@/lib/device-shape";

const LINE = "rgb(231 231 239 / 0.55)";

function Frame({ viewBox, className, children }: { viewBox: string; className?: string; children: ReactNode }) {
  return (
    <svg viewBox={viewBox} className={cn("pointer-events-none", className)} aria-hidden="true">
      <g fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" stroke={LINE}>
        {children}
      </g>
    </svg>
  );
}

/** A right-and-left symmetrical mouse seen from above. */
function Symmetric({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 160 250" className={className}>
      <path d="M22 98C22 50 47 20 80 20C113 20 138 50 138 98V158C138 204 113 232 80 232C47 232 22 204 22 158Z" />
      <path d="M80 21V96M23 108Q80 124 137 108" />
      <rect x="72" y="38" width="16" height="34" rx="8" stroke="var(--primary)" />
    </Frame>
  );
}

/** A shorter, narrower shell. */
function Small({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 160 250" className={className}>
      <path d="M40 112C40 74 58 48 80 48C102 48 120 74 120 112V164C120 200 102 222 80 222C58 222 40 200 40 164Z" />
      <path d="M80 49V108M41 118Q80 130 119 118" />
      <rect x="73" y="62" width="14" height="28" rx="7" stroke="var(--primary)" />
    </Frame>
  );
}

/** A right-hand shape: a thumb rest on the left, a taller hump behind the buttons. */
function Ergonomic({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 160 250" className={className}>
      <path d="M66 98C66 52 80 20 104 20C130 20 146 52 146 98V160C146 206 128 234 100 234C74 234 54 222 46 200C40 184 44 170 54 156C62 146 66 126 66 98Z" />
      <path d="M104 21V98M67 112Q106 128 145 112" />
      <rect x="96" y="38" width="16" height="34" rx="8" stroke="var(--primary)" />
      <path d="M52 168L62 160" />
    </Frame>
  );
}

/** A USB receiver: the plug, the body and its light. */
function Receiver({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 160 250" className={className}>
      <rect x="58" y="22" width="44" height="56" rx="6" />
      <path d="M70 36h8M82 36h8" />
      <path d="M52 78H108V210C108 224 98 232 86 232H74C62 232 52 224 52 210Z" />
      <circle cx="80" cy="190" r="6" stroke="var(--primary)" />
    </Frame>
  );
}

/** Two earphones, each with its stem and nozzle. */
function Iem({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 200 180" className={className}>
      <path d="M62 38C40 38 28 56 30 80C32 100 44 112 58 112C72 112 78 102 78 84C78 56 76 38 62 38Z" />
      <path d="M64 112V142C64 150 58 156 52 156" />
      <path d="M138 38C160 38 172 56 170 80C168 100 156 112 142 112C128 112 122 102 122 84C122 56 124 38 138 38Z" />
      <path d="M136 112V142C136 150 142 156 148 156" />
      <circle cx="64" cy="72" r="8" stroke="var(--primary)" />
    </Frame>
  );
}

/** Headphones: the band, both cups and the sound waves in the accent (the same drawing as SoundOutline). */
function Headset({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 200 180" className={className}>
      <path d="M30 108V96a70 70 0 0 1 140 0v12" />
      <rect x="20" y="104" width="34" height="56" rx="14" />
      <rect x="146" y="104" width="34" height="56" rx="14" />
      <path d="M82 96c7 7 29 7 36 0M72 80c14 12 42 12 56 0" stroke="var(--primary)" />
    </Frame>
  );
}

/** Nothing is known about the shape: a plain tile with a ring. */
function Generic({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 200 180" className={className}>
      <rect x="40" y="30" width="120" height="120" rx="30" />
      <circle cx="100" cy="90" r="26" />
      <circle cx="100" cy="90" r="5" stroke="var(--primary)" />
    </Frame>
  );
}

/** A strip or neon rope without a picture: a lit strip coiled once, glowing at its start. */
function Light({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 200 180" className={className}>
      <path d="M40 130C40 70 70 40 110 40C146 40 166 62 166 90C166 120 142 138 112 138C86 138 70 122 70 100C70 80 86 68 104 68" />
      <circle cx="104" cy="68" r="7" stroke="var(--primary)" />
      <path d="M30 144H58" />
    </Frame>
  );
}

/** A TV backlight: the set from the front, dim, with the light's glow around its edges. */
function LightTv({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 240 180" className={className}>
      <rect x="22" y="22" width="196" height="118" rx="10" stroke="var(--primary)" strokeOpacity="0.35" strokeWidth="9" />
      <rect x="34" y="32" width="172" height="100" rx="5" />
      <path d="M108 140L102 158M132 140L138 158M84 160H156" />
    </Frame>
  );
}

/** Light bars: two upright bars side by side on their feet, the near one lit at its top. */
function LightBars({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 200 200" className={className}>
      {[62, 138].map((x) => (
        <g key={x}>
          <rect x={x - 11} y="22" width="22" height="138" rx="11" />
          <path d={`M${x - 20} 174H${x + 20}M${x} 160V174`} />
        </g>
      ))}
      <path d="M62 34V64" stroke="var(--primary)" strokeWidth="6" />
    </Frame>
  );
}

const HEX = (cx: number, cy: number, r: number) =>
  Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return `${i ? "L" : "M"}${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)}`;
  }).join("") + "Z";

/** Light panels: a cluster of hexagon tiles, one lit. */
function LightPanels({ className }: { className?: string }) {
  const r = 30;
  const w = r * Math.sqrt(3);
  const tiles = [
    [100 - w / 2, 66],
    [100 + w / 2, 66],
    [100, 66 + r * 1.5],
    [100 - w, 66 + r * 1.5],
  ] as const;
  return (
    <Frame viewBox="0 0 200 170" className={className}>
      {tiles.map(([x, y], i) => (
        <path key={i} d={HEX(x, y, r - 2)} stroke={i === 1 ? "var(--primary)" : undefined} />
      ))}
    </Frame>
  );
}

/** A floor lamp: the lit pole on its round foot. */
function LightLamp({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 120 220" className={className}>
      <path d="M60 18V176" />
      <path d="M60 30V120" stroke="var(--primary)" strokeWidth="6" />
      <path d="M34 190C34 183 46 180 60 180C74 180 86 183 86 190C86 195 74 198 60 198C46 198 34 195 34 190Z" />
    </Frame>
  );
}

/** A bulb, or a light whose form isn't known: the glass, the base and a filament. */
function LightBulb({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 160 200" className={className}>
      <path d="M80 22C108 22 128 42 128 70C128 92 116 104 106 116C100 123 98 130 98 138H62C62 130 60 123 54 116C44 104 32 92 32 70C32 42 52 22 80 22Z" />
      <path d="M64 150H96M66 162H94M72 174H88" />
      <path d="M68 104L76 82L84 104L92 82" stroke="var(--primary)" />
    </Frame>
  );
}

/** A USB RGB hub: the controller box with its row of channel ports and status light, a lead out to a lit fan. */
function Hub({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 240 180" className={className}>
      <rect x="18" y="62" width="112" height="70" rx="12" />
      <path d="M34 116H44M54 116H64M74 116H84M94 116H104" strokeWidth="2.4" />
      <circle cx="112" cy="80" r="3" stroke="var(--primary)" />
      <path d="M130 97C150 97 152 70 170 70" strokeWidth="2.2" />
      <circle cx="190" cy="70" r="30" />
      <circle cx="190" cy="70" r="9" strokeWidth="2.2" />
      <path d="M190 40V52M220 70H208M190 100V88M160 70H172" strokeWidth="2" strokeOpacity="0.5" />
    </Frame>
  );
}

/** A gamepad seen from the front: the body with its two grips, two sticks, the d-pad and four face buttons. */
export function Gamepad({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 260 172" className={className}>
      <path d="M72 30H188C214 30 232 46 240 76L252 128C257 152 240 166 222 160C206 155 196 138 184 122H76C64 138 54 155 38 160C20 166 3 152 8 128L20 76C28 46 46 30 72 30Z" />
      <path d="M96 30C98 22 104 18 112 18H148C156 18 162 22 164 30" />
      <circle cx="82" cy="98" r="15" />
      <circle cx="160" cy="112" r="15" />
      <path d="M68 66H76V58H84V66H92V74H84V82H76V74H68Z" strokeWidth="2.4" />
      <circle cx="190" cy="56" r="5.5" strokeWidth="2.2" />
      <circle cx="178" cy="68" r="5.5" strokeWidth="2.2" />
      <circle cx="202" cy="68" r="5.5" strokeWidth="2.2" />
      <circle cx="190" cy="80" r="5.5" strokeWidth="2.2" stroke="var(--primary)" />
      <path d="M118 58H124M136 58H142" strokeWidth="2.4" />
    </Frame>
  );
}

/** A fight stick / leverless board from above: the case, the lever (or a thumb button) and the button rows. */
function Arcade({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 260 150" className={className}>
      <rect x="10" y="22" width="240" height="108" rx="16" />
      <circle cx="68" cy="76" r="20" />
      <circle cx="68" cy="76" r="7" stroke="var(--primary)" />
      {[0, 1, 2, 3].map((i) => (
        <circle key={`t${i}`} cx={128 + i * 28} cy={62 - (i === 0 ? 6 : 0)} r="10" strokeWidth="2.2" />
      ))}
      {[0, 1, 2, 3].map((i) => (
        <circle key={`b${i}`} cx={128 + i * 28} cy={94 - (i === 0 ? 6 : 0)} r="10" strokeWidth="2.2" />
      ))}
    </Frame>
  );
}

/** A monitor from the front: the bezel and panel with a glint, the chin with the maker's mark and the power light, the neck and the foot. */
function Monitor({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 260 210" className={className}>
      <rect x="12" y="12" width="236" height="142" rx="10" />
      <rect x="21" y="21" width="218" height="118" rx="3" strokeWidth="2.2" />
      <path d="M190 31L222 63M206 31L228 53" strokeWidth="2" strokeOpacity="0.45" />
      <path d="M122 147H138" strokeWidth="2.4" />
      <circle cx="228" cy="147" r="2.4" stroke="var(--primary)" />
      <path d="M114 154L110 184M146 154L150 184" />
      <path d="M64 192C64 186 92 184 130 184C168 184 196 186 196 192C196 196 192 198 186 198H74C68 198 64 196 64 192Z" />
    </Frame>
  );
}

/** A webcam on top of a screen: the body with its mics and status light, the lens in its ring, the hinge and the clip over the screen's edge. */
function Webcam({ className }: { className?: string }) {
  return (
    <Frame viewBox="0 0 220 180" className={className}>
      <rect x="24" y="22" width="172" height="66" rx="33" />
      <circle cx="110" cy="55" r="25" />
      <circle cx="110" cy="55" r="15" strokeWidth="2.4" />
      <circle cx="110" cy="55" r="6" stroke="var(--primary)" />
      <path d="M101 48a11 11 0 0 1 9-5" strokeWidth="2" strokeOpacity="0.6" />
      <circle cx="52" cy="55" r="3" strokeWidth="2.2" />
      <circle cx="168" cy="55" r="3" strokeWidth="2.2" />
      <circle cx="148" cy="40" r="2" strokeWidth="2" />
      <rect x="96" y="88" width="28" height="12" rx="5" strokeWidth="2.4" />
      <path d="M101 100L97 132Q96 138 102 138H118Q124 138 123 132L119 100" />
      <rect x="28" y="138" width="164" height="12" rx="3" strokeOpacity="0.45" />
    </Frame>
  );
}

const SHAPES: Record<ShapeClass, (p: { className?: string }) => ReactElement> = {
  monitor: Monitor,
  webcam: Webcam,
  gamepad: Gamepad,
  arcade: Arcade,
  light: Light,
  "light-tv": LightTv,
  "light-bars": LightBars,
  "light-panels": LightPanels,
  "light-lamp": LightLamp,
  "light-bulb": LightBulb,
  hub: Hub,
  symmetric: Symmetric,
  small: Small,
  ergonomic: Ergonomic,
  receiver: Receiver,
  iem: Iem,
  headset: Headset,
  generic: Generic,
};

/** The silhouette for a shape class. */
export function Silhouette({ shape, className }: { shape: ShapeClass; className?: string }) {
  const S = SHAPES[shape];
  return <S className={className} />;
}
