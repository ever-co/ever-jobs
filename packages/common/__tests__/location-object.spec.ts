import { toLocationDto, toLocationDtos } from '../src/utils/location-object';

describe('toLocationDtos — input shapes', () => {
  it('maps a flat object', () => {
    const out = toLocationDtos({ city: 'Berlin', state: 'BE', country: 'DE' });
    expect(out).toHaveLength(1);
    expect(out[0].city).toBe('Berlin');
    expect(out[0].state).toBe('BE');
    expect(out[0].country).toBe('DE');
  });

  it('maps an array of objects', () => {
    const out = toLocationDtos([{ city: 'Paris' }, { city: 'Lyon' }]);
    expect(out.map((l) => l.city)).toEqual(['Paris', 'Lyon']);
  });

  it('parses a direct string via parseLocationList', () => {
    const out = toLocationDtos('Austin, TX');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].city).toBe('Austin');
    expect(out[0].state).toBe('TX');
  });

  it('skips unusable entries and keeps source order', () => {
    const out = toLocationDtos([null, {}, { city: 'Berlin' }, { city: 'Paris' }]);
    expect(out.map((l) => l.city)).toEqual(['Berlin', 'Paris']);
  });

  it('toLocationDto returns the first usable result or null', () => {
    expect(toLocationDto([null, {}, { city: 'Berlin' }])?.city).toBe('Berlin');
    expect(toLocationDto([null, {}])).toBeNull();
    expect(toLocationDto(undefined)).toBeNull();
  });
});

describe('toLocationDtos — selection (opts.in)', () => {
  it('maps only the selected path, never the whole posting', () => {
    const posting = {
      title: 'Engineer',
      location: { city: 'Paris', office: { country: 'US' } },
    };
    const out = toLocationDtos(posting, { in: 'location' });
    expect(out).toHaveLength(1);
    // siblings under the selection do not merge geography
    expect(out[0].country).toBeNull();
  });

  it('ordered fallback paths: first yielding a usable location wins', () => {
    const posting = { PostingLocations: [{ city: 'Denver', state: 'CO' }] };
    const out = toLocationDtos(posting, {
      in: ['postingLocations', 'PostingLocations'],
    });
    expect(out).toHaveLength(1);
    expect(out[0].city).toBe('Denver');
  });

  it('returns [] when every selector fails', () => {
    expect(toLocationDtos({ city: 'Paris' }, { in: 'loc.address' })).toEqual([]);
  });

  it('never maps the whole posting as fallback', () => {
    const posting = { city: 'Paris', title: 'x' };
    expect(toLocationDtos(posting, { in: 'missing' })).toEqual([]);
  });
});

describe('toLocationDtos — address descent', () => {
  it('auto-descends into address/postalAddress to fill missing slots', () => {
    const out = toLocationDtos({
      name: 'HQ',
      address: { city: 'Austin', state: 'TX', country: 'US', streetAddress: '1 Main St' },
    });
    expect(out[0].name).toBe('HQ');
    expect(out[0].city).toBe('Austin');
    expect(out[0].streetAddress).toBe('1 Main St');
  });

  it('root slots win over address values', () => {
    const out = toLocationDtos({
      city: 'Boston',
      address: { city: 'Austin', state: 'TX' },
    });
    expect(out[0].city).toBe('Boston');
    expect(out[0].state).toBe('TX');
  });

  it('expands address arrays into separate locations', () => {
    const out = toLocationDtos({
      name: 'Offices',
      address: [{ city: 'Austin' }, { city: 'Denver' }],
    });
    expect(out.map((l) => l.city).sort()).toEqual(['Austin', 'Denver']);
  });

  it('a string address supplies streetAddress only', () => {
    const out = toLocationDtos({ city: 'X', address: '10 Downing St' });
    expect(out[0].streetAddress).toBe('10 Downing St');
    expect(out[0].city).toBe('X');
  });
});

