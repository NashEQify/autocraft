import { createContext, useContext, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftIcon } from "@phosphor-icons/react";

/** A host page (the Admin pages) sets the heading of the page below it and a link back to its index. */
export const PageFrame = createContext<{ title: string; back: { to: string; label: string } } | null>(null);

/** Scrolling page body with the app's content width; `wide` for boards that need more room. */
export function Page({ title, sub, children, wide }: { title: string; sub?: ReactNode; children: ReactNode; wide?: boolean }) {
  const frame = useContext(PageFrame);
  return (
    <div className="h-full overflow-y-auto">
      <div className={wide ? "mx-auto max-w-[1680px] px-4 pb-12 pt-5 md:px-6" : "mx-auto max-w-[1180px] px-4 pb-12 pt-5 md:px-6"}>
        {frame && (
          <Link to={frame.back.to} className="mb-2 inline-flex h-11 items-center gap-1.5 rounded text-sm text-ink/70 hover:text-ink md:h-9">
            <ArrowLeftIcon aria-hidden /> {frame.back.label}
          </Link>
        )}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h1 className="text-xl font-semibold">{frame?.title ?? title}</h1>
          {sub && <span className="text-sm text-ink/55">{sub}</span>}
        </div>
        {children}
      </div>
    </div>
  );
}
