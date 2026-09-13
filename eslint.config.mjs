import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
const config = [
  { ignores: [".next/**", ".open-next/**", "out/**", "dist/**", ".wrangler/**", "test-results/**", "playwright-report/**", "next-env.d.ts"] },
  ...nextVitals,
  ...nextTypescript,
  // Next 16 adds these diagnostics to existing, non-compiler components.
  // Keep them visible while migrating without changing their state lifecycles.
  {
    files: ["components/HistoryControls.tsx", "components/MapLayers.tsx", "components/MapPanels.tsx", "components/atlas/AtlasFrame.tsx"],
    rules: { "react-hooks/set-state-in-effect": "warn" }
  },
  {
    files: ["components/MapPanels.tsx", "components/atlas/AtlasFrame.tsx"],
    rules: { "react-hooks/refs": "warn" }
  }
];

export default config;
