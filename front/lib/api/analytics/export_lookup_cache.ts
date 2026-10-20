// Remembers misses too, so an id unknown to the database is not looked up again on every page.
export class ExportLookupCache<V> {
  private readonly values = new Map<string, V | undefined>();

  constructor(
    private readonly fetchByIds: (ids: string[]) => Promise<Map<string, V>>
  ) {}

  async load(ids: string[]): Promise<void> {
    const missingIds = [...new Set(ids)].filter(
      (id) => id && !this.values.has(id)
    );
    if (missingIds.length === 0) {
      return;
    }

    const fetched = await this.fetchByIds(missingIds);
    for (const id of missingIds) {
      this.values.set(id, fetched.get(id));
    }
  }

  get(id: string): V | undefined {
    return this.values.get(id);
  }
}