describe('toLocationDtos — agreement and conflicts', () => {
  it('identical copies consume together', () => {
    const out = toLocationDtos({ city: 'Paris', City: 'Paris' });
    expect(out[0].city).toBe('Paris');
    expect(out[0].extras?.City).toBeUndefined();
  });

  it('case-variant conflict leaves slot unset without prefer', () => {
    const out = toLocationDtos({ city: 'Paris', City: 'Lyon', country: 'FR' });
    expect(out[0].city).toBeNull();
    expect(out[0].extras?.City).toBe('Lyon');
  });

  it('explicit prefer resolves the conflict', () => {
    const out = toLocationDtos(
      { city: 'Paris', City: 'Lyon', country: 'FR' },
      { prefer: { city: 'City' } },
    );
    expect(out[0].city).toBe('Lyon');
  });

  it('scalar canonical field wins over suffixed aliases', () => {
    const out = toLocationDtos({ city: 'Paris', cityName: 'Lyon' });
    expect(out[0].city).toBe('Paris');
  });

  it('two non-canonical aliases in conflict leave the slot unset', () => {
    const out = toLocationDtos({ town: 'Paris', cityName: 'Lyon', country: 'FR' });
    expect(out[0].city).toBeNull();
    expect(out[0].extras?.town).toBe('Paris');
  });

  it('object country picks the recognized full name, keeps residual extras', () => {
    const out = toLocationDtos({
      country: { alpha2Code: 'DE', name: 'Germany', id: '123' },
    });
    expect(out[0].country).toBe('Germany');
    expect((out[0].extras?.country as Record<string, unknown>)?.id).toBe('123');
  });

  it('state code/name agree without minting a US country', () => {
    const out = toLocationDtos({ stateCode: 'CA', stateName: 'California' });
    expect(out[0].state).toBe('California');
    expect(out[0].country).toBeNull();
  });

  it('conflicting object country leaves slot unset', () => {
    const out = toLocationDtos({
      country: { alpha2Code: 'DE', name: 'France' },
      city: 'Berlin',
    });
    expect(out[0].country).toBeNull();
    expect(out[0].city).toBe('Berlin');
  });
});

describe('toLocationDtos — coercion', () => {
  it('numeric postal zero survives', () => {
    const out = toLocationDtos({ postalCode: 0 });
    expect(out[0].postalCode).toBe('0');
  });

  it('booleans never become geography', () => {
    const out = toLocationDtos({ city: true, country: 'DE' });
    expect(out[0].city).toBeNull();
    expect(out[0].extras?.city).toBe(true);
  });

  it('whitespace-only strings are no value', () => {
    const out = toLocationDtos({ city: '  ', country: 'DE' });
    expect(out[0].city).toBeNull();
  });

  it('non-string/non-finite values land in extras', () => {
    const out = toLocationDtos({ city: { weird: 1 }, country: 'DE' });
    expect(out[0].city).toBeNull();
    expect(out[0].extras?.city).toBeDefined();
  });
});

describe('toLocationDtos — ambiguous keys route to extras', () => {
  it('officeName/siteName/descriptor/label/title have no default slot', () => {
    const out = toLocationDtos({
      officeName: 'The Hive',
      descriptor: 'Berlin, Germany',
      label: 'X',
      city: 'Berlin',
    });
    expect(out[0].name).toBeNull();
    expect(out[0].text).toBeNull();
    expect(out[0].extras?.officeName).toBe('The Hive');
    expect(out[0].extras?.descriptor).toBe('Berlin, Germany');
  });

  it('locationName maps to text (observed geo label)', () => {
    const out = toLocationDtos({ locationName: 'Austin, TX' });
    expect(out[0].text).toBe('Austin, TX');
  });

  it('nameKeys/textKeys assign ambiguous keys explicitly', () => {
    const out = toLocationDtos(
      { descriptor: 'Downtown Office' },
      { nameKeys: ['descriptor'] },
    );
    expect(out[0].name).toBe('Downtown Office');
    expect(out[0].extras?.descriptor).toBeUndefined();
  });

  it('assigning one path to two slots throws', () => {
    expect(() =>
      toLocationDtos({ name: 'x' }, { nameKeys: ['label'], textKeys: ['label'] }),
    ).toThrow();
  });
});

