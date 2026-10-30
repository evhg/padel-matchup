import {
  cleanLocale,
  HINT_CONTRASTS,
  HINT_HOUR_CYCLES,
  isEuropeanZone,
  isSignalHash,
  platformOf,
  SIGNAL_BOUNDS,
  SIGNAL_NA,
  SIGNALS_COOKIE,
  SIGNALS_COOKIE_MAX_AGE,
  SIGNALS_COOKIE_PATH,
  type HintContrast,
  type HintFlag,
  type HintHourCycle,
  type SignalNa,
  type SignalsWire,
} from "@/lib/domain/hintSignals";

/**
 * What a browser tells every site, read in the browser for a device hint (design B, the owner's decision
 * of 28 October 2026; the rules are in src/lib/domain/hintSignals.ts). Our own few lines, no library, read
 * at two moments only: when a person acts (a join, a sign-in, "Sign out on this browser"), and the values
 * go with that act's own request; and once per match in a tab for the question "Welcome back, Tim?"
 * (`WelcomeBack`), only on a page whose server found a remembered phone among the records it shows. A
 * plain view reads nothing. A browser set to a European zone reads nothing more and sends nothing: the
 * zone comes first, before any setting or test below.
 *
 * Since 30 October 2026 (v2; the owner: "I want them anyway"), also three tests and five settings: a short
 * hash of a small fixed drawing, of the WebGL renderer with a small 3D drawing, and of a short sound
 * rendered offline (no gesture needed, nothing is heard); and the contrast, inverted colours, reduced
 * transparency, hour cycle and locale. Only the hashes leave the browser, never the picture or the sound.
 * Every platform runs the three tests, iPhones, iPads and Safari too (the owner, 30 October 2026: "On
 * everywhere"; Safari may add noise that differs between the browsers of one iPhone, DECIDING rule 40).
 * The read waits for them until `SIGNAL_BUDGET_MS` after it began (`SIGNAL_GRACE_MS` more when the
 * drawings alone ran past it). A test that throws, is missing or answers anything but a short hash
 * gives "na", the same every time. A test still running at the limit
 * makes the whole read null: that act or question sends no values, because a key that holds a timing
 * would change between two page loads of one phone. No font list, no IP address, no system version and
 * no dark mode. Null on the server, in Europe, late, or when anything else throws.
 */

/** The whole read's limit on a phone. A test still running then makes this read null, and the act sends no values (docs/OPERATING.md). */
export const SIGNAL_BUDGET_MS = 150;
/**
 * The drawings run synchronously, and no timer can stop them. When they alone run past the limit (a cold
 * WebGL start), the read still waits this long for the hashes it already asked for, so one slow start does
 * not make the read null. A test that hangs still ends the read at the limit.
 */
export const SIGNAL_GRACE_MS = 25;
/**
 * A browser that renders no sound without a tap leaves its offline context suspended, and the sound never
 * comes. The sound's test looks once, this long after it asked: still suspended with no sample rendered is
 * "na", the same at every read, never a late test that would make every read null.
 */
export const AUDIO_START_MS = 50;
/** The page's own three tests: each answers a short hash (`hashPrefix`) or "na". */
export type SignalProbes = { audio: () => Promise<string>; canvas: () => Promise<string>; webgl: () => Promise<string> };

/** SHA-256 through `crypto.subtle`, base64url, cut to `SIGNAL_BOUNDS.hash` characters: what a test sends instead of what it drew or played. */
export async function hashPrefix(data: string | Uint8Array | Uint8ClampedArray): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, SIGNAL_BOUNDS.hash);
}

