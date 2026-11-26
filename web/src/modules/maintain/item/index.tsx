// The item page: status, steps, numbered parts and the command box beside the GitHub side.
import type { FeatureModule } from "../../../registry/types";
import { lazyView } from "../../../registry/lazyView";
import { t } from "../../../../../src/i18n/index.ts";

const ItemView = lazyView(() => import("./views"), "ItemView");

// Mock builds only: the conversation on the fake stories, until the item page shows it.
const ChatPreview = import.meta.env.VITE_MOCK === "1" ? lazyView(() => import("./chat/ChatPreview"), "ChatPreview") : null;

export const maintainItemModule: FeatureModule = {
  id: "maintain-item",
  permission: "viewer",
  routes: [
    { path: "items/:repo/:number", view: { id: "maintain-item", title: t("Item"), phone: ItemView, panels: [{ id: "main", title: t("Item"), component: ItemView, defaultSize: 100 }] } },
    ...(ChatPreview ? [{ path: "chat-preview/:repo/:number", view: { id: "chat-preview", title: t("Conversation"), phone: ChatPreview, panels: [{ id: "main", title: t("Conversation"), component: ChatPreview, defaultSize: 100 }] } }] : []),
  ],
};
