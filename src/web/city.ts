// Lays the sim's venues out on a grid town. Downtown, roads and props: KayKit City Builder Bits (CC0).
// Houses and trees: Kenney City Kit Suburban (CC0), recoloured per house with its variation textures.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { Place, World } from "../sim/world.ts";

// One character per block. C offices, H houses, L houses plus one labelled place (bar, shop, gym, library…), P park,
// S college, W churches. Labelled blocks sit on a checkerboard so names spread evenly; downtown zig-zags around two of them.
const MAP = [
  "HLHLHL",
  "LHSHPH",
  "HLCLCL",
  "LCLCLH",
  "HPHWHL",
  "LHLHLH",
];
const CELL = 2; // a lot or a road square, the size of one KayKit tile
const CELLS = MAP.length * 3 + 1; // each block is 2×2 lots, then a road; roads on every edge
const at = (c: number) => (c - (CELLS - 1) / 2) * CELL; // cell index → world coordinate of its centre
export const CITY_SIZE = CELLS * CELL;

const KAYKIT = [..."ABCDEFGH"].map(c => `kaykit/building_${c}`);
const SHORT = KAYKIT.slice(0, 2).concat(KAYKIT.slice(4, 6)), TALL = [KAYKIT[2], KAYKIT[3], KAYKIT[6], KAYKIT[7]];
const HOUSES = [..."abcdefghijklmnopqrstu"].map(c => `suburban/building-type-${c}`);
const TREES = ["suburban/tree-large", "suburban/tree-small"];
const CARS = ["kaykit/car_hatchback", "kaykit/car_sedan", "kaykit/car_stationwagon", "kaykit/car_taxi", "kaykit/car_police"];
const PROPS = ["kaykit/road_straight", "kaykit/road_junction", "kaykit/road_tsplit", "kaykit/road_corner", "kaykit/base",
  "kaykit/streetlight", "kaykit/bench", "kaykit/bush", "kaykit/watertower", "kaykit/firehydrant"];
const HOUSE_COLOURS = ["colormap", "variation-a", "variation-b", "variation-c"];

interface Lot { x: number; z: number; facing: number; block: string; blockId: number; dist: number } // facing: road at ±z

export interface City {
  anchor: THREE.Vector3[]; // per venue id: where people stand (in front of the door)
  indoor: boolean[];       // per venue id: people there are hidden (homes, workplaces)
  spread: number[];        // per venue id: how far people fan out around the anchor
  night(k: number): void;  // 0 day … 1 night: streetlights fade in
}

