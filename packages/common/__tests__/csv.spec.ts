import { toCsvCell } from '@ever-jobs/common';

describe('toCsvCell', () => {
  it('prefixes cells that a spreadsheet would run as a formula', () => {
    expect(toCsvCell('=1+1')).toBe("'=1+1");
    expect(toCsvCell('@x')).toBe("'@x");
    expect(toCsvCell('+x')).toBe("'+x");
    expect(toCsvCell('-x')).toBe("'-x");
    expect(toCsvCell('\tx')).toBe("'\tx");
  });

  it('prefixes and then quotes a formula that also needs quoting', () => {
    expect(toCsvCell('=HYPERLINK("x")')).toBe('"\'=HYPERLINK(""x"")"');
    expect(toCsvCell('\rx')).toBe('"\'\rx"');
  });

  it('quotes cells holding a comma, quote, newline or carriage return', () => {
    expect(toCsvCell('a,b')).toBe('"a,b"');
    expect(toCsvCell('a\rb')).toBe('"a\rb"');
    expect(toCsvCell('a\nb')).toBe('"a\nb"');
    expect(toCsvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('leaves plain text, numbers and booleans unchanged', () => {
    expect(toCsvCell('Software Engineer')).toBe('Software Engineer');
    expect(toCsvCell('a-b=c@d+e')).toBe('a-b=c@d+e');
    expect(toCsvCell(-5)).toBe('-5');
    expect(toCsvCell(120000.5)).toBe('120000.5');
    expect(toCsvCell(true)).toBe('true');
  });

  it('writes null, undefined and empty strings as an empty cell', () => {
    expect(toCsvCell(null)).toBe('');
    expect(toCsvCell(undefined)).toBe('');
    expect(toCsvCell('')).toBe('');
  });

  it('writes objects as JSON and dates as ISO strings', () => {
    expect(toCsvCell({ city: 'A' })).toBe('"{""city"":""A""}"');
    expect(toCsvCell(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
  });
});
