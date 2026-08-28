import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CategorySelector } from '../../components/CategorySelector'
import { getCategoryLabel } from '../brands/data'
import { useLanguage } from '../../i18n/LanguageContext'
import type { Language } from '../../i18n/LanguageContext'
import type { Dictionary } from '../../i18n/dictionary'
import { generateListing, filesToUploadedImages, GenerateListingError } from './generateListingClient'
import type { GeneratedListingResult, GenerationMode, UploadedImage } from './schema'

type FlowStep = 'mode' | 'input' | 'website' | 'loading' | 'result'
type GeneratorText = Dictionary['secondhandPage']['generator']
/** This professional generator only ever handles furniture/fashion — 'seller' is the consumer product's own mode, driven entirely by SellerFlow instead. */
type ProfessionalMode = Extract<GenerationMode, 'furniture' | 'fashion'>

const IMAGE_LIMITS: Record<ProfessionalMode, { min: number; max: number }> = {
  furniture: { min: 2, max: 6 },
  fashion: { min: 2, max: 8 },
}

const LABEL_MAX = 4

const STEP_INTERVAL_MS = 3200

function sek(value: number, language: Language): string {
  const nf = new Intl.NumberFormat(language === 'en' ? 'en-US' : 'sv-SE')
  return language === 'en' ? `${nf.format(Math.round(value))} SEK` : `${nf.format(Math.round(value))} kr`
}

function useObjectUrls(files: File[]): string[] {
  const [urls, setUrls] = useState<string[]>([])
  useEffect(() => {
    const next = files.map((f) => URL.createObjectURL(f))
    setUrls(next)
    return () => next.forEach((u) => URL.revokeObjectURL(u))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files])
  return urls
}

/** True once a generation run has been in flight for `afterMs` — used to switch to an honest "still working" message on long grounded-research runs instead of silently cycling the same steps. */
function useSlowPhase(active: boolean, afterMs: number) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!active) {
      setSlow(false)
      return
    }
    const id = setTimeout(() => setSlow(true), afterMs)
    return () => clearTimeout(id)
  }, [active, afterMs])
  return slow
}

function useLoadingSteps(active: boolean, stepCount: number) {
  const [stepIndex, setStepIndex] = useState(0)
  useEffect(() => {
    if (!active) {
      setStepIndex(0)
      return
    }
    const id = setInterval(() => {
      setStepIndex((i) => Math.min(i + 1, stepCount - 1))
    }, STEP_INTERVAL_MS)
    return () => clearInterval(id)
  }, [active, stepCount])
  return stepIndex
}

