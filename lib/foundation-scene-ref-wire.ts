/** Transport syntax only. Canonical validators still own episode/key existence and scope. */
export function normalizeFoundationSceneRefWire(value: unknown): unknown {
  const visit = (node: unknown, path: string): unknown => {
    if (Array.isArray(node)) return node.map((item, index) => visit(item, `${path}.${index}`));
    if (node === null || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).map(([key, item]) => {
      if (key !== 'sceneRefs' || !Array.isArray(item)) return [key, visit(item, `${path}.${key}`)];
      return [key, item.map((ref, index) => {
        if (!Array.isArray(ref)) return ref;
        if (ref.length !== 2 || !Number.isSafeInteger(ref[0]) || typeof ref[1] !== 'string') {
          throw new Error(`${path}.${key}.${index}: sceneRefs tuple must be exactly [integer episode, string sceneKey].`);
        }
        return { episode: ref[0], sceneKey: ref[1] };
      })];
    }));
  };
  return visit(value, '$');
}
