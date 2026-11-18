import { LocationDto } from '@ever-jobs/models';
import {
  canonicalCountryName,
  normalizeUsState,
  parseLocationList,
  ParseLocationOptions,
} from './location-parser';

/**
 * Generic runtime-object → `LocationDto` mapper (Spec 5171).
 *
 * Structured location objects arrive with per-feed key names
 * (`city`/`cityName`/`addressLocality`/`address.cityName`…); before this
 * module every plugin hand-rolled a partial alias table and silently dropped
 * whatever it didn't name. The mapper reads own runtime keys — feed type
 * declarations are irrelevant — so field coverage doesn't depend on how
 * completely somebody typed the payload.
 */

type Slot =
  | 'city'
  | 'state'
  | 'country'
  | 'postalCode'
  | 'streetAddress'
  | 'name'
  | 'text';

const SLOTS: Slot[] = [
  'city',
  'state',
  'country',
  'postalCode',
  'streetAddress',
  'name',
  'text',
];

/** Case-insensitive default alias sets (matched on every dotted segment). */
const DEFAULT_ALIASES: Record<Slot, string[]> = {
  city: [
    'city',
    'addressLocality',
    'locality',
    'town',
    'cityName',
    'municipal',
    'municipality',
    'city_name',
    'municipality_name',
    'ort',
  ],
  state: [
    'state',
    'addressRegion',
    'province',
    'stateName',
    'state_name',
    'stateCode',
    'stateProvince',
    'state_province',
    'subdivision',
    'subdivisionFullName',
    'countrySubdivisionLevel1.codeValue',
    'CountrySubDivisionCode',
  ],
  country: [
    'country',
    'addressCountry',
    'countryName',
    'countryCode',
    'country_code',
    'country_name',
    'isoCountryCode',
    'isoCountry',
    'land',
  ],
  postalCode: [
    'postalCode',
    'postal',
    'zip',
    'postal_code',
    'postcode',
    'zip_code',
    'zipCode',
    'plz',
    'codePostal',
  ],
  streetAddress: [
    'streetAddress',
    'street',
    'addressLine1',
    'street_address',
    'address_line1',
    'addressLine',
    'address1',
    'line1',
  ],
  name: ['name'],
  text: [
    'text',
    'locationText',
    'locationStr',
    'location_string',
    'formatted',
    'formattedAddress',
    'fullLocation',
    'locationLabel',
    'display_name',
    'locationName',
    'libelle',
  ],
};

/** Object-valued alias leaf candidates, per slot — `.id` is never geography. */
const OBJECT_LEAVES: Partial<Record<Slot, string[]>> = {
  country: ['alpha2Code', 'name', 'descriptor', 'code'],
  city: ['name', 'descriptor'],
  state: ['name', 'descriptor'],
};

export interface LocationObjectLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
}

export interface LocationObjectOptions {
  /** Dotted selector path(s) into a wrapper object; ordered fallbacks. */
  in?: string | string[];
  /** Extra case-insensitive dotted paths per slot. */
  aliases?: Partial<Record<Slot, string[]>>;
  /** Extra label paths for the entity-name set. */
  nameKeys?: string[];
  /** Extra label paths for the geo-label set. */
  textKeys?: string[];
  /** One preferred source path per slot for genuine conflicts. */
  prefer?: Partial<Record<Slot, string>>;
  /** extras whitelist (`[]` = none) — absent = carry all residuals. */
  keep?: string[];
  /** extras blacklist — wins over `keep`. */
  drop?: string[];
  /** extras bounds; defaults 4KiB / depth 3 / 2000 nodes. */
  extrasLimits?: LocationObjectLimits;
  /** Object input only: parse the selected `text` into missing slots. */
  parseTextFallback?: boolean;
  /** Parser options forwarded to `parseLocationList` (text + string paths). */
  parseOptions?: ParseLocationOptions;
}

const DEFAULT_LIMITS: Required<LocationObjectLimits> = {
  maxBytes: 4096,
  maxDepth: 3,
  maxNodes: 2000,
};

const MAX_SELECTOR_SEGMENTS = 8;
const MAX_ARRAY_DEPTH = 4;

/*
 * Work bounds (fork-sync hardening). Scraped JSON-LD and feed payloads are
 * untrusted, and the mapper runs synchronously on the API event loop, so every
 * loop below is bounded by these caps rather than by the payload's shape.
 * Before them, a 35 KiB JSON-LD address with ~1000 keys and a ~1000-entry
 * `address` array cost ~94 s of CPU (each clone re-read every key against
 * every alias and re-serialized the growing extras per field).
 */

/**
 * `address`/`postalAddress` array entries expanded into sibling locations;
 * object entries past this are ignored.
 */
const MAX_ADDRESS_EXPANSION = 20;

/**
 * Own keys read from any one object (in `Object.keys` order); later keys are
 * ignored everywhere: alias matching, `in` selector and other key lookups,
 * address clones and extras. Real location objects and postings carry a few
 * dozen keys at most.
 */
const MAX_OBJECT_KEYS = 200;

/**
 * Every address clone carries all of its parent's other fields into its
 * extras, so a parent with many fields expands fewer entries: at most
 * `floor(MAX_CLONE_FIELDS / fields)` (still at most MAX_ADDRESS_EXPANSION,
 * and at least one), where `fields` counts the parent's other keys plus the
 * keys of an incoming `extras` object. A schema.org Place or a feed location
 * has a handful of fields and keeps all 20; a parent with 199 junk keys
 * expands 2.
 */
const MAX_CLONE_FIELDS = 400;

/*
 * Per-call and per-clone cost (fork-sync hardening, second pass). The caps
 * above bound one object, but a payload can repeat objects: many tiny
 * addresses (one mapping call each), or many parents at the caps. So:
 * - the alias tables are built once per alias configuration and reused, not
 *   rebuilt on every call (an empty object used to cost ~70 us);
 * - an address clone shares its parent's work (candidates, root slots, the
 *   parent-side address, each field's jsonSafe walk and sizes), so a clone
 *   costs its entry plus copying its own output, not another full pass over
 *   every parent key; and MAX_CLONE_FIELDS bounds that output per parent.
 */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The single object in `v` (a value or an array of values), or `null` when
 * there is none or more than one. Stops at the second object instead of
 * filtering the whole array.
 */
