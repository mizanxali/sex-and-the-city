// Character form → simulate the month up front → replay it in three.js with an event feed.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import calibrationJson from "../../data/calibration.json" with { type: "json" };
import personasJson from "../../data/town.json" with { type: "json" };
import tuningJson from "../../data/tuning.json" with { type: "json" };
import { type SimEvent, SLOTS, type Tuning, simulate } from "../sim/engine.ts";
import { INTERESTS, type Orientation, type PlayerSpec, type Sex, ageBand, buildWorld } from "../sim/world.ts";
import { CITY_SIZE, buildCity } from "./city.ts";

const DAYS = 30;
const RATING_BUDGET = 33; // five ratings, average 6.6: you can be hot, or nice, not everything
const MAX_INTERESTS = 5;
const SPEEDS = [1, 4, 16, 64]; // × half an hour per 2 seconds
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------------------------------------------------------------- character form
const form = $<HTMLFormElement>("#setup");
const ratingInputs = [...form.querySelectorAll<HTMLInputElement>("#ratings input")];
$("#interests").append(...INTERESTS.map(name => {
  const l = document.createElement("label");
  l.className = "check";
  l.innerHTML = `<input type="checkbox" name="interest" value="${name}" /> ${name}`;
  return l;
}));
const showBudget = () => {
  const left = RATING_BUDGET - ratingInputs.reduce((s, i) => s + +i.value, 0);
  $("#budget").textContent = `${left} point${left === 1 ? "" : "s"} left to spend`;
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
    employed: f.has("employed"), apps: f.has("apps"), nightlife: +f.get("nightlife")!, gym: +f.get("gym")!,
    attr: +f.get("attr")!, sinc: +f.get("sinc")!, intel: +f.get("intel")!, fun: +f.get("fun")!, amb: +f.get("amb")!,
    interests: f.getAll("interest").map(String),
  };
}

form.addEventListener("submit", e => {
  e.preventDefault();
  form.style.display = "none";
  start(readForm(), (Math.random() * 2 ** 31) | 0);
});
const rerun = sessionStorage.getItem("rerun");
if (rerun) { sessionStorage.removeItem("rerun"); form.style.display = "none"; start(JSON.parse(rerun), (Math.random() * 2 ** 31) | 0); }

