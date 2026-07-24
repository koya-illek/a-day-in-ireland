import { getLiveSnapshot } from "../lib/live-data";
import IrelandExperience from "../components/IrelandExperience";

export const revalidate = 300;

export default async function Home() {
  const snapshot = await getLiveSnapshot();
  return <IrelandExperience initialSnapshot={snapshot} />;
}
