// Character form → simulate the month up front → replay it in three.js with an event feed.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import townJson from "../../data/town.json" with { type: "json" };
import traitsJson from "../../data/traits.json" with { type: "json" };
import tuningJson from "../../data/tuning.json" with { type: "json" };
import { type Affinity, eventKey, type SimEvent, SLOTS, type Tuning, simulate } from "../sim/engine.ts";
import { MAX_INTERESTS, type Orientation, type PlayerSpec, RATINGS, RATING_BUDGET, type Sex, buildWorld } from "../sim/world.ts";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/inter";
import { type ShareData, share, xIntent } from "./share.ts";
import { CITY_SIZE, buildCity } from "./city.ts";
import { loadPeople, PERSON_SCALE } from "./people.ts";

const DAYS = 30;
const SPEEDS = [1, 4, 16, 64]; // × half an hour per 2 seconds
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const PHONE_ZOOM = 1.6; // playback starts this far in on small screens, so the place names don't pile up
// Same queries as the CSS: small screens measure the score and HUD; portrait ones stack the feed at the bottom.
const COMPACT = "(max-width: 900px), (max-height: 500px)", STACKED = "(max-width: 900px) and (orientation: portrait)";
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------------------------------------------------------------- the stage
// Built at load, behind the form: a still, sunlit town. start() brings the same town to life.
const base = buildWorld(); // the town without a player: identical to the one the player joins
const stage = (async () => {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  $("#app").append(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.setSize(innerWidth, innerHeight);
  Object.assign(labels.domElement.style, { position: "fixed", top: "0", pointerEvents: "none" });
  document.body.append(labels.domElement);

  const scene = new THREE.Scene();
  // Fixed isometric view of the whole town: looking down the (1,1,1) diagonal, framed beside the feed and under the HUD.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 300);
  camera.position.set(60, 60, 60); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  let playing = false, declutter = () => {};
  const overlaps = (a: DOMRect, b: DOMRect, lift: number) =>
    a.left < b.right + 3 && b.left < a.right + 3 && a.top < b.bottom - lift && b.top - lift < a.bottom;
  const frame = (play = playing) => {
    playing = play;
    const half = CITY_SIZE / 2, v = new THREE.Vector3();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, g0 = Infinity, g1 = -Infinity; // g: the ground alone
    for (const x of [-half, half]) for (const y of [0, 3]) for (const z of [-half, half]) { // city bounds, tallest tower ~3
      v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
      if (y === 0) { g0 = Math.min(g0, v.y); g1 = Math.max(g1, v.y); }
    }
    // Desktop: feed on the right, score top-left, HUD below. Small screens: town between the score bar and the HUD (and feed, in portrait).
    const compact = playing && matchMedia(COMPACT).matches, margin = 16;
    const side = playing && !matchMedia(STACKED).matches ? 360 : 0;
    const top = compact ? $("#score").getBoundingClientRect().bottom + 8 : margin;
    const bottom = playing ? innerHeight - $("#hud").getBoundingClientRect().top + 8 : margin; // clear of the HUD
    const w = innerWidth - side - 2 * margin, h = innerHeight - top - bottom;
    const s = Math.max((x1 - x0) / w, (y1 - y0) / h); // world units per pixel
    // City centre → this pixel. Sized to fit the towers, but centred on the ground on desktop: the back corner's buildings
    // are short, so centring the tower-height box would leave the town sitting low.
    const px = margin + w / 2, py = top + h / 2, cx = (x0 + x1) / 2, cy = compact ? (y0 + y1) / 2 : (g0 + g1) / 2;
    // three zooms about the frustum's middle (the screen centre); shift it so a zoom stays centred on (px, py) instead
    const k = s * (1 - 1 / camera.zoom), dx = (innerWidth / 2 - px) * k, dy = (py - innerHeight / 2) * k;
    Object.assign(camera, { left: cx - px * s - dx, right: cx + (innerWidth - px) * s - dx, top: cy + py * s - dy, bottom: cy - (innerHeight - py) * s - dy });
    camera.updateProjectionMatrix();
    declutter();
  };
  frame();
  // Zoom and pan, never rotate: wheel or pinch zooms toward the cursor, drag pans, the view stays over the town.
  const controls = new OrbitControls(camera, renderer.domElement);
  Object.assign(controls, { enableRotate: false, zoomToCursor: true, minZoom: 1, maxZoom: 6, maxTargetRadius: CITY_SIZE / 2 });
  controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
  controls.touches.ONE = THREE.TOUCH.PAN;
  controls.addEventListener("change", () => declutter());
  const hemi = new THREE.HemisphereLight(0xdff2ff, 0x6a7a4a, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const reach = CITY_SIZE * 0.75; // the sun circles, so cover the city's diagonal
  Object.assign(sun.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, far: 100 });
  scene.add(hemi, sun);
  addEventListener("resize", () => {
    frame();
    renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight);
  });

  const city = await buildCity(scene, base);
  // Place names. The renderer owns each wrapper's transform; we nudge the pill inside it so names never overlap.
  const placeLabels = base.venues.filter(v => !["home", "work", "transit"].includes(v.kind)).map(v => {
    const wrap = document.createElement("div"), pill = document.createElement("div");
    pill.className = "label place"; pill.textContent = v.name; wrap.append(pill);
    const label = new CSS2DObject(wrap);
    label.position.copy(city.anchor[v.id]).setY(v.kind === "outdoors" || v.kind === "school" ? 0.8 : 1.5);
    scene.add(label);
    return { label, pill };
  });
  declutter = () => { // greedy, bottom of the screen first: lift each name above any it would cover
    labels.render(scene, camera);
    const placed: DOMRect[] = [], v = new THREE.Vector3();
    const items = placeLabels.map(l => ({ ...l, y: (1 - v.copy(l.label.position).project(camera).y) / 2 * innerHeight }));
    for (const it of items.sort((a, b) => b.y - a.y)) {
      it.pill.style.transform = "";
      let r = it.pill.getBoundingClientRect(), lift = 0;
      for (let hit = placed.find(p => overlaps(p, r, lift)); hit; hit = placed.find(p => overlaps(p, r, lift))) lift = r.bottom - hit.top + 2;
      it.pill.style.transform = `translateY(${-lift}px)`;
      placed.push(new DOMRect(r.x, r.y - lift, r.width, r.height));
    }
  };
  declutter();
  hemi.intensity = 1.8; sun.intensity = 2.9; sun.position.set(8, 25, 12); scene.background = new THREE.Color(0xa8dcff);
  renderer.setAnimationLoop(() => { renderer.render(scene, camera); labels.render(scene, camera); });
  return { renderer, labels, scene, camera, hemi, sun, city, frame };
})();