describe('toLocationDtos — extras', () => {
  it('carry-all default: unclaimed fields land in extras', () => {
    const out = toLocationDtos({
      city: 'Berlin',
      coordinates: { lat: 52, lng: 13 },
      locationId: 'loc-9',
    });
    expect((out[0].extras?.coordinates as { lat: number }).lat).toBe(52);
    expect(out[0].extras?.locationId).toBe('loc-9');
  });

  it('keep:[] carries nothing', () => {
    const out = toLocationDtos({ city: 'X', junk: 1 }, { keep: [] });
    expect(out[0].extras ?? null).toBeNull();
  });

  it('keep whitelist filters residuals; drop wins over keep', () => {
    const out = toLocationDtos(
      { city: 'X', a: 1, b: 2, 'c.deep': undefined },
      { keep: ['a', 'b'], drop: ['b'] },
    );
    expect(out[0].extras?.a).toBe(1);
    expect(out[0].extras?.b).toBeUndefined();
  });

  it('extras alone never create a location', () => {
    expect(toLocationDtos({ locationId: 'x', locationType: 'y' })).toEqual([]);
  });

  it('incoming extras flatten, raw keys win collisions', () => {
    const out = toLocationDtos({
      city: 'X',
      extras: { locationId: 'old', other: 1 },
      locationId: 'new',
    });
    expect(out[0].extras?.locationId).toBe('new');
    expect(out[0].extras?.other).toBe(1);
    expect(out[0].extras?.extras).toBeUndefined();
  });

  it('extras survive a JSON round-trip', () => {
    const dto = toLocationDto({ city: 'X', coordinates: { lat: 1 } });
    const revived = JSON.parse(JSON.stringify(dto));
    expect(revived.extras.coordinates.lat).toBe(1);
  });
});

