// Live light for SYNQ: the window's background and the Gear page's orange slab. Two looks, adapted from Paper Shaders
// (https://shaders.paper.design, Apache-2.0) through the 21st.dev Shader Builder: "grain", a slow grainy gradient,
// and "dither", an ordered-dither field like a pixel display. The drawing is in shader.worker.ts.
//
// Built to cost next to nothing on a gaming PC, without looking any different:
// - every shader draws in one worker, off the page's thread, on one shared 12 frames a second clock, so the page
//   never wakes for them and the browser composites one frame per tick for all of them;
// - dither draws one shader pixel per dot and the browser scales it up crisply (1/16 of the work at 4 px dots);
// - grain draws its smooth light at a third of the size, scaled up smoothly (it has no fine detail to lose), and its
//   print grain is a still texture made once;
// - it asks for the low-power GPU, draws one still frame, and moves only while SYNQ is the visible, focused window
//   (never behind a game) and the shader is on screen. With reduced motion it stays still. Where the browser can't
//   (no WebGL in a worker), nothing is drawn and whatever is under it (a CSS gradient, the page colour) shows.
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type ShaderLook = "grain" | "dither";

export type ShaderMessage =
  | { kind: "add"; id: number; canvas: OffscreenCanvas; look: ShaderLook; colors: string[]; scale: number; intensity: number; speed: number; seed: number }
  | { kind: "size"; id: number; width: number; height: number }
  | { kind: "move"; id: number; on: boolean }
  | { kind: "remove"; id: number };

export interface ShaderProps {
  look: ShaderLook;
  /** Four colours, dark to light, as #rrggbb. */
  colors: readonly [string, string, string, string];
  className?: string;
  /** Pattern size: higher is finer. */
  scale?: number;
  /** How far the light folds (grain) or how many tones the dots step through (dither), 0 to 1. */
  intensity?: number;
  /** Dither: one dot's size, in CSS pixels. */
  cell?: number;
  /** Grain: how strong the print grain is, 0 to 1. */
  grain?: number;
  /** How fast it moves (1 is the Paper Shaders pace). */
  speed?: number;
  /** Where in its motion the still frame is taken. */
  seed?: number;
}

/** Grain: the share of CSS pixels drawn. */
const GRAIN_RES = 1 / 3;

let worker: Worker | null = null;
let nextId = 1;
const shaderWorker = () => (worker ??= new Worker(new URL("./shader.worker.ts", import.meta.url), { type: "module" }));

/** The print grain: a small tile of warm light and dark specks, made once and shared. */
let grainTile: string | null = null;
function grainUrl(): string {
  if (grainTile !== null) return grainTile;
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const x = c.getContext("2d");
  if (!x) return (grainTile = "");
  const img = x.createImageData(size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const light = Math.random() < 0.5;
    img.data[i] = light ? 255 : 24;
    img.data[i + 1] = light ? 240 : 14;
    img.data[i + 2] = light ? 228 : 8;
    img.data[i + 3] = Math.random() * 46;
  }
  x.putImageData(img, 0, 0);
  return (grainTile = c.toDataURL("image/png"));
}

export function Shader({ look, colors, className, scale = 1.2, intensity = 0.35, cell = 4, grain = 0.6, speed = 0.5, seed = 7 }: ShaderProps) {
  const box = useRef<HTMLDivElement>(null);
  const palette = colors.join(",");

  useEffect(() => {
    const frame = box.current;
    if (!frame || typeof OffscreenCanvas === "undefined") return;
    // Made here rather than rendered: a canvas can hand its drawing to a worker only once, and React's development
    // double-mount would ask twice.
    const canvas = document.createElement("canvas");
    canvas.className = "absolute left-0 top-0 block";
    if (look === "dither") canvas.style.imageRendering = "pixelated";
    else Object.assign(canvas.style, { width: "100%", height: "100%" });
    frame.prepend(canvas);
    let offscreen: OffscreenCanvas;
    try {
      offscreen = canvas.transferControlToOffscreen();
    } catch {
      canvas.remove();
      return;
    }
    const id = nextId++;
    const w = shaderWorker();
    const post = (m: ShaderMessage, transfer: Transferable[] = []) => w.postMessage(m, transfer);
    post({ kind: "add", id, canvas: offscreen, look, colors: palette.split(","), scale, intensity, speed, seed }, [offscreen]);

    // Dither: whole device pixels per dot, so every dot is the same square; the canvas may overhang the box a little.
    let size = "";
    const resize = () => {
      const r = frame.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      let width: number;
      let height: number;
      if (look === "dither") {
        const dot = Math.max(1, Math.round(cell * dpr));
        width = Math.max(1, Math.ceil((r.width * dpr) / dot));
        height = Math.max(1, Math.ceil((r.height * dpr) / dot));
        canvas.style.width = `${(width * dot) / dpr}px`;
        canvas.style.height = `${(height * dot) / dpr}px`;
      } else {
        width = Math.max(1, Math.round(r.width * GRAIN_RES));
        height = Math.max(1, Math.round(r.height * GRAIN_RES));
      }
      if (`${width}x${height}` === size) return;
      size = `${width}x${height}`;
      post({ kind: "size", id, width, height });
    };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let inView = true;
    let moving: boolean | null = null;
    const settle = () => {
      const on = !reduce.matches && inView && document.visibilityState === "visible" && document.hasFocus();
      if (on === moving) return;
      moving = on;
      post({ kind: "move", id, on });
    };

    const sized = new ResizeObserver(resize);
    sized.observe(frame);
    const seen = new IntersectionObserver(([e]) => {
      inView = e?.isIntersecting ?? true;
      settle();
    });
    seen.observe(frame);
    window.addEventListener("focus", settle);
    window.addEventListener("blur", settle);
    document.addEventListener("visibilitychange", settle);
    reduce.addEventListener("change", settle);
    resize();
    settle();

    return () => {
      sized.disconnect();
      seen.disconnect();
      window.removeEventListener("focus", settle);
      window.removeEventListener("blur", settle);
      document.removeEventListener("visibilitychange", settle);
      reduce.removeEventListener("change", settle);
      post({ kind: "remove", id });
      canvas.remove();
    };
  }, [look, palette, scale, intensity, cell, speed, seed]);

  return (
    <div ref={box} aria-hidden="true" className={cn("pointer-events-none relative overflow-hidden", className)}>
      {look === "grain" && grain > 0 && (
        <div className="absolute inset-0" style={{ backgroundImage: `url(${grainUrl()})`, backgroundSize: "128px", imageRendering: "pixelated", opacity: grain }} />
      )}
    </div>
  );
}