export function RealGenerator() {
  const { t, language } = useLanguage()
  const g = t.secondhandPage.generator
  const [flow, setFlow] = useState<FlowStep>('mode')
  const [mode, setMode] = useState<ProfessionalMode>('furniture')
  const [brand, setBrand] = useState('')
  const [modelText, setModelText] = useState('')
  const [styleCode, setStyleCode] = useState('')
  const [sizeText, setSizeText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [labelFiles, setLabelFiles] = useState<File[]>([])
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<GeneratedListingResult | null>(null)
  const previewUrls = useObjectUrls(files)
  const labelPreviewUrls = useObjectUrls(labelFiles)
  const loadingSteps = g.loading.steps[mode]
  const stepIndex = useLoadingSteps(flow === 'loading', loadingSteps.length)
  const slowPhase = useSlowPhase(flow === 'loading', 65_000)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const labelInputRef = useRef<HTMLInputElement>(null)
  const limits = IMAGE_LIMITS[mode]

  function resetAll() {
    setFlow('mode')
    setMode('furniture')
    setBrand('')
    setModelText('')
    setStyleCode('')
    setSizeText('')
    setFiles([])
    setLabelFiles([])
    setWebsiteUrl('')
    setError(null)
    setResult(null)
  }

  function addFiles(list: FileList | null) {
    if (!list) return
    const incoming = Array.from(list).filter((f) => f.type.startsWith('image/'))
    setFiles((prev) => [...prev, ...incoming].slice(0, limits.max))
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  function addLabelFiles(list: FileList | null) {
    if (!list) return
    const incoming = Array.from(list).filter((f) => f.type.startsWith('image/'))
    setLabelFiles((prev) => [...prev, ...incoming].slice(0, LABEL_MAX))
  }

  function removeLabelFile(idx: number) {
    setLabelFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  async function handleGenerate() {
    setError(null)
    setFlow('loading')
    try {
      const { images, failedCount } = await filesToUploadedImages([...files, ...labelFiles])
      if (images.length === 0) throw new GenerateListingError(g.errors.imagesUnreadable)
      const input: { mode: GenerationMode; brand?: string; model?: string; styleCode?: string; size?: string; images: UploadedImage[]; websiteUrl?: string } = {
        mode,
        images,
      }
      if (mode === 'furniture') {
        input.brand = brand.trim()
        input.model = modelText.trim()
      } else {
        // Fashion: all optional, but user-typed values are treated as truth by
        // the backend and dramatically improve identification (style codes
        // often identify the exact original product).
        if (brand.trim()) input.brand = brand.trim()
        if (styleCode.trim()) input.styleCode = styleCode.trim()
        if (sizeText.trim()) input.size = sizeText.trim()
      }
      if (websiteUrl.trim()) input.websiteUrl = websiteUrl.trim()
      const generated = await generateListing(input, {
        unexpectedServer: g.errors.unexpectedServer,
        genericFailed: g.errors.genericFailedWithStatus,
      })
      if (failedCount > 0) {
        generated.missingNotes.push(g.errors.imagesExcludedNote(failedCount))
      }
      setResult(generated)
      setFlow('result')
    } catch (err) {
      setError(err instanceof GenerateListingError ? err.message : g.errors.genericFailed)
      setFlow('website')
    }
  }

  const canProceedFromInput =
    files.length >= limits.min && files.length <= limits.max && (mode === 'fashion' || (brand.trim() !== '' && modelText.trim() !== ''))

  return (
    <div className="rounded-3xl border border-[var(--color-line)] bg-white p-5 shadow-[var(--shadow-card)] sm:p-8">
      {flow === 'mode' && (
        <div>
          <p className="text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">
            {g.stepOf(1, 3)} · {g.mode.stepLabel}
          </p>
          <h3 className="mt-2 text-2xl font-bold text-[var(--color-ink)]">{g.mode.heading}</h3>
          <div className="mt-6 max-w-xl">
            <CategorySelector
              value={mode}
              onChange={(v) => setMode(v)}
              fashionLabel={getCategoryLabel(language).fashion}
              furnitureLabel={getCategoryLabel(language).furniture}
              fashionCta={language === 'en' ? 'Garments, bags, shoes with a label/care tag' : 'Plagg, väskor, skor med etikett/tvättråd'}
              furnitureCta={language === 'en' ? 'Furniture with a known brand and model' : 'Möbler med känt märke och modell'}
            />
          </div>
          <button
            type="button"
            onClick={() => setFlow('input')}
            className="mt-8 inline-flex items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
          >
            {g.mode.continueButton}
          </button>
        </div>
      )}

      {flow === 'input' && (
        <div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">
                {g.stepOf(2, 3)} · {g.input.stepLabel(mode === 'furniture' ? (language === 'en' ? 'Furniture' : 'Möbler') : language === 'en' ? 'Fashion' : 'Mode')}
              </p>
              <h3 className="mt-2 text-2xl font-bold text-[var(--color-ink)]">{g.input.heading}</h3>
            </div>
            <button type="button" onClick={() => setFlow('mode')} className="text-xs text-[var(--color-body)] underline underline-offset-4">
              {g.input.changeCategory}
            </button>
          </div>

          {mode === 'furniture' ? (
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">{g.input.brandLabel}</span>
                <input
                  type="text"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  placeholder={g.input.brandPlaceholder}
                  className="w-full rounded-xl border border-[var(--color-line)] bg-white px-4 py-2.5 text-[15px] text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">{g.input.modelLabel}</span>
                <input
                  type="text"
                  value={modelText}
                  onChange={(e) => setModelText(e.target.value)}
                  placeholder={g.input.modelPlaceholder}
                  className="w-full rounded-xl border border-[var(--color-line)] bg-white px-4 py-2.5 text-[15px] text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
                />
              </label>
            </div>
          ) : (
            <div className="mt-5">
              <p className="text-xs leading-relaxed text-[var(--color-body)]">{g.input.fashionFieldsHelper}</p>
              <div className="mt-3 grid gap-4 sm:grid-cols-3">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">{g.input.fashionBrandLabel}</span>
                  <input
                    type="text"
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder={g.input.fashionBrandPlaceholder}
                    className="w-full rounded-xl border border-[var(--color-line)] bg-white px-4 py-2.5 text-[15px] text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">{g.input.styleCodeLabel}</span>
                  <input
                    type="text"
                    value={styleCode}
                    onChange={(e) => setStyleCode(e.target.value)}
                    placeholder={g.input.styleCodePlaceholder}
                    className="w-full rounded-xl border border-[var(--color-line)] bg-white px-4 py-2.5 text-[15px] text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">{g.input.sizeLabel}</span>
                  <input
                    type="text"
                    value={sizeText}
                    onChange={(e) => setSizeText(e.target.value)}
                    placeholder={g.input.sizePlaceholder}
                    className="w-full rounded-xl border border-[var(--color-line)] bg-white px-4 py-2.5 text-[15px] text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
                  />
                </label>
              </div>
            </div>
          )}

          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            <UploadCard
              headline={g.input.productHeadline}
              helper={g.input.productHelper}
              count={files.length}
              max={limits.max}
              min={limits.min}
              required
              icon={<ImageIcon />}
              previewUrls={previewUrls}
              onAdd={() => fileInputRef.current?.click()}
              onRemove={removeFile}
              dropHint={g.input.productDropHint(limits.min, limits.max)}
              text={g.input}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                addFiles(e.target.files)
                e.target.value = ''
              }}
            />

            <UploadCard
              headline={g.input.labelHeadline}
              badge={g.input.labelBadge}
              helper={g.input.labelHelper}
              examples={g.input.labelExamples[mode]}
              count={labelFiles.length}
              max={LABEL_MAX}
              icon={<TagIcon />}
              previewUrls={labelPreviewUrls}
              onAdd={() => labelInputRef.current?.click()}
              onRemove={removeLabelFile}
              dropHint={g.input.labelDropHint(LABEL_MAX)}
              accent
              text={g.input}
            />
            <input
              ref={labelInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                addLabelFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>

          <button
            type="button"
            disabled={!canProceedFromInput}
            onClick={() => setFlow('website')}
            className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)] disabled:opacity-40 sm:w-auto"
          >
            {g.input.continueButton}
          </button>
        </div>
      )}

      {flow === 'website' && (
        <div>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">
                {g.stepOf(3, 3)} · {g.website.stepLabel}
              </p>
              <h3 className="mt-2 text-2xl font-bold text-[var(--color-ink)]">{g.website.heading}</h3>
            </div>
            <button type="button" onClick={() => setFlow('input')} className="text-xs text-[var(--color-body)] underline underline-offset-4">
              {g.website.changeImages}
            </button>
          </div>

          <label className="mt-5 block max-w-md">
            <span className="mb-1.5 block text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">{g.website.urlLabel}</span>
            <input
              type="text"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              placeholder={g.website.urlPlaceholder}
              className="w-full rounded-xl border border-[var(--color-line)] bg-white px-4 py-2.5 text-[15px] text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
            />
          </label>
          <p className="mt-2 max-w-md text-sm text-[var(--color-body)]">{g.website.urlHelper}</p>

          {error && (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="text-sm font-medium text-red-700">{error}</p>
              <p className="mt-0.5 text-xs text-red-700/70">{g.website.errorPersistHint}</p>
            </div>
          )}

          <button
            type="button"
            onClick={handleGenerate}
            className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)] sm:w-auto"
          >
            {error ? g.website.retryButton : g.website.generateButton}
          </button>
        </div>
      )}

      {flow === 'loading' && (
        <div className="flex min-h-[360px] flex-col items-center justify-center py-10 text-center">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-[var(--color-line)] border-t-[var(--color-accent)]" />
          <div className="mt-8 flex flex-col items-center gap-3">
            {loadingSteps.map((label, i) => (
              <p
                key={label}
                className={`text-sm transition-colors duration-500 ${
                  i === stepIndex ? 'font-semibold text-[var(--color-ink)]' : 'text-[var(--color-body)]/50'
                }`}
              >
                {label}
                {i === stepIndex && <span className="ml-1 inline-block animate-pulse text-[var(--color-accent)]">…</span>}
              </p>
            ))}
          </div>
          <p className="mt-8 max-w-xs text-xs text-[var(--color-body)]">{slowPhase ? g.loading.stillWorkingNote : g.loading.note}</p>
        </div>
      )}

      {flow === 'result' && result && (
        <ResultEditor result={result} previewUrls={previewUrls} onReset={resetAll} text={g.result} publish={g.publishModal} language={language} />
      )}
    </div>
  )
}