function soleObject(v: unknown): Record<string, unknown> | null {
  if (!Array.isArray(v)) return isObject(v) ? v : null;
  let found: Record<string, unknown> | null = null;
  for (const item of v) {
    if (!isObject(item)) continue;
    if (found) return null;
    found = item;
  }
  return found;
}

function normKey(k: string): string {
  return k.toLowerCase();
}

/** The capped own keys of one object, read once per mapping call. */
interface KeyIndex {
  /** First {@link MAX_OBJECT_KEYS} own enumerable keys, `Object.keys` order. */
  keys: string[];
  /** Lower-cased key to the first key spelled that way; built on first lookup. */
  byLower?: Map<string, string>;
}

/**
 * Per-call cache (one per `toLocationDtos` call): each input object's keys
 * are enumerated and lower-cased once, however many address clones, alias
 * lookups or extras passes touch it. The mapper never mutates its input, and
 * its own mutable `extras` object is tracked separately, never indexed here.
 * A plain Map: it lives only as long as the call, and is much cheaper than a
 * WeakMap to create and to fill.
 */
type KeyCache = Map<object, KeyIndex>;

function keyIndex(cache: KeyCache, obj: Record<string, unknown>): KeyIndex {
  let idx = cache.get(obj);
  if (!idx) {
    const all = Object.keys(obj);
    idx = { keys: all.length > MAX_OBJECT_KEYS ? all.slice(0, MAX_OBJECT_KEYS) : all };
    cache.set(obj, idx);
  }
  return idx;
}

/** The capped own keys of `obj`. */
function ownKeys(cache: KeyCache, obj: Record<string, unknown>): string[] {
  return keyIndex(cache, obj).keys;
}

/** Case-insensitive own-key lookup; returns the actual key or undefined. */
function ownKey(
  cache: KeyCache,
  obj: Record<string, unknown>,
  wanted: string,
): string | undefined {
  const idx = keyIndex(cache, obj);
  if (idx.keys.length === 0) return undefined;
  if (!idx.byLower) {
    const byLower = new Map<string, string>();
    for (const k of idx.keys) {
      const lower = normKey(k);
      if (!byLower.has(lower)) byLower.set(lower, k);
    }
    idx.byLower = byLower;
  }
  return idx.byLower.get(normKey(wanted));
}

/** Resolve a case-insensitive dotted path on own enumerable properties. */
function resolvePath(
  cache: KeyCache,
  root: unknown,
  dotted: string,
): { value: unknown; path: string } | null {
  const segments = dotted.split('.');
  if (segments.length > MAX_SELECTOR_SEGMENTS) return null;
  let cur: unknown = root;
  const walked: string[] = [];
  for (const seg of segments) {
    if (Array.isArray(cur)) {
      // Allow "key" matching inside single-element arrays implicitly? No —
      // selector paths are object paths; arrays need `toLocationDtos` on the
      // resolved node instead.
      return null;
    }
    if (!isObject(cur)) return null;
    const key = ownKey(cache, cur, seg);
    if (key === undefined) return null;
    cur = cur[key];
    walked.push(key);
  }
  return { value: cur, path: walked.join('.') };
}

function scalarValue(v: unknown, slot: Slot): string | null {
  if (typeof v === 'string') {
    const t = slot === 'text' ? v : v.trim();
    return t.trim() ? (slot === 'text' ? v : t) : null;
  }
  if (typeof v === 'number' && Number.isFinite(v) && slot === 'postalCode') {
    return String(v);
  }
  return null;
}

/** Leaf-scalar candidates for an object-valued alias, no priority. */
function objectCandidates(
  cache: KeyCache,
  v: Record<string, unknown>,
  slot: Slot,
  pathPrefix: string,
): Array<{ value: string; path: string }> {
  const leaves = OBJECT_LEAVES[slot];
  if (!leaves) return [];
  const out: Array<{ value: string; path: string }> = [];
  for (const leaf of leaves) {
    const key = ownKey(cache, v, leaf);
    if (key === undefined) continue;
    const s = scalarValue(v[key], slot);
    if (s !== null) out.push({ value: s, path: `${pathPrefix}.${key}` });
  }
  return out;
}

interface Candidate {
  value: string;
  path: string;
}

function emptyCandidates(): Record<Slot, Candidate[]> {
  return {
    city: [],
    state: [],
    country: [],
    postalCode: [],
    streetAddress: [],
    name: [],
    text: [],
  };
}

/** Add the slot candidates found under one key (holding `raw`) to `out`. */
function addKeyCandidates(
  out: Record<Slot, Candidate[]>,
  key: string,
  raw: unknown,
  resolved: Resolved,
  pathPrefix: string,
): void {
  // One map lookup per key instead of splitting all ~70 aliases per key.
  const refs = resolved.aliasIndex.get(normKey(key));
  if (!refs) return;
  const cache = resolved.keyCache;
  for (const { slot, rest } of refs) {
    if (rest === null) {
      const path = pathPrefix ? `${pathPrefix}.${key}` : key;
      const s = scalarValue(raw, slot);
      if (s !== null) {
        out[slot].push({ value: s, path });
      } else if (isObject(raw)) {
        for (const c of objectCandidates(cache, raw, slot, path)) out[slot].push(c);
      }
    } else {
      // Dotted alias: resolve inside this key's subtree.
      const sub = resolvePath(cache, raw, rest);
      if (sub) {
        const s = scalarValue(sub.value, slot);
        if (s !== null) {
          const path = pathPrefix
            ? `${pathPrefix}.${key}.${sub.path}`
            : `${key}.${sub.path}`;
          out[slot].push({ value: s, path });
        }
      }
    }
  }
}

/** Collect raw slot candidates from a location object, in key order. */
function collectCandidates(
  obj: Record<string, unknown>,
  resolved: Resolved,
  pathPrefix: string,
): Record<Slot, Candidate[]> {
  const out = emptyCandidates();
  for (const key of ownKeys(resolved.keyCache, obj)) {
    addKeyCandidates(out, key, obj[key], resolved, pathPrefix);
  }
  return out;
}

/** One alias, pre-split: its slot and its lower-cased tail after segment 1. */
interface AliasRef {
  slot: Slot;
  /** Remaining dotted path (lower-cased), or `null` for a one-segment alias. */
  rest: string | null;
}

/**
 * The alias sets and index for one alias configuration. Built once per
 * configuration and shared by every call that uses it: never mutated.
 */
