import { createFixtureProvider } from "../../../integration/fixtureProvider.ts";
import { createHttpProvider } from "../../../integration/httpProvider.ts";
import { hasScenario } from "../../../states/scenarios.ts";
export const isFixture =
  import.meta.env.VITE_DATA_MODE === "fixture" ||
  (import.meta.env.DEV && import.meta.env.VITE_DATA_MODE !== "http");
const requested = new URLSearchParams(window.location.search).get("s");
export const scenarioId =
  requested && hasScenario(requested) ? requested : "normal";
export const provider = isFixture
  ? createFixtureProvider({ scenarioId })
  : createHttpProvider();
