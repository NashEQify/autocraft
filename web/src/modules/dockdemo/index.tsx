// A demonstration of SideDock and its phone tabs, registered only in the mock build.
import type { FeatureModule } from "../../registry/types";
import { lazyView } from "../../registry/lazyView";

const DockDemoView = lazyView(() => import("./views"), "DockDemoView");

export const dockDemoModule: FeatureModule = {
  id: "dockdemo",
  permission: "viewer",
  routes: [{ path: "dock-demo", view: { id: "dock-demo", title: "Side dock", phone: DockDemoView, panels: [{ id: "main", title: "Side dock", component: DockDemoView, defaultSize: 100 }] } }],
};