describe('toLocationDtos — dedup', () => {
  it('collapses exact-duplicate mapped DTOs', () => {
    const out = toLocationDtos([{ city: 'Berlin' }, { city: 'Berlin' }]);
    expect(out).toHaveLength(1);
  });

  it('keeps same-field sites with distinct extras separate', () => {
    const out = toLocationDtos([
      { city: 'Berlin', locationId: '1' },
      { city: 'Berlin', locationId: '2' },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('toLocationDtos — street/postal-only results', () => {
  it('street-only and postal-only entries survive', () => {
    const out = toLocationDtos([
      { streetAddress: '1 Main St' },
      { postalCode: '78701' },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('toLocationDtos: work bounds (fork-sync hardening)', () => {
  const junkKeys = (n: number, prefix = 'junk'): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) o[`${prefix}${i}`] = 'x'.repeat(30);
    return o;
  };
  const addresses = (n: number, keysEach = 0) =>
    Array.from({ length: n }, (_, i) => ({ addressLocality: `c${i}`, ...junkKeys(keysEach, 'k') }));
  // Generous bounds: the uncapped mapper took ~8 s on the 300 x 300 shape
  // and ~94 s on a 35 KiB JSON-LD page; slow CI CPUs must never flake here.
  const BOUND_MS = 2000;

  it('maps a 300 x 300 nested-address object (address key first) quickly', () => {
    const input = JSON.parse(JSON.stringify({ address: addresses(300, 300), ...junkKeys(300) }));
    let started = Date.now();
    const all = toLocationDtos(input);
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
    // expansion is capped: 199 other parent keys (the first 200 keys read,
    // minus `address`) allow floor(400 / 199) = 2 clones
    expect(all.map((l) => l.city)).toEqual(['c0', 'c1']);
    started = Date.now();
    const first = toLocationDto(input, { prefer: { country: 'addressCountry.name' } });
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
    expect(first?.city).toBe('c0');
  });

  it('maps the reported 300 x 300 shape (junk keys first, address last) quickly', () => {
    const input = JSON.parse(JSON.stringify({ ...junkKeys(300), address: addresses(300) }));
    const started = Date.now();
    toLocationDtos(input);
    toLocationDto(input);
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
  });

  it('expands at most 20 address entries and skips non-objects without counting them', () => {
    const out = toLocationDtos({
      name: 'Offices',
      address: ['skip', null, ...addresses(25)],
    });
    expect(out).toHaveLength(20);
    expect(out[19].city).toBe('c19');
  });

  it('reads at most the first 200 keys of an object', () => {
    const within = { ...junkKeys(199), city: 'Berlin' };
    expect(toLocationDto(within)?.city).toBe('Berlin');
    const past = { ...junkKeys(200), city: 'Berlin' };
    expect(toLocationDto(past)).toBeNull();
  });

  it('keeps extras within maxBytes and still lands later small fields', () => {
    const out = toLocationDto(
      { city: 'X', a: 'aaaa', b: 'b'.repeat(24), c: 1 },
      { extrasLimits: { maxBytes: 30 } },
    );
    // '{"a":"aaaa"}' is 12 bytes; "b" (26 bytes) would overflow 30; 1 fits.
    expect(out?.extras).toEqual({ a: 'aaaa', c: 1 });
  });

  it('caps the serialized extras of a large object at the default 4 KiB', () => {
    const input: Record<string, unknown> = { city: 'Berlin', ...junkKeys(190) };
    const started = Date.now();
    const out = toLocationDto(input);
    expect(Date.now() - started).toBeLessThan(BOUND_MS);
    const bytes = Buffer.byteLength(JSON.stringify(out?.extras), 'utf8');
    expect(bytes).toBeLessThanOrEqual(4096);
    expect(bytes).toBeGreaterThan(4096 - 40);
  });

  it('toLocationDto matches the first toLocationDtos result', () => {
    const input = { name: 'HQ', locationId: 'L1', address: addresses(5, 3) };
    expect(toLocationDto(input)).toEqual(toLocationDtos(input)[0]);
    expect(toLocationDto(input, { in: 'address' })).toEqual(
      toLocationDtos(input, { in: 'address' })[0],
    );
  });
});

describe('toLocationDtos: per-call and per-clone cost (fork-sync hardening)', () => {
  const junkKeys = (n: number, prefix = 'junk'): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) o[`${prefix}${i}`] = 'x'.repeat(30);
    return o;
  };
  const cities = (n: number) => Array.from({ length: n }, (_, i) => ({ city: `c${i}` }));

  it('builds the alias tables once per configuration, not on every call', () => {
    // Every call used to split all ~60 default aliases (plus the custom ones
    // and the prefer path) again: ~55 us per call even for an empty object.
    toLocationDto({}, { aliases: { state: ['region'] } }); // first use builds it
    const split = jest.spyOn(String.prototype, 'split');
    try {
      for (let i = 0; i < 100; i++) {
        toLocationDto({}, { prefer: { country: 'addressCountry.name' } });
        toLocationDto({}, { aliases: { state: ['region'] } });
        toLocationDtos([{}, {}], { textKeys: [], nameKeys: [] });
      }
      expect(split).not.toHaveBeenCalled();
    } finally {
      split.mockRestore();
    }
  });

  it('keeps custom alias configurations apart and still validates them per call', () => {
    const input = { region: 'Bavaria', city: 'Munich' };
    expect(toLocationDto(input, { aliases: { state: ['region'] } })?.state).toBe('Bavaria');
    expect(toLocationDto({ region: 'Bavaria' }, { aliases: { city: ['region'] } })?.city).toBe(
      'Bavaria',
    );
    expect(toLocationDto(input, { textKeys: ['region'] })?.text).toBe('Bavaria');
    // the defaults are untouched by earlier custom calls
    const plain = toLocationDto(input);
    expect(plain?.state).toBeNull();
    expect(plain?.extras).toEqual({ region: 'Bavaria' });
    // a conflicting configuration is never cached: it throws every time
    for (let i = 0; i < 2; i++) {
      expect(() => toLocationDto(input, { aliases: { city: ['spot'], state: ['spot'] } })).toThrow(
        /assigned to both/,
      );
    }
    expect(() => toLocationDto(input, { prefer: { city: 'region' } })).toThrow(/prefer path/);
    expect(toLocationDto(input, { aliases: { city: ['region'] }, prefer: { city: 'region' } })?.city).toBe(
      'Bavaria',
    );
  });

  it("walks each parent value once, however many address clones carry it", () => {
    let reads = 0;
    const info = new Proxy(
      { a: 1, b: [2, 3] },
      {
        get(target, prop, receiver) {
          if (prop === 'a') reads++;
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const out = toLocationDtos({ info, label: 'x', address: cities(20) });
    expect(out.map((l) => l.city)).toEqual(cities(20).map((c) => c.city));
    // every clone used to re-walk (and re-serialize) the parent's fields
    expect(reads).toBe(1);
    expect(out[0].extras).toEqual({ info: { a: 1, b: [2, 3] }, label: 'x' });
    // every DTO still owns its extras
    expect(out[19].extras).toEqual(out[0].extras);
    expect(out[19].extras?.info).not.toBe(out[0].extras?.info);
    expect(out[19].extras).not.toBe(out[0].extras);
  });

  it.each([
    ['defaults', {}],
    ['prefer', { prefer: { country: 'addressCountry.name' } }],
    ['alias rooted at the address key', { aliases: { city: ['address.city'] } }],
    ['keep/drop and small limits', { drop: ['junk'], extrasLimits: { maxBytes: 120, maxNodes: 6 } }],
  ])('maps an address clone exactly like the clone object itself (%s)', (_label, opts) => {
    const entries = [
      { city: 'Lyon' },
      { addressLocality: 'Paris', zip: '75001', geo: { lat: 1, lng: [2, 3] } },
      { junk: 1 },
      { addressCountry: 'DE' },
    ];
    const parent: Record<string, unknown> = {
      name: 'HQ',
      locationId: 'L1',
      junk: 'j',
      extras: { site: 'S1', name: 'shadowed' },
      postalAddress: { country: 'FR', city: 'Nice', postalCode: '06000' },
      meta: { tags: ['a', 'b'], deep: { x: 1 } },
    };
    // A later same-named key is read before the expanded one in a clone.
    const withStreet = { ...parent, address: '1 Main St' };
    for (const rest of [parent, withStreet]) {
      const input = { Address: entries, ...rest };
      // What expansion means: one object per entry, holding every other key
      // and the expanded key (moved last) with that entry.
      const clones = entries.map((entry) => ({ ...rest, Address: entry }));
      expect(JSON.stringify(toLocationDtos(input, opts))).toBe(
        JSON.stringify(toLocationDtos(clones, opts)),
      );
      expect(JSON.stringify(toLocationDto(input, opts))).toBe(
        JSON.stringify(toLocationDto(clones, opts)),
      );
    }
  });

  it('expands fewer entries the more fields every clone has to carry', () => {
    // clones x fields <= 400, at most 20 clones and at least one
    expect(toLocationDtos({ name: 'HQ', ...junkKeys(19), address: cities(25) })).toHaveLength(20);
    expect(toLocationDtos({ ...junkKeys(39), address: cities(20) })).toHaveLength(10);
    // incoming extras keys count as fields too
    expect(
      toLocationDtos({ name: 'HQ', extras: junkKeys(99, 'e'), address: cities(20) }),
    ).toHaveLength(4);
    expect(toLocationDtos({ ...junkKeys(199), address: cities(20) })).toHaveLength(2);
    const huge = { address: cities(20), extras: junkKeys(200, 'e'), extras2: 1, Extras: junkKeys(200, 'f') };
    expect(toLocationDtos(huge)).toHaveLength(1);
  });

  it('maps 100 parents of 199 keys x 20 addresses quickly', () => {
    // The reported shape: 222 KiB, ~3.8 s (21 s before the first caps); a
    // few hundred ms now. Generous bound so slow CI CPUs never flake; the
    // expansion count below is the exact check.
    const parent = (): Record<string, unknown> => {
      const o: Record<string, unknown> = {};
      for (let i = 0; i < 199; i++) o[`k${i}`] = i;
      o.address = cities(20);
      return o;
    };
    const input = JSON.parse(JSON.stringify(Array.from({ length: 100 }, parent)));
    const started = Date.now();
    const out = toLocationDtos(input);
    expect(Date.now() - started).toBeLessThan(2000);
    // identical parents dedupe; each expands floor(400 / 199) = 2 entries
    expect(out.map((l) => l.city)).toEqual(['c0', 'c1']);
  });
});

describe('toLocationDtos — parseTextFallback', () => {
  it('parses selected text into missing slots without overwriting', () => {
    const out = toLocationDtos(
      { text: 'Austin, TX', city: 'Austin' },
      { parseTextFallback: true },
    );
    expect(out[0].city).toBe('Austin');
    expect(out[0].state).toBe('TX');
  });

  it('rejects all inferred fields on any conflict', () => {
    const out = toLocationDtos(
      { text: 'Austin, TX', state: 'CA' },
      { parseTextFallback: true },
    );
    expect(out[0].state).toBe('CA');
    expect(out[0].city).toBeNull();
  });
});