// ---------------------------------------------------------------- character form
const form = $<HTMLFormElement>("#setup");
const ratingInputs = [...form.querySelectorAll<HTMLInputElement>("#ratings input")];
const showBudget = () => { // points left, plus each stat bar's fill and number
  const left = RATING_BUDGET - ratingInputs.reduce((s, i) => s + +i.value, 0);
  $("#budget").textContent = left ? `${left} point${left === 1 ? "" : "s"} to spend` : "all points spent";
  $("#budget").classList.toggle("spent", !left);
  for (const i of ratingInputs) {
    i.style.setProperty("--pct", `${((+i.value - 1) / 9) * 100}%`);
    i.nextElementSibling!.textContent = i.value;
  }
};
ratingInputs.forEach(i => i.addEventListener("input", () => {
  const over = ratingInputs.reduce((s, x) => s + +x.value, 0) - RATING_BUDGET;
  if (over > 0) i.value = String(+i.value - over);
  showBudget();
}));
form.addEventListener("change", e => {
  const box = e.target as HTMLInputElement;
  if (box.name === "interest" && form.querySelectorAll("input[name=interest]:checked").length > MAX_INTERESTS) box.checked = false;
});
showBudget();

function readForm(): PlayerSpec {
  const f = new FormData(form);
  const sex = f.get("sex") as Sex, into = f.get("into") as string;
  const orientation: Orientation = into === "everyone" ? "bisexual" : (into === "women") === (sex === "female") ? "gay" : "straight";
  return {
    name: String(f.get("name")).trim() || "You", sex, age: Math.max(21, +f.get("age")!), orientation,
    employed: f.has("employed"), apps: f.has("apps"), casual: f.get("looking") !== "love", nightlife: +f.get("nightlife")!, gym: +f.get("gym")!,
    attr: +f.get("attr")!, sinc: +f.get("sinc")!, intel: +f.get("intel")!, fun: +f.get("fun")!, amb: +f.get("amb")!,
    interests: f.getAll("interest").map(String),
  };
}

// npm run dev sets VITE_NO_API: UI work runs on the calibrated model and canned text, spending nothing.
const NO_API = import.meta.env.VITE_NO_API === "1";
async function api<T>(path: string, payload: unknown): Promise<T> {
  if (NO_API) throw new Error("API calls are off (npm run dev). Use npm run dev:api for the real thing.");
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const data = await r.json().catch(() => ({ error: "The city is unreachable." }));
  if (!r.ok) throw Object.assign(new Error(data.error ?? "Something went wrong."), { status: r.status });
  return data as T;
}

