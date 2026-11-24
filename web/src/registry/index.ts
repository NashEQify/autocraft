// The lists of feature modules: the classic dashboard's, and the new dashboard's for users with `ui_v2` on. Adding a feature
// means adding its module here; the shell builds routes, panels and shortcut help from these declarations.
import type { FeatureModule } from "./types";
import { setListPages } from "../api/scope";
import { needsModule } from "../modules/needs";
import { flowModule } from "../modules/flow";
import { nowModule } from "../modules/now";
import { itemModule } from "../modules/item";
import { progressModule } from "../modules/progress";
import { itemsModule } from "../modules/items";
import { classifiersModule } from "../modules/classifiers";
import { costModule } from "../modules/cost";
import { downloadsModule } from "../modules/downloads";
import { adminHubModule } from "../modules/admin/v2";
import { accessModule, auditModule, contributorsModule, githubAppModule, discordModule, reposModule } from "../modules/admin";
import { aboutModule } from "../modules/about";
import { connectModule } from "../modules/connect";
import { pipelineModule } from "../modules/pipeline";
import { promptsModule } from "../modules/prompts";
import { accountsModule } from "../modules/accounts";
import { inferenceModule } from "../modules/inference";
import { agentsModule } from "../modules/agents";
import { envsModule } from "../modules/envs";
import { workspacesModule } from "../modules/workspaces";
import { ratesModule } from "../modules/rates";
import { nextModule } from "../modules/next";
import { similarModule } from "../modules/similar";
import { mainCiModule } from "../modules/mainci";
import { nightlyModule } from "../modules/nightly";
import { stuckModule } from "../modules/stuck";
import { activityModule } from "../modules/activity";
import { batchModule } from "../modules/batch";
import { securityModule } from "../modules/security";
import { homeModule } from "../modules/home";
import { hubModule } from "../modules/hub";
import { maintainHomeModule } from "../modules/maintain/home";
import { helpModule } from "../modules/help";

export const classicModules: FeatureModule[] = [homeModule, hubModule, nowModule, flowModule, needsModule, nextModule, agentsModule, envsModule, workspacesModule, ratesModule, itemModule, progressModule, itemsModule, activityModule, contributorsModule, classifiersModule, costModule, downloadsModule, reposModule, accessModule, githubAppModule, discordModule, auditModule, aboutModule, connectModule, pipelineModule, promptsModule, similarModule, accountsModule, inferenceModule, mainCiModule, nightlyModule, stuckModule, batchModule, securityModule];

/** The new dashboard: its own Home; the classic views serve the pages the new dashboard has not replaced yet. */
export const v2Modules: FeatureModule[] = [maintainHomeModule, helpModule, adminHubModule, ...classicModules.filter((m) => m !== homeModule && m !== githubAppModule && m !== discordModule)];

/** Every module of either dashboard, for preloading code. */
export const allModules: FeatureModule[] = [...new Set([...classicModules, ...v2Modules])];

/** The signed-in user's list; selectModules sets it before the app renders. */
export let modules: FeatureModule[] = classicModules;

/** Picks the module list by the user's `ui_v2` switch. */
export function selectModules(uiV2: boolean): FeatureModule[] {
  modules = uiV2 ? v2Modules : classicModules;
  setListPages(modules.flatMap((m) => m.routes.filter((r) => r.scoped).map((r) => r.path)));
  return modules;
}

selectModules(false);
