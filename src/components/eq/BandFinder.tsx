// Plays narrow bands of pink noise so you can find the frequencies that bite. The sound goes to
// the default output, so it passes through the current EQ: what still bites is what is left to
// fix. Level is capped low on purpose.
import { useEffect, useRef, useState } from "react";
import { Broadcast, Play, Scissors, Stop, X } from "@phosphor-icons/react";
import { EqBarSlider } from "@/components/ui/eq-bar-slider";
import { GlassRadio, TransportKeys } from "@/components/uiverse";
import { formatHz } from "@/lib/eq";

const F_LO = 100;
const F_HI = 16000;
/** Sweep ranges. "Flinch zone" is the 9-12 kHz band where hi-hats bit hardest when the Zero:2
 *  EQ was tuned, stepped finely. */
const RANGES = {
  full: [1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000],
  treble: [4000, 5000, 6300, 8000, 10000, 12500, 16000],
  flinch: [9000, 9500, 10000, 10500, 11000, 11500, 12000],
} as const;
type Range = keyof typeof RANGES;
type Mode = "stop" | "play" | "sweep";
const SWEEP_STEP_MS = 1600;
/** 100% on the level control is -20 dBFS; 0% is -60 dBFS. */
const LEVEL_DB = (pct: number) => -60 + 40 * (pct / 100);

function pinkNoise(ctx: AudioContext): AudioBuffer {
  // Paul Kellet's refined pink filter over white noise, 4 s, looped.
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return buf;
}

interface BandFinderProps {
  markers: number[];
  onMark: (freq: number) => void;
  onUnmark: (freq: number) => void;
  onCut: (freq: number) => void;
}