/** The drawing: a fixed scene on a small offscreen 2D canvas (two fonts, an emoji, a gradient, arcs), hashed from its pixels. */
async function canvasProbe(): Promise<string> {
  const c = document.createElement("canvas");
  c.width = 240;
  c.height = 60;
  const g = c.getContext("2d");
  if (!g) return SIGNAL_NA;
  const sky = g.createLinearGradient(0, 0, 240, 60);
  sky.addColorStop(0, "#f2c14e");
  sky.addColorStop(0.5, "#2a9d8f");
  sky.addColorStop(1, "#264653");
  g.fillStyle = sky;
  g.fillRect(0, 0, 240, 60);
  g.textBaseline = "alphabetic";
  g.fillStyle = "#1d1d1f";
  g.font = "17px serif";
  g.fillText("Kicksmash, padel ñ ж 0.5", 6, 22);
  g.fillStyle = "rgba(255, 255, 255, 0.8)";
  g.font = "bold 15px sans-serif";
  g.fillText("Welcome back 🎾", 6, 46);
  g.beginPath();
  g.arc(200, 30, 22, 0, Math.PI * 1.5);
  g.strokeStyle = "rgba(230, 57, 70, 0.9)";
  g.lineWidth = 3;
  g.stroke();
  g.beginPath();
  g.arc(170, 38, 12, 0, Math.PI * 2, true);
  g.fillStyle = "rgba(102, 0, 153, 0.5)";
  g.fill();
  return hashPrefix(g.getImageData(0, 0, c.width, c.height).data);
}

const VERTEX = "attribute vec2 p;attribute vec3 c;varying vec3 v;void main(){v=c;gl_Position=vec4(p,0.0,1.0);}";
const FRAGMENT = "precision mediump float;varying vec3 v;void main(){gl_FragColor=vec4(v*v+0.1*sin(v*9.0),1.0);}";

/**
 * The 3D shape: the renderer and vendor (the unmasked ones where the browser masks them), four limits, the
 * supported extensions and the pixels of one small coloured triangle, in one hash. The context is let go
 * at the end, so the page holds no WebGL context it does not use.
 */