interface AliasTables {
  /** Each slot's aliases, lower-cased (for `prefer` validation). */
  aliasLower: Readonly<Record<Slot, ReadonlySet<string>>>;
  /**
   * Lower-cased first alias segment to every alias starting with it, in
   * `SLOTS` order then alias order (the order candidates are collected in).
   */
  aliasIndex: ReadonlyMap<string, readonly AliasRef[]>;
}

interface Resolved {
  aliasIndex: ReadonlyMap<string, readonly AliasRef[]>;
  prefer: Partial<Record<Slot, string>>;
  keyCache: KeyCache;
  limits: Required<LocationObjectLimits>;
}

/** Merge default aliases with caller `aliases`/`nameKeys`/`textKeys`. */
function buildAliasTables(opts: LocationObjectOptions): AliasTables {
  const aliasSets: Record<Slot, string[]> = {
    city: [...DEFAULT_ALIASES.city],
    state: [...DEFAULT_ALIASES.state],
    country: [...DEFAULT_ALIASES.country],
    postalCode: [...DEFAULT_ALIASES.postalCode],
    streetAddress: [...DEFAULT_ALIASES.streetAddress],
    name: [...DEFAULT_ALIASES.name],
    text: [...DEFAULT_ALIASES.text],
  };
  const assigned = new Map<string, Slot>();
  const assign = (slot: Slot, paths: string[] | undefined) => {
    for (const p of paths ?? []) {
      const key = p.toLowerCase();
      const prev = assigned.get(key);
      if (prev && prev !== slot) {
        throw new Error(
          `location-object: path '${p}' assigned to both '${prev}' and '${slot}'`,
        );
      }
      assigned.set(key, slot);
      for (const s of SLOTS) {
        if (s !== slot) {
          const i = aliasSets[s].findIndex((a) => a.toLowerCase() === key);
          if (i >= 0) aliasSets[s].splice(i, 1);
        }
      }
      if (!aliasSets[slot].some((a) => a.toLowerCase() === key)) {
        aliasSets[slot].push(p);
      }
    }
  };
  for (const slot of SLOTS) assign(slot, opts.aliases?.[slot]);
  assign('name', opts.nameKeys);
  assign('text', opts.textKeys);

  // Split every alias once per configuration, not once per (key x alias) pair.
  const aliasIndex = new Map<string, AliasRef[]>();
  const aliasLower = {} as Record<Slot, ReadonlySet<string>>;
  for (const slot of SLOTS) {
    aliasLower[slot] = new Set(aliasSets[slot].map((a) => a.toLowerCase()));
    for (const alias of aliasSets[slot]) {
      const segs = alias.split('.').map(normKey);
      const ref: AliasRef = {
        slot,
        rest: segs.length === 1 ? null : segs.slice(1).join('.'),
      };
      const refs = aliasIndex.get(segs[0]);
      if (refs) refs.push(ref);
      else aliasIndex.set(segs[0], [ref]);
    }
  }
  return { aliasLower, aliasIndex };
}

/** Each slot's object leaves, lower-cased (for `prefer` validation). */
const OBJECT_LEAVES_LOWER: Partial<Record<Slot, ReadonlySet<string>>> = {};
for (const slot of SLOTS) {
  const leaves = OBJECT_LEAVES[slot];
  if (leaves) OBJECT_LEAVES_LOWER[slot] = new Set(leaves.map((l) => l.toLowerCase()));
}

/** The tables for calls that pass no `aliases`/`nameKeys`/`textKeys`. */
const DEFAULT_ALIAS_TABLES = buildAliasTables({});

/**
 * Tables for custom alias configurations, by signature. Plugins pass a fixed
 * configuration per call site, so a handful of entries cover them; the oldest
 * entry is evicted past the bound. A configuration that fails to build (a
 * path assigned to two slots) is never cached and throws on every call.
 */
const customAliasTables = new Map<string, AliasTables>();
const MAX_CUSTOM_ALIAS_TABLES = 64;

/** Alias paths that change nothing: absent or an empty array. */
function noPaths(paths: unknown): boolean {
  return paths == null || (Array.isArray(paths) && paths.length === 0);
}

/**
 * A signature of the alias path lists that is injective (each list is
 * absent, or a count then length-prefixed strings), or `null` when a list is
 * not an array of strings (such a configuration is built uncached).
 */
function aliasSignature(lists: readonly unknown[]): string | null {
  let sig = '';
  for (const list of lists) {
    if (list == null) {
      sig += '-';
      continue;
    }
    if (!Array.isArray(list)) return null;
    sig += `${list.length};`;
    for (const p of list) {
      if (typeof p !== 'string') return null;
      sig += `${p.length}:${p}`;
    }
  }
  return sig;
}

/**
 * The alias tables for `opts`: shared defaults, or a cached custom build.
 * Rebuilding them on every call (~60 alias splits plus map inserts) made
 * each call cost ~70 us even for an empty object, and JSON-LD maps one
 * call per address (fork-sync hardening).
 */
function aliasTables(opts: LocationObjectOptions): AliasTables {
  const { aliases, nameKeys, textKeys } = opts;
  if (aliases == null && noPaths(nameKeys) && noPaths(textKeys)) {
    return DEFAULT_ALIAS_TABLES;
  }
  const lists: unknown[] = [nameKeys, textKeys];
  for (const slot of SLOTS) lists.push(aliases?.[slot]);
  if (lists.every(noPaths)) return DEFAULT_ALIAS_TABLES;
  const signature = aliasSignature(lists);
  if (signature === null) return buildAliasTables(opts);
  let tables = customAliasTables.get(signature);
  if (!tables) {
    tables = buildAliasTables(opts);
    if (customAliasTables.size >= MAX_CUSTOM_ALIAS_TABLES) {
      const oldest = customAliasTables.keys().next();
      if (!oldest.done) customAliasTables.delete(oldest.value);
    }
    customAliasTables.set(signature, tables);
  }
  return tables;
}

/** Per-call mapping context: alias tables, validated `prefer`, caches. */
function resolveAliases(opts: LocationObjectOptions): Resolved {
  const { aliasLower, aliasIndex } = aliasTables(opts);

  const prefer: Partial<Record<Slot, string>> = {};
  for (const slot of SLOTS) {
    const p = opts.prefer?.[slot];
    if (!p) continue;
    const key = p.toLowerCase();
    const inAliases = aliasLower[slot].has(key);
    const isLeaf =
      OBJECT_LEAVES_LOWER[slot]?.has(key.slice(key.lastIndexOf('.') + 1)) ?? false;
    if (!inAliases && !isLeaf) {
      throw new Error(
        `location-object: prefer path '${p}' is not an alias or object leaf of '${slot}'`,
      );
    }
    prefer[slot] = p;
  }

  return {
    aliasIndex,
    prefer,
    keyCache: new Map(),
    // Read-only: DEFAULT_LIMITS itself when nothing overrides it.
    limits: opts.extrasLimits ? { ...DEFAULT_LIMITS, ...opts.extrasLimits } : DEFAULT_LIMITS,
  };
}

