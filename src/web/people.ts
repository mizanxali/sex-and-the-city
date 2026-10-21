// Kenney Mini Characters (CC0). The crowd: each character posed once, then drawn as one InstancedMesh per
// character (500 skinned, animated meshes would be too slow). The player: a real animated character.
import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

const LOOKS = ["a", "b", "c", "d", "e", "f"];
export const PERSON_SCALE = 0.7; // ~0.55 tall next to ~1-unit houses

// Bake one frame of `pose` into a plain geometry: skin every vertex on the CPU, normals by skinning a nudged copy.
function bake(gltf: GLTF, pose: string) {
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const clip = gltf.animations.find(a => a.name === pose);
  if (clip) mixer.clipAction(clip).play();
  mixer.update(0);
  gltf.scene.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  let material: THREE.Material | undefined;
  gltf.scene.traverse(o => {
    const mesh = o as THREE.SkinnedMesh;
    if (!mesh.isMesh) return;
    material ??= mesh.material as THREE.Material;
    const g = new THREE.BufferGeometry(), src = mesh.geometry;
    const pos = src.attributes.position, nrm = src.attributes.normal, n = pos.count;
    const outPos = new Float32Array(n * 3), outNrm = new Float32Array(n * 3);
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    if (mesh.isSkinnedMesh) mesh.skeleton.update();
    for (let i = 0; i < n; i++) {
      p.fromBufferAttribute(pos, i); q.fromBufferAttribute(nrm, i).multiplyScalar(0.01).add(p);
      if (mesh.isSkinnedMesh) { mesh.applyBoneTransform(i, p); mesh.applyBoneTransform(i, q); }
      p.applyMatrix4(mesh.matrixWorld); q.applyMatrix4(mesh.matrixWorld);
      p.toArray(outPos, i * 3); q.sub(p).normalize().toArray(outNrm, i * 3);
    }
    g.setAttribute("position", new THREE.BufferAttribute(outPos, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(outNrm, 3));
    g.setAttribute("uv", src.attributes.uv);
    if (src.index) g.setIndex(src.index);
    parts.push(g);
  });
  return { geometry: mergeGeometries(parts)!, material: material! };
}

export interface People {
  crowd: THREE.InstancedMesh[];               // one per character look
  slot: { mesh: number; index: number }[];    // per agent: which mesh and instance it is
  player: THREE.Object3D;
  animate: (moving: boolean, dt: number) => void;
  emote: (yes: boolean) => void;
}

export async function loadPeople(scene: THREE.Scene, sexes: ("male" | "female")[], playerSex: "male" | "female"): Promise<People> {
  const loader = new GLTFLoader();
  const looks = [...LOOKS.map(l => `female-${l}`), ...LOOKS.map(l => `male-${l}`)];
  const gltfs = new Map(await Promise.all(looks.map(async l => [l, await loader.loadAsync(`/models/people/character-${l}.glb`)] as const)));

  // Crowd: give each agent a look of their sex, then one InstancedMesh per look.
  const byLook = new Map<string, number[]>();
  sexes.forEach((sex, i) => {
    const look = `${sex}-${LOOKS[(i * 7) % LOOKS.length]}`;
    (byLook.get(look) ?? byLook.set(look, []).get(look)!).push(i);
  });
  const crowd: THREE.InstancedMesh[] = [], slot: People["slot"] = [];
  for (const [look, agents] of byLook) {
    const { geometry, material } = bake(gltfs.get(look)!, "idle");
    const mesh = new THREE.InstancedMesh(geometry, material, agents.length);
    mesh.castShadow = true;
    mesh.frustumCulled = false; // instances move all over town; the base bounds don't cover them
    agents.forEach((agent, index) => (slot[agent] = { mesh: crowd.length, index }));
    crowd.push(mesh);
    scene.add(mesh);
  }

  // Player: the animated original, walking or idling, nodding or shaking their head on news.
  const source = gltfs.get(`${playerSex}-a`)!;
  const player = cloneSkinned(source.scene);
  player.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  const mixer = new THREE.AnimationMixer(player);
  const action = (name: string) => mixer.clipAction(source.animations.find(a => a.name === name)!);
  const idle = action("idle"), walk = action("walk"), yes = action("emote-yes"), no = action("emote-no");
  for (const once of [yes, no]) { once.setLoop(THREE.LoopOnce, 1); once.clampWhenFinished = false; }
  idle.play();
  let current = idle;
  const to = (next: THREE.AnimationAction) => {
    if (next === current) return;
    next.reset().fadeIn(0.2).play(); current.fadeOut(0.2); current = next;
  };
  mixer.addEventListener("finished", () => { current = yes.isRunning() || no.isRunning() ? current : idle; to(idle); });
  return {
    crowd, slot, player,
    animate: (moving, dt) => {
      if (current !== yes && current !== no) to(moving ? walk : idle);
      mixer.update(dt);
    },
    emote: positive => to(positive ? yes : no),
  };
}