export function BandFinder({ markers, onMark, onUnmark, onCut }: BandFinderProps) {
  const [freq, setFreq] = useState(4000);
  const [level, setLevel] = useState(35);
  const [mode, setMode] = useState<Mode>("stop");
  const [range, setRange] = useState<Range>("full");
  const playing = mode !== "stop";
  const sweeping = mode === "sweep";
  const audio = useRef<{ ctx: AudioContext; filter: BiquadFilterNode; gain: GainNode; src: AudioBufferSourceNode } | null>(null);

  const stop = () => {
    audio.current?.src.stop();
    audio.current?.ctx.close();
    audio.current = null;
  };

  const start = () => {
    const ctx = new AudioContext();
    const src = ctx.createBufferSource();
    src.buffer = pinkNoise(ctx);
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 4.3; // about a third of an octave
    filter.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.linearRampToValueAtTime(10 ** (LEVEL_DB(level) / 20), ctx.currentTime + 0.25);
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
    audio.current = { ctx, filter, gain, src };
  };

  const changeMode = (next: Mode) => {
    if (next === "stop") stop();
    else if (!audio.current) start();
    setMode(next);
  };

  useEffect(() => stop, []);

  useEffect(() => {
    const a = audio.current;
    a?.filter.frequency.setTargetAtTime(freq, a.ctx.currentTime, 0.03);
  }, [freq]);

  useEffect(() => {
    const a = audio.current;
    a?.gain.gain.setTargetAtTime(10 ** (LEVEL_DB(level) / 20), a.ctx.currentTime, 0.05);
  }, [level]);

  useEffect(() => {
    if (!sweeping) return;
    const steps = RANGES[range];
    let i = Math.max(0, steps.findIndex((f) => f >= freq));
    setFreq(steps[i]);
    const timer = window.setInterval(() => {
      i = (i + 1) % steps.length;
      setFreq(steps[i]);
    }, SWEEP_STEP_MS);
    return () => window.clearInterval(timer);
    // Restarting only when the sweep toggles is intended.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sweeping, range]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <TransportKeys<Mode>
          value={mode}
          onChange={changeMode}
          keys={[
            { value: "stop", label: "Stop", icon: <Stop size={12} weight="fill" /> },
            { value: "play", label: "Play", icon: <Play size={12} weight="fill" /> },
            { value: "sweep", label: "Sweep", icon: <Broadcast size={13} weight="bold" /> },
          ]}
        />
        <button
          disabled={!playing}
          onClick={() => onMark(freq)}
          className="ml-auto flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[13.5px] font-medium text-primary-foreground shadow-[0_8px_24px_-8px_var(--primary)] transition-transform duration-300 ease-fluid active:scale-[0.97] disabled:opacity-40 disabled:shadow-none"
        >
          That one's harsh
        </button>
      </div>

      <GlassRadio<Range>
        value={range}
        onChange={setRange}
        options={[
          { value: "full", label: "Full", hint: "1k–16k" },
          { value: "treble", label: "Treble", hint: "4k–16k" },
          { value: "flinch", label: "Flinch zone", hint: "9k–12k" },
        ]}
      />

      <LogFreqSlider value={freq} onChange={(f) => { if (sweeping) setMode("play"); setFreq(f); }} />

      <div className="flex items-center gap-3">
        <span className="w-14 text-[12.5px] text-muted-foreground">Volume</span>
        <div className="flex-1">
          <EqBarSlider value={level} min={0} max={100} step={1} unit="%" onChange={setLevel} aria-label="Noise level" />
        </div>
      </div>

      {markers.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {markers.map((f) => (
            <span key={f} className="tabular flex items-center gap-1 rounded-full bg-chart-3/10 py-1 pl-3 pr-1 text-[12px] text-chart-3 ring-1 ring-chart-3/25">
              {formatHz(f)} Hz
              <button onClick={() => onCut(f)} title="Turn this frequency down 3 dB" className="ml-1 flex items-center gap-1 rounded-full bg-white/[0.06] px-2.5 py-0.5 font-sans text-[12px] text-foreground transition-colors hover:bg-white/[0.12]">
                <Scissors size={12} weight="light" /> Tame it
              </button>
              <button onClick={() => onUnmark(f)} className="rounded-full p-1 text-muted-foreground hover:text-foreground" title="Remove mark">
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const TICKS = [125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function LogFreqSlider({ value, onChange }: { value: number; onChange: (f: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(false);
  const l0 = Math.log(F_LO), l1 = Math.log(F_HI);
  const pct = (f: number) => (Math.log(f) - l0) / (l1 - l0);
  const at = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const f = Math.exp(l0 + t * (l1 - l0));
    return f < 1000 ? Math.round(f / 5) * 5 : Math.round(f / 50) * 50;
  };
  return (
    <div className="flex items-center gap-3">
      <span className="tabular w-14 text-[14px] text-foreground">{formatHz(value)}<span className="ml-0.5 font-sans text-[11px] text-muted-foreground">Hz</span></span>
      <div
        ref={ref}
        className="relative h-10 flex-1 cursor-pointer touch-none rounded-full bg-black/30 shadow-[inset_0_2px_6px_rgb(0_0_0/0.5)] ring-1 ring-white/[0.06]"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(true);
          onChange(at(e.clientX));
        }}
        onPointerMove={(e) => drag && onChange(at(e.clientX))}
        onPointerUp={() => setDrag(false)}
      >
        {TICKS.map((f) => (
          <span key={f} className="absolute bottom-1 -translate-x-1/2 text-[10px] text-muted-foreground/80" style={{ left: `${pct(f) * 100}%` }}>
            {formatHz(f)}
          </span>
        ))}
        {Array.from({ length: 48 }).slice(1, 47).map((_, i) => (
          <span key={i} className="absolute top-2 h-2 w-px bg-white/[0.1]" style={{ left: `${((i + 1) / 47) * 100}%` }} />
        ))}
        <span className="absolute inset-y-1 w-[3px] -translate-x-1/2 rounded-full bg-primary shadow-[0_0_8px_var(--primary)]" style={{ left: `${pct(value) * 100}%` }} />
      </div>
    </div>
  );
}