/** Canonical group key for a slot value (comparison, never stored). */
function comparisonKey(slot: Slot, value: string, countryResolved: string | null): string {
  if (slot === 'country') {
    return (canonicalCountryName(value, { isoCountryNames: true }) ?? value)
      .trim()
      .toLowerCase();
  }
  if (slot === 'state') {
    const us = normalizeUsState(value);
    if (us && (countryResolved === null || countryResolved === 'united states')) {
      return `us:${us}`;
    }
    return value.trim().toLowerCase();
  }
  if (slot === 'text') return value; // exact
  return value.trim().toLowerCase();
}

function canonicalScalarMatch(slot: Slot, path: string): boolean {
  const leaf = path.split('.').pop() ?? path;
  return leaf.toLowerCase() === slot;
}

/** Pick the stored candidate within an agreeing group, per spec ordering. */
function pickStored(
  slot: Slot,
  group: Candidate[],
  prefer: Partial<Record<Slot, string>>,
  countryResolved: string | null,
): string {
  const pref = prefer[slot];
  if (pref) {
    const hit = group.find(
      (c) => c.path.toLowerCase().endsWith(pref.toLowerCase()) || c.path.toLowerCase() === pref.toLowerCase(),
    );
    if (hit) {
      const exact = group.find((c) => c.path.split('.').pop() === pref.split('.').pop());
      return (exact ?? hit).value;
    }
  }
  const canonical = group.filter((c) => canonicalScalarMatch(slot, c.path));
  const pool = canonical.length ? canonical : group;
  if (slot === 'country') {
    // recognized full name over a bare code
    const named = pool.find(
      (c) =>
        canonicalCountryName(c.value, { isoCountryNames: true }) !== null &&
        c.value.trim().length > 2,
    );
    if (named) return named.value;
  }
  if (slot === 'state' && (countryResolved === null || countryResolved === 'united states')) {
    const named = pool.find((c) => !/^[A-Za-z]{2}$/.test(c.value.trim()));
    if (named) return named.value;
  }
  pool.sort((a, b) => a.path.localeCompare(b.path));
  return pool[0].value;
}

/** A slot's stored value, the paths it claims, and the losing candidates. */
interface SlotResolution {
  value: string | null;
  consumedPaths: ReadonlySet<string>;
  alternates: readonly Candidate[];
}

/** Shared empty set (read-only by type; never added to). */
const NO_PATHS: ReadonlySet<string> = new Set<string>();

/** Shared result for a slot with no candidates (most slots of most objects). */
const NO_CANDIDATES: SlotResolution = {
  value: null,
  consumedPaths: NO_PATHS,
  alternates: [],
};

/**
 * Resolve one slot's candidates to a stored value (or leave unset). May sort
 * `candidates` in place: callers pass an array they own.
 */
function resolveSlot(
  slot: Slot,
  candidates: Candidate[],
  prefer: Partial<Record<Slot, string>>,
  countryResolved: string | null,
): SlotResolution {
  if (candidates.length === 0) return NO_CANDIDATES;
  const consumedPaths = new Set<string>();
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = comparisonKey(slot, c.value, countryResolved);
    const g = groups.get(k) ?? [];
    g.push(c);
    groups.set(k, g);
  }
  if (groups.size === 0) return { value: null, consumedPaths, alternates: [] };
  if (groups.size === 1) {
    const group = candidates;
    for (const c of group) consumedPaths.add(c.path);
    return {
      value: pickStored(slot, group, prefer, countryResolved),
      consumedPaths,
      alternates: [],
    };
  }
  // Genuine conflict: explicit prefer path, then scalar canonical field.
  const pref = prefer[slot];
  let winner: Candidate[] | null = null;
  if (pref) {
    const prefLower = pref.toLowerCase();
    const prefLeaf = pref.split('.').pop()!.toLowerCase();
    // Exact casing wins over a case-insensitive leaf match — the prefer path
    // 'City' must pick the `City` key, not the earlier `city` one.
    const hit =
      candidates.find((c) => c.path === pref) ??
      candidates.find((c) => (c.path.split('.').pop() ?? '') === pref.split('.').pop()) ??
      candidates.find(
        (c) =>
          c.path.toLowerCase() === prefLower ||
          (c.path.split('.').pop() ?? '').toLowerCase() === prefLeaf,
      );
    if (hit) {
      const key = comparisonKey(slot, hit.value, countryResolved);
      winner = groups.get(key) ?? null;
    }
  }
  if (!winner) {
    // A scalar field whose name exactly matches the slot resolves the
    // conflict — but only when a single group claims that distinction;
    // `city` vs `City` disagreeing is still a conflict.
    const canon = candidates.filter((c) => canonicalScalarMatch(slot, c.path));
    const canonGroups = new Set(
      canon.map((c) => comparisonKey(slot, c.value, countryResolved)),
    );
    if (canon.length && canonGroups.size === 1) {
      winner = groups.get([...canonGroups][0]) ?? null;
    }
  }
  if (winner) {
    for (const c of winner) consumedPaths.add(c.path);
    const won = new Set(winner);
    return {
      value: pickStored(slot, winner, prefer, countryResolved),
      consumedPaths,
      alternates: candidates.filter((c) => !won.has(c)),
    };
  }
  return { value: null, consumedPaths, alternates: candidates };
}

// ─── extras ───────────────────────────────────────────────────────────

interface ExtrasCtx {
  nodes: number;
  limits: Required<LocationObjectLimits>;
  omitted: boolean;
  keyCache: KeyCache;
}

function pathListed(list: string[] | undefined, path: string): boolean {
  if (!list) return false;
  const p = path.toLowerCase();
  return list.some((e) => {
    const l = e.toLowerCase();
    return p === l || p.startsWith(l + '.');
  });
}

/**
 * Set an own enumerable data property on a plain object built here. Plain
 * assignment, which is several times faster than `defineProperty` on objects
 * with many keys, except for `__proto__`, which assignment would treat as the
 * prototype setter instead of a key.
 */