async function webglProbe(): Promise<string> {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 32;
  const gl = (c.getContext("webgl", { preserveDrawingBuffer: true }) ?? c.getContext("experimental-webgl")) as WebGLRenderingContext | null;
  if (!gl) return SIGNAL_NA;
  try {
    const masked = String(gl.getParameter(gl.RENDERER));
    // Chromium and Safari answer "WebKit WebGL" here; Firefox answers the real words, and warns about the extension.
    const info = /webkit webgl/i.test(masked) ? gl.getExtension("WEBGL_debug_renderer_info") : null;
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : masked);
    const vendor = String(info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR));
    const limits = [gl.MAX_TEXTURE_SIZE, gl.MAX_RENDERBUFFER_SIZE, gl.MAX_VIEWPORT_DIMS, gl.ALIASED_LINE_WIDTH_RANGE].map((p) => {
      const v = gl.getParameter(p) as number | ArrayLike<number> | null;
      return typeof v === "number" ? String(v) : v ? Array.from(v).join("x") : "";
    });
    const extensions = [...(gl.getSupportedExtensions() ?? [])].sort().join(",");
    const shader = (kind: number, source: string) => {
      const s = gl.createShader(kind);
      if (!s) throw new Error("shader");
      gl.shaderSource(s, source);
      gl.compileShader(s);
      return s;
    };
    const program = gl.createProgram();
    if (!program) throw new Error("program");
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    // x, y, then r, g, b, for each corner.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.9, -0.8, 1, 0.2, 0.1, 0.85, -0.6, 0.1, 0.9, 0.3, -0.1, 0.9, 0.3, 0.2, 1]), gl.STATIC_DRAW);
    const at = gl.getAttribLocation(program, "p");
    const colour = gl.getAttribLocation(program, "c");
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(colour);
    gl.vertexAttribPointer(colour, 3, gl.FLOAT, false, 20, 8);
    gl.clearColor(0.05, 0.1, 0.15, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixels = new Uint8Array(32 * 32 * 4);
    gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return hashPrefix([renderer, vendor, ...limits, extensions, await hashPrefix(pixels)].join("|"));
  } finally {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

/** The sound: a fixed oscillator through a compressor, rendered offline (no gesture, nothing heard); the sum of its last 500 samples, hashed. */
async function audioProbe(): Promise<string> {
  const w = window as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  const Offline = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (!Offline) return SIGNAL_NA;
  const ctx = new Offline(1, 5000, 44100);
  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = 10000;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -50;
  comp.knee.value = 40;
  comp.ratio.value = 12;
  comp.attack.value = 0;
  comp.release.value = 0.25;
  osc.connect(comp);
  comp.connect(ctx.destination);
  osc.start(0);
  const rendering = ctx.startRendering();
  rendering.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const begun = await Promise.race([rendering.then(() => true), new Promise<boolean>((done) => (timer = setTimeout(() => done(false), AUDIO_START_MS)))]).finally(() => clearTimeout(timer));
  // The sound's own clock moves on the audio thread, even while the page draws: still at 0 means it never began.
  if (!begun && ctx.state === "suspended" && !(ctx.currentTime > 0)) return SIGNAL_NA;
  const data = (await rendering).getChannelData(0);
  let sum = 0;
  for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
  return hashPrefix(sum.toString());
}

/** The page's real tests. The sound starts first: it renders while the page draws the other two. */
export const SIGNAL_PROBES: SignalProbes = { audio: audioProbe, canvas: canvasProbe, webgl: webglProbe };

/**
 * Each set of tests runs once in a page, and each answer settles once: every read in the page that gets
 * all three gets the same three. A test still running at one read's limit keeps running; that read is
 * null, and a later read in the page takes the whole set.
 */
const running = new WeakMap<SignalProbes, Promise<string>[]>();

const safely = async (probe: () => Promise<string>): Promise<string> => {
  try {
    const v = await probe();
    return isSignalHash(v) ? v : SIGNAL_NA;
  } catch {
    return SIGNAL_NA;
  }
};

const clock = () => (typeof performance === "undefined" ? Date.now() : performance.now());

const LATE = Symbol("late");

/**
 * The three answers, or null when one is not in by the limit: `budgetMs` after `began`, or
 * `SIGNAL_GRACE_MS` after the drawings when they alone ran past it. One timer for the three, cleared at the end.
 */
async function probedWithin(probes: SignalProbes, began: number, budgetMs: number): Promise<{ audio: string; canvas: string; webgl: string } | null> {
  let started = running.get(probes);
  if (!started) {
    // The sound first, so it renders while the page draws; each drawing runs here, synchronously, up to its hash.
    started = [safely(probes.audio), safely(probes.canvas), safely(probes.webgl)];
    running.set(probes, started);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof LATE>((done) => {
    timer = setTimeout(() => done(LATE), Math.max(budgetMs - (clock() - began), SIGNAL_GRACE_MS));
  });
  try {
    // Three tests in the browser, not three queries: rule 8 is about the database.
    const [audio, canvas, webgl] = await Promise.all(started.map((p) => Promise.race([p, late])));
    if (audio === LATE || canvas === LATE || webgl === LATE) return null;
    return { audio, canvas, webgl };
  } finally {
    clearTimeout(timer);
  }
}

type Settings = Pick<Required<SignalsWire>, "contrast" | "inverted" | "transparency" | "hourCycle" | "locale">;

/** The five settings, each as a short token; "na" where the browser knows no such setting (it matches no value). Synchronous. */
function settingsOf(): Settings {
  const matches = (q: string) => window.matchMedia?.(q).matches === true;
  const contrast: HintContrast | SignalNa = matches("(prefers-contrast: no-preference)") ? "none" : (HINT_CONTRASTS.find((c) => c !== "none" && matches(`(prefers-contrast: ${c})`)) ?? SIGNAL_NA);
  const flag = (feature: string, yes: string, no: string): HintFlag | SignalNa => (matches(`(${feature}: ${yes})`) ? "yes" : matches(`(${feature}: ${no})`) ? "no" : SIGNAL_NA);
  let hourCycle: HintHourCycle | SignalNa = SIGNAL_NA;
  let locale: string = SIGNAL_NA;
  try {
    const hours = new Intl.DateTimeFormat([], { hour: "numeric" }).resolvedOptions();
    if ((HINT_HOUR_CYCLES as readonly string[]).includes(hours.hourCycle ?? "")) hourCycle = hours.hourCycle as HintHourCycle;
    // A locale the server would refuse goes as "na", so one odd value never drops the whole hint.
    locale = cleanLocale(hours.locale) ?? SIGNAL_NA;
  } catch {
    // An Intl that cannot format an hour: both stay "na".
  }
  return { contrast, inverted: flag("inverted-colors", "inverted", "none"), transparency: flag("prefers-reduced-transparency", "reduce", "no-preference"), hourCycle, locale };
}

/**
 * The values, or null on the server, in Europe, when a test is late, or when anything throws. Asynchronous
 * since 30 October 2026: the hashes and the sound take a moment, and the whole read never more than
 * `budgetMs` (and `SIGNAL_GRACE_MS`). Every platform runs the tests: the values never go without them.
 */
export async function readDeviceSignals(probes: SignalProbes = SIGNAL_PROBES, budgetMs: number = SIGNAL_BUDGET_MS): Promise<SignalsWire | null> {
  let values: SignalsWire;
  const began = clock();
  try {
    if (typeof window === "undefined" || typeof navigator === "undefined") return null;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // The zone first: in Europe no setting is read and no test runs.
    if (!tz || isEuropeanZone(tz)) return null;
    const ua = navigator.userAgent;
    const touch = navigator.maxTouchPoints || 0;
    const platform = platformOf(ua, touch);
    let text: number | "na" = "na";
    // The phone's own text size (Dynamic Type), where the browser knows the font; else "na".
    if (typeof CSS !== "undefined" && CSS.supports?.("font", "-apple-system-body")) {
      const probe = document.createElement("span");
      probe.style.font = "-apple-system-body";
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      document.body.appendChild(probe);
      const size = parseFloat(getComputedStyle(probe).fontSize);
      probe.remove();
      if (Number.isFinite(size)) text = size;
    }
    const langs = (navigator.languages?.length ? navigator.languages : [navigator.language]).slice(0, 10).map((l) => l.toLowerCase());
    values = {
      w: screen.width,
      h: screen.height,
      dpr: Math.round((window.devicePixelRatio || 1) * 4) / 4,
      langs,
      tz,
      platform,
      touch,
      text,
      motion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true,
      ...settingsOf(),
    };
  } catch {
    return null;
  }
  const tests = await probedWithin(probes, began, budgetMs);
  return tests && { ...values, ...tests };
}

/** The tab's own note that it asked about one match: one question per match in a tab, never one per view. */
export const HINT_ASKED_KEY = "km_hint_asked:";

/** The values each question of the page sent, by match: "It's me" and "Not me" send exactly these. */
const askedWith = new WeakMap<SignalProbes, Map<string, SignalsWire>>();

/**
 * The values for the question "Welcome back, Tim?" (`WelcomeBack`), once per match in a tab, or null. The
 * zone comes first: in a European zone, on the server, or when anything throws, nothing is written to the
 * tab's storage and nothing is sent, because EU and UK law asks consent for any storage on the device,
 * personal data or not. Only then the tab's note (`sessionStorage`, which goes with the tab), and then the
 * values. A tab with no storage asks nothing, rather than once per view. A read that gives nothing (a test
 * still running at the limit) takes its note back, so a later view of the match may ask.
 */
export async function hintAskOnce(code: string, probes: SignalProbes = SIGNAL_PROBES): Promise<SignalsWire | null> {
  const note = HINT_ASKED_KEY + code;
  try {
    if (typeof window === "undefined") return null;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz || isEuropeanZone(tz)) return null;
    if (window.sessionStorage.getItem(note)) return null;
    window.sessionStorage.setItem(note, "1");
  } catch {
    return null;
  }
  const values = await readDeviceSignals(probes);
  if (!values) {
    try {
      window.sessionStorage.removeItem(note);
    } catch {
      // The note stays: this tab asks no more about the match.
    }
    return null;
  }
  const page = askedWith.get(probes) ?? new Map<string, SignalsWire>();
  askedWith.set(probes, page.set(code, values));
  return values;
}

/**
 * What "It's me" and "Not me" send: exactly the values the question of this match sent in this page, so
 * the server makes the same key and finds the same question ("a question and the tap that answers it send
 * the same input"). Nothing is read again. Null where this page asked nothing about the match.
 */
export function hintAnswerValues(code: string, probes: SignalProbes = SIGNAL_PROBES): SignalsWire | null {
  return askedWith.get(probes)?.get(code) ?? null;
}

/**
 * For the one door that is a plain navigation, the Telegram return: the values ride in a cookie bound to
 * the login route for one minute, which the route reads and deletes (`SIGNALS_COOKIE`, named on /privacy).
 * Nothing is written in Europe. The return waits for it (at most `SIGNAL_BUDGET_MS`) before it leaves.
 */
export async function writeSignalsCookie(): Promise<void> {
  const values = await readDeviceSignals();
  if (!values) return;
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${SIGNALS_COOKIE}=${encodeURIComponent(JSON.stringify(values))}; path=${SIGNALS_COOKIE_PATH}; max-age=${SIGNALS_COOKIE_MAX_AGE}; samesite=lax${secure}`;
}