// Free text → server (moderation + Opus) → fill in the form, so the player can still tweak by hand.
let bio = "";
function fillForm(s: PlayerSpec, newBio: string) {
  const set = (name: string, v: string | number) => ((form.elements.namedItem(name) as HTMLInputElement).value = String(v));
  for (const k of ["name", "age", "sex", "nightlife", "gym", "attr", "sinc", "intel", "fun", "amb"] as const) set(k, s[k]);
  set("looking", s.casual ? "casual" : "love");
  set("into", s.orientation === "bisexual" ? "everyone" : (s.orientation === "gay") === (s.sex === "female") ? "women" : "men");
  (form.elements.namedItem("employed") as HTMLInputElement).checked = s.employed;
  (form.elements.namedItem("apps") as HTMLInputElement).checked = s.apps;
  form.querySelectorAll<HTMLInputElement>("input[name=interest]").forEach(b => (b.checked = s.interests.includes(b.value)));
  bio = newBio; $("#bio").textContent = bio;
  showBudget();
}
$("#describe").onclick = async () => {
  const status = $("#describe-status"), description = (form.elements.namedItem("description") as HTMLTextAreaElement).value;
  status.textContent = "Reading them…";
  try {
    const out = await api<{ spec: PlayerSpec; bio: string }>("/api/character", { description });
    fillForm(out.spec, out.bio); status.textContent = "";
  } catch (e) { status.textContent = (e as Error).message; }
};

// 🎲 A starting point, free: a single resident aged 21-45 under an invented name, loaded on first use, half the time
// from data/english-*-names.json (human-names' English lists, MIT, minus places, brands, celebrities and typos), half
// from data/indian-*-names.json (first names seen at least twice in the indian-names npm package's records), their
// job, quirks, week and ratings in the form, the ratings scaled to spend exactly the 33-point budget.
const traitsOf = traitsJson as Record<string, { nightlife: number; gym: number; dating_apps: boolean; interests: string[]; type: string; dealbreaker: string; flirting_style: string }>;
const cast21to45 = townJson.filter(p => !("visitor" in p) && p.status === "single" && p.age >= 21 && p.age <= 45);
const randomName = async (sex: Sex) => {
  const names: string[] = (await (Math.random() < 0.5
    ? sex === "female" ? import("../../data/english-female-names.json") : import("../../data/english-male-names.json")
    : sex === "female" ? import("../../data/indian-female-names.json") : import("../../data/indian-male-names.json"))).default;
  return names[Math.random() * names.length | 0];
};
$("#dice").onclick = async () => {
  const p = cast21to45[Math.random() * cast21to45.length | 0], t = traitsOf[String(p.id)], sex = p.sex as Sex;
  const name = await randomName(sex), old = new RegExp(`\\b${p.name.split(" ")[0]}\\b`, "g"), own = (s: string) => s.replace(old, name);
  const job = p.occupation.replaceAll("_", " "); // as the feed shows it: "janitor or building cleaner"
  const working = !["not_in_workforce", "no_occupation"].includes(p.occupation);
  const into = p.orientation === "bisexual" ? "everyone" : (p.orientation === "gay") === (sex === "female") ? "women" : "men";
  (form.elements.namedItem("description") as HTMLTextAreaElement).value = `${name}, ${p.age}, ${working ? `${/^[aeiou]/.test(job) ? "an" : "a"} ${job}` : "between jobs"}. ` +
    `Into ${into}. ${own(t.flirting_style)} Type: ${own(t.type)} Dealbreaker: ${own(t.dealbreaker)}`;
  const r = base.agents[p.id], sum = RATINGS.reduce((s, k) => s + r[k], 0);
  const pts = Object.fromEntries(RATINGS.map(k => [k, Math.max(1, Math.min(10, Math.round(r[k] * RATING_BUDGET / sum)))])) as Record<(typeof RATINGS)[number], number>;
  for (let left = RATING_BUDGET - RATINGS.reduce((s, k) => s + pts[k], 0); left !== 0;) { // rounding: fix the last point or two
    const k = RATINGS[Math.random() * RATINGS.length | 0];
    if (left > 0 && pts[k] < 10) { pts[k]++; left--; } else if (left < 0 && pts[k] > 1) { pts[k]--; left++; }
  }
  fillForm({ ...readForm(), ...pts, name, age: p.age, sex, orientation: p.orientation as Orientation, employed: working,
    nightlife: Math.min(5, t.nightlife), gym: Math.min(6, t.gym), apps: t.dating_apps, interests: t.interests.slice(0, MAX_INTERESTS) }, "");
  $<HTMLButtonElement>("#describe").disabled = true; // the form already matches; editing the text turns it back on
};
// the HTML's "Alex" holds the field until the list loads; swap it unless they've already typed a name
const nameInput = form.elements.namedItem("name") as HTMLInputElement;
randomName("male").then(n => { if (nameInput.value === nameInput.defaultValue) nameInput.value = n; });
$("textarea[name=description]").addEventListener("input", () => ($<HTMLButtonElement>("#describe").disabled = false));