function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === '__proto__') {
    Object.defineProperty(obj, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

function jsonSafe(v: unknown, depth: number, ctx: ExtrasCtx, seen: Set<unknown>): unknown {
  if (ctx.nodes >= ctx.limits.maxNodes) {
    ctx.omitted = true;
    return undefined;
  }
  ctx.nodes++;
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') return Number.isFinite(v as number) ? v : undefined;
  if (t !== 'object') return undefined;
  if (depth > ctx.limits.maxDepth) {
    ctx.omitted = true;
    return undefined;
  }
  if (seen.has(v)) {
    ctx.omitted = true;
    return undefined;
  }
  seen.add(v);
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const item of v) {
      const sv = jsonSafe(item, depth + 1, ctx, seen);
      if (sv !== undefined) out.push(sv);
      if (ctx.nodes >= ctx.limits.maxNodes) break;
    }
    seen.delete(v);
    return out;
  }
  const out: Record<string, unknown> = {};
  const keys = ownKeys(ctx.keyCache, v as Record<string, unknown>);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const sv = jsonSafe((v as Record<string, unknown>)[k], depth + 1, ctx, seen);
    if (sv !== undefined) setOwn(out, k, sv);
    if (ctx.nodes >= ctx.limits.maxNodes) {
      // Every later key would be dropped anyway; stop walking them.
      if (i < keys.length - 1) ctx.omitted = true;
      break;
    }
  }
  seen.delete(v);
  return out;
}

/**
 * One possible extras member: a raw key of the mapped object, or a key of an
 * incoming `extras` object. Its path for `keep`/`drop` and the consumed set is
 * the key itself (extras are only built for the selected root object).
 * Everything memoized here depends only on the field, so every address clone
 * of one parent reuses it.
 */
interface ExtrasField {
  key: string;
  value: unknown;
  /** `normKey(key)`, for the incoming-extras collision check. */
  lower: string;
  /** Passes `keep`/`drop`; computed on first use. */
  listed?: boolean;
  /** UTF-8 size of `JSON.stringify(key)`; computed on first use. */
  keyBytes?: number;
  /** `jsonSafe(value)` walked from a node count of 0; computed on first use. */
  safe?: SafeValue;
  /** The last walk that hit the node cap from a non-zero count. */
  cut?: SafeValue & { start: number };
}

interface SafeValue {
  sv: unknown;
  /** Nodes the walk counted. */
  nodes: number;
  /** UTF-8 size of `JSON.stringify(sv)`; computed on first use. */
  bytes?: number;
  /** `sv` already sits in one DTO's extras: later DTOs get their own copy. */
  handedOut: boolean;
}

/** A raw field, or an incoming `extras` object's fields (flattened in place). */
type ExtrasStep = ExtrasField | ExtrasField[];

function extrasField(key: string, value: unknown): ExtrasField {
  return { key, value, lower: normKey(key) };
}

/** Whether `path` passes `keep`/`drop` (drop wins; `keep: []` keeps nothing). */
function passesKeepDrop(path: string, opts: LocationObjectOptions): boolean {
  if (opts.drop && pathListed(opts.drop, path)) return false;
  if (opts.keep !== undefined) {
    if (opts.keep.length === 0) return false;
    if (!pathListed(opts.keep, path)) return false;
  }
  return true;
}

function walkSafe(
  value: unknown,
  start: number,
  limits: Required<LocationObjectLimits>,
  keyCache: KeyCache,
): SafeValue {
  const ctx: ExtrasCtx = { nodes: start, limits, omitted: false, keyCache };
  const sv = jsonSafe(value, 1, ctx, new Set());
  return { sv, nodes: ctx.nodes - start, handedOut: false };
}

/** Deep copy of a `jsonSafe` result (plain arrays/objects of JSON values). */
function copySafe(v: unknown): unknown {
  if (typeof v !== 'object' || v === null) return v;
  if (Array.isArray(v)) return v.map(copySafe);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) setOwn(out, k, copySafe((v as Record<string, unknown>)[k]));
  return out;
}

/**
 * Collect the unclaimed fields into extras, honouring keep/drop: the `steps`
 * of the mapped object in key order, then `trailing` (an address clone's
 * expanded key, which sits last in the clone).
 *
 * Same rule as walking the object directly: a field lands while the
 * serialized extras stay within `maxBytes`, all fields share one `maxNodes`
 * budget, and the walk stops once the size reaches `maxBytes`. The UTF-8
 * size is kept current as fields land instead of re-serializing the whole
 * object per field (quadratic in the number of keys), and each field's
 * `jsonSafe` walk and sizes are computed once and reused by later clones of
 * the same parent: a walk from node count `n` equals the walk from 0 when the
 * whole value fits in the remaining budget, so only a walk that hits the cap
 * is redone (at most once per fold, since it exhausts the budget).
 */
