import { createContext, useContext, type ReactNode } from "react";

const EmbeddedContext = createContext(false);

/** Inside it, pages drop their own scroll frame and heading, so a page can host another page's view in a fold. */
export function Embedded({ children }: { children: ReactNode }) {
  return <EmbeddedContext.Provider value>{children}</EmbeddedContext.Provider>;
}

export const useEmbedded = () => useContext(EmbeddedContext);

/** Scrolling page body with the app's content width; `wide` for boards that need more room. */
export function PageFrame({ children, wide, className }: { children: ReactNode; wide?: boolean; className?: string }) {
  if (useEmbedded()) return <div className={className}>{children}</div>;
  return (
    <div className="h-full overflow-y-auto">
      <div className={`${wide ? "mx-auto max-w-[1680px]" : "mx-auto max-w-[1180px]"} px-4 pb-12 pt-5 md:px-6 ${className ?? ""}`}>{children}</div>
    </div>
  );
}

/** The page heading; a hosted view's heading is only for screen readers, its host names it. */
export function PageTitle({ children }: { children: ReactNode }) {
  return useEmbedded() ? <h3 className="sr-only">{children}</h3> : <h1 className="text-xl font-semibold">{children}</h1>;
}

export function Page({ title, sub, children, wide }: { title: string; sub?: ReactNode; children: ReactNode; wide?: boolean }) {
  const embedded = useEmbedded();
  return (
    <PageFrame wide={wide}>
      {embedded ? (
        <h3 className="sr-only">{title}</h3>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h1 className="text-xl font-semibold">{title}</h1>
          {sub && <span className="text-sm text-ink/55">{sub}</span>}
        </div>
      )}
      {children}
    </PageFrame>
  );
}
