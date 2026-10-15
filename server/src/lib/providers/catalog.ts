import type { ModelCatalogEntry } from "./types.js";
import type { PriceVersion } from "./metering.js";
export class ModelCatalog {
  private readonly entries: Map<string, ModelCatalogEntry>;
  constructor(seed: readonly ModelCatalogEntry[]) {
    this.entries = new Map(seed.map((e) => [e.id, e]));
  }
  list(): readonly ModelCatalogEntry[] {
    return [...this.entries.values()];
  }
  get(id: string): ModelCatalogEntry {
    const value = this.entries.get(id);
    if (!value) throw new Error(`Unknown model catalog entry: ${id}`);
    return value;
  }
  assertCallable(id: string, price?: PriceVersion): ModelCatalogEntry {
    const model = this.get(id);
    if (model.verification !== "verified")
      throw new Error(
        `Model ${id} requires verification and cannot be enabled`,
      );
    if (!price)
      throw new Error(
        `Model ${id} has no effective price and cannot be called`,
      );
    if (model.contextWindowTokens === null || model.maxOutputTokens === null)
      throw new Error(`Model ${id} has unverified limits`);
    return model;
  }
}