// ─── Upload cards ────────────────────────────────────────────────────────

function UploadCard({
  headline,
  badge,
  helper,
  examples,
  count,
  max,
  min,
  required,
  icon,
  previewUrls,
  onAdd,
  onRemove,
  dropHint,
  accent,
  text,
}: {
  headline: string
  badge?: string
  helper: string
  examples?: string
  count: number
  max: number
  min?: number
  required?: boolean
  icon: ReactNode
  previewUrls: string[]
  onAdd: () => void
  onRemove: (idx: number) => void
  dropHint: string
  accent?: boolean
  text: GeneratorText['input']
}) {
  return (
    <div
      className={`rounded-2xl border p-4 sm:p-5 ${
        accent ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent)]/[0.025]' : 'border-[var(--color-line)]'
      }`}
    >
      <div className="flex items-center gap-2">
        <h4 className="text-[15px] font-semibold text-[var(--color-ink)]">{headline}</h4>
        {badge && (
          <span className="rounded-full bg-[var(--color-cream-soft)] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--color-body)] uppercase">
            {badge}
          </span>
        )}
        {required && <span className="text-xs text-[var(--color-accent)]">*</span>}
        <span className="ml-auto text-xs text-[var(--color-body)]">
          {count}/{max}
        </span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-body)]">{helper}</p>
      {examples && <p className="mt-0.5 text-xs text-[var(--color-body)]/70">{examples}</p>}

      {count === 0 ? (
        <button
          type="button"
          onClick={onAdd}
          className={`mt-3.5 flex aspect-[16/9] w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-sm text-[var(--color-body)] transition-colors ${
            accent
              ? 'border-[var(--color-accent)]/40 bg-white hover:border-[var(--color-accent)]'
              : 'border-[var(--color-line)] bg-[var(--color-cream-soft)] hover:border-[var(--color-accent)]'
          }`}
        >
          <span className={accent ? 'text-[var(--color-accent)]' : 'text-[var(--color-body)]'}>{icon}</span>
          <span className="font-medium text-[var(--color-ink)]">{text.clickToUpload}</span>
          <span className="text-xs">{dropHint}</span>
        </button>
      ) : (
        <div className="mt-3.5">
          <div className="grid grid-cols-4 gap-2">
            {previewUrls.map((url, i) => (
              <div key={url} className="group relative aspect-square overflow-hidden rounded-lg border border-[var(--color-line)]">
                <img src={url} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label={text.removeImage}
                  className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  ×
                </button>
              </div>
            ))}
            {count < max && (
              <button
                type="button"
                onClick={onAdd}
                aria-label={text.addMore}
                className="flex aspect-square items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-line)] text-[var(--color-body)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
              >
                <PlusIcon />
              </button>
            )}
          </div>
          {min != null && count < min && <p className="mt-2 text-xs text-[var(--color-accent)]">{text.minRequired(min)}</p>}
        </div>
      )}
    </div>
  )
}

