/** Fictional mailbox story and sample-only candidate copy for the Jev recording. */
export const schoolTripFixture = {
  school: "Lincoln Middle School (fictional local sample)",
  sender: "Ms. Rivera (fictional local sample)",
  searchQuery: "aquarium",
  choices: [
    { id: "permission-slip", label: "Complete permission slip", details: [], sources: [] },
    { id: "trip-details", label: "Review trip details", details: [], sources: [] },
    { id: "explore-exhibits", label: "Explore exhibits", details: [], sources: [] },
  ],
} as const;

// Facts checked against the aquarium's public exhibit pages on 2026-09-23.
// These records make sample decisions repeatable; they do not represent a live Jev response.
export const aquariumFixtureCheckedAt = "2026-09-23";

/** Exhibit facts go stale when the aquarium's pages change: past this many
 * days since the last check, sample mode warns instead of deciding quietly. */
export const AQUARIUM_FIXTURE_STALE_DAYS = 90;

/** Freshness of the aquarium fixture facts against a date (default now):
 * the checked date, the age in whole days, and whether a re-check is due. */
export function aquariumFixtureFreshness(now: Date = new Date()): {
  checkedAt: string;
  ageDays: number;
  stale: boolean;
} {
  const ageDays = Math.floor(
    (now.getTime() - new Date(`${aquariumFixtureCheckedAt}T00:00:00Z`).getTime()) / 86_400_000,
  );
  return {
    checkedAt: aquariumFixtureCheckedAt,
    ageDays,
    stale: ageDays > AQUARIUM_FIXTURE_STALE_DAYS,
  };
}
export const aquariumFixture = {
  indexUrl: "https://www.montereybayaquarium.org/visit/exhibits",
  options: [
    {
      id: "kelp-forest",
      label: "Kelp Forest",
      details: ["See a 28-foot-tall kelp exhibit with sardines, leopard sharks, and other fish."],
      sources: [
        {
          title: "Monterey Bay Aquarium · Kelp Forest",
          url: "https://www.montereybayaquarium.org/visit/exhibits/kelp-forest/",
        },
      ],
    },
    {
      id: "open-sea",
      label: "Open Sea",
      details: ["Watch turtles, sardines, and tuna through the aquarium's 90-foot viewing window."],
      sources: [
        {
          title: "Monterey Bay Aquarium · Open Sea",
          url: "https://www.montereybayaquarium.org/visit/exhibits/open-sea/",
        },
      ],
    },
    {
      id: "rocky-shore",
      label: "Rocky Shore",
      details: ["Touch and interact with bat rays in the touch pool."],
      sources: [
        {
          title: "Monterey Bay Aquarium · Rocky Shore",
          url: "https://www.montereybayaquarium.org/visit/exhibits/rocky-shore",
        },
      ],
    },
  ],
} as const;
