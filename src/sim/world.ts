// The town: agents (500 personas + optional player) and the venues they move between.
import personasJson from "../../data/personas.json" with { type: "json" };
import traitsJson from "../../data/traits.json" with { type: "json" };
import attractionJson from "../../data/attraction.json" with { type: "json" };
import schedulesJson from "../../data/schedules.json" with { type: "json" };

export const MIN_AGE = 21;
export const WORLD_SEED = 1; // the town itself never changes between runs
export const PLACES = schedulesJson.places as Place[];
export type Place = "home" | "work" | "friends_home" | "restaurant_bar" | "gym" | "store" | "outdoors" | "worship"
  | "school" | "transit" | "other";
export type Sex = "male" | "female";
export type Orientation = "straight" | "gay" | "bisexual";
export type Status = "single" | "partnered" | "married";
export const DAYTYPES = ["weekday", "fri", "sat", "sun"] as const;
export const INTERESTS = [
  "fitness", "running", "outdoors", "cooking", "eating out", "wine and cocktails", "craft beer", "live music",
  "dancing", "art and museums", "reading", "video games", "movies and tv", "watching sports", "travel",
  "gardening", "diy and crafts", "religion", "volunteering", "tech", "pets", "fashion", "yoga and wellness",
  "board games"];

export interface PlayerSpec {
  name: string; sex: Sex; age: number; orientation: Orientation; employed: boolean;
  nightlife: number; gym: number; apps: boolean; // nights out / gym visits per week, on dating apps
  attr: number; sinc: number; intel: number; fun: number; amb: number; // 1-10, speed-dating scale
  interests: string[];
}

export interface Agent {
  id: number; name: string; sex: Sex; age: number; orientation: Orientation; status: Status;
  employed: boolean; nightlife: number; gym: number; apps: boolean; gossip: number;
  attr: number; sinc: number; intel: number; fun: number; amb: number; interests: number; // bitmask
  home: number; work: number; circle: number; favorites: Partial<Record<Place, number[]>>;
  probs: Float32Array; // [daytype][slot][place], schedule shaped by this agent's habits
  isPlayer: boolean;
}

export interface Venue { id: number; kind: Place; name: string }
export interface World { agents: Agent[]; venues: Venue[]; circles: number[][]; hangouts: number[] }

// Public venues by kind. ponytail: placeholder names, the 3D town in phase 3 will own the real list.
const PUBLIC: [Place, string[]][] = [
  ["restaurant_bar", ["The Tipsy Moose", "Club Neon", "Bean There Cafe", "Olive Garden-ish", "Rusty Nail Dive Bar", "Uncorked Wine Bar"]],
  ["gym", ["Iron Temple", "Planet Fine-ness"]],
  ["store", ["MegaMart", "Corner Grocery", "The Mall"]],
  ["outdoors", ["Central Park", "River Trail"]],
  ["worship", ["First Church", "Community Temple"]],
  ["school", ["Community College"]],
  ["transit", ["Main Street"]],
  ["other", ["Public Library", "Town Hall", "Laundromat"]],
];
const N_WORKPLACES = 20;
const CIRCLE_SIZE = 12;

export function rng(seed: number) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export type Rng = ReturnType<typeof rng>;
export const gauss = (r: Rng) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const ageBand = (age: number) => age <= 29 ? "21-29" : age <= 44 ? "30-44" : age <= 64 ? "45-64" : "65+";