const newSeed = () => (Math.random() * 2 ** 31) | 0;
form.addEventListener("submit", async e => {
  e.preventDefault();
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
  button.disabled = true; button.textContent = "Asking the town about you…";
  const description = (form.elements.namedItem("description") as HTMLTextAreaElement).value.trim();
  let spec = readForm(), seed = newSeed(), affinity: Affinity | undefined, runId: string | undefined;
  try {
    ({ spec, seed, affinity, runId } = await api<{ spec: PlayerSpec; seed: number; affinity: Affinity; runId: string }>("/api/run", { spec, bio, description }));
  } catch (err) {
    if ([422, 429].includes((err as { status?: number }).status!)) { // moderation said no, or slow down: stay on the form
      button.disabled = false; button.textContent = "Release them into the city 🏙️";
      $("#describe-status").textContent = (err as Error).message;
      return;
    } // otherwise offline: the calibrated sim still runs, unranked, without Jev's read on who likes whom
  }
  form.style.display = "none"; $("#corner").style.display = "none"; $("#veil").style.display = "none";
  start(spec, bio, seed, affinity, runId);
  sessionStorage.setItem("last", JSON.stringify({ spec, bio, description }));
});
// "Tweak & try again" reloads with the last character filled in but not released: change something, or release
// as is for new dice.
const last = sessionStorage.getItem("tweak");
if (last) {
  sessionStorage.removeItem("tweak");
  const r = JSON.parse(last);
  fillForm(r.spec, r.bio);
  (form.elements.namedItem("description") as HTMLTextAreaElement).value = r.description;
}

// ---------------------------------------------------------------- leaderboard
// Every run by everyone, best first: character name and body count.
type Row = { rank: number; name: string; score: number };
let boardRows = 0, boardYou: Row | null = null;
async function loadBoard(more = false) {
  const list = $("#board ol");
  if (!more) { list.innerHTML = ""; boardRows = 0; }
  try {
    const { total, rows } = await api<{ total: number; rows: Row[] }>("/api/leaderboard", { offset: boardRows, limit: 50 });
    for (const r of rows) {
      const li = document.createElement("li");
      li.className = boardYou && r.rank === boardYou.rank && r.name === boardYou.name && r.score === boardYou.score ? "mine" : "";
      li.innerHTML = `<span class="rank">#${r.rank}</span><span class="who"></span><b>${r.score} 💋</b>`;
      li.querySelector(".who")!.textContent = r.name;
      list.append(li);
    }
    boardRows += rows.length;
    $("#board .total").textContent = `${total.toLocaleString()} ${total === 1 ? "run" : "runs"}`;
    $("#board-more").style.display = boardRows < total ? "block" : "none";
  } catch (e) { $("#board .total").textContent = (e as Error).message; $("#board-more").style.display = "none"; }
}
function openBoard() {
  $("#board .you-line").textContent = boardYou ? `You: #${boardYou.rank} · ${boardYou.name} · ${boardYou.score} 💋` : "";
  popup("board");
  loadBoard();
}
// Leaderboard, how-it-works and the recap: at most one open, over a dimmed, blurred page.
function popup(id: "board" | "how" | "recap" | null) {
  for (const p of ["board", "how", "recap"]) $(`#${p}`).style.display = p !== id ? "none" : p === "recap" ? "block" : "flex";
  $("#scrim").style.display = id ? "block" : "none";
}
$("#board-open").onclick = openBoard;
$("#how-open").onclick = () => popup("how");
for (const id of ["#board-close", "#how-close", "#scrim"]) $(id).onclick = () => popup(null);
addEventListener("keydown", e => { if (e.key === "Escape") popup(null); });
$("#board-more").onclick = () => loadBoard(true);