// ---------------------------------------------------------------- the month
async function start(spec: PlayerSpec, seed: number) {
  const world = buildWorld(spec);
  const N = world.agents.length, me = N - 1;
  const res = simulate(world, tuningJson as Tuning, { days: DAYS, seed, focus: me, trackLocations: true });
  const locations = res.locations!;
  const ticks = DAYS * SLOTS;

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
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 200);
  camera.position.set(6, 7, 9); // start close; follow mode pans to the player
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.maxPolarAngle = Math.PI * 0.45;
  controls.minDistance = 3; controls.maxDistance = 60;
  const hemi = new THREE.HemisphereLight(0xffffff, 0x445533, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -CITY_SIZE / 2, right: CITY_SIZE / 2, top: CITY_SIZE / 2, bottom: -CITY_SIZE / 2, far: 80 });
  scene.add(hemi, sun);
  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight); labels.setSize(innerWidth, innerHeight);
  });

  const city = await buildCity(scene, world);
  for (const v of world.venues) {
    if (["home", "work", "transit"].includes(v.kind)) continue;
    const div = document.createElement("div");
    div.className = "label"; div.textContent = v.name;
    const label = new CSS2DObject(div);
    label.position.copy(city.anchor[v.id]).setY(v.kind === "outdoors" || v.kind === "school" ? 0.6 : 1.6);
    scene.add(label);
  }

  // People: one instanced capsule each, the player as their own bigger mesh with a ring and a name tag.
  const geo = new THREE.CapsuleGeometry(0.07, 0.14, 4, 8).translate(0, 0.14, 0);
  const crowd = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial(), N - 1);
  const colour = new THREE.Color();
  for (let i = 0; i < N - 1; i++) {
    const a = world.agents[i];
    crowd.setColorAt(i, colour.setHSL(a.sex === "female" ? 0.9 + (i % 7) * 0.012 : 0.55 + (i % 7) * 0.02, 0.45, 0.6));
  }
  crowd.castShadow = true;
  scene.add(crowd);
  const player = new THREE.Group();
  const body = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xe0245e }));
  body.scale.setScalar(1.5); body.castShadow = true;
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.28, 32), new THREE.MeshBasicMaterial({ color: 0xe0245e, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
  const tagDiv = document.createElement("div");
  tagDiv.className = "label you"; tagDiv.textContent = spec.name;
  const tag = new CSS2DObject(tagDiv);
  tag.position.y = 0.7;
  player.add(body, ring, tag);
  scene.add(player);

  // Where agent i stands at a tick: their venue's anchor plus a stable personal offset.
  const jitter = world.agents.map((_, i) => {
    const a = (i * 2.399963) % (2 * Math.PI), r = Math.sqrt(((i * 0.618034) % 1));
    return { x: Math.cos(a) * r, z: Math.sin(a) * r, street: ((i * 0.754877) % 1) - 0.5 };
  });
  const posAt = (i: number, tick: number, out: THREE.Vector3) => {
    const v = locations[Math.min(tick, ticks - 1) * N + i], j = jitter[i];
    out.copy(city.anchor[v]);
    if (world.venues[v].kind === "transit") return out.set(out.x + j.x * 0.2, 0, j.street * (CITY_SIZE - 6));
    return out.set(out.x + j.x * city.spread[v], 0, out.z + j.z * city.spread[v]);
  };
  const hidden = (i: number, tick: number) => {
    const v0 = locations[Math.min(tick, ticks - 1) * N + i], v1 = locations[Math.min(tick + 1, ticks - 1) * N + i];
    return v0 === v1 && city.indoor[v0];
  };

  // ------------------------------------------------------------ HUD and feed
  let t = 0, speed = 4, paused = false, follow = true, nextEvent = 0;
  const partners = new Set<number>();
  $("#hud").style.display = "flex"; $("#feed").style.display = "block";
  $("#speeds").append(...SPEEDS.map(s => {
    const b = document.createElement("button");
    b.className = "ghost"; b.textContent = `${s}×`; b.setAttribute("aria-pressed", String(s === speed));
    b.onclick = () => { speed = s; document.querySelectorAll("#speeds button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); };
    return b;
  }));
  $("#pause").onclick = () => { paused = !paused; $("#pause").textContent = paused ? "Play" : "Pause"; };
  $("#follow").onclick = () => { follow = !follow; $("#follow").setAttribute("aria-pressed", String(follow)); };
  $("#skip").onclick = () => { t = ticks; };

  const who = (i: number) => {
    const p = personasJson[i];
    return p ? `${p.name} (${p.age}, ${p.occupation.replaceAll("_", " ").replace("not in workforce", "not working")})` : "someone";
  };
  const at = (v: number) => world.venues[v].name;
  const other = (e: SimEvent) => (e.a === me ? e.b : e.a);
  function describe(e: SimEvent): string {
    switch (e.type) {
      case "spark": return `Hit it off with ${who(other(e))} at ${at(e.venue)}. Numbers exchanged.`;
      case "match": return `Matched with ${who(other(e))} on the apps.`;
      case "rejected": return e.a === me ? `${who(e.b)} was not into you at ${at(e.venue)}.` : `You weren't feeling ${who(e.a)}.`;
      case "date": return `Date with ${who(other(e))} at ${at(e.venue)}.`;
      case "stood_up": return e.a === me ? `${who(e.b)} stood you up.` : `You stood up ${who(e.a)}.`;
      case "hookup": return `Went home with ${who(other(e))}.`;
      case "couple": return `You and ${who(other(e))} are official now.`;
      case "gossip": return `${who(e.b)} told you about their night with ${who(e.about!)}.`; // other cases grouped in show()
    }
  }
  const n = (k: number, one: string, many = one + "s") => `${k} ${k === 1 ? one : many}`;
  const friends = (k: number) => n(k, "friend");
  const gossipLines = new Map<string, { li: HTMLLIElement; n: number }>();
  const clock = (tick: number) => {
    const day = Math.floor(tick / SLOTS), mins = 240 + (tick % SLOTS) * 30;
    const wd = WEEKDAYS[(day + (mins >= 1440 ? 1 : 0)) % 7], hh = Math.floor(mins / 60) % 24, mm = mins % 60;
    return `Day ${day + 1} · ${wd} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  };
  const feed = $("#feed ol");
  function show(e: SimEvent) {
    if (e.type === "hookup") partners.add(other(e));
    if (e.type === "gossip" && e.a !== me) { // one line per telling, however many friends heard it
      const key = `${e.tick}|${e.b}|${e.about}`, g = gossipLines.get(key) ?? { li: document.createElement("li"), n: 0 };
      if (!g.n) { g.li.className = "gossip"; feed.append(g.li); gossipLines.set(key, g); }
      g.n++;
      g.li.innerHTML = `<time>${clock(e.tick)}</time>`;
      g.li.append(e.b === me ? `You told ${friends(g.n)} about your night with ${who(e.about!)}.`
        : `${who(e.b)} told ${friends(g.n)} about your night together.`);
      return;
    }
    const li = document.createElement("li");
    li.className = e.type;
    li.innerHTML = `<time>${clock(e.tick)}</time>`;
    li.append(describe(e));
    feed.append(li);
    if (["hookup", "spark", "match", "rejected", "couple"].includes(e.type)) {
      tagDiv.textContent = `${spec.name} ${{ hookup: "💋", spark: "✨", match: "📱", rejected: "🙅", couple: "💘" }[e.type as string]}`;
      setTimeout(() => tagDiv.textContent = spec.name, 2500);
    }
  }

  function recap() {
    const band = ageBand(spec.age), gss = calibrationJson.partners_last_year_single[`${spec.sex}|${band}` as keyof typeof calibrationJson.partners_last_year_single];
    const anyInYear = Math.round(100 * (1 - gss["0"]));
    const count = (type: string) => res.events.filter(e => e.type === type && (type !== "rejected" || e.a === me)).length;
    const el = $("#recap");
    el.innerHTML = `
      <h2>${spec.name}'s month: ${partners.size} ${partners.size === 1 ? "partner" : "partners"}</h2>
      <ul>${[...partners].map(p => `<li>${who(p)}</li>`).join("") || "<li>Nobody. The city was not ready.</li>"}</ul>
      <p>${n(count("spark"), "spark")} in person, ${n(count("match"), "app match", "app matches")}, ${n(count("date"), "date")}, ${n(count("rejected"), "rejection")}, stood up ${n(res.events.filter(e => e.type === "stood_up" && e.a === me).length, "time")}.</p>
      <p>For scale: only ${anyInYear}% of real single ${spec.sex === "female" ? "women" : "men"} aged ${band} had <em>any</em> partner in a whole year (GSS 2022-24).</p>
      <button id="again">Run it back</button> <button id="new" class="ghost">New character</button>`;
    el.style.display = "block";
    $("#again").onclick = () => { sessionStorage.setItem("rerun", JSON.stringify(spec)); location.reload(); };
    $("#new").onclick = () => location.reload();
  }

  // ------------------------------------------------------------ frame loop
  const night = new THREE.Color(0x0b1026), day = new THREE.Color(0x9fd3ff), sky = new THREE.Color();
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1), none = new THREE.Vector3(0, 0, 0);
  let last = performance.now(), done = false;
  renderer.setAnimationLoop(now => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (!paused && !done) t = Math.min(ticks, t + dt * speed / 2);
    const k = Math.min(Math.floor(t), ticks - 1), f = Math.min(1, (t - k) * 3); // walk in the first third, then linger
    while (nextEvent < res.events.length && res.events[nextEvent].tick <= t) show(res.events[nextEvent++]);

    for (let i = 0; i < N; i++) {
      posAt(i, k, p0); posAt(i, k + 1, p1);
      p0.lerp(p1, f * f * (3 - 2 * f));
      if (i === me) player.position.copy(p0);
      else crowd.setMatrixAt(i, m.compose(p0, q, hidden(i, k) ? none : one));
    }
    crowd.instanceMatrix.needsUpdate = true;
    if (follow) controls.target.lerp(player.position, 0.05);

    const hour = (4 + (t % SLOTS) / 2) % 24, light = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
    scene.background = sky.copy(night).lerp(day, light);
    hemi.intensity = 0.35 + 0.9 * light; sun.intensity = 0.15 + 2.2 * light;
    sun.position.set(Math.cos((hour / 24) * 2 * Math.PI) * 20, 25, 12);
    $("#clock").textContent = clock(k);
    $("#score").textContent = `💋 ${partners.size}`;

    controls.update();
    renderer.render(scene, camera);
    labels.render(scene, camera);
    if (t >= ticks && !done) { done = true; recap(); }
  });
}
