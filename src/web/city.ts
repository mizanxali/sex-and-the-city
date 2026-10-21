// Lays the sim's venues out on a grid town built from Kenney City Kit models (CC0).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { Place, World } from "../sim/world.ts";

// One character per block. C downtown, H houses, P park, S college, W churches.
const MAP = [
  "HHHHHH",
  "HCCCPH",
  "HCCCCH",
  "HSCCWH",
  "HHPHHH",
  "HHHHHH",
];
const BLOCK = 4, PERIOD = BLOCK + 1; // 4×4 tiles of lots, then a road
const SIZE = MAP.length * PERIOD + 1; // tiles across, roads on every edge
const tile = (i: number) => i - SIZE / 2 + 0.5; // tile index → world coordinate of its centre
export const CITY_SIZE = SIZE;

const MODELS = {
  commercial: [..."abcdefghijklmn"].map(c => `commercial/building-${c}`),
  tower: [..."abcde"].map(c => `commercial/building-skyscraper-${c}`),
  filler: [..."abcdefghijklmn"].map(c => `commercial/low-detail-building-${c}`),
  house: [..."abcdefghijklmnopqrstu"].map(c => `suburban/building-type-${c}`),
  tree: ["suburban/tree-large", "suburban/tree-small"],
  road: ["roads/road-straight", "roads/road-crossroad", "roads/light-square"],
};

interface Lot { x: number; z: number; facing: number; block: string; blockId: number; dist: number } // facing: +1 road at +z, -1 at -z

export interface City {
  anchor: THREE.Vector3[]; // per venue id: where people stand (in front of the door)
  indoor: boolean[];       // per venue id: people there are hidden (homes, workplaces)
  spread: number[];        // per venue id: how far people fan out around the anchor
}

export async function buildCity(scene: THREE.Scene, world: World): Promise<City> {
  const loader = new GLTFLoader();
  const names = Object.values(MODELS).flat();
  const loaded = new Map(await Promise.all(names.map(async n => {
    const gltf = await loader.loadAsync(`/models/${n}.glb`);
    gltf.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true; });
    return [n, gltf.scene] as const;
  })));
  const place = (name: string, x: number, z: number, rotY = 0, scale = 1) => {
    const m = loaded.get(name)!.clone();
    m.position.set(x, 0, z); m.rotation.y = rotY; m.scale.setScalar(scale);
    scene.add(m);
  };

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(SIZE + 20, SIZE + 20), new THREE.MeshLambertMaterial({ color: 0x8fbf6a }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.01; ground.receiveShadow = true;
  scene.add(ground);

  for (let i = 0; i < SIZE; i++) for (let j = 0; j < SIZE; j++) {
    const ri = i % PERIOD === 0, rj = j % PERIOD === 0;
    if (ri && rj) place("roads/road-crossroad", tile(i), tile(j));
    else if (ri || rj) {
      place("roads/road-straight", tile(i), tile(j), ri ? 0 : Math.PI / 2);
      if ((i + j) % 4 === 2) place("roads/light-square", tile(i) + (ri ? 0.45 : 0), tile(j) + (rj ? 0.45 : 0), ri ? -Math.PI / 2 : 0);
    }
  }

  // Lots: each block is 2×2 lots of 2×2 tiles; a lot's building faces the road on its z side.
  const lots: Lot[] = [];
  MAP.forEach((row, bz) => [...row].forEach((block, bx) => {
    for (let lx = 0; lx < 2; lx++) for (let lz = 0; lz < 2; lz++) {
      const x = tile(bx * PERIOD + 1.5 + 2 * lx), z = tile(bz * PERIOD + 1.5 + 2 * lz);
      lots.push({ x, z, facing: lz ? 1 : -1, block, blockId: bz * MAP.length + bx, dist: Math.hypot(x, z) });
    }
  }));
  const blockCentre = (b: string, nth: number) => {
    const ids = [...new Set(lots.filter(l => l.block === b).map(l => l.blockId))];
    const mine = lots.filter(l => l.blockId === ids[nth % ids.length]);
    return mine.reduce((v, l) => v.add(new THREE.Vector3(l.x / mine.length, 0, l.z / mine.length)), new THREE.Vector3());
  };

  const anchor: THREE.Vector3[] = [], indoor: boolean[] = [], spread: number[] = [];
  const front = (l: Lot) => new THREE.Vector3(l.x, 0, l.z + l.facing * 1.15);
  const rot = (l: Lot) => (l.facing > 0 ? 0 : Math.PI);
  const pick = <T>(list: T[], k: number) => list[((k % list.length) + list.length) % list.length];

  const downtown = lots.filter(l => l.block === "C").sort((a, b) => a.dist - b.dist);
  const houses = lots.filter(l => l.block === "H");
  const churchLots = lots.filter(l => l.block === "W");
  let nextDowntown = 0, parks = 0, churches = 0;

  // Friends live near each other: hand out houses in circle order.
  const homeOwners = world.agents.slice().sort((a, b) => a.circle - b.circle);
  const houseOf = new Map(homeOwners.map((a, k) => [a.home, houses[Math.floor(k * houses.length / homeOwners.length)]]));

  for (const v of world.venues) {
    const kind: Place = v.kind;
    let lot: Lot | undefined;
    if (kind === "home") lot = houseOf.get(v.id)!;
    else if (["restaurant_bar", "store", "gym", "other", "work"].includes(kind)) {
      lot = downtown[nextDowntown++];
      place(kind === "work" && v.id % 3 === 0 ? pick(MODELS.tower, v.id) : pick(MODELS.commercial, v.id), lot.x, lot.z, rot(lot));
    } else if (kind === "worship") {
      lot = churchLots[churches++ * 2];
      place(pick(MODELS.house, v.id + 7), lot.x, lot.z, rot(lot), 1.2);
    }
    if (lot) { anchor[v.id] = front(lot); indoor[v.id] = kind === "home" || kind === "work"; spread[v.id] = 0.45; continue; }
    // Open-air venues: parks, the college quad, Main Street.
    if (kind === "outdoors") anchor[v.id] = blockCentre("P", parks++);
    else if (kind === "school") anchor[v.id] = blockCentre("S", 0);
    else anchor[v.id] = new THREE.Vector3(tile(Math.floor(SIZE / 2)), 0, 0); // transit: Main Street runs north-south
    indoor[v.id] = false;
    spread[v.id] = kind === "transit" ? 0 : 1.4;
  }

  // Houses everyone lives in, fillers on unused downtown lots, trees in parks and spare lots.
  for (const l of new Set(houseOf.values())) place(pick(MODELS.house, Math.round(l.x * 7 + l.z * 13)), l.x, l.z, rot(l));
  for (const l of houses.filter(h => ![...houseOf.values()].includes(h))) place(MODELS.tree[0], l.x, l.z, 0, 2);
  for (const l of downtown.slice(nextDowntown)) place(pick(MODELS.filler, Math.round(l.x * 3 + l.z)), l.x, l.z, rot(l));
  for (const l of churchLots.filter((_, k) => k % 2)) place(MODELS.tree[1], l.x, l.z, 0, 2);
  const school = lots.filter(l => l.block === "S");
  school.forEach((l, k) => k === 0 ? place(MODELS.tower[1], l.x, l.z, rot(l)) : place(MODELS.tree[k % 2], l.x, l.z, 0, 2));
  for (const l of lots.filter(l => l.block === "P"))
    for (let t = 0; t < 4; t++) place(MODELS.tree[t % 2], l.x + (t % 2 ? 0.5 : -0.5), l.z + (t < 2 ? 0.5 : -0.5), t, 1.6);

  return { anchor, indoor, spread };
}
