// The product IS the pitch — one headline, one sentence, one action. No
// marketing paragraphs before the flow starts.

export function StartScreen({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col justify-center px-6 py-10 sm:min-h-[calc(100dvh-4rem)]">
      <div className="mx-auto w-full max-w-md">
        <h1 className="text-[2.75rem] leading-[1.02] font-bold tracking-tight text-[var(--color-ink)] sm:text-6xl">
          Ta några bilder.
          <br />
          <span className="text-[var(--color-accent)]">Vi gör resten.</span>
        </h1>

        <p className="mt-6 max-w-sm text-lg leading-relaxed text-[var(--color-body)]">
          Loopa identifierar produkten, bedömer skicket och tar fram ett bra pris — du behöver bara ta bilderna.
        </p>

        <button
          type="button"
          onClick={onStart}
          className="mt-9 inline-flex w-full items-center justify-center rounded-full bg-[var(--color-accent)] px-8 py-4 text-lg font-semibold text-white transition-colors hover:bg-[var(--color-accent-dark)] sm:w-auto"
        >
          Börja sälja
        </button>

        <div className="mt-12 flex items-center gap-6 text-sm text-[var(--color-body)]">
          <span className="flex items-center gap-2">
            <Dot /> Foton
          </span>
          <span className="flex items-center gap-2">
            <Dot /> Pris
          </span>
          <span className="flex items-center gap-2">
            <Dot /> Annons
          </span>
        </div>
      </div>
    </div>
  )
}

function Dot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
}