function foldExtras(
  steps: readonly ExtrasStep[],
  trailing: ExtrasField | null,
  isConsumed: (path: string) => boolean,
  opts: LocationObjectOptions,
  resolved: Resolved,
): Record<string, unknown> | null {
  const { limits, keyCache } = resolved;
  const { maxBytes, maxNodes } = limits;
  const extras: Record<string, unknown> = {};
  let size = 2; // '{}'
  let nodes = 0;
  /** UTF-8 size of each landed `"key":value` member, for overwrites. */
  const memberBytes = new Map<string, number>();
  /** Lower-cased landed keys, for the incoming-extras collision check. */
  const landedLower = new Set<string>();

  const add = (f: ExtrasField): void => {
    if (isConsumed(f.key)) return;
    if (f.listed === undefined) f.listed = passesKeepDrop(f.key, opts);
    if (!f.listed) return;
    // jsonSafe returns undefined at once when the node budget is spent.
    if (nodes >= maxNodes) return;
    let safe = f.safe;
    if (!safe) safe = f.safe = walkSafe(f.value, 0, limits, keyCache);
    if (!(nodes + safe.nodes <= maxNodes)) {
      // The value does not fit the remaining budget: the walk from `nodes`
      // is cut short, unlike the memoized one.
      if (!f.cut || f.cut.start !== nodes) {
        f.cut = { ...walkSafe(f.value, nodes, limits, keyCache), start: nodes };
      }
      safe = f.cut;
    }
    nodes += safe.nodes;
    const sv = safe.sv;
    if (sv === undefined) return;
    // A JSON string takes at least its UTF-16 length + 2 quotes in UTF-8, so
    // an oversized string is rejected without serializing it.
    if (typeof sv === 'string' && size + sv.length + 2 > maxBytes) return;
    let bytes = safe.bytes;
    if (bytes === undefined) {
      bytes = safe.bytes = Buffer.byteLength(JSON.stringify(sv), 'utf8');
    }
    if (size + bytes > maxBytes) return;
    let keyBytes = f.keyBytes;
    if (keyBytes === undefined) {
      keyBytes = f.keyBytes = Buffer.byteLength(JSON.stringify(f.key), 'utf8');
    }
    const member = keyBytes + 1 + bytes;
    const prev = memberBytes.get(f.key);
    // A new member also adds its ',' separator; an overwrite swaps sizes.
    size += prev === undefined ? member + (memberBytes.size > 0 ? 1 : 0) : member - prev;
    memberBytes.set(f.key, member);
    landedLower.add(f.lower);
    let value: unknown = sv;
    if (typeof sv === 'object' && sv !== null) {
      // Each DTO owns its extras: the first gets the memoized value, later
      // clones a copy.
      if (safe.handedOut) value = copySafe(sv);
      else safe.handedOut = true;
    }
    setOwn(extras, f.key, value);
  };

  // Every value serializes to at least one byte, so once the size reaches
  // the cap nothing else can land: stop walking the remaining fields.
  const full = (): boolean => size >= maxBytes;
  let stopped = false;
  for (const step of steps) {
    if (full()) {
      stopped = true;
      break;
    }
    if (Array.isArray(step)) {
      // Incoming extras flatten into output extras (never extras.extras);
      // raw fields win collisions.
      for (const f of step) {
        if (full()) break;
        if (!landedLower.has(f.lower)) add(f);
      }
      continue;
    }
    add(step);
  }
  if (trailing && !stopped && !full()) add(trailing);
  return memberBytes.size ? extras : null;
}

// ─── location mapping ────────────────────────────────────────────────

/** Root slot values of one object (before address descent). */
interface RootSlots {
  values: Record<Slot, string | null>;
  /** Paths claimed by the winning candidates. */
  consumed: ReadonlySet<string>;
  /** Comparison key of the resolved country, for state equivalence. */
  countryResolved: string | null;
}

/** Resolve the root slots; `candidates` arrays may be sorted in place. */
function resolveRootSlots(
  candidates: Record<Slot, Candidate[]>,
  prefer: Partial<Record<Slot, string>>,
): RootSlots {
  // Resolve country first (state equivalence depends on it).
  const countryRes = resolveSlot('country', candidates.country, prefer, null);
  const countryResolved = countryRes.value
    ? comparisonKey('country', countryRes.value, null)
    : null;
  const values: Record<Slot, string | null> = {
    city: null,
    state: null,
    country: countryRes.value,
    postalCode: null,
    streetAddress: null,
    name: null,
    text: null,
  };
  // Only winner-group paths count as consumed — losing/conflicting
  // candidates stay unclaimed and land in extras.
  let consumed: Set<string> | null = null;
  for (const p of countryRes.consumedPaths) (consumed ??= new Set()).add(p);
  for (const slot of ['city', 'state', 'postalCode', 'streetAddress', 'name', 'text'] as Slot[]) {
    const res = resolveSlot(slot, candidates[slot], prefer, countryResolved);
    values[slot] = res.value;
    for (const p of res.consumedPaths) (consumed ??= new Set()).add(p);
  }
  return { values, consumed: consumed ?? NO_PATHS, countryResolved };
}

/** No key matched an alias (frozen: shared by every such object). */
const NO_KEY_CANDIDATES: Record<Slot, Candidate[]> = Object.freeze({
  city: Object.freeze([]) as unknown as Candidate[],
  state: Object.freeze([]) as unknown as Candidate[],
  country: Object.freeze([]) as unknown as Candidate[],
  postalCode: Object.freeze([]) as unknown as Candidate[],
  streetAddress: Object.freeze([]) as unknown as Candidate[],
  name: Object.freeze([]) as unknown as Candidate[],
  text: Object.freeze([]) as unknown as Candidate[],
});

/** Root slots of an object with no candidates (frozen, shared). */
const NO_ROOT_SLOTS: RootSlots = Object.freeze({
  values: Object.freeze({
    city: null,
    state: null,
    country: null,
    postalCode: null,
    streetAddress: null,
    name: null,
    text: null,
  }),
  consumed: NO_PATHS,
  countryResolved: null,
});

function copyCandidates(c: Record<Slot, Candidate[]>): Record<Slot, Candidate[]> {
  const out = emptyCandidates();
  for (const slot of SLOTS) out[slot] = c[slot].slice();
  return out;
}

/** What an `address`/`postalAddress` key held on the parent side. */
interface BaseAddress {
  /** Trimmed string value. */
  text?: string;
  /** Candidates of the single address object. */
  candidates?: Record<Slot, Candidate[]>;
}

const ADDRESS_KEYS = ['address', 'postalAddress'];

/**
 * The parts of mapping one location object that do not depend on which
 * `address` entry it is paired with, each computed at most once. A plain
 * object is mapped through one scan; the address clones of a parent all
 * share the parent's scan, so the parent's keys are read, matched and
 * serialized once instead of once per clone (fork-sync hardening: 100
 * parents of 199 keys x 20 addresses, 222 KiB, took ~3.8 s).
 */
class ObjectScan {
  private candidates?: Record<Slot, Candidate[]>;
  private root?: RootSlots;
  private steps?: ExtrasStep[];
  private fields?: number;
  private firstKeys?: Map<string, string | undefined>;
  private addresses?: Map<string, BaseAddress>;
  private fills?: Map<string, SlotResolution>;

  /**
   * @param obj the object (for a clone: the parent)
   * @param keys the keys mapped, in order: the object's own capped keys, or
   *   for a clone the parent's minus the expanded key
   * @param expandedKey for a clone, the parent's expanded address key
   */
  constructor(
    readonly obj: Record<string, unknown>,
    readonly keys: readonly string[],
    private readonly expandedKey: string | undefined,
    private readonly resolved: Resolved,
  ) {}

  /** Candidates of `keys`, in key order. Callers must not mutate them. */
  keyCandidates(): Record<Slot, Candidate[]> {
    if (!this.candidates) {
      let out: Record<Slot, Candidate[]> | null = null;
      for (const key of this.keys) {
        if (!this.resolved.aliasIndex.has(normKey(key))) continue;
        out ??= emptyCandidates();
        addKeyCandidates(out, key, this.obj[key], this.resolved, '');
      }
      this.candidates = out ?? NO_KEY_CANDIDATES;
    }
    return this.candidates;
  }

