/** The pet world assembled by the application entry point. */
import { PetWorld, PET_ID, type PetWorldOptions } from './world.ts';

export interface PetAssembly extends Omit<PetWorldOptions, 'timezone' | 'userName'> {
  /** What she calls the person, read at each use; 伙伴 when absent or empty (the old pet's default). */
  userName?(): string;
  /** Called with each World instance Core creates. */
  onCreate?(world: PetWorld): void;
}

/** Temporary app-owned assembly descriptor; startup turns this into a PetWorld directly. */
export function petDefinition(assembly: PetAssembly): { id: string; label: string; create(ctx: { timezone: string }): PetWorld } {
  return { id: PET_ID, label: '桌宠', create: (ctx) => createPetWorld(assembly, ctx.timezone) };
}

export function createPetWorld(assembly: PetAssembly, timezone: string): PetWorld {
  const world = new PetWorld({ ...assembly, timezone, userName: () => assembly.userName?.() || '伙伴' });
  assembly.onCreate?.(world);
  return world;
}