function hash(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

const interestMask = (list: string[]) =>
  list.reduce((m, s) => INTERESTS.includes(s) ? m | (1 << INTERESTS.indexOf(s)) : m, 0);

// Schedules are population averages; scale bar/party and gym time by this agent's habits relative to the town.
function shapeSchedule(employed: boolean, age: number, nightlife: number, gym: number, avgNight: number, avgGym: number) {
  const out = new Float32Array(DAYTYPES.length * 48 * PLACES.length);
  const night = (nightlife + 0.25) / (avgNight + 0.25), gymMult = (gym + 0.25) / (avgGym + 0.25);
  const iBar = PLACES.indexOf("restaurant_bar"), iFriends = PLACES.indexOf("friends_home"), iGym = PLACES.indexOf("gym");
  DAYTYPES.forEach((day, d) => {
    const group = (schedulesJson.groups as Record<string, { p: number[][] }>)[
      `${employed ? "employed" : "not_employed"}|${ageBand(age)}|${day}`];
    group.p.forEach((row, slot) => {
      const p = row.slice();
      p[iBar] *= night; p[iFriends] *= night; p[iGym] *= gymMult;
      const sum = p.reduce((a, b) => a + b, 0);
      p.forEach((v, k) => out[(d * 48 + slot) * PLACES.length + k] = v / sum);
    });
  });
  return out;
}

export function buildWorld(player?: PlayerSpec): World {
  const r = rng(WORLD_SEED);
  const att = Object.values(attractionJson.by_chooser);
  const attrDist = { mean: att.reduce((s, a) => s + a.feature_mean.attr, 0) / 2, sd: att.reduce((s, a) => s + a.feature_sd.attr, 0) / 2 };
  const traits = traitsJson as Record<string, { nightlife: number; gym: number; dating_apps: boolean; gossip: number;
    sincerity: number; intelligence: number; fun: number; ambition: number; interests: string[] }>;
  const tl = Object.values(traits);
  const avgNight = tl.reduce((s, t) => s + t.nightlife, 0) / tl.length, avgGym = tl.reduce((s, t) => s + t.gym, 0) / tl.length;

  const venues: Venue[] = [];
  const addVenue = (kind: Place, name: string) => venues.push({ id: venues.length, kind, name }) - 1;
  const publicIds: Partial<Record<Place, number[]>> = {};
  for (const [kind, names] of PUBLIC) publicIds[kind] = names.map(n => addVenue(kind, n));
  const workplaces = Array.from({ length: N_WORKPLACES }, (_, i) => addVenue("work", `Workplace ${i + 1}`));

  const agents: Agent[] = personasJson.map(p => {
    const t = traits[String(p.id)];
    const employed = !["not_in_workforce", "no_occupation"].includes(p.occupation);
    return {
      id: p.id, name: p.name, sex: p.sex as Sex, age: p.age, orientation: p.orientation as Orientation,
      status: p.status as Status, employed, nightlife: t.nightlife, gym: t.gym, apps: t.dating_apps, gossip: t.gossip,
      attr: clamp(attrDist.mean + attrDist.sd * gauss(r), 1, 10), sinc: t.sincerity, intel: t.intelligence,
      fun: t.fun, amb: t.ambition, interests: interestMask(t.interests),
      home: addVenue("home", `${p.name}'s place`), work: workplaces[hash(p.occupation) % N_WORKPLACES],
      circle: -1, favorites: {}, probs: shapeSchedule(employed, p.age, t.nightlife, t.gym, avgNight, avgGym),
      isPlayer: false,
    };
  });
  if (player) {
    if (player.age < MIN_AGE) throw new Error(`player must be ${MIN_AGE}+`);
    agents.push({
      ...player, id: agents.length, status: "single", gossip: 0.5, interests: interestMask(player.interests),
      home: addVenue("home", `${player.name}'s place`), work: workplaces[r() * N_WORKPLACES | 0], circle: -1,
      favorites: {}, probs: shapeSchedule(player.employed, player.age, player.nightlife, player.gym, avgNight, avgGym),
      isPlayer: true,
    });
  }
  for (const a of agents) {
    if (a.age < MIN_AGE) throw new Error(`agent ${a.id} is under ${MIN_AGE}`);
    for (const [kind, ids] of Object.entries(publicIds) as [Place, number[]][]) {
      const first = ids[r() * ids.length | 0];
      a.favorites[kind] = [first, ids[r() * ids.length | 0]]; // regular spot + occasional other one
    }
  }

  // Friend circles: people near in age, shuffled a little, chunked; each circle hangs out at one member's place.
  const order = agents.map(a => ({ a, k: a.age + 8 * gauss(r) })).sort((x, y) => x.k - y.k).map(x => x.a);
  const circles: number[][] = [], hangouts: number[] = [];
  for (let i = 0; i < order.length; i += CIRCLE_SIZE) {
    const members = order.slice(i, i + CIRCLE_SIZE);
    members.forEach(m => m.circle = circles.length);
    circles.push(members.map(m => m.id));
    hangouts.push(members[r() * members.length | 0].home);
  }
  return { agents, venues, circles, hangouts };
}