  /** Root slots from `keys` alone. */
  rootSlots(): RootSlots {
    if (!this.root) {
      const candidates = this.keyCandidates();
      if (candidates === NO_KEY_CANDIDATES) return (this.root = NO_ROOT_SLOTS);
      // Resolution may sort the arrays in place; a clone's merge reads them
      // later, so a shared scan resolves copies.
      this.root = resolveRootSlots(
        this.expandedKey === undefined ? candidates : copyCandidates(candidates),
        this.resolved.prefer,
      );
    }
    return this.root;
  }

  /** The first of `keys` spelled `name` case-insensitively. */
  firstKey(name: string): string | undefined {
    const k = ownKey(this.resolved.keyCache, this.obj, name);
    // `keys` is all of the object's keys, or all but the expanded key (and
    // `__proto__`, which no address name matches).
    if (k === undefined || k !== this.expandedKey) return k;
    const lower = normKey(name);
    this.firstKeys ??= new Map();
    if (!this.firstKeys.has(lower)) {
      this.firstKeys.set(lower, this.keys.find((key) => normKey(key) === lower));
    }
    return this.firstKeys.get(lower);
  }

  /** The parent-side value of the address key `key` (one of `keys`). */
  address(key: string): BaseAddress {
    this.addresses ??= new Map();
    let a = this.addresses.get(key);
    if (!a) {
      const raw = this.obj[key];
      if (typeof raw === 'string') {
        a = { text: raw.trim() };
      } else {
        const address = soleObject(raw);
        a = address ? { candidates: collectCandidates(address, this.resolved, key) } : {};
      }
      this.addresses.set(key, a);
    }
    return a;
  }

  /** `slot` resolved from the address key `key` against the shared root. */
  fill(key: string, slot: Slot): SlotResolution {
    this.fills ??= new Map();
    const memoKey = `${slot}\u0000${key}`;
    let res = this.fills.get(memoKey);
    if (!res) {
      const candidates = this.address(key).candidates?.[slot] ?? [];
      res = resolveSlot(
        slot,
        candidates.slice(),
        this.resolved.prefer,
        this.rootSlots().countryResolved,
      );
      this.fills.set(memoKey, res);
    }
    return res;
  }

  /** The extras walk over `keys`, in key order. */
  extrasSteps(): readonly ExtrasStep[] {
    if (!this.steps) {
      const cache = this.resolved.keyCache;
      const steps: ExtrasStep[] = [];
      for (const key of this.keys) {
        const v = this.obj[key];
        if (normKey(key) === 'extras' && isObject(v)) {
          steps.push(ownKeys(cache, v).map((ek) => extrasField(ek, v[ek])));
        } else {
          steps.push(extrasField(key, v));
        }
      }
      this.steps = steps;
    }
    return this.steps;
  }

  /** Fields the extras walk visits (incoming `extras` keys counted singly). */
  extrasFieldCount(): number {
    if (this.fields === undefined) {
      let n = 0;
      for (const step of this.extrasSteps()) n += Array.isArray(step) ? step.length : 1;
      this.fields = n;
    }
    return this.fields;
  }
}

/** Fill the slots still missing from one address's candidates. */
function fillFromAddress(
  values: Record<Slot, string | null>,
  consumed: Set<string>,
  key: string,
  sub: Record<Slot, Candidate[]>,
  resolve: (slot: Slot) => SlotResolution,
): void {
  let filledAny = false;
  for (const slot of SLOTS) {
    if (values[slot] == null && sub[slot].length) {
      const res = resolve(slot);
      values[slot] = res.value;
      for (const p of res.consumedPaths) consumed.add(p);
      filledAny = true;
    }
  }
  if (filledAny) consumed.add(key);
}

/**
 * Map one location object: `scan`'s keys, then for an address clone the
 * expanded key holding one entry (`trailing`), exactly as if the clone were
 * a separate object with that key last.
 */
function mapScanned(
  scan: ObjectScan,
  trailing: { key: string; value: Record<string, unknown> } | null,
  resolved: Resolved,
  opts: LocationObjectOptions,
): LocationDto | null {
  const { prefer } = resolved;

  // The entry adds root candidates only under a custom alias rooted at the
  // address key itself (e.g. `address.city`); otherwise the root slots are
  // the parent's, shared by every clone.
  let root: RootSlots | null = null;
  if (trailing && resolved.aliasIndex.has(normKey(trailing.key))) {
    const own = emptyCandidates();
    addKeyCandidates(own, trailing.key, trailing.value, resolved, '');
    if (SLOTS.some((slot) => own[slot].length > 0)) {
      const base = scan.keyCandidates();
      const merged = emptyCandidates();
      for (const slot of SLOTS) merged[slot] = base[slot].concat(own[slot]);
      root = resolveRootSlots(merged, prefer);
    }
  }
  const sharedRoot = root === null;
  if (!root) root = scan.rootSlots();
  const { countryResolved } = root;
  const values: Record<Slot, string | null> = { ...root.values };
  const consumed = new Set<string>();

  // Address descent: root slots win; address fills missing; conflicts → extras.
  for (const addrName of ADDRESS_KEYS) {
    const key = scan.firstKey(addrName);
    if (key !== undefined) {
      const base = scan.address(key);
      if (base.text !== undefined) {
        if (base.text && values.streetAddress == null) {
          values.streetAddress = base.text;
          consumed.add(key);
        }
        continue;
      }
      // Arrays expand into separate locations in `mapInput`; here only a
      // single address object fills.
      const sub = base.candidates;
      if (sub) {
        fillFromAddress(values, consumed, key, sub, (slot) =>
          sharedRoot
            ? scan.fill(key, slot)
            : resolveSlot(slot, sub[slot].slice(), prefer, countryResolved),
        );
      }
      continue;
    }
    if (trailing && normKey(trailing.key) === normKey(addrName)) {
      const sub = collectCandidates(trailing.value, resolved, trailing.key);
      fillFromAddress(values, consumed, trailing.key, sub, (slot) =>
        resolveSlot(slot, sub[slot], prefer, countryResolved),
      );
    }
  }

  const meaningful =
    values.name || values.text || values.city || values.state ||
    values.country || values.streetAddress || values.postalCode;
  if (!meaningful) return null;

  const rootConsumed = root.consumed;
  const extras = foldExtras(
    scan.extrasSteps(),
    trailing ? extrasField(trailing.key, trailing.value) : null,
    (path) => rootConsumed.has(path) || consumed.has(path),
    opts,
    resolved,
  );

  const dto = new LocationDto({
    name: values.name ?? null,
    text: values.text ?? null,
    city: values.city ?? null,
    state: values.state ?? null,
    country: values.country ?? null,
    streetAddress: values.streetAddress ?? null,
    postalCode: values.postalCode ?? null,
  });
  if (extras) dto.extras = extras;

  if (opts.parseTextFallback && dto.text) {
    const parsed = parseLocationList([dto.text], opts.parseOptions);
    if (parsed.locations.length === 1) {
      const p = parsed.locations[0];
      let conflict = false;
      for (const slot of ['city', 'state', 'country'] as const) {
        const inferred = p[slot];
        if (!inferred) continue;
        const cur = dto[slot];
        if (cur && comparisonKey(slot, String(cur), countryResolved) !== comparisonKey(slot, String(inferred), countryResolved)) {
          conflict = true;
          break;
        }
      }
      if (!conflict) {
        for (const slot of ['city', 'state', 'country'] as const) {
          if (dto[slot] == null && p[slot]) {
            (dto as unknown as Record<string, unknown>)[slot] = p[slot];
          }
        }
      }
    }
  }

  return dto;
}

