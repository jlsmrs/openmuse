import assert from "node:assert/strict";
import test from "node:test";
import {
  calendarRange,
  isCompleteInstant,
  localDateTime,
  plusDays,
  startOfZonedDay,
  zonedInstant,
} from "../src/date-time.ts";

test("calendar time is rendered and entered in the selected named zone", () => {
  assert.deepEqual(localDateTime("2026-09-15T17:30:00Z", "America/Los_Angeles"), {
    date: "2026-09-15",
    time: "10:30",
  });
  assert.equal(
    zonedInstant("2026-09-15", "10:30", "America/Los_Angeles"),
    "2026-09-15T17:30:00.000Z",
  );
});
test("a zone crossing the UTC date boundary preserves the selected day", () => {
  assert.equal(zonedInstant("2026-09-15", "08:00", "Asia/Tokyo"), "2026-09-14T23:00:00.000Z");
});
test("invalid calendar dates and out-of-range times do not normalize silently", () => {
  assert.throws(() => zonedInstant("2026-02-31", "09:00", "UTC"));
  assert.throws(() => zonedInstant("2026-09-15", "25:00", "UTC"));
});
test("a daylight-saving gap cannot become a different appointment time", () => {
  assert.throws(() => zonedInstant("2026-03-08", "02:30", "America/Los_Angeles"), /does not exist/);
  assert.equal(
    zonedInstant("2026-03-08", "03:30", "America/Los_Angeles"),
    "2026-03-08T10:30:00.000Z",
  );
});

test("a day boundary clamps to the first existing local time instead of failing", () => {
  // America/Santiago springs forward 00:00→01:00 on 2026-09-06.
  assert.equal(startOfZonedDay("2026-09-06", "America/Santiago"), "2026-09-06T04:00:00.000Z");
  // Ordinary days still start exactly at midnight (Santiago is UTC-3 after the transition).
  assert.equal(startOfZonedDay("2026-09-07", "America/Santiago"), "2026-09-07T03:00:00.000Z");
  assert.equal(startOfZonedDay("2026-09-15", "UTC"), "2026-09-15T00:00:00.000Z");
});

test("partial native date edits never normalize from Date.parse", () => {
  for (const value of [
    "2026-09-1 09:00",
    "2026-09-15 09:0",
    "2026-09-15 09:00",
    "2026-09-15T09:00",
  ])
    assert.equal(isCompleteInstant(value), false);
  assert.equal(isCompleteInstant("2026-09-15T17:30:00.000Z"), true);
  assert.equal(isCompleteInstant("2026-09-15T10:30:00-07:00"), true);
});

test("plusDays shifts a calendar date by whole days", () => {
  assert.equal(plusDays("2026-11-13", 30), "2026-12-13");
  assert.equal(plusDays("2026-11-13", -7), "2026-11-06");
  assert.equal(plusDays("2026-12-31", 1), "2027-01-01");
});

test("the Next 30 days window is anchored at today, not the selected week", () => {
  const zone = "America/Chicago";
  const today = localDateTime(new Date().toISOString(), zone).date;
  const range = calendarRange("2026-11-20", zone, true);
  assert.equal(range.timeMin, startOfZonedDay(today, zone));
  assert.equal(range.timeMax, startOfZonedDay(plusDays(today, 30), zone));
  // A selected week date in the past or future must not move the window.
  assert.deepEqual(
    calendarRange("2026-01-05", zone, true),
    calendarRange("2026-12-25", zone, true),
  );
});

test("the single-day window stays on the selected day", () => {
  const range = calendarRange("2026-11-20", "America/Chicago", false);
  assert.equal(range.timeMin, startOfZonedDay("2026-11-20", "America/Chicago"));
  assert.equal(range.timeMax, startOfZonedDay("2026-11-21", "America/Chicago"));
});
