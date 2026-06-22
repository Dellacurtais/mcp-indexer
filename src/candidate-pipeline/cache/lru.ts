/**
 * In-process LRU cache — Moka-style (used by every CachedHydrator in
 * `candidate-pipeline/hydrator.rs:79-184`).
 *
 * Simple Map-based LRU: Map preserves insertion order, so the oldest entry
 * is `map.keys().next().value`. On access we delete + re-insert to move
 * the entry to the end. Bounded by `maxSize`; optional per-entry TTL.
 *
 * Not concurrent — Node is single-threaded per event loop, so a single Map
 * with no locks is the right tool. (Rust's Moka needed concurrent reads
 * because it's used across Tokio worker threads.)
 */
import type { CacheStore } from '../traits.js';

export interface LruCacheOptions {
  maxSize: number;
  /** Default TTL in ms; can be overridden per-set. */
  defaultTtlMs?: number;
}

interface Entry<V> {
  value: V;
  /** Absolute expiry timestamp in ms; 0 = no expiry. */
  expiresAt: number;
}

export class LruCache<K, V> implements CacheStore<K, V> {
  private map = new Map<K, Entry<V>>();
  constructor(private opts: LruCacheOptions) {
    if (opts.maxSize <= 0) throw new Error('LruCache.maxSize must be positive');
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== 0 && entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Move to end (most-recently-used).
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs?: number): void {
    const ttl = ttlMs ?? this.opts.defaultTtlMs ?? 0;
    const entry: Entry<V> = {
      value,
      expiresAt: ttl > 0 ? Date.now() + ttl : 0,
    };
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, entry);
    if (this.map.size > this.opts.maxSize) {
      // Evict LRU (the first key in insertion order).
      const lru = this.map.keys().next().value;
      if (lru !== undefined) this.map.delete(lru as K);
    }
  }

  delete(key: K): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
  size(): number { return this.map.size; }
}
