// Sample-mode Jev fixture facts are stamped with the date they were checked
// against the aquarium's public pages, and go stale after a fixed window so
// sample mode warns instead of deciding on old facts.
import assert from "node:assert/strict";
import test from "node:test";
import {
  AQUARIUM_FIXTURE_STALE_DAYS,
  aquariumFixtureCheckedAt,
  aquariumFixtureFreshness,
} from "../apps/server/src/demo/jev-fixture.ts";

test("the aquarium fixture is stamped with its checked date", () => {
  assert.equal(aquariumFixtureCheckedAt, "2026-09-23");
  assert.equal(AQUARIUM_FIXTURE_STALE_DAYS, 90);
});

test("fixture freshness is fresh at the check date and stale past the window", () => {
  const atCheck = aquariumFixtureFreshness(new Date("2026-09-23T12:00:00Z"));
  assert.equal(atCheck.checkedAt, "2026-09-23");
  assert.equal(atCheck.ageDays, 0);
  assert.equal(atCheck.stale, false);
  const aMonthLater = aquariumFixtureFreshness(new Date("2026-10-23T12:00:00Z"));
  assert.equal(aMonthLater.ageDays, 30);
  assert.equal(aMonthLater.stale, false);
  const pastWindow = aquariumFixtureFreshness(new Date("2026-12-23T12:00:00Z"));
  assert.equal(pastWindow.ageDays, 91);
  assert.equal(pastWindow.stale, true);
});