export async function buildCity(scene: THREE.Scene, world: World): Promise<City> {
  const loader = new GLTFLoader(), textures = new THREE.TextureLoader();
  const names = [...KAYKIT, ...HOUSES, ...TREES, ...CARS, ...PROPS];
  const loaded = new Map(await Promise.all(names.map(async n => {
    const gltf = await loader.loadAsync(`/models/${n}.${n.startsWith("kaykit") ? "gltf" : "glb"}`);
    gltf.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true; });
    return [n, gltf.scene] as const;
  })));
  // Kenney houses: same models, swapped palette texture per house.
  const palettes = await Promise.all(HOUSE_COLOURS.map(async c => {
    const t = await textures.loadAsync(`/models/suburban/Textures/${c}.png`);
    t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; t.magFilter = THREE.NearestFilter;
    return t;
  }));
  const recoloured = new Map<string, THREE.Material>();
  const recolour = (m: THREE.Mesh, k: number) => {
    const base = m.material as THREE.MeshStandardMaterial, key = `${base.uuid}|${k}`;
    if (!recoloured.has(key)) recoloured.set(key, Object.assign(base.clone(), { map: palettes[k] }));
    m.material = recoloured.get(key)!;
  };
  const town = new THREE.Group(); // every prop, merged into one mesh per material once placed
  const place = (name: string, x: number, z: number, rotY = 0, scale = 1, palette = -1) => {
    const m = loaded.get(name)!.clone();
    m.position.set(x, 0, z); m.rotation.y = rotY; m.scale.setScalar(scale);
    if (palette >= 0) m.traverse(o => { if ((o as THREE.Mesh).isMesh) recolour(o as THREE.Mesh, palette); });
    town.add(m);
  };
  const hash = (x: number, z: number) => Math.abs(Math.round(x * 73 + z * 151));
  const pick = <T>(list: T[], k: number) => list[((k % list.length) + list.length) % list.length];

  // The town sits on a floating slab: grass on top, earth on the sides.
  const grass = new THREE.MeshLambertMaterial({ color: 0x8fcf6a }), earth = new THREE.MeshLambertMaterial({ color: 0x8a6440 });
  const ground = new THREE.Mesh(new THREE.BoxGeometry(CITY_SIZE + 1, 0.6, CITY_SIZE + 1), [earth, earth, grass, earth, earth, earth]);
  ground.position.y = -0.31; ground.receiveShadow = true;
  scene.add(ground);

  const lamps: THREE.Vector3[] = []; // streetlight bulbs, lit at night
  // Roads: every third cell. Pieces chosen by which neighbours are road too.
  const isRoad = (i: number, j: number) => i >= 0 && j >= 0 && i < CELLS && j < CELLS && (i % 3 === 0 || j % 3 === 0);
  for (let i = 0; i < CELLS; i++) for (let j = 0; j < CELLS; j++) {
    if (!isRoad(i, j)) continue;
    const x = at(i), z = at(j);
    const n = isRoad(i, j - 1), s = isRoad(i, j + 1), w = isRoad(i - 1, j), e = isRoad(i + 1, j);
    const count = +n + +s + +w + +e;
    if (count === 4) place("kaykit/road_junction", x, z);
    else if (count === 3) place("kaykit/road_tsplit", x, z, !n ? Math.PI : !s ? 0 : !w ? -Math.PI / 2 : Math.PI / 2);
    else if (count === 2 && (n || s) && (w || e)) place("kaykit/road_corner", x, z, s && e ? 0 : s && w ? -Math.PI / 2 : n && w ? Math.PI : Math.PI / 2);
    else place("kaykit/road_straight", x, z, n || s ? 0 : Math.PI / 2);
    // Streetlights on some straights, parked cars on others.
    const h = hash(x, z);
    if (count === 2 && ((n && s) || (w && e))) {
      if (h % 5 === 0) {
        const lx = x + (n ? 0.85 : 0), lz = z + (n ? 0 : 0.85), r = n ? -Math.PI / 2 : 0;
        place("kaykit/streetlight", lx, lz, r);
        lamps.push(new THREE.Vector3(-0.21, 0.92, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), r).add(new THREE.Vector3(lx, 0, lz)));
      }
      else if (h % 7 === 0) place(pick(CARS, h), x + (n ? -0.45 : 0), z + (n ? 0 : -0.45), n ? 0 : Math.PI / 2);
    }
  }

  // Lots: each block is 2×2 lots; a lot's building faces the road on its z side.
  const lots: Lot[] = [];
  MAP.forEach((row, bz) => [...row].forEach((block, bx) => {
    for (let lx = 0; lx < 2; lx++) for (let lz = 0; lz < 2; lz++) {
      const x = at(bx * 3 + 1 + lx), z = at(bz * 3 + 1 + lz);
      lots.push({ x, z, facing: lz ? 1 : -1, block, blockId: bz * MAP.length + bx, dist: Math.hypot(x, z) });
    }
  }));
  const blockCentre = (b: string, nth: number) => {
    const ids = [...new Set(lots.filter(l => l.block === b).map(l => l.blockId))];
    const mine = lots.filter(l => l.blockId === ids[nth % ids.length]);
    return mine.reduce((v, l) => v.add(new THREE.Vector3(l.x / mine.length, 0, l.z / mine.length)), new THREE.Vector3());
  };

  const anchor: THREE.Vector3[] = [], indoor: boolean[] = [], spread: number[] = [];
  const front = (l: Lot) => new THREE.Vector3(l.x, 0, l.z + l.facing * 1.25);
  const rot = (l: Lot) => (l.facing > 0 ? 0 : Math.PI);

  const downtown = lots.filter(l => l.block === "C").sort((a, b) => a.dist - b.dist);
  const churchLots = lots.filter(l => l.block === "W");
  let parks = 0, churches = 0;

  // Labelled places go one per L block, kinds interleaved so bars don't share a corner of town.
  const labelled = world.venues.filter(v => ["restaurant_bar", "store", "gym", "other"].includes(v.kind));
  const rank = (v: (typeof labelled)[number]) => { const same = labelled.filter(u => u.kind === v.kind); return same.indexOf(v) / same.length; };
  labelled.sort((a, b) => rank(a) - rank(b));
  const labelBlocks = [...new Set(lots.filter(l => l.block === "L").map(l => l.blockId))];
  if (labelBlocks.length < labelled.length) throw new Error(`MAP has ${labelBlocks.length} L blocks for ${labelled.length} labelled places`);
  const venueLot = new Map(labelled.map((v, k) => [v.id, lots.filter(l => l.blockId === labelBlocks[k])[k % 4]]));
  const taken = new Set(venueLot.values());
  const houses = lots.filter(l => (l.block === "H" || l.block === "L") && !taken.has(l));

  // Friends live near each other: hand out houses in circle order.
  const homeOwners = world.agents.slice().sort((a, b) => a.circle - b.circle);
  const houseOf = new Map(homeOwners.map((a, k) => [a.home, houses[Math.floor(k * houses.length / homeOwners.length)]]));

  // Workplaces fill the office core, centre-first.
  world.venues.filter(v => v.kind === "work").forEach((v, k) => venueLot.set(v.id, downtown[k]));

  for (const v of world.venues) {
    const kind: Place = v.kind;
    let lot: Lot | undefined;
    if (kind === "home") lot = houseOf.get(v.id)!;
    else if (venueLot.has(v.id)) {
      lot = venueLot.get(v.id)!;
      place(pick(kind === "work" ? TALL : SHORT, v.id), lot.x, lot.z, rot(lot));
    } else if (kind === "worship") {
      lot = churchLots[churches++ * 3]; // opposite corners, facing opposite roads
      place(pick(HOUSES, v.id + 7), lot.x, lot.z, rot(lot), 1.25, 3);
    }
    if (lot) { anchor[v.id] = front(lot); indoor[v.id] = kind === "home" || kind === "work"; spread[v.id] = 0.5; continue; }
    // Open-air venues: parks, the college quad, Main Street.
    if (kind === "outdoors") anchor[v.id] = blockCentre("P", parks++);
    else if (kind === "school") anchor[v.id] = blockCentre("S", 0);
    else anchor[v.id] = new THREE.Vector3(at((CELLS - 1) / 2), 0, 0); // transit: Main Street runs north-south
    indoor[v.id] = false;
    spread[v.id] = kind === "transit" ? 0 : 1.6;
  }

  // Houses everyone lives in (each its own colours), fillers downtown, trees and benches in green spaces.
  for (const l of new Set(houseOf.values())) {
    const h = hash(l.x, l.z);
    place(pick(HOUSES, h), l.x, l.z, rot(l), 1, h % HOUSE_COLOURS.length);
    if (h % 3 === 0) place("kaykit/bush", l.x + 0.75, l.z + l.facing * 0.7);
    if (h % 4 === 1) place(TREES[1], l.x - 0.8, l.z - l.facing * 0.7, h, 1.8);
  }
  const used = new Set(houseOf.values());
  for (const l of houses.filter(h => !used.has(h))) {
    place(TREES[0], l.x - 0.4, l.z - 0.3, 0, 2.2); place(TREES[1], l.x + 0.5, l.z + 0.4, 1, 2.2); place("kaykit/bush", l.x + 0.3, l.z - 0.6);
  }
  downtown.slice(world.venues.filter(v => v.kind === "work").length).forEach((l, k) => k === 0 ? place("kaykit/watertower", l.x, l.z, 0, 1.6) : place(pick(SHORT, k + 3), l.x, l.z, rot(l)));
  for (const l of churchLots.filter((_, k) => k % 3)) { place(TREES[0], l.x, l.z, 0, 2.4); place("kaykit/bench", l.x, l.z + 0.8); }
  lots.filter(l => l.block === "S").forEach((l, k) => k === 0 ? place(TALL[3], l.x, l.z, rot(l)) : place(TREES[k % 2], l.x, l.z, k, 2.4));
  for (const l of lots.filter(l => l.block === "P")) {
    for (let t = 0; t < 4; t++) place(TREES[t % 2], l.x + (t % 2 ? 0.55 : -0.55), l.z + (t < 2 ? 0.55 : -0.55), t, 2);
    place("kaykit/bench", l.x, l.z, l.facing > 0 ? 0 : Math.PI); place("kaykit/bush", l.x + 0.2, l.z + 0.2);
  }

  // The town never moves: bake each prop's transform in and draw one mesh per material (~1,100 draw calls → ~100).
  town.updateMatrixWorld(true);
  const byMaterial = new Map<string, { material: THREE.Material; parts: THREE.BufferGeometry[] }>();
  town.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry, material = mesh.material as THREE.Material; // glTF gives one material per mesh
    const key = `${material.uuid}|${Object.keys(g.attributes).sort()}|${!!g.index}`; // merge needs matching attributes
    (byMaterial.get(key) ?? byMaterial.set(key, { material, parts: [] }).get(key)!).parts.push(g.clone().applyMatrix4(mesh.matrixWorld));
  });
  for (const { material, parts } of byMaterial.values()) {
    const merged = new THREE.Mesh(mergeGeometries(parts)!, material);
    merged.castShadow = merged.receiveShadow = true;
    scene.add(merged);
  }

  // Streetlights at night: a warm bulb and a pool on the road, faked with additive glow (dozens of real lights cost every pixel).
  const canvas = Object.assign(document.createElement("canvas"), { width: 64, height: 64 }), ctx = canvas.getContext("2d")!;
  const fade = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  fade.addColorStop(0, "#fff"); fade.addColorStop(1, "#000");
  ctx.fillStyle = fade; ctx.fillRect(0, 0, 64, 64);
  const glow = { transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false };
  const poolLight = new THREE.MeshBasicMaterial({ ...glow, color: 0xffb860, map: new THREE.CanvasTexture(canvas) });
  const bulbLight = new THREE.MeshBasicMaterial({ ...glow, color: 0xfff0c0 });
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.2, 2.2).rotateX(-Math.PI / 2), poolLight, lamps.length);
  const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.06, 8, 6), bulbLight, lamps.length);
  const m = new THREE.Matrix4();
  lamps.forEach((p, k) => { pools.setMatrixAt(k, m.makeTranslation(p.x, 0.11, p.z)); bulbs.setMatrixAt(k, m.makeTranslation(p.x, p.y, p.z)); });
  scene.add(pools, bulbs);
  const night = (k: number) => { poolLight.opacity = 0.7 * k; bulbLight.opacity = k; };

  return { anchor, indoor, spread, night };
}