// ---------------------------------------------------------------- the month
async function start(spec: PlayerSpec, bio: string, seed: number, affinity?: Affinity, runId?: string) {
  const world = buildWorld(spec);
  const N = world.agents.length, me = N - 1;
  const res = simulate(world, tuningJson as Tuning, { days: DAYS, seed, focus: me, trackLocations: true, affinity });
  // Words arrive while the month plays; canned text covers anything not back yet.
  let story: { lines: Record<string, string>; recap: { headline: string; recap: string } | null } = { lines: {}, recap: null };
  const feedItems = new Map<string, [HTMLLIElement, SimEvent]>();
  let writing = !!runId; // the recap is on its way
  if (runId) api<typeof story>("/api/story", { runId, seed }).then(s => {
    story = s;
    for (const [key, [li, e]] of feedItems) if (s.lines[key]) cast(li, s.lines[key], [e.a, e.b, e.about ?? -1]);
  }).catch(() => {}).finally(() => {
    writing = false;
    if ($("#recap").style.display === "block") recap(); // the month ended first (Skip, or a fast speed): swap in the words now
  });
  const locations = res.locations!;
  const ticks = DAYS * SLOTS;

  const { renderer, labels, scene, camera, hemi, sun, city, frame } = await stage;
  // The player's home: next door to someone in their friend circle (the town was laid out without them).
  const mate = world.circles[world.agents[me].circle].find(id => id !== me)!;
  city.anchor[world.agents[me].home] = city.anchor[world.agents[mate].home].clone().add(new THREE.Vector3(0.45, 0, 0.2));
  city.indoor[world.agents[me].home] = true; city.spread[world.agents[me].home] = 0.5;
  for (const v of world.venues) if (v.name === "out of town") { // visitors wait, hidden, at the end of Main Street
    city.anchor[v.id] = new THREE.Vector3(0, 0, CITY_SIZE / 2); city.indoor[v.id] = true; city.spread[v.id] = 0;
  }

  // People: Kenney mini characters. Crowd instanced; the player animated, a bit bigger, with a ring and a name tag.
  const people = await loadPeople(scene, world.agents.slice(0, -1).map(a => a.sex), spec.sex);
  const player = new THREE.Group();
  people.player.scale.setScalar(PERSON_SCALE * 1.3);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.42, 32), new THREE.MeshBasicMaterial({ color: 0xe0245e, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
  const tagDiv = document.createElement("div");
  tagDiv.className = "label you"; tagDiv.innerHTML = "<b></b><small></small>";
  const [tagName, tagWhere] = tagDiv.children as unknown as [HTMLElement, HTMLElement];
  tagName.textContent = spec.name;
  const tag = new CSS2DObject(tagDiv);
  tag.position.y = 1.1;
  player.add(people.player, ring, tag);
  scene.add(player);

  // Where agent i stands at a tick: their venue's anchor plus a stable personal offset.
  const jitter = world.agents.map((_, i) => {
    const a = (i * 2.399963) % (2 * Math.PI), r = Math.sqrt(((i * 0.618034) % 1));
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  });
  const via = new THREE.Vector3();
  const posAt = (i: number, tick: number, out: THREE.Vector3): THREE.Vector3 => {
    tick = Math.min(tick, ticks - 1);
    const v = locations[tick * N + i], j = jitter[i];
    if (world.venues[v].kind === "transit") { // travelling: partway along the line from the last place to the next
      let a = tick, b = tick;
      while (a > 0 && locations[a * N + i] === v) a--;
      while (b < ticks - 1 && locations[b * N + i] === v) b++;
      const from = locations[a * N + i] === v ? b : a, to = locations[b * N + i] === v ? a : b;
      if (locations[from * N + i] === v) return out.copy(city.anchor[v]); // in transit all month: never happens
      return posAt(i, from, out).lerp(posAt(i, to, via), (tick - a) / (b - a));
    }
    out.copy(city.anchor[v]);
    return out.set(out.x + j.x * city.spread[v], 0, out.z + j.z * city.spread[v]);
  };
  const hidden = (i: number, tick: number) => {
    const v0 = locations[Math.min(tick, ticks - 1) * N + i], v1 = locations[Math.min(tick + 1, ticks - 1) * N + i];
    return v0 === v1 && city.indoor[v0];
  };

  // ------------------------------------------------------------ HUD and feed
  let t = 0, speed = 4, paused = false, nextEvent = 0;
  const partners = new Set<number>();
  let matches = 0, dates = 0;
  const tally = () => {
    $("#matches").innerHTML = `📱 <b>${matches}</b> ${matches === 1 ? "match" : "matches"}`;
    $("#dates").innerHTML = `🍷 <b>${dates}</b> ${dates === 1 ? "date" : "dates"}`;
    $("#bodies").innerHTML = `💋 <b>${partners.size}</b> body count`;
  };
  tally();
  $("#hud").style.display = $("#score").style.display = "flex"; $("#feed").style.display = "block";
  $("#speeds").append(...SPEEDS.map(s => {
    const b = document.createElement("button");
    b.className = "ghost"; b.textContent = `${s}×`; b.setAttribute("aria-pressed", String(s === speed));
    b.onclick = () => { speed = s; document.querySelectorAll("#speeds button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); };
    return b;
  }));
  $("#pause").onclick = () => { paused = !paused; $("#pause").textContent = paused ? "Play" : "Pause"; };
  $("#skip").onclick = () => { if (done) recap(); else t = ticks; };
  if (matchMedia(COMPACT).matches) camera.zoom = PHONE_ZOOM; // the whole town is too small to read on a phone; pinch out for it
  frame(true); // after the HUD is up: on phones the framing measures it

  const person = (i: number) => (i === me ? undefined : world.agents[i]); // everyone but the player
  const who = (i: number) => {
    const p = person(i);
    return p ? `${p.name} (${p.age}, ${p.occupation.replaceAll("_", " ").replace("not in workforce", "not working")})` : "someone";
  };
  const at = (v: number) => world.venues[v].name;
  const other = (e: SimEvent) => (e.a === me ? e.b : e.a);
  function describe(e: SimEvent): string {
    if (story.lines[eventKey(e)]) return story.lines[eventKey(e)];
    switch (e.type) {
      case "spark": return `Hit it off with ${who(other(e))} at ${at(e.venue)}. Numbers exchanged.`;
      case "match": return `Matched with ${who(other(e))} on the apps.`;
      case "rejected": return e.a === me ? `${who(e.b)} was not into you at ${at(e.venue)}.` : `You weren't feeling ${who(e.a)}.`;
      case "date": return `Date with ${who(other(e))} at ${at(e.venue)}.`;
      case "stood_up": return e.a === me ? `${who(e.b)} stood you up.` : `You stood up ${who(e.a)}.`;
      case "hookup": return `Went home with ${who(other(e))}.`;
      case "couple": return `You and ${who(other(e))} are official now.`;
      case "breakup": return `You and ${who(other(e))} called it off.`;
      case "gossip": return `${who(e.b)} told you about their night with ${who(e.about!)}.`; // other cases grouped in show()
    }
  }
  const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  const friends = (k: number) => n(k, "friend");
  const gossipLines = new Map<string, { li: HTMLLIElement; mine: number; theirs: number }>();
  const clock = (tick: number, ofMonth = false) => { // the HUD says "Day 3/30", cards just "Day 3"
    const day = Math.floor(tick / SLOTS), mins = 240 + (tick % SLOTS) * 30;
    const wd = WEEKDAYS[(day + (mins >= 1440 ? 1 : 0)) % 7], hh = Math.floor(mins / 60) % 24, mm = mins % 60;
    return `Day ${day + 1}${ofMonth ? `/${DAYS}` : ""} · ${wd} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };
  const feed = $("#feed ol");
  // Every outcome gets a card: big emoji, a title in the player's terms, then the story line.
  type Tone = "love" | "good" | "date" | "meh" | "gossip";
  function outcome(e: SimEvent): { emoji: string; title: string; tone: Tone } {
    switch (e.type) {
      case "spark": return { emoji: "✨", title: "Sparks flew", tone: "good" };
      case "match": return { emoji: "📱", title: "It's a match", tone: "good" };
      case "rejected": return e.a === me ? { emoji: "🙅", title: "Turned down", tone: "meh" } : { emoji: "🤷", title: "Not feeling it", tone: "meh" };
      case "date": return { emoji: "🍷", title: "Date night", tone: "date" };
      case "stood_up": return e.a === me ? { emoji: "🪑", title: "Stood up", tone: "meh" } : { emoji: "👻", title: "You ghosted", tone: "meh" };
      case "hookup": return { emoji: "💋", title: "Went home together", tone: "love" };
      case "couple": return { emoji: "💘", title: "It's official", tone: "love" };
      case "breakup": return { emoji: "💔", title: "It's over", tone: "meh" };
      case "gossip": return e.a === me ? { emoji: "👂", title: "Heard some gossip", tone: "gossip" } : { emoji: "🗣️", title: "Word gets around", tone: "gossip" };
    }
  }
  // A card's text with its people picked out: names in the card's colour, "(age, job)" quieter. Plain text nodes, never HTML.
  function cast(li: HTMLLIElement, text: string, ids: number[]) {
    const names = ids.flatMap(i => { const p = person(i); return p ? [p.name, p.name.split(" ")[0]] : []; }); // full name wins
    const alts = names.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const p = li.querySelector("p")!, re = new RegExp(`\\b(${alts})\\b( \\(\\d+, [^)]*\\))?`, "g");
    p.replaceChildren();
    let i = 0;
    for (const m of names.length ? text.matchAll(re) : []) {
      p.append(text.slice(i, m.index), Object.assign(document.createElement("strong"), { textContent: m[1] }));
      if (m[2]) p.append(Object.assign(document.createElement("small"), { textContent: m[2] }));
      i = m.index + m[0].length;
    }
    p.append(text.slice(i));
  }
  function card(tick: number, o: ReturnType<typeof outcome>, text: string, ids: number[]) {
    const li = document.createElement("li");
    li.className = `card ${o.tone}`;
    li.innerHTML = `<span class="emoji" aria-hidden="true">${o.emoji}</span><div><header><b>${o.title}</b><time>${clock(tick)}</time></header><p></p></div>`;
    cast(li, text, ids);
    return li;
  }

  function show(e: SimEvent) {
    if (e.type === "hookup") partners.add(other(e));
    if (e.type === "match") matches++;
    if (e.type === "date") dates++;
    tally();
    if (e.type === "gossip" && e.a !== me) { // one card per night: who told how many friends, both sides
      const them = e.b === me ? e.about! : e.b, key = `${e.tick}|${them}`;
      const g = gossipLines.get(key) ?? { li: card(e.tick, outcome(e), "", []), mine: 0, theirs: 0 };
      if (!gossipLines.has(key)) { feed.append(g.li); gossipLines.set(key, g); }
      if (e.b === me) g.mine++; else g.theirs++;
      const name = person(them)?.name.split(" ")[0] ?? "they";
      cast(g.li, [g.mine && `You told ${friends(g.mine)} about your night with ${who(them)}.`,
        g.theirs && `${g.mine ? name : who(them)} told ${friends(g.theirs)}.`].filter(Boolean).join(" "), [them]);
      return;
    }
    const li = card(e.tick, outcome(e), describe(e), [e.a, e.b, e.about ?? -1]);
    feed.append(li);
    feedItems.set(eventKey(e), [li, e]);
    if (["hookup", "spark", "match", "rejected", "couple", "breakup"].includes(e.type)) {
      tagName.textContent = `${spec.name} ${{ hookup: "💋", spark: "✨", match: "📱", rejected: "🙅", couple: "💘", breakup: "💔" }[e.type as string]}`;
      if (e.type !== "rejected" || e.a === me) people.emote(e.type !== "rejected" && e.type !== "breakup"); // nod at good news, head-shake at bad
      setTimeout(() => tagName.textContent = spec.name, 2500);
    }
  }

  function recap() {
    const count = (type: string) => res.events.filter(e => e.type === type && (type !== "rejected" || e.a === me)).length;
    const el = $("#recap");
    const esc = (t: string) => t.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
    const open = el.querySelector("details")?.open ? " open" : ""; // keep the list as the player left it on a redraw
    // Two columns: the story on the left, everything to do on the right (one column without a story, or on phones).
    el.classList.toggle("solo", !story.recap && !writing);
    el.innerHTML = `<div class="recap-grid">
      <div class="recap-story">${story.recap ? `<h2 class="headline">${esc(story.recap.headline)}</h2><p>${esc(story.recap.recap)}</p>`
        : writing ? `<p class="writing">✍️ Writing your recap…</p>` : ""}</div>
      <div class="recap-side">
      <details${open}><summary>💋 ${esc(spec.name)}'s body count: ${partners.size}</summary>
        <ul>${[...partners].map(p => `<li>${who(p)}</li>`).join("") || "<li>Nobody. The city was not ready.</li>"}</ul></details>
      <div class="stats"><span>✨ ${n(count("spark"), "spark")}</span><span>📱 ${n(count("match"), "match", "matches")}</span><span>🍷 ${n(count("date"), "date")}</span><span>🙅 ${n(count("rejected"), "rejection")}</span><span>🪑 stood up ${n(res.events.filter(e => e.type === "stood_up" && e.a === me).length, "time")}</span></div>
      <p class="ranked" id="ranked">${runId ? "🏆 Ranking…" : "Unranked: the API is off, so this run isn't on the leaderboard."}</p>
      <div class="share"><button id="share">📸 Share your month</button> <a id="post-x" class="button ghost" target="_blank" rel="noopener">Post on 𝕏</a> <span id="share-status"></span></div>
      <div class="ctas"><button id="tweak">✏️ Tweak &amp; try again</button> <button id="board-recap" class="ghost">🏆 Leaderboard</button> <button id="new" class="ghost">New character</button> <button id="back" class="ghost">🏙️ Back to the city</button></div>
      </div></div>`;
    popup("recap");
    const card: ShareData = { name: spec.name, score: partners.size, rank: null, total: null, matches: count("match"), dates: count("date"),
      headline: story.recap?.headline ?? null, url: "https://sexandthecity.fun" };
    const postX = $<HTMLAnchorElement>("#post-x");
    postX.href = xIntent(card);
    if (runId) api<{ you: Row | null; total: number }>("/api/leaderboard", { limit: 0, run: runId }).then(({ you, total }) => {
      boardYou = you;
      $("#ranked").textContent = you ? `🏆 #${you.rank.toLocaleString()} of ${total.toLocaleString()} runs on the leaderboard` : "";
      if (you) { card.rank = you.rank; card.total = total; postX.href = xIntent(card); }
    }).catch(() => ($("#ranked").textContent = ""));
    $("#share").onclick = async () => {
      $("#share-status").textContent = "Drawing…";
      const how = await share(card).catch(() => null);
      $("#share-status").textContent = how === "downloaded" ? "Saved the image and copied the link." : how ? "" : "Couldn't make the image.";
    };
    $("#board-recap").onclick = openBoard;
    $("#tweak").onclick = () => { sessionStorage.setItem("tweak", sessionStorage.getItem("last") ?? ""); location.reload(); };
    $("#new").onclick = () => location.reload();
    $("#back").onclick = () => popup(null);
  }

  // ------------------------------------------------------------ frame loop
  const night = new THREE.Color(0x1b2550), day = new THREE.Color(0xa8dcff), sky = new THREE.Color();
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const size = new THREE.Vector3().setScalar(PERSON_SCALE), none = new THREE.Vector3(0, 0, 0), up = new THREE.Vector3(0, 1, 0);
  const heading = new Float32Array(N);
  let last = performance.now(), done = false, shownVenue = -1;
  renderer.setAnimationLoop(now => {
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000)); last = now; // rAF time can predate setup
    if (!paused && !done) t = Math.min(ticks, t + dt * speed / 2);
    const k = Math.min(Math.floor(t), ticks - 1), f = Math.min(1, (t - k) * 3); // walk in the first third, then linger
    while (nextEvent < res.events.length && res.events[nextEvent].tick <= t) show(res.events[nextEvent++]);

    for (let i = 0; i < N; i++) {
      posAt(i, k, p0); posAt(i, k + 1, p1);
      const dx = p1.x - p0.x, dz = p1.z - p0.z, moving = f < 1 && dx * dx + dz * dz > 1e-4;
      if (moving) heading[i] = Math.atan2(dx, dz); // face where they're walking, keep facing it once there
      p0.lerp(p1, f * f * (3 - 2 * f));
      if (i === me) {
        player.position.copy(p0); people.player.rotation.y = heading[i];
        people.animate(moving && !paused, paused ? 0 : dt);
        continue;
      }
      if (moving && !paused) p0.y = Math.abs(Math.sin(now / 90 + i)) * 0.06; // the crowd hops instead of animating
      const slot = people.slot[i];
      people.crowd[slot.mesh].setMatrixAt(slot.index, m.compose(p0, q.setFromAxisAngle(up, heading[i]), hidden(i, k) ? none : size));
    }
    for (const mesh of people.crowd) mesh.instanceMatrix.needsUpdate = true;

    const hour = (4 + (t % SLOTS) / 2) % 24, light = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
    scene.background = sky.copy(night).lerp(day, light);
    hemi.intensity = 0.9 + 0.9 * light; sun.intensity = 0.3 + 2.6 * light; // never too dark to see the colours
    sun.position.set(Math.cos((hour / 24) * 2 * Math.PI) * 20, 25, 12);
    city.night(Math.min(1, Math.max(0, 1 - light * 2))); // lamps on through dusk and dawn
    $("#clock").textContent = clock(k, true);
    const here = locations[k * N + me];
    if (here !== shownVenue) { shownVenue = here; tagWhere.textContent = here === world.agents[me].home ? "home" : world.venues[here].name; }

    renderer.render(scene, camera);
    labels.render(scene, camera);
    if (t >= ticks && !done) {
      done = true;
      document.querySelectorAll<HTMLButtonElement>("#hud button").forEach(b => (b.disabled = b.id !== "skip"));
      Object.assign($("#skip"), { textContent: "🏆 View results", className: "" });
    }
  });
}
