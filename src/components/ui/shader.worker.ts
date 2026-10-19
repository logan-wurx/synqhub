// The drawing side of src/components/ui/shader.tsx. Every shader on the page draws here, off the page's own thread, on
// one shared clock: the page never wakes for them, and the browser composites a single frame per tick however many
// are on screen. The looks are adapted from Paper Shaders (https://shaders.paper.design, Apache-2.0) through the
// 21st.dev Shader Builder.
import type { ShaderLook, ShaderMessage } from "./shader";

/** Frames a second while anything moves. The motion is slow enough that more would look the same and cost more. */
const FPS = 12;

const VERT = `attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`;

const COMMON = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_res;
uniform float u_time;
uniform vec3 u_colors[4];
uniform vec2 u_shape; // scale, intensity

float hash21(vec2 p) {
#ifndef GL_FRAGMENT_PRECISION_HIGH
  p = mod(p, 31.0);
#endif
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.0, 9.2);
    a *= 0.5;
  }
  return v;
}
vec3 palette(float x) {
  float f = clamp(x, 0.0, 1.0) * 3.0;
  vec3 col = mix(u_colors[0], u_colors[1], smoothstep(0.0, 1.0, clamp(f, 0.0, 1.0)));
  col = mix(col, u_colors[2], smoothstep(0.0, 1.0, clamp(f - 1.0, 0.0, 1.0)));
  return mix(col, u_colors[3], smoothstep(0.0, 1.0, clamp(f - 2.0, 0.0, 1.0)));
}
vec2 field(vec2 frag) {
  return (frag - 0.5 * u_res) / min(u_res.x, u_res.y) * u_shape.x;
}
`;

const SHADE: Record<ShaderLook, string> = {
  grain: `
void main() {
  vec2 q = field(gl_FragCoord.xy);
  float t = u_time;
  q.x += sin(q.y * 2.1 + t * 0.2) * (0.08 + u_shape.y * 0.32);
  q.y += cos(q.x * 2.7 - t * 0.17) * (0.06 + u_shape.y * 0.26);
  float wave = 0.5 + 0.5 * sin(q.x * 2.8 + q.y * 1.9 + fbm(q * 2.0) * 3.0);
  gl_FragColor = vec4(palette(wave), 1.0);
}`,
  // One fragment is one dot: the field is read at the dot's centre and stepped against a per-dot threshold.
  dither: `
void main() {
  vec2 id = floor(gl_FragCoord.xy);
  float t = u_time;
  float level = fbm(field(gl_FragCoord.xy) * (1.7 + u_shape.y * 4.0) + vec2(t * 0.08, -t * 0.05));
  float threshold = fract(dot(id, vec2(0.75487766, 0.56984029)));
  float steps = mix(2.0, 7.0, u_shape.y);
  gl_FragColor = vec4(palette(floor(level * steps + threshold) / steps), 1.0);
}`,
};

interface Pane {
  canvas: OffscreenCanvas;
  gl: WebGLRenderingContext;
  program: WebGLProgram;
  buf: WebGLBuffer | null;
  uRes: WebGLUniformLocation | null;
  uTime: WebGLUniformLocation | null;
  t: number;
  speed: number;
  on: boolean;
}

const panes = new Map<number, Pane>();
let timer = 0;
let last = 0;

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

function draw(p: Pane) {
  p.gl.uniform1f(p.uTime, p.t);
  p.gl.drawArrays(p.gl.TRIANGLES, 0, 3);
}

function tick() {
  timer = 0;
  const now = performance.now();
  const dt = Math.min(now - last, 250) / 1000;
  last = now;
  let moving = false;
  for (const p of panes.values()) {
    if (!p.on) continue;
    p.t += dt * p.speed;
    draw(p);
    moving = true;
  }
  if (moving) timer = self.setTimeout(tick, 1000 / FPS);
}

function wake() {
  if (timer || ![...panes.values()].some((p) => p.on)) return;
  last = performance.now();
  timer = self.setTimeout(tick, 1000 / FPS);
}

function add(m: Extract<ShaderMessage, { kind: "add" }>) {
  const gl = m.canvas.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl) return;
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const program = gl.createProgram()!;
  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, COMMON + SHADE[m.look]);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return;
  }
  gl.useProgram(program);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.uniform3fv(gl.getUniformLocation(program, "u_colors"), new Float32Array(m.colors.flatMap(rgb)));
  gl.uniform2f(gl.getUniformLocation(program, "u_shape"), m.scale, m.intensity);
  const pane: Pane = { canvas: m.canvas, gl, program, buf, uRes: gl.getUniformLocation(program, "u_res"), uTime: gl.getUniformLocation(program, "u_time"), t: m.seed, speed: m.speed, on: false };
  m.canvas.addEventListener("webglcontextlost", (e) => {
    e.preventDefault();
    pane.on = false;
  });
  panes.set(m.id, pane);
}

self.onmessage = (e: MessageEvent<ShaderMessage>) => {
  const m = e.data;
  if (m.kind === "add") return add(m);
  const p = panes.get(m.id);
  if (!p) return;
  if (m.kind === "size") {
    p.canvas.width = m.width;
    p.canvas.height = m.height;
    p.gl.viewport(0, 0, m.width, m.height);
    p.gl.uniform2f(p.uRes, m.width, m.height);
    draw(p);
  } else if (m.kind === "move") {
    p.on = m.on;
    wake();
  } else {
    panes.delete(m.id);
    p.gl.deleteBuffer(p.buf);
    p.gl.deleteProgram(p.program);
    p.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
};