// ─── Result ──────────────────────────────────────────────────────────────

function ResultEditor({
  result,
  previewUrls,
  onReset,
  text,
  publish,
  language,
}: {
  result: GeneratedListingResult
  previewUrls: string[]
  onReset: () => void
  text: GeneratorText['result']
  publish: GeneratorText['publishModal']
  language: Language
}) {
  const [activeImage, setActiveImage] = useState(0)
  const [publishOpen, setPublishOpen] = useState(false)

  const priceAvailable =
    result.pricing.available &&
    (result.pricing.suggestedPriceSek != null || (result.pricing.priceRangeMinSek != null && result.pricing.priceRangeMaxSek != null))
  const priceLine = priceAvailable
    ? result.pricing.suggestedPriceSek != null
      ? sek(result.pricing.suggestedPriceSek, language)
      : `${sek(result.pricing.priceRangeMinSek!, language)} – ${sek(result.pricing.priceRangeMaxSek!, language)}`
    : null

  const metaLine = [result.identity.exactProduct, result.identity.variant].filter(Boolean).join(' · ')

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">{text.stepLabel}</p>
        <button type="button" onClick={onReset} className="text-xs font-medium text-[var(--color-body)] underline underline-offset-4">
          {text.resetButton}
        </button>
      </div>

      {result.websiteAdaptation && (
        <div className="mt-4 flex items-center gap-2 rounded-full bg-[var(--color-ink)] px-4 py-2 text-white">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" />
          <p className="text-sm font-medium">{text.adaptedFor(result.websiteAdaptation.domain)}</p>
        </div>
      )}

      {result.missingNotes.length > 0 && (
        <div className="mt-4 rounded-xl bg-[var(--color-cream-soft)] px-4 py-3 text-xs text-[var(--color-body)]">
          <span className="font-semibold text-[var(--color-ink)]">{text.observeLabel} </span>
          {result.missingNotes.join(' · ')}
        </div>
      )}

      <div className="mt-7 grid gap-10 lg:grid-cols-[440px_1fr]">
        {/* Product image */}
        <div className="lg:sticky lg:top-24 lg:self-start">
          <div className="overflow-hidden rounded-2xl bg-[var(--color-cream-soft)]">
            {previewUrls[activeImage] && (
              <img src={previewUrls[activeImage]} alt={result.seo.imageAlt} className="aspect-[4/5] w-full object-cover" />
            )}
          </div>
          {previewUrls.length > 1 && (
            <div className="mt-2.5 grid grid-cols-6 gap-2">
              {previewUrls.map((url, i) => (
                <button
                  key={url}
                  type="button"
                  onClick={() => setActiveImage(i)}
                  className={`overflow-hidden rounded-lg border-2 transition-colors ${
                    activeImage === i ? 'border-[var(--color-accent)]' : 'border-transparent'
                  }`}
                >
                  <img src={url} alt="" className="aspect-square w-full object-cover" />
                </button>
              ))}
            </div>
          )}

          {result.sources.length > 0 && (
            <div className="mt-5">
              <p className="text-xs font-medium text-[var(--color-body)]">{text.sourcesLabel}</p>
              <ul className="mt-1.5 space-y-1">
                {result.sources.map((s) => (
                  <li key={s.url} className="flex items-center gap-1.5 truncate text-xs">
                    <a href={s.url} target="_blank" rel="noreferrer" className="truncate text-[var(--color-accent)] underline underline-offset-2">
                      {s.title}
                    </a>
                    {s.qualityTier <= 2 && (
                      <span className="shrink-0 rounded-full bg-[var(--color-cream-soft)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-body)]">
                        {text.verifiedSourceBadge}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Editorial product content */}
        <div>
          <p className="text-xs font-medium tracking-wide text-[var(--color-body)] uppercase">
            {[result.identity.category, result.identity.brand].filter(Boolean).join(' · ') || text.defaultCategory}
          </p>
          <div className="mt-1.5 flex items-start gap-2">
            <h2 className="text-3xl leading-[1.1] font-bold text-[var(--color-ink)] sm:text-[34px]">{result.listing.title}</h2>
            <EditableHint hint={text.editableHint} />
          </div>
          {metaLine && <p className="mt-1.5 text-sm text-[var(--color-body)]">{metaLine}</p>}
          {result.identity.uncertain && (
            <div className="mt-2 inline-flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
              <span className="font-medium">{text.identityUncertainLabel}</span>
              {result.identity.uncertaintyNote && <span>— {result.identity.uncertaintyNote}</span>}
            </div>
          )}

          {result.listing.description && (
            <p className="mt-4 max-w-[62ch] text-[15px] leading-relaxed text-[var(--color-body)]">{result.listing.description}</p>
          )}

          {/* Specifications */}
          <div className="mt-8 border-t border-[var(--color-line)] pt-6">
            <h5 className="text-xs font-semibold tracking-wide text-[var(--color-body)] uppercase">{text.specifications}</h5>
            {result.attributes.length > 0 ? (
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                {result.attributes.map((a) => (
                  <div key={a.key}>
                    <dt className="text-xs text-[var(--color-body)]">{a.label}</dt>
                    <dd className="font-medium text-[var(--color-ink)]">
                      {a.value}
                      {a.sourceUrl && (
                        <a
                          href={a.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={text.attributeSourceAria(a.label)}
                          title={a.sourceUrl}
                          className="ml-1.5 inline-block align-baseline text-xs text-[var(--color-accent)] underline underline-offset-2"
                        >
                          ↗
                        </a>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="mt-2 text-sm text-[var(--color-body)]">{text.noSpecifications}</p>
            )}
          </div>

          {/* Condition — kept visually important */}
          <div className="mt-6 rounded-2xl border-2 border-[var(--color-ink)] p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h5 className="text-xs font-semibold tracking-wide text-[var(--color-body)] uppercase">{text.condition}</h5>
              <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-cream-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-body)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent)]" />
                {text.aiAssessed}
              </span>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {result.condition.grade && (
                <span className="rounded-full bg-[var(--color-ink)] px-2.5 py-1 text-xs font-semibold text-white">{result.condition.grade}</span>
              )}
              <span className="text-lg font-bold text-[var(--color-ink)]">{result.condition.label ?? text.notAssessed}</span>
              {result.condition.uncertain && (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">{text.uncertainAssessment}</span>
              )}
            </div>
            {result.condition.reasoning && <p className="mt-2 text-sm text-[var(--color-body)]">{result.condition.reasoning}</p>}
            {result.condition.defects.length > 0 && (
              <ul className="mt-2 list-inside list-disc text-sm text-[var(--color-body)]">
                {result.condition.defects.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
            {result.condition.uncertaintyNote && <p className="mt-2 text-xs text-[var(--color-body)] italic">{result.condition.uncertaintyNote}</p>}
            <p className="mt-3 border-t border-[var(--color-line)] pt-2.5 text-[11px] text-[var(--color-body)]">{text.aiDisclaimer}</p>
          </div>

          {/* Price */}
          <div className="mt-6 border-t border-[var(--color-line)] pt-6">
            <h5 className="text-xs font-semibold tracking-wide text-[var(--color-body)] uppercase">{text.price}</h5>
            {priceAvailable ? (
              <p className="mt-1.5 text-3xl font-bold text-[var(--color-ink)]">{priceLine}</p>
            ) : (
              <p className="mt-1.5 text-sm font-medium text-[var(--color-body)]">{text.insufficientPricingData}</p>
            )}
            {result.pricing.retailPriceSek != null && (
              <p className="mt-1 text-sm text-[var(--color-body)]">
                {text.retailPriceLabel} {sek(result.pricing.retailPriceSek, language)}
              </p>
            )}
            {result.pricing.rationale && <p className="mt-1 text-sm text-[var(--color-body)]">{result.pricing.rationale}</p>}
          </div>

          {/* Listing condition text */}
          <div className="mt-6 border-t border-[var(--color-line)] pt-6">
            <div className="flex items-center justify-between">
              <h5 className="text-xs font-semibold tracking-wide text-[var(--color-body)] uppercase">{text.conditionText}</h5>
              <EditableHint hint={text.editableHint} />
            </div>
            <p className="mt-1.5 text-sm text-[var(--color-body)]">{result.listing.conditionText || '—'}</p>
          </div>

          {/* SEO ready — kept visually prominent */}
          <div className="mt-6 rounded-2xl border-2 border-[var(--color-accent)]/30 bg-[var(--color-accent)]/[0.03] p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h5 className="text-xs font-semibold tracking-wide text-[var(--color-body)] uppercase">{text.seoReady}</h5>
              <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2.5 py-1 text-[11px] font-semibold text-green-700">
                {text.seoReadyBadge}
              </span>
            </div>
            {result.websiteAdaptation && (
              <p className="mt-1.5 text-xs text-[var(--color-body)]">{text.adaptedForWebshop(result.websiteAdaptation.domain)}</p>
            )}
            <dl className="mt-3 space-y-2.5 text-sm">
              <div>
                <dt className="text-xs text-[var(--color-body)] uppercase">{text.seoTitleLabel}</dt>
                <dd className="text-[var(--color-ink)]">{result.listing.title}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-body)] uppercase">{text.metaTitleLabel}</dt>
                <dd className="text-[var(--color-ink)]">{result.seo.metaTitle}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-body)] uppercase">{text.metaDescriptionLabel}</dt>
                <dd className="text-[var(--color-ink)]">{result.seo.metaDescription}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-body)] uppercase">{text.urlLabel}</dt>
                <dd className="text-[var(--color-ink)]">/produkt/{result.slug}</dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-body)] uppercase">{text.imageAltLabel}</dt>
                <dd className="text-[var(--color-ink)]">{result.seo.imageAlt}</dd>
              </div>
            </dl>

            {result.attributes.length > 0 && (
              <div className="mt-3.5 border-t border-[var(--color-line)] pt-3">
                <p className="text-xs text-[var(--color-body)] uppercase">{text.structuredAttributesLabel}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {result.attributes.map((a) => (
                    <span
                      key={a.key}
                      className="rounded-full border border-[var(--color-line)] bg-white px-2.5 py-1 text-[11px] text-[var(--color-ink)]"
                    >
                      {a.label}: <span className="font-medium">{a.value}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {result.jsonLd && (
              <details className="mt-3.5 border-t border-[var(--color-line)] pt-3">
                <summary className="cursor-pointer text-xs font-medium text-[var(--color-body)] uppercase">{text.jsonLdSummary}</summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-[var(--color-ink)] p-3 text-[11px] leading-relaxed text-[var(--color-cream)]">
                  {JSON.stringify(result.jsonLd, null, 2)}
                </pre>
              </details>
            )}

            <p className="mt-3.5 border-t border-[var(--color-line)] pt-3 text-xs text-[var(--color-body)]">{text.structureNote}</p>
          </div>

          {/* Closing workflow + publish */}
          <div className="mt-8 rounded-2xl bg-[var(--color-cream-soft)] p-5 sm:p-6">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-3 py-1.5 text-xs font-semibold text-green-700">
              {text.readyToPublish}
            </span>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-sm font-medium text-[var(--color-ink)]">
              {text.workflowSteps.map((step, i) => (
                <span key={step} className="contents">
                  {i > 0 && <span className="text-[var(--color-body)]">→</span>}
                  <span className="rounded-full bg-white px-3 py-1.5 shadow-[var(--shadow-card)]">{step}</span>
                </span>
              ))}
            </div>
            <p className="mt-3 text-xs text-[var(--color-body)]">{text.integrationNote}</p>

            <button
              type="button"
              onClick={() => setPublishOpen(true)}
              className="mt-5 inline-flex w-full items-center justify-center rounded-full bg-[var(--color-ink)] px-6 py-3.5 text-[15px] font-semibold text-white transition-colors hover:bg-black sm:w-auto"
            >
              {text.publishButton}
            </button>
          </div>
        </div>
      </div>

      {publishOpen && <PublishModal onClose={() => setPublishOpen(false)} text={publish} />}
    </div>
  )
}

function PublishModal({ onClose, text }: { onClose: () => void; text: GeneratorText['publishModal'] }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl sm:p-8"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <span className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-green-50 text-green-700">
          <CheckIcon />
        </span>
        <h3 className="mt-4 text-2xl font-bold text-[var(--color-ink)]">{text.heading}</h3>
        <p className="mt-3 text-[15px] leading-relaxed text-[var(--color-body)]">{text.body1}</p>
        <p className="mt-2 text-[15px] font-medium text-[var(--color-ink)]">{text.body2}</p>
        <p className="mt-4 text-xs text-[var(--color-body)]">{text.integrationNote}</p>

        <a
          href="/company#contact-form"
          className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-[var(--color-accent)] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[var(--color-accent-dark)]"
        >
          {text.ctaTalk}
        </a>
        <button
          type="button"
          onClick={onClose}
          className="mt-3 inline-flex w-full items-center justify-center rounded-full border border-[var(--color-line)] px-6 py-3 text-[15px] font-medium text-[var(--color-ink)] transition-colors hover:bg-[var(--color-cream-soft)]"
        >
          {text.ctaBack}
        </button>
      </div>
    </div>
  )
}

// ─── Small shared bits ───────────────────────────────────────────────────

function EditableHint({ hint }: { hint: string }) {
  return (
    <span className="mt-1.5 inline-flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-body)]/70">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {hint}
    </span>
  )
}

function ImageIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8.5" cy="9.5" r="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M21 15.5l-5-5-9.5 9.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TagIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M11.5 3.5H5.5a2 2 0 0 0-2 2v6l9.7 9.7a2 2 0 0 0 2.83 0l6.17-6.17a2 2 0 0 0 0-2.83L12.5 3.5h-1Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.4" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
