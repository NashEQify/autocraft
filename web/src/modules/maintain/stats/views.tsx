// Stats: what the pipeline got done, how main and the nightly checks stand, what it cost; the rest in folds.
// Maintainers and viewers see it as well as operators. Hosted views drop their own frame and heading (Embedded).
import type { ReactNode } from "react";
import { t } from "../../../../../src/i18n/index.ts";
import { Embedded } from "../../../ui/organisms/Page";
import { Fold } from "../../connect/Fold";
import { Overview } from "../../progress/views";
import { MainCiView } from "../../mainci/views";
import { NightlyView } from "../../nightly/views";
import { Cost } from "../../cost/views";
import { ActivityView } from "../../activity/views";
import { Classifiers } from "../../classifiers/views";
import { RatesView } from "../../rates/views";
import { AgentsView } from "../../agents/views";
import { Downloads } from "../../downloads/views";
import type { ViewProps } from "../../../registry/types";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Details({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-1">
      <Fold title={<span className="text-md font-semibold text-ink">{title}</span>}>
        <div className="pb-3">{children}</div>
      </Fold>
    </div>
  );
}

export function StatsView(props: ViewProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-6 px-4 pb-12 pt-5 md:px-6">
        <h1 className="text-xl font-semibold">{t("Stats")}</h1>
        <Embedded>
          <Section title={t("Merged and closed")}>
            <Overview {...props} />
          </Section>
          <Section title={t("Main CI")}>
            <MainCiView {...props} />
          </Section>
          <Section title={t("Nightly")}>
            <NightlyView />
          </Section>
          <Section title={t("Cost")}>
            <Cost {...props} />
          </Section>
          <div className="flex flex-col gap-2">
            <Details title={t("Activity")}>
              <ActivityView />
            </Details>
            <Details title={t("Classifiers")}>
              <Classifiers {...props} />
            </Details>
            <Details title={t("Rates and agents")}>
              <div className="flex flex-col gap-6">
                <RatesView />
                <AgentsView {...props} />
              </div>
            </Details>
            <Details title={t("Downloads")}>
              <Downloads {...props} />
            </Details>
          </div>
        </Embedded>
      </div>
    </div>
  );
}
