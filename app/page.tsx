import IrelandExperience from "../components/IrelandExperience";
import { createInitialSnapshot } from "../lib/initial-snapshot";

export default function Home() {
  return <IrelandExperience initialSnapshot={createInitialSnapshot()} />;
}
