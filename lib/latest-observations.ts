const dublinFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Dublin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

const dublinParts = (timestamp: number) => {
  const parts = Object.fromEntries(
    dublinFormatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
};

const dublinOffsetMinutes = (timestamp: number) => {
  const parts = dublinParts(timestamp);
  return (Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - timestamp) / 60_000;
};

const parseDublinWallTime = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  notAfter: number | null = null
) => {
  if (![year, month, day, hour, minute, second].every(Number.isInteger)) return null;
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const wallTimestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const wallDate = new Date(wallTimestamp);
  if (
    wallDate.getUTCFullYear() !== year ||
    wallDate.getUTCMonth() !== month - 1 ||
    wallDate.getUTCDate() !== day ||
    wallDate.getUTCHours() !== hour ||
    wallDate.getUTCMinutes() !== minute ||
    wallDate.getUTCSeconds() !== second
  ) return null;

  const offsets = new Set([
    dublinOffsetMinutes(wallTimestamp - 86_400_000),
    dublinOffsetMinutes(wallTimestamp),
    dublinOffsetMinutes(wallTimestamp + 86_400_000)
  ]);
  const candidates = [...offsets]
    .map((offset) => wallTimestamp - offset * 60_000)
    .filter((candidate) => {
      const parts = dublinParts(candidate);
      return parts.year === year && parts.month === month && parts.day === day &&
        parts.hour === hour && parts.minute === minute && parts.second === second;
    })
    .sort((first, secondValue) => first - secondValue);
  const selected = Number.isFinite(notAfter)
    ? candidates.filter((candidate) => candidate <= notAfter!).at(-1)
    : candidates[0];
  return selected === undefined ? null : new Date(selected).toISOString();
};

export function parseIrelandLocalTimestamp(date: string, time: string, notAfter: number | null = null): string | null {
  const dateMatch = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(date ?? "").trim());
  const timeMatch = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(time ?? "").trim());
  if (!dateMatch || !timeMatch) return null;
  return parseDublinWallTime(
    Number(dateMatch[3]),
    Number(dateMatch[2]),
    Number(dateMatch[1]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
    Number(timeMatch[3] ?? "0"),
    notAfter
  );
}

const EIRGRID_MONTHS: Record<string, number> = {
  Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
  Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12
};

export function parseEirGridLocalTimestamp(value: string, notAfter: number | null = null): string | null {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const monthName = match[2][0].toUpperCase() + match[2].slice(1).toLowerCase();
  const month = EIRGRID_MONTHS[monthName];
  return month
    ? parseDublinWallTime(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6]), notAfter)
    : null;
}
