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
 */
type KeyCache = WeakMap<object, KeyIndex>;

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

/**
 * Collect raw slot candidates from a selected location object. Returns the
 * consumed leaf paths so extras can exclude exactly what was claimed.
 */
function collectCandidates(
  obj: Record<string, unknown>,
  resolved: Resolved,
  pathPrefix: string,
  consumed: Set<string>,
): Record<Slot, Candidate[]> {
  const out: Record<Slot, Candidate[]> = {
    city: [],
    state: [],
    country: [],
    postalCode: [],
    streetAddress: [],
    name: [],
    text: [],
  };
  const cache = resolved.keyCache;
  for (const key of ownKeys(cache, obj)) {
    // One map lookup per key instead of splitting all ~70 aliases per key.
    const refs = resolved.aliasIndex.get(normKey(key));
    if (!refs) continue;
    for (const { slot, rest } of refs) {
      if (rest === null) {
        const raw = obj[key];
        const path = pathPrefix ? `${pathPrefix}.${key}` : key;
        const s = scalarValue(raw, slot);
        if (s !== null) {
          out[slot].push({ value: s, path });
          consumed.add(path);
        } else if (isObject(raw)) {
          for (const c of objectCandidates(cache, raw, slot, path)) {
            out[slot].push(c);
            consumed.add(c.path);
          }
        }
      } else {
        // Dotted alias: resolve inside this key's subtree.
        const sub = resolvePath(cache, obj[key], rest);
        if (sub) {
          const s = scalarValue(sub.value, slot);
          if (s !== null) {
            const path = pathPrefix
              ? `${pathPrefix}.${key}.${sub.path}`
              : `${key}.${sub.path}`;
            out[slot].push({ value: s, path });
            consumed.add(path);
          }
        }
      }
    }
  }
  return out;
}

/** One alias, pre-split: its slot and its lower-cased tail after segment 1. */
interface AliasRef {
  slot: Slot;
  /** Remaining dotted path (lower-cased), or `null` for a one-segment alias. */
  rest: string | null;
}

interface Resolved {
  aliasSets: Record<Slot, string[]>;
  /**
   * Lower-cased first alias segment to every alias starting with it, in
   * `SLOTS` order then alias order (the order candidates are collected in).
   */
  aliasIndex: Map<string, AliasRef[]>;
  prefer: Partial<Record<Slot, string>>;
  keyCache: KeyCache;
}

