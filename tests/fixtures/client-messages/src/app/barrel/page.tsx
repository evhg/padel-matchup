import { ByAlias } from "../../components/ByAlias";
import { ByBarrel } from "../../components/ByBarrel";
import { ByMessages } from "../../components/ByMessages";
import { ByNamespace } from "../../components/ByNamespace";

export default function Page() {
  return (
    <main>
      <ByBarrel />
      <ByAlias />
      <ByNamespace />
      <ByMessages />
    </main>
  );
}
