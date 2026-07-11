import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_SCHEMA = 'agent-insight/facet-cache-v1';

function stableKey(key) {
  return {
    source: String(key.source),
    opaqueSessionId: String(key.opaqueSessionId),
    contentHash: String(key.contentHash),
    analyzerHost: String(key.analyzerHost),
    analyzerModel: key.analyzerModel == null ? null : String(key.analyzerModel),
    promptVersion: String(key.promptVersion)
  };
}

function cacheId(key) {
  return createHash('sha256').update(JSON.stringify(stableKey(key))).digest('hex');
}

function identityId(key) {
  const { contentHash: _contentHash, ...identity } = stableKey(key);
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export class FacetCache {
  constructor(root) {
    this.root = root;
    this._identityIndex = null;
  }

  async ensureRoot() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }

  fileFor(key) {
    return join(this.root, `${cacheId(key)}.json`);
  }

  async put(key, facet) {
    await this.ensureRoot();
    const file = this.fileFor(key);
    await writeFile(file, `${JSON.stringify({ schema: CACHE_SCHEMA, key: stableKey(key), facet })}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    if (this._identityIndex) {
      const id = identityId(key);
      const entries = this._identityIndex.get(id) ?? [];
      this._identityIndex.set(id, [...entries.filter((entry) => entry.file !== file), { file, key: stableKey(key) }]);
    }
  }

  async get(key) {
    const lookup = await this.lookup(key);
    return lookup.status === 'hit' ? lookup.facet : null;
  }

  async lookup(key) {
    let document;
    try {
      document = JSON.parse(await readFile(this.fileFor(key), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        const stale = await this.removeStale(key);
        return { status: stale > 0 ? 'stale' : 'miss', facet: null, removed: stale };
      }
      if (error instanceof SyntaxError) {
        await unlink(this.fileFor(key)).catch(() => {});
        return { status: 'invalid', facet: null };
      }
      throw error;
    }
    if (document?.schema !== CACHE_SCHEMA || JSON.stringify(document.key) !== JSON.stringify(stableKey(key)) || !document.facet || typeof document.facet !== 'object') {
      await unlink(this.fileFor(key)).catch(() => {});
      return { status: 'invalid', facet: null };
    }
    return { status: 'hit', facet: document.facet };
  }

  async remove(key) {
    try {
      await unlink(this.fileFor(key));
      this._identityIndex = null;
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  }

  async identityIndex() {
    if (this._identityIndex) return this._identityIndex;
    const index = new Map();
    let names;
    try {
      names = (await readdir(this.root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this._identityIndex = index;
        return index;
      }
      throw error;
    }
    await Promise.all(names.map(async (name) => {
      const file = join(this.root, name);
      try {
        const document = JSON.parse(await readFile(file, 'utf8'));
        if (document?.schema !== CACHE_SCHEMA || !document.key) return;
        const id = identityId(document.key);
        const entries = index.get(id) ?? [];
        entries.push({ file, key: stableKey(document.key) });
        index.set(id, entries);
      } catch {
        // Invalid entries are reported by status or evicted by an exact lookup.
      }
    }));
    this._identityIndex = index;
    return index;
  }

  async removeStale(key) {
    const expected = stableKey(key);
    const index = await this.identityIndex();
    const id = identityId(expected);
    const stale = (index.get(id) ?? []).filter((entry) => entry.key.contentHash !== expected.contentHash);
    await Promise.all(stale.map((entry) => unlink(entry.file).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    })));
    if (stale.length) index.set(id, (index.get(id) ?? []).filter((entry) => !stale.includes(entry)));
    return stale.length;
  }

  async status() {
    let names;
    try {
      names = (await readdir(this.root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    } catch (error) {
      if (error?.code === 'ENOENT') return { entries: 0, bytes: 0, valid: 0, invalid: 0 };
      throw error;
    }
    const documents = await Promise.all(names.map(async (name) => {
      const file = join(this.root, name);
      const size = (await stat(file)).size;
      try {
        const value = JSON.parse(await readFile(file, 'utf8'));
        return { size, valid: value?.schema === CACHE_SCHEMA && value.key && value.facet && typeof value.facet === 'object' };
      } catch {
        return { size, valid: false };
      }
    }));
    const valid = documents.filter((document) => document.valid).length;
    return { entries: names.length, bytes: documents.reduce((sum, document) => sum + document.size, 0), valid, invalid: names.length - valid };
  }

  async clear() {
    let names;
    try {
      names = (await readdir(this.root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
    await Promise.all(names.map((name) => unlink(join(this.root, name))));
    this._identityIndex = new Map();
    return names.length;
  }

  async clearForAnalyzer(host, model) {
    let names;
    try {
      names = (await readdir(this.root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
    const matching = (await Promise.all(names.map(async (name) => {
      const file = join(this.root, name);
      try {
        const document = JSON.parse(await readFile(file, 'utf8'));
        return document?.schema === CACHE_SCHEMA
          && document.key?.analyzerHost === String(host)
          && document.key?.analyzerModel === String(model) ? file : null;
      } catch {
        return null;
      }
    }))).filter(Boolean);
    await Promise.all(matching.map((file) => unlink(file)));
    this._identityIndex = null;
    return matching.length;
  }
}

export { CACHE_SCHEMA };
