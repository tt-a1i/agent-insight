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

export class FacetCache {
  constructor(root) {
    this.root = root;
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
  }

  async get(key) {
    let document;
    try {
      document = JSON.parse(await readFile(this.fileFor(key), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
    if (document?.schema !== CACHE_SCHEMA || JSON.stringify(document.key) !== JSON.stringify(stableKey(key))) return null;
    return document.facet ?? null;
  }

  async status() {
    let names;
    try {
      names = (await readdir(this.root)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    } catch (error) {
      if (error?.code === 'ENOENT') return { entries: 0, bytes: 0 };
      throw error;
    }
    const sizes = await Promise.all(names.map(async (name) => (await stat(join(this.root, name))).size));
    return { entries: names.length, bytes: sizes.reduce((sum, size) => sum + size, 0) };
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
    return names.length;
  }
}

export { CACHE_SCHEMA };