/** Merge default aliases with caller `aliases`/`nameKeys`/`textKeys`. */
function resolveAliases(opts: LocationObjectOptions): Resolved {
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

  const prefer: Partial<Record<Slot, string>> = {};
  for (const slot of SLOTS) {
    const p = opts.prefer?.[slot];
    if (!p) continue;
    const key = p.toLowerCase();
    const inAliases = aliasSets[slot].some((a) => a.toLowerCase() === key);
    const isLeaf = (OBJECT_LEAVES[slot] ?? []).some(
      (l) => l.toLowerCase() === key.split('.').pop(),
    );
    if (!inAliases && !isLeaf) {
      throw new Error(
        `location-object: prefer path '${p}' is not an alias or object leaf of '${slot}'`,
      );
    }
    prefer[slot] = p;
  }

  // Split every alias once per call, not once per (key x alias) pair.
  const aliasIndex = new Map<string, AliasRef[]>();
  for (const slot of SLOTS) {
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
  return { aliasSets, aliasIndex, prefer, keyCache: new WeakMap() };
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

/** Resolve one slot's candidates to a stored value (or leave unset). */
function resolveSlot(
  slot: Slot,
  candidates: Candidate[],
  prefer: Partial<Record<Slot, string>>,
  countryResolved: string | null,
): { value: string | null; consumedPaths: Set<string>; alternates: Candidate[] } {
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
  keep?: string[];
  drop?: string[];
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
    if (sv !== undefined) {
      Object.defineProperty(out, k, {
        value: sv,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (ctx.nodes >= ctx.limits.maxNodes) {
      // Every later key would be dropped anyway; stop walking them.
      if (i < keys.length - 1) ctx.omitted = true;
      break;
    }
  }
  seen.delete(v);
  return out;
}

/** Collect unclaimed fields of `obj` into extras, honouring keep/drop. */
function buildExtras(
  obj: Record<string, unknown>,
  pathPrefix: string,
  consumed: Set<string>,
  opts: LocationObjectOptions,
  keyCache: KeyCache,
  incomingExtras?: Record<string, unknown> | null,
): { extras: Record<string, unknown> | null; omitted: boolean } {
  const ctx: ExtrasCtx = {
    nodes: 0,
    limits: { ...DEFAULT_LIMITS, ...(opts.extrasLimits ?? {}) },
    keep: opts.keep,
    drop: opts.drop,
    omitted: false,
    keyCache,
  };
  const maxBytes = ctx.limits.maxBytes;
  const extras: Record<string, unknown> = {};
  // UTF-8 size of `JSON.stringify(extras)`, kept current as fields land
  // instead of re-serializing the whole object for every field (which was
  // quadratic in the number of keys).
  let size = 2; // '{}'
  /** UTF-8 size of each landed `"key":value` member, for overwrites. */
  const memberBytes = new Map<string, number>();
  /** Lower-cased landed keys, for the incoming-extras collision check. */
  const landedLower = new Set<string>();
  const addField = (key: string, value: unknown, relPath: string) => {
    if (consumed.has(relPath)) return;
    if (ctx.drop && pathListed(ctx.drop, relPath)) return;
    if (ctx.keep !== undefined) {
      if (ctx.keep.length === 0) return;
      if (!pathListed(ctx.keep, relPath)) return;
    }
    const sv = jsonSafe(value, 1, ctx, new Set());
    if (sv === undefined) return;
    // A JSON string takes at least its UTF-16 length + 2 quotes in UTF-8, so
    // an oversized string is rejected without serializing it.
    if (typeof sv === 'string' && size + sv.length + 2 > maxBytes) {
      ctx.omitted = true;
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(sv), 'utf8');
    if (size + bytes > maxBytes) {
      ctx.omitted = true;
      return;
    }
    const member = Buffer.byteLength(JSON.stringify(key), 'utf8') + 1 + bytes;
    const prev = memberBytes.get(key);
    // A new member also adds its ',' separator; an overwrite swaps sizes.
    size += prev === undefined ? member + (memberBytes.size > 0 ? 1 : 0) : member - prev;
    memberBytes.set(key, member);
    landedLower.add(normKey(key));
    Object.defineProperty(extras, key, {
      value: sv,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  // Every value serializes to at least one byte, so once the size reaches
  // the cap nothing else can land: stop walking the remaining keys.
  const full = (): boolean => size >= maxBytes;
  for (const key of ownKeys(keyCache, obj)) {
    if (full()) {
      ctx.omitted = true;
      break;
    }
    if (normKey(key) === 'extras' && isObject(obj[key])) {
      // Incoming extras flatten into output extras (never extras.extras);
      // raw fields win collisions.
      const incoming = obj[key] as Record<string, unknown>;
      for (const ek of ownKeys(keyCache, incoming)) {
        if (full()) break;
        const rel = pathPrefix ? `${pathPrefix}.${ek}` : ek;
        if (!landedLower.has(normKey(ek))) {
          addField(ek, incoming[ek], rel);
        }
      }
      continue;
    }
    const rel = pathPrefix ? `${pathPrefix}.${key}` : key;
    addField(key, obj[key], rel);
  }
  return { extras: memberBytes.size ? extras : null, omitted: ctx.omitted };
}

// ─── location mapping ────────────────────────────────────────────────

function mapOne(
  obj: Record<string, unknown>,
  resolved: Resolved,
  opts: LocationObjectOptions,
  depth: number,
): LocationDto | null {
  if (depth > MAX_ARRAY_DEPTH) return null;

  const collected = new Set<string>();
  const candidates = collectCandidates(obj, resolved, '', collected);

  // Resolve country first (state equivalence depends on it).
  const countryRes = resolveSlot('country', candidates.country, resolved.prefer, null);
  const countryResolved = countryRes.value
    ? comparisonKey('country', countryRes.value, null)
    : null;

  const values: Partial<Record<Slot, string | null>> = {};
  values.country = countryRes.value;
  // Only winner-group paths count as consumed — losing/conflicting
  // candidates stay unclaimed and land in extras.
  const consumedPaths = new Set<string>();
  for (const p of countryRes.consumedPaths) consumedPaths.add(p);
  const alternates: Record<string, unknown> = {};

  for (const slot of ['city', 'state', 'postalCode', 'streetAddress', 'name', 'text'] as Slot[]) {
    const res = resolveSlot(slot, candidates[slot], resolved.prefer, countryResolved);
    values[slot] = res.value;
    // unclaimed alternates survive in extras under the slot's source keys:
    // buildExtras copies every unconsumed leaf, so nothing to look up here
    for (const alt of res.alternates) {
      alternates[alt.path] = alt.value;
    }
    for (const p of res.consumedPaths) consumedPaths.add(p);
  }

  // Address descent: root slots win; address fills missing; conflicts → extras.
  for (const addrKey of ['address', 'postalAddress']) {
    const key = ownKey(resolved.keyCache, obj, addrKey);
    if (key === undefined) continue;
    const raw = obj[key];
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (s && values.streetAddress == null) {
        values.streetAddress = s;
        consumedPaths.add(key);
      }
      continue;
    }
    // Expand arrays into separate locations is handled by the caller via
    // `toLocationDtos` on the address node; here only a single address fills.
    const address = soleObject(raw);
    if (address) {
      const sub = collectCandidates(address, resolved, key, collected);
      let filledAny = false;
      for (const slot of SLOTS) {
        if (values[slot] == null && sub[slot].length) {
          const res = resolveSlot(slot, sub[slot], resolved.prefer, countryResolved);
          values[slot] = res.value;
          for (const p of res.consumedPaths) consumedPaths.add(p);
          filledAny = true;
        }
      }
      if (filledAny) consumedPaths.add(key);
    }
  }

  const meaningful =
    values.name || values.text || values.city || values.state ||
    values.country || values.streetAddress || values.postalCode;
  if (!meaningful) return null;

  const { extras } = buildExtras(obj, '', consumedPaths, opts, resolved.keyCache);

  const dto = new LocationDto({
    name: (values.name as string) ?? null,
    text: (values.text as string) ?? null,
    city: (values.city as string) ?? null,
    state: (values.state as string) ?? null,
    country: (values.country as string) ?? null,
    streetAddress: (values.streetAddress as string) ?? null,
    postalCode: (values.postalCode as string) ?? null,
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
    // Expand `address`/`postalAddress` arrays into sibling locations.
    const expanded: Record<string, unknown>[] = [input];
    for (const addrKey of ['address', 'postalAddress']) {
      const key = ownKey(resolved.keyCache, input, addrKey);
      if (key === undefined) continue;
      const raw = input[key];
      if (Array.isArray(raw) && raw.length > 1 && raw.some(isObject)) {
        expanded.length = 0;
        // Each clone copies the parent's (capped) keys, so clones x keys is
        // bounded by MAX_ADDRESS_EXPANSION x MAX_OBJECT_KEYS.
        const parentKeys = ownKeys(resolved.keyCache, input);
        for (const entry of raw) {
          if (!isObject(entry)) continue;
          if (expanded.length >= MAX_ADDRESS_EXPANSION) break;
          const clone: Record<string, unknown> = {};
          for (const k of parentKeys) {
            if (k !== key) clone[k] = input[k];
          }
          clone[key] = entry;
          expanded.push(clone);
        }
        break;
      }
    }
    for (const item of expanded) {
      if (out.length >= limit) return;
      const dto = mapOne(item, resolved, opts, depth);
      if (dto) out.push(dto);
    }
  }
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
        if (probe.length) {
          const seen = new Set<string>();
          return probe.filter((d) => {
            const k = dedupeKey(d);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
      }
    }
    return [];
  }

  const out: LocationDto[] = [];
  mapInput(selected, resolved, opts, out, 0, limit);
  const seen = new Set<string>();
  return out.filter((d) => {
    const k = dedupeKey(d);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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