/** Exact-duplicate key across mapped fields + extras. */
function dedupeKey(dto: LocationDto): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (isObject(v)) {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
      return o;
    }
    return v ?? null;
  };
  return JSON.stringify(
    canon({
      name: dto.name ?? null,
      text: dto.text ?? null,
      city: dto.city ?? null,
      state: dto.state ?? null,
      country: dto.country ?? null,
      streetAddress: dto.streetAddress ?? null,
      postalCode: dto.postalCode ?? null,
      extras: dto.extras ?? null,
    }),
  );
}

/**
 * Map `input` into `out`, stopping once `out` holds `limit` DTOs (the first
 * DTOs are the same either way, so `toLocationDto` skips mapping the rest).
 */
function mapInput(
  input: unknown,
  resolved: Resolved,
  opts: LocationObjectOptions,
  out: LocationDto[],
  depth: number,
  limit: number,
): void {
  if (depth > MAX_ARRAY_DEPTH || out.length >= limit) return;
  if (typeof input === 'string') {
    const normalized = input.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    const parsed = parseLocationList([input], opts.parseOptions);
    if (parsed.locations.length) {
      for (const loc of parsed.locations) {
        const dto = new LocationDto({ ...loc });
        if (dto.text == null) dto.text = normalized;
        out.push(dto);
      }
    } else {
      out.push(new LocationDto({ text: normalized }));
    }
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      if (out.length >= limit) return;
      mapInput(item, resolved, opts, out, depth + 1, limit);
    }
    return;
  }
  if (isObject(input)) {
    const cache = resolved.keyCache;
    // Expand `address`/`postalAddress` arrays into sibling locations: one
    // clone of the parent per object entry, with the address key holding
    // that entry and moved last. Clones are not built: they share the
    // parent's scan, and only the entry is mapped per clone.
    for (const addrKey of ADDRESS_KEYS) {
      const key = ownKey(cache, input, addrKey);
      if (key === undefined) continue;
      const raw = input[key];
      if (Array.isArray(raw) && raw.length > 1 && raw.some(isObject)) {
        // A clone held every other (capped) parent key except `__proto__`:
        // assigning that one set the clone's prototype instead of a key.
        const keys = ownKeys(cache, input).filter((k) => k !== key && k !== '__proto__');
        const scan = new ObjectScan(input, keys, key, resolved);
        const maxClones = Math.min(
          MAX_ADDRESS_EXPANSION,
          Math.max(1, Math.floor(MAX_CLONE_FIELDS / Math.max(1, scan.extrasFieldCount()))),
        );
        let clones = 0;
        for (const entry of raw) {
          if (!isObject(entry)) continue;
          if (clones >= maxClones || out.length >= limit) return;
          clones++;
          const dto = mapScanned(scan, { key, value: entry }, resolved, opts);
          if (dto) out.push(dto);
        }
        return;
      }
    }
    const scan = new ObjectScan(input, ownKeys(cache, input), undefined, resolved);
    const dto = mapScanned(scan, null, resolved, opts);
    if (dto) out.push(dto);
  }
}

/** Drop exact duplicates (mapped fields + extras), keeping the first. */
function dedupe(dtos: LocationDto[]): LocationDto[] {
  // Nothing to compare: skip serializing (toLocationDto maps at most one).
  if (dtos.length < 2) return dtos;
  const seen = new Set<string>();
  return dtos.filter((d) => {
    const k = dedupeKey(d);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Shared body of {@link toLocationDtos} / {@link toLocationDto}. */
function mapLocations(
  input: unknown,
  opts: LocationObjectOptions,
  limit: number,
): LocationDto[] {
  const resolved = resolveAliases(opts);
  let selected: unknown = input;

  if (opts.in !== undefined) {
    const paths = Array.isArray(opts.in) ? opts.in : [opts.in];
    selected = undefined;
    for (const p of paths) {
      const hit = isObject(input) ? resolvePath(resolved.keyCache, input, p) : null;
      if (hit) {
        const probe: LocationDto[] = [];
        mapInput(hit.value, resolved, { ...opts, in: undefined }, probe, 0, limit);
        if (probe.length) return dedupe(probe);
      }
    }
    return [];
  }

  const out: LocationDto[] = [];
  mapInput(selected, resolved, opts, out, 0, limit);
  return dedupe(out);
}

/**
 * Map a location object, string, or array to `LocationDto`s. Reads own
 * runtime keys only — feed interfaces don't gate discovery.
 */
export function toLocationDtos(
  input: unknown,
  opts: LocationObjectOptions = {},
): LocationDto[] {
  return mapLocations(input, opts, Number.POSITIVE_INFINITY);
}

/**
 * First usable mapped location, or `null`. Same result as
 * `toLocationDtos(input, opts)[0]`, but stops mapping after that first DTO.
 */
export function toLocationDto(
  input: unknown,
  opts: LocationObjectOptions = {},
): LocationDto | null {
  return mapLocations(input, opts, 1)[0] ?? null;
}
